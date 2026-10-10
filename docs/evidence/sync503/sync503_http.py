import hashlib, json, subprocess, urllib.request, urllib.error, uuid

DOCKER = ['wsl','-d','Ubuntu-20.04','-u','root','--','/tmp/shufang-builder/docker/docker','-H','unix:///tmp/shufang-builder/docker.sock']
DATABASE = 'shufang_test_sync503'
WORKSPACE = 'sync503-http'
BASE = 'http://127.0.0.1:33120'
def sql(query):
    result = subprocess.run(DOCKER + ['exec','-i','shufang-test-sync503','mysql','-uroot','-pisolated-sync503-only','-N','-B',DATABASE], input=query.encode(),capture_output=True,check=True)
    return result.stdout.decode().strip()
def request(path, data=None):
    req = urllib.request.Request(BASE+path, data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer isolated-sync503-service-token-for-tests-only','Content-Type':'application/json','Origin':BASE,'X-Workspace-Id':WORKSPACE})
    try:
        with urllib.request.urlopen(req,timeout=20) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        raise AssertionError((error.code,error.read().decode())) from error
assert sql('SELECT DATABASE()') == DATABASE
lock = ('shufang:'+hashlib.sha256((DATABASE+'\0'+WORKSPACE).encode()).hexdigest())[:64]
before = sql('SELECT IS_USED_LOCK("'+lock+'")')
assert before.isdecimal()
operation = {'workspaceId':WORKSPACE,'operationId':str(uuid.uuid4()),'replicaId':'fixture-client','kind':'notes','entityId':str(uuid.uuid4()),'clock':'101:0','patch':{'title':'Reconnect fixture','content':'Only isolated data','createdAt':100,'updatedAt':101},'unset':[],'deleted':False}
status,push = request('/api/v2/sync/push',{'operations':[operation]})
assert status==200 and push['receipts'][0]['persisted']
sql('KILL CONNECTION '+before)
status,snapshot = request('/api/v2/sync/snapshots',{})
assert status==201
status,page = request('/api/v2/sync/snapshots/'+snapshot['id'])
assert status==200 and any(e['id']==operation['entityId'] for e in page['entities'])
after = sql('SELECT IS_USED_LOCK("'+lock+'")')
assert after.isdecimal() and after != before
sql('KILL CONNECTION '+after)
operation['operationId']=str(uuid.uuid4())
operation['clock']='102:0'
operation['patch']['content']='Updated after second disconnection'
status,updated = request('/api/v2/sync/push',{'operations':[operation]})
assert status==200 and updated['receipts'][0]['persisted'] and not updated['receipts'][0]['duplicate']
status,repeated = request('/api/v2/sync/push',{'operations':[operation]})
assert status==200 and repeated['receipts'][0]['duplicate']
assert repeated['receipts'][0]['seq']==updated['receipts'][0]['seq']
print(json.dumps({'snapshotAfterDisconnect':201,'pageAfterDisconnect':200,'pushAfterSecondDisconnect':200,'repeatOperationDeduplicated':True,'writerConnectionChanged':True,'entities':len(page['entities'])},indent=2))
