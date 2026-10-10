import json,pathlib,subprocess,time
scope={}
source=pathlib.Path(__file__).with_name('sync503_http.py').read_text()
exec(source[:source.index("assert sql('SELECT DATABASE()')")],scope)
sql,request,DOCKER=scope['sql'],scope['request'],scope['DOCKER']
assert sql('SELECT DATABASE()')=='shufang_test_sync503'
def ready():
    for _ in range(30):
        try:
            assert request('/api/v2/capabilities')[0]==200
            return
        except Exception:time.sleep(.2)
    raise AssertionError('service not ready')
def snapshot():
    status,value=request('/api/v2/sync/snapshots',{})
    assert status==201
    status,page=request('/api/v2/sync/snapshots/'+value['id'])
    assert status==200
    return len(page['entities'])
before=snapshot()
subprocess.run(DOCKER+['stop','shufang-test-sync503-service'],check=True,capture_output=True)
try:
    args=['run','-d','--name','shufang-test-sync503-rollback','--network','host','-v','/tmp/shufang-sync503-20261008/previous-service:/usr/local/bin/shufang-service:ro']
    for env in ['DATABASE_URL=mysql://root:isolated-sync503-only@127.0.0.1:33119/shufang_test_sync503','SHUFANG_SERVICE_TOKEN=isolated-sync503-service-token-for-tests-only','APP_DATA_SECRET=isolated-data-secret-long-enough-for-tests','APP_SESSION_SECRET=isolated-session-secret-long-enough-for-tests']:
        args+=['-e',env]
    args+=['shufang:source-90fdf65','--mysql','--workspace','/tmp/sync503','--workspace-id','sync503-http','--node-id','test-node','--port','33120']
    subprocess.run(DOCKER+args,check=True,capture_output=True)
    ready();rolled=snapshot();assert rolled==before
finally:
    subprocess.run(DOCKER+['stop','shufang-test-sync503-rollback'],capture_output=True)
    subprocess.run(DOCKER+['start','shufang-test-sync503-service'],check=True,capture_output=True)
ready();after=snapshot();assert after==before
print(json.dumps({'isolatedRollbackToActualPreviousProductionBinary':True,'snapshotWithOldBinary':201,'snapshotAfterRestoringHotfix':201,'entityCountBefore':before,'entityCountAfterRollback':rolled,'entityCountAfterHotfix':after},indent=2))
