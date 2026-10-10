import importlib.util, json, pathlib, subprocess, time
# Import only the local fixture helpers, without running its fault injection.
source=pathlib.Path(__file__).with_name('sync503_http.py').read_text()
scope={}
exec(source[:source.index("assert sql('SELECT DATABASE()')")],scope)
sql,request,DOCKER=scope['sql'],scope['request'],scope['DOCKER']
assert sql('SELECT DATABASE()')=='shufang_test_sync503'
original=sql('SELECT @@global.wait_timeout')
try:
    sql('SET GLOBAL wait_timeout=2')
    subprocess.run(DOCKER+['restart','shufang-test-sync503-service'],check=True,capture_output=True)
    for _ in range(30):
        try:
            assert request('/api/v2/capabilities')[0]==200
            break
        except Exception:
            time.sleep(0.2)
    else:
        raise AssertionError('service did not become ready')
finally:
    sql('SET GLOBAL wait_timeout='+original)
time.sleep(3)
lock=('shufang:'+scope['hashlib'].sha256(b'shufang_test_sync503\0sync503-http').hexdigest())[:64]
assert sql('SELECT IS_USED_LOCK("'+lock+'")')=='NULL'
assert request('/api/v2/capabilities')[0]==200
status,snapshot=request('/api/v2/sync/snapshots',{})
assert status==201
assert request('/api/v2/sync/snapshots/'+snapshot['id'])[0]==200
assert sql('SELECT IS_USED_LOCK("'+lock+'")').isdecimal()
print(json.dumps({'idleTimeoutSeconds':2,'leaseExpiredConfirmed':True,'readWhileWriterExpired':200,'snapshotAfterIdleTimeout':201,'pageAfterIdleTimeout':200,'serverRestartNeededForRecovery':False},indent=2))
