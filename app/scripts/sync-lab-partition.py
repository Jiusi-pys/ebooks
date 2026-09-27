"""Run on each lab host while the SSH replication tunnel is disconnected."""
import json
import sys
import time
import uuid
import urllib.request
from pathlib import Path

remote = sys.argv[1] == 'linux'
env_path = Path('/opt/shufang-sync-lab/linux.env') if remote else Path('.runtime/sync-lab/windows.env')
env = dict(line.split('=', 1) for line in env_path.read_text(encoding='utf-8').splitlines() if '=' in line)
node = 'linux' if remote else 'windows'
port = 3102 if remote else 3101
key = env['OPEN_API_KEY']
headers = {'X-API-Key': key, 'Content-Type': 'application/json'}
patch = {'content': 'Linux partition content', 'color': 'blue'} if remote else {'title': 'Windows partition title', 'createdAt': int(time.time()*1000), 'updatedAt': int(time.time()*1000)}
operation = {'workspaceId': env['SYNC_WORKSPACE_ID'], 'operationId': str(uuid.uuid4()), 'replicaId': node+'-partition', 'kind': 'notes', 'entityId': 'partition-20260927', 'clock': str(int(time.time()*1000))+':0', 'patch': patch, 'unset': [], 'deleted': False}
request = urllib.request.Request(f'http://127.0.0.1:{port}/api/v2/sync/push', data=json.dumps({'operations':[operation]}).encode(), headers=headers)
with urllib.request.urlopen(request, timeout=15) as response:
    receipt = json.load(response)
result = {'node': node, 'operation': operation, 'receipt': receipt, 'time': time.time()}
destination = env_path.parent / ('partition-'+node+'.json')
destination.write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
