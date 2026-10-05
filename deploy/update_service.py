"""Loopback deployment supervisor. Run separately from the application container."""
import hmac
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from urllib.request import urlopen

REPOSITORY = 'https://github.com/Jiusi-pys/ebooks.git'
ROOT = Path('/opt/shufang')


def authorized(secret, header):
    return len(secret) >= 32 and hmac.compare_digest(
        ('Bearer ' + secret).encode(), header.encode())


def validate_sha(payload):
    if not isinstance(payload, dict) or set(payload) != {'sha'}:
        raise ValueError('Expected only sha')
    sha = payload['sha']
    if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Expected a full lowercase commit SHA')
    return sha


class Jobs:
    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs = {}
        for path in directory.glob('*.json'):
            job = json.loads(path.read_text())
            self.jobs[job['id']] = job
            if job['state'] == 'running':
                job.update(state='failed', error='Supervisor interrupted; inspect containers before retry')
                self.persist(job)

    def persist(self, job):
        path = self.directory / (job['id'] + '.json')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(job))
        temporary.replace(path)

    def accept(self, sha):
        with self.lock:
            active = next((j for j in self.jobs.values() if j['state'] == 'running'), None)
            if active:
                if active['sha'] == sha:
                    return dict(active), False
                raise BlockingIOError('Another deployment is running')
            latest = max(self.jobs.values(), key=lambda j: j['createdAt'], default=None)
            if latest and latest['sha'] == sha and latest['state'] == 'succeeded':
                return dict(latest), False
            job = dict(id=uuid.uuid4().hex, sha=sha, state='running', createdAt=time.time())
            self.persist(job)
            self.jobs[job['id']] = job
            return dict(job), True

    def finish(self, job_id, state, error=None):
        with self.lock:
            job = self.jobs[job_id]
            job.update(state=state, finishedAt=time.time())
            if error:
                job['error'] = error
            self.persist(job)

    def read(self, job_id=None):
        with self.lock:
            job = self.jobs.get(job_id) if job_id else max(
                self.jobs.values(), key=lambda j: j['createdAt'], default=None)
            return dict(job) if job else None


class Rollout:
    def __init__(self, run, healthy=None, runtime="node"):
        if runtime not in ("node", "rust"):
            raise ValueError("Unsupported runtime")
        self.runtime = runtime
        self.port = int(os.environ.get('DEPLOY_PORT', '3000'))
        if not 1 <= self.port <= 65535:
            raise ValueError('Invalid deployment port')
        self.run = run
        self.healthy = healthy or self.wait_healthy

    def wait_healthy(self):
        deadline = time.monotonic() + 90
        consecutive = 0
        while time.monotonic() < deadline:
            try:
                with urlopen(f'http://127.0.0.1:{self.port}/api/auth/session', timeout=4) as response:
                    body = json.load(response)
                    ready = response.status == 200 and body.get('configured') is True
                state = self.run(['docker', 'inspect', '--format', '{{.State.Running}} {{.RestartCount}}', 'shufang-app'], capture=True)
                consecutive = consecutive + 1 if ready and state.strip() == 'true 0' else 0
                if consecutive >= 3:
                    return True
            except Exception:
                consecutive = 0
            time.sleep(2)
        return False

    def switch(self, sha):
        if self.runtime == 'rust':
            return self.switch_rust(sha)
        image = 'shufang:' + sha
        environment = ['--network', 'host', '--env-file', str(ROOT / '.env.sync'),
                       '-e', 'HOST=127.0.0.1', '-e', 'PORT=3000', '-e', 'AUTO_UPDATE_ENABLED=false',
                       '-v', str(ROOT / 'runtime') + ':/app/.runtime']
        migration = 'shufang-migrate-' + sha[:12]
        try:
            self.run(['docker', 'run', '--rm', '--name', migration, *environment, image, 'node', 'dist/api/migrate.js'], timeout=180)
        finally:
            self.run(['docker', 'rm', '-f', migration], check=False)
        # Keep the currently running container intact until the build/migration succeeds.
        self.run(['docker', 'inspect', 'shufang-app'], capture=True)
        self.run(['docker', 'rm', '-f', 'shufang-previous'], check=False)
        renamed = False
        try:
            self.run(['docker', 'stop', '-t', '30', 'shufang-app'])
            self.run(['docker', 'rename', 'shufang-app', 'shufang-previous'])
            renamed = True
            self.run(['docker', 'run', '-d', '--name', 'shufang-app', '--restart', 'unless-stopped',
                      *environment, '--label', 'org.opencontainers.image.revision=' + sha,
                      image, 'node', 'dist/api/boot.js'])
            if not self.healthy():
                raise RuntimeError('Candidate failed readiness checks')
        except Exception:
            if renamed:
                self.run(['docker', 'rm', '-f', 'shufang-app'], check=False)
                self.run(['docker', 'rename', 'shufang-previous', 'shufang-app'])
            self.run(['docker', 'start', 'shufang-app'])
            raise

    def switch_rust(self, sha):
        image = 'shufang:' + sha
        environment = ['--network', 'host', '--env-file', str(ROOT / '.env.rust'),
                       '-v', str(ROOT / 'runtime-rust') + ':/app/runtime']
        migration = 'shufang-migrate-' + sha[:12]
        self.run(['docker', 'inspect', 'shufang-app'], capture=True)
        # Keep a recoverable snapshot before appending migrations. This helper
        # must fail closed and is installed/configured by the first Rust rollout.
        self.run([str(ROOT / 'backup-rust.sh')], timeout=300)
        self.run(['docker', 'run', '--rm', '--name', migration, *environment,
                  image, '--migrate', '--migrations', '/app/migrations'], timeout=300)
        self.run(['docker', 'rm', '-f', 'shufang-previous'], check=False)
        renamed = False
        try:
            self.run(['docker', 'stop', '-t', '30', 'shufang-app'])
            self.run(['docker', 'rename', 'shufang-app', 'shufang-previous'])
            renamed = True
            self.run(['docker', 'run', '-d', '--name', 'shufang-app', '--restart', 'unless-stopped',
                      *environment, '--label', 'org.opencontainers.image.revision=' + sha,
                      image, '--mysql', '--workspace', '/app/runtime',
                      '--workspace-id', os.environ.get('SYNC_WORKSPACE_ID', 'personal-workspace'),
                      '--node-id', os.environ.get('SYNC_NODE_ID', 'us-server'),
                      '--port', str(self.port), '--v1-contract', 'sync-entities',
                      '--auth-runtime', '/app/runtime', '--public-url', 'https://us.jiusi.org'])
            if not self.healthy():
                raise RuntimeError('Candidate failed readiness checks')
        except Exception:
            if renamed:
                self.run(['docker', 'rm', '-f', 'shufang-app'], check=False)
                self.run(['docker', 'rename', 'shufang-previous', 'shufang-app'])
            # Restart uses the same MySQL/runtime and therefore preserves any
            # candidate writes; it does not pretend to roll back the database.
            self.run(['docker', 'start', 'shufang-app'])
            raise


def deploy(job, jobs):
    log_path = jobs.directory / (job['id'] + '.log')
    try:
        with log_path.open('a') as log:
            def run(args, capture=False, check=True, timeout=1800):
                log.write('$ ' + ' '.join(args) + '\n')
                log.flush()
                result = subprocess.run(args, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE if capture else log,
                                        stderr=log, text=True, timeout=timeout,
                                        env={**{k: v for k, v in os.environ.items() if k != 'DEPLOY_TOKEN'},
                                             'GIT_TERMINAL_PROMPT': '0'})
                if check and result.returncode:
                    raise RuntimeError('Deployment step failed: ' + args[0])
                return result.stdout or ''
            with tempfile.TemporaryDirectory(prefix='build-', dir=ROOT) as directory:
                branch = os.environ.get('DEPLOY_BRANCH', 'main')
                if branch not in ('main', 'base'):
                    raise RuntimeError('Unsupported deployment branch')
                run(['git', 'clone', '--depth', '1', '--branch', branch, '--single-branch', REPOSITORY, directory])
                head = run(['git', '-C', directory, 'rev-parse', 'HEAD'], capture=True).strip()
                if head != job['sha']:
                    raise RuntimeError('Requested SHA is no longer the deployment branch head; deploy the latest push')
                runtime = os.environ.get('DEPLOY_RUNTIME', 'node')
                dockerfile = '/deploy/Dockerfile.rust' if runtime == 'rust' else '/app/Dockerfile'
                run(['docker', 'build', '--label', 'org.opencontainers.image.revision=' + head,
                     '-t', 'shufang:' + head, '-f', directory + dockerfile, directory])
                Rollout(run, runtime=runtime).switch(head)
        jobs.finish(job['id'], 'succeeded')
    except Exception as error:
        # Details remain in the local restricted log; never expose command output/secrets.
        with log_path.open('a') as log:
            log.write(type(error).__name__ + ': ' + str(error) + '\n')
        jobs.finish(job['id'], 'failed', 'Deployment failed; inspect the server job log')


def handler_for(secret, jobs, launch):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass

        def reply(self, status, body):
            content = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(content)
            self.close_connection = True

        def gate(self):
            if urlsplit(self.path).path != '/api/deploy':
                self.reply(404, {'error': 'Not found'})
                return False
            if not authorized(secret, self.headers.get('Authorization', '')):
                self.reply(401, {'error': 'Unauthorized'})
                return False
            return True

        def do_GET(self):
            if not self.gate():
                return
            query = parse_qs(urlsplit(self.path).query)
            job_id = query.get('id', [None])[0]
            job = jobs.read(job_id)
            self.reply(404 if job_id and not job else 200, {'job': job})

        def do_POST(self):
            if not self.gate():
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1024 or self.headers.get('Transfer-Encoding'):
                    return self.reply(413, {'error': 'Body must be 1..1024 bytes with Content-Length'})
                if self.headers.get_content_type() != 'application/json':
                    return self.reply(415, {'error': 'Expected application/json'})
                sha = validate_sha(json.loads(self.rfile.read(size)))
                job, created = jobs.accept(sha)
            except BlockingIOError:
                return self.reply(409, {'error': 'Another deployment is running'})
            except (ValueError, UnicodeError):
                return self.reply(400, {'error': 'Expected {sha: full lowercase commit SHA}'})
            if created:
                try:
                    launch(job)
                except Exception:
                    jobs.finish(job['id'], 'failed', 'Unable to start deployment worker')
                    return self.reply(500, {'error': 'Unable to start deployment'})
            self.reply(202, {'job': job})
    return Handler


if __name__ == '__main__':
    os.umask(0o077)
    secret = os.environ.get('DEPLOY_TOKEN', '')
    if len(secret) < 32:
        raise SystemExit('DEPLOY_TOKEN must contain at least 32 characters')
    jobs = Jobs(ROOT / 'deploy-jobs')
    def launch(job):
        threading.Thread(target=deploy, args=(job, jobs), daemon=False).start()
    server = ThreadingHTTPServer(('127.0.0.1', 3001), handler_for(secret, jobs, launch))
    server.serve_forever()
