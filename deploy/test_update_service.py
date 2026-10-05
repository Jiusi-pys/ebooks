import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

from update_service import Jobs, authorized, validate_sha, Rollout, handler_for, verified_prebuilt_image

SHA = 'a' * 40


class UpdateTests(unittest.TestCase):
    def test_production_entrypoints_match_build_output(self):
        package = json.loads((Path(__file__).parents[1] / 'app' / 'package.json').read_text())
        self.assertIn('dist/api/migrate.js', package['scripts']['start'])
        self.assertIn('dist/api/boot.js', package['scripts']['start'])

    def test_auth_fails_closed(self):
        self.assertFalse(authorized('', 'Bearer '))
        self.assertFalse(authorized('x' * 48, 'Bearer wrong'))
        self.assertTrue(authorized('x' * 48, 'Bearer ' + 'x' * 48))

    def test_sha_only(self):
        self.assertEqual(validate_sha({'sha': SHA}), SHA)
        for payload in [{}, {'sha': '../main'}, {'sha': SHA, 'command': 'whoami'}, {'sha': 2}, []]:
            with self.assertRaises(ValueError):
                validate_sha(payload)

    def test_idempotency_busy_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = Jobs(Path(directory))
            job, created = jobs.accept(SHA)
            self.assertTrue(created)
            self.assertEqual(jobs.accept(SHA), (job, False))
            with self.assertRaises(BlockingIOError):
                jobs.accept('b' * 40)
            jobs.finish(job['id'], 'failed')
            self.assertTrue(jobs.accept(SHA)[1])

    def test_success_dedup_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = Jobs(Path(directory))
            job, _ = jobs.accept(SHA)
            restored = Jobs(Path(directory))
            self.assertEqual(restored.read(job['id'])['state'], 'failed')
            job, _ = restored.accept(SHA)
            restored.finish(job['id'], 'succeeded')
            self.assertFalse(Jobs(Path(directory)).accept(SHA)[1])

    def test_rollout_restores_previous_on_health_failure(self):
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            return ''
        rollout = Rollout(run=run, healthy=lambda: False)
        with self.assertRaises(RuntimeError):
            rollout.switch(SHA)
        self.assertIn(['docker', 'rename', 'shufang-previous', 'shufang-app'], commands)
        self.assertIn(['docker', 'start', 'shufang-app'], commands)

    def test_migration_failure_keeps_current_container(self):
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            if 'dist/api/migrate.js' in args:
                raise RuntimeError('migration failed')
            return ''
        with self.assertRaises(RuntimeError):
            Rollout(run=run, healthy=lambda: True).switch(SHA)
        self.assertNotIn(['docker', 'stop', '-t', '30', 'shufang-app'], commands)
        self.assertIn('dist/api/migrate.js', commands[0])

    def test_success_retains_previous(self):
        commands = []
        rollout = Rollout(run=lambda args, **kw: commands.append(args), healthy=lambda: True)
        rollout.switch(SHA)
        self.assertIn(['docker', 'rename', 'shufang-app', 'shufang-previous'], commands)
        self.assertNotIn(['docker', 'rename', 'shufang-previous', 'shufang-app'], commands)
        self.assertTrue(any('dist/api/boot.js' in command for command in commands))


class RustRolloutTests(unittest.TestCase):
    def test_rust_release_uses_rust_migrations_and_retains_shared_state_on_failure(self):
        commands=[]
        rollout=Rollout(run=lambda args, **kw: commands.append(args) or '',healthy=lambda:False,runtime='rust')
        with self.assertRaises(RuntimeError):
            rollout.switch(SHA)
        self.assertTrue(any('--migrate' in command for command in commands))
        self.assertTrue(any('--mysql' in command for command in commands))
        self.assertTrue(any(command[0].endswith('backup-rust.sh') for command in commands))
        self.assertFalse(any('node' in command for command in commands))
        self.assertIn(['docker','rename','shufang-previous','shufang-app'],commands)
        self.assertIn(['docker','start','shufang-app'],commands)
    def test_backup_failure_does_not_stop_writer(self):
        commands=[]
        def run(args,**kw):
            commands.append(args)
            if args[0].endswith('backup-rust.sh'):
                raise RuntimeError('backup failed')
            return ''
        with self.assertRaises(RuntimeError):
            Rollout(run,healthy=lambda:True,runtime='rust').switch(SHA)
        self.assertFalse(any('stop' in command for command in commands))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.jobs = Jobs(Path(self.directory.name))
        self.launch = Mock()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for('x' * 48, self.jobs, self.launch))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, method='POST', path='/api/deploy', data=None, auth=True):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = {'Content-Type': 'application/json'}
        if auth:
            headers['Authorization'] = 'Bearer ' + 'x' * 48
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_auth_and_input_before_launch(self):
        self.assertEqual(self.request(data='not json', auth=False)[0], 401)
        self.assertEqual(self.request(data='not json')[0], 400)
        self.assertEqual(self.request(data='x' * 1025)[0], 413)
        self.assertEqual(self.request(path='/api/deploy/other')[0], 404)
        self.launch.assert_not_called()

    def test_accept_status_busy_and_duplicate(self):
        status, body = self.request(data=json.dumps({'sha': SHA}))
        self.assertEqual(status, 202)
        self.assertEqual(self.request(data=json.dumps({'sha': SHA}))[0], 202)
        self.launch.assert_called_once()
        self.assertEqual(self.request(data=json.dumps({'sha': 'b' * 40}))[0], 409)
        status, result = self.request('GET', '/api/deploy?id=' + body['job']['id'])
        self.assertEqual(status, 200)
        self.assertEqual(result['job']['sha'], SHA)
        self.assertEqual(self.request('GET', '/api/deploy?id=missing')[0], 404)

    def test_launch_failure_is_recorded(self):
        self.launch.side_effect = RuntimeError('cannot spawn')
        self.assertEqual(self.request(data=json.dumps({'sha': SHA}))[0], 500)
        self.assertEqual(self.jobs.read()['state'], 'failed')


class PrebuiltTests(unittest.TestCase):
    def fixture(self, directory, revision=SHA, image_id='sha256:'+'b'*64):
        Path(directory, SHA+'.json').write_text(json.dumps({'revision':revision,'imageId':image_id}))
        return [{'Id':image_id,'Config':{'Labels':{'org.opencontainers.image.revision':revision}}}]
    def test_verified_image_is_bound_to_commit_and_immutable_id(self):
        with tempfile.TemporaryDirectory() as directory:
            image=self.fixture(directory)
            run=Mock(return_value=json.dumps(image))
            self.assertEqual(verified_prebuilt_image(run,SHA,Path(directory)),'shufang:'+SHA)
            run.assert_called_once_with(['docker','image','inspect','shufang:'+SHA],capture=True)
    def test_missing_manifest_and_wrong_commit_or_image_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            run=Mock()
            with self.assertRaises(Exception):verified_prebuilt_image(run,SHA,Path(directory))
            image=self.fixture(directory,revision='c'*40)
            with self.assertRaises(ValueError):verified_prebuilt_image(Mock(return_value=json.dumps(image)),SHA,Path(directory))
            image=self.fixture(directory)
            image[0]['Id']='sha256:'+'d'*64
            with self.assertRaises(ValueError):verified_prebuilt_image(Mock(return_value=json.dumps(image)),SHA,Path(directory))
            image=self.fixture(directory)
            image[0]['Config']['Labels']['org.opencontainers.image.revision']='e'*40
            with self.assertRaises(ValueError):verified_prebuilt_image(Mock(return_value=json.dumps(image)),SHA,Path(directory))

if __name__ == '__main__':
    unittest.main()
