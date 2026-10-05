#!/bin/sh
# Invoked by the supervisor: archive an actual consistent Rust version and keys.
set -eu
umask 077
python3 - <<'PY'
import datetime, hashlib, json, os, shutil, urllib.request
from pathlib import Path
root = Path('/opt/shufang')
env = {}
for line in (root / '.env.rust').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
req = urllib.request.Request('http://127.0.0.1:'+os.environ.get('DEPLOY_PORT','3000')+'/api/native/v1/versions', data=b'{}', method='POST', headers={'Authorization':'Bearer '+env['SHUFANG_SERVICE_TOKEN'],'Content-Type':'application/json'})
with urllib.request.urlopen(req,timeout=240) as response:
    value=json.load(response)
id=value['id']
import uuid
if not id.startswith("version-"):
    raise RuntimeError("Invalid version identifier")
uuid.UUID(id.removeprefix("version-"))
source=root/'runtime-rust'/'versions'/(id+'.zip')
if not source.is_file():
    raise RuntimeError('Version archive unavailable')
destination=root/'backups'/('rust-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+id)
destination.mkdir(mode=0o700)
shutil.copyfile(source,destination/'version.zip')
shutil.copyfile(root/'.env.rust',destination/'runtime.env')
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.iterdir() if p.is_file()}
(destination/'sha256.json').write_text(json.dumps(manifest))
for p in destination.iterdir():
    p.chmod(0o600)
print('Consistent Rust backup completed')
PY
