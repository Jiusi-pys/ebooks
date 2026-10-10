"""Real Android JNI -> Rust HTTP -> iOS StudyStore/PencilKit -> Android -> iOS.
Only disposable server data and the acceptance APK are used. SSH credentials are
read from an environment variable and never included in evidence or arguments.
"""
import argparse,base64,hashlib,json,os,re,select,shutil,socket,subprocess,threading,time,uuid
from pathlib import Path
import paramiko,requests

p=argparse.ArgumentParser()
p.add_argument('--ssh-host',required=True);p.add_argument('--ssh-user',required=True)
p.add_argument('--mac-directory',required=True);p.add_argument('--serial',default='127.0.0.1:16416')
p.add_argument('--evidence',required=True);p.add_argument('--password-env',default='SHUFANG_SSH_PASSWORD')
a=p.parse_args();root=Path(__file__).resolve().parents[3];evidence=Path(a.evidence).resolve();evidence.mkdir(parents=True,exist_ok=True)
adb=Path(os.environ['LOCALAPPDATA'])/'Android/Sdk/platform-tools/adb.exe'
def run(args,log):
    with (evidence/log).open('wb') as out:result=subprocess.run([str(x) for x in args],stdout=out,stderr=subprocess.STDOUT,timeout=900)
    if result.returncode:raise RuntimeError('Command failed; inspect '+log)
    return (evidence/log).read_text(encoding='utf-8',errors='replace')
def instrument(step):
    method={'publish':'androidPublishesEditableInkThroughRealServer','receive':'androidReceivesIosEditingAndContinuesDrawing','restore':'androidRestoresIosZIPWithOriginalAndInk'}[step]
    result=run([adb,'-s',a.serial,'shell','am','instrument','-w','-e','crossInkStep',step,'-e','class','org.shufang.android.CrossInkNetworkTest#'+method,'org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner'],step+'-android.log')
    if 'OK (1 test)' not in result or 'FAILURES' in result:raise RuntimeError('Android '+step+' failed')
ssh=paramiko.SSHClient();ssh.load_system_host_keys();ssh.connect(a.ssh_host,username=a.ssh_user,password=os.environ[a.password_env],timeout=20)
transport=ssh.get_transport();transport.set_keepalive(20);stopping=threading.Event()
def forward(channel):
    try:
        with socket.create_connection(('127.0.0.1',31487),timeout=20) as local:
            while not stopping.is_set():
                readable,_,_=select.select([local,channel],[],[],1)
                for source in readable:
                    data=source.recv(65536)
                    if not data:return
                    (channel if source is local else local).sendall(data)
    finally:channel.close()
def accept():
    while not stopping.is_set():
        channel=transport.accept(1)
        if channel:threading.Thread(target=forward,args=(channel,),daemon=True).start()
def remote(command,log):
    _,out,err=ssh.exec_command(command,timeout=900)
    with (evidence/log).open('wb') as file:
        # Drain both streams concurrently to avoid SSH channel window deadlock.
        while not out.channel.exit_status_ready() or out.channel.recv_ready() or out.channel.recv_stderr_ready():
            if out.channel.recv_ready():file.write(out.channel.recv(65536))
            if out.channel.recv_stderr_ready():file.write(out.channel.recv_stderr(65536))
            time.sleep(.05)
    if out.channel.recv_exit_status():raise RuntimeError('Apple command failed; inspect '+log)
server_dir=root/'.tools'/('cross-ink-fixture-'+uuid.uuid4().hex);server_dir.mkdir();server_log=(evidence/'server.log').open('wb')
fixture_binary=server_dir/'fixture.exe';shutil.copy2(root/'base/target/debug/examples/android_fixture_server.exe',fixture_binary)
server=subprocess.Popen([str(fixture_binary),str(server_dir)],stdout=server_log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
simulator=None
web_server=None;web_log=None
try:
    for _ in range(100):
        if server.poll() is not None:raise RuntimeError('Isolated server exited; inspect server.log. Port may be occupied.')
        try:requests.get('http://127.0.0.1:31487/api/v2/capabilities',headers={'Authorization':'Bearer android-public-machine-token'},timeout=1).raise_for_status();break
        except requests.RequestException:time.sleep(.1)
    else:raise RuntimeError('Fixture startup timeout')
    session=requests.Session();session.headers['Origin']='http://127.0.0.1:31487'
    session.post('http://127.0.0.1:31487/api/auth/login',json={'appId':'bootstrap','appSecret':'bootstrap-secret'},timeout=10).raise_for_status()
    session.post('http://127.0.0.1:31487/api/auth/setup',json={'username':'ink-network-acceptance','newPassword':'public-ink-test-password-123','confirmPassword':'public-ink-test-password-123'},timeout=10).raise_for_status()
    run([adb,'-s',a.serial,'reverse','tcp:31487','tcp:31487'],'reverse.log')
    build=Path(os.environ['LOCALAPPDATA'])/'Shufang/android-build/app/outputs/apk'
    artifacts={name:hashlib.sha256((build/path).read_bytes()).hexdigest() for name,path in {'apkSha256':'debug/app-debug.apk','testApkSha256':'androidTest/debug/app-debug-androidTest.apk'}.items()}
    run([adb,'-s',a.serial,'install','-r',build/'debug/app-debug.apk'],'install-app.log')
    run([adb,'-s',a.serial,'install','-r',build/'androidTest/debug/app-debug-androidTest.apk'],'install-tests.log')
    instrument('publish')
    for name in ['cross-ink-network.json','cross-study.zip']:run([adb,'-s',a.serial,'pull','/sdcard/Android/data/org.shufang.android.acceptance/files/'+name,evidence/name],'pull-'+name+'.log')
    transport.request_port_forward('127.0.0.1',31487);threading.Thread(target=accept,daemon=True).start()
    # The caller supplies an existing isolated acceptance checkout, never a user repo.
    if not a.mac_directory.startswith('/Users/') or '/CodexAcceptance-' not in a.mac_directory:raise ValueError('An isolated CodexAcceptance checkout is required')
    mac=a.mac_directory.rstrip('/')+'/ios';sftp=ssh.open_sftp()
    for path in list((root/'ios/Shufang/Core').glob('*.swift'))+[root/'ios/ShufangTests/NetworkInkParityTests.swift',root/'ios/scripts/generate-network-ink-project.py']:
        sftp.put(str(path),mac+'/'+path.relative_to(root/'ios').as_posix())
    remote('cd '+mac+' && python3 scripts/generate-network-ink-project.py','apple-project.log')
    metadata=json.loads((evidence/'cross-ink-network.json').read_text(encoding='utf-8'));sftp.put(str(evidence/'cross-ink-network.json'),mac+'/.network-ink-harness/network-ink.json')
    sftp.put(str(evidence/'cross-study.zip'),mac+'/.network-ink-harness/cross-study.zip')
    simulator=sftp.open(mac+'/.parity-harness/simulator-id').read().decode().strip()
    if not uuid.UUID(simulator):raise ValueError('Invalid simulator ID')
    remote('xcrun simctl boot '+simulator+' >/dev/null 2>&1; xcrun simctl bootstatus '+simulator+' -b','apple-boot.log')
    def apple(step):remote('cd '+mac+' && xcodebuild -project .network-ink-harness/NetworkInk.xcodeproj -scheme NetworkInkParityTests -destination "platform=iOS Simulator,id='+simulator+'" -parallel-testing-enabled NO -derivedDataPath .network-ink-harness/DerivedData -resultBundlePath .network-ink-harness/'+step+'-'+uuid.uuid4().hex+'.xcresult test CODE_SIGNING_ALLOWED=NO',step+'-apple.log')
    apple('edit')
    encoded=re.search(r'IOS_STUDY_ZIP_BASE64=([A-Za-z0-9+/=]+)',(evidence/'edit-apple.log').read_text(encoding='utf-8'))
    if not encoded:raise RuntimeError('iOS archive output missing')
    (evidence/'ios-return-study.zip').write_bytes(base64.b64decode(encoded.group(1),validate=True))
    run([adb,'-s',a.serial,'push',evidence/'ios-return-study.zip','/sdcard/Android/data/org.shufang.android.acceptance/files/ios-return-study.zip'],'push-ios-zip.log')
    instrument('restore')
    # Run the actual Web sync/storage modules in a real, disposable Chromium
    # context, including its native IndexedDB and embedded shared WASM core.
    from playwright.sync_api import sync_playwright
    web_log=(evidence/'web-server.log').open('wb')
    web_server=subprocess.Popen(['node',str(root/'platforms/android/scripts/web-network-server.mjs')],stdout=web_log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    for _ in range(100):
        if web_server.poll() is not None:raise RuntimeError('Browser server exited; inspect web-server.log')
        try:requests.get('http://127.0.0.1:31234/acceptance',timeout=1).raise_for_status();break
        except requests.RequestException:time.sleep(.1)
    else:raise RuntimeError('Browser server startup timeout')
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',headless=True)
        context=browser.new_context()
        context.add_cookies([{'name':cookie.name,'value':cookie.value,'domain':'127.0.0.1','path':'/','httpOnly':True,'secure':False} for cookie in session.cookies])
        # Serve test modules at the fixture's real origin. API requests pass
        # straight through, keeping production CSRF and session checks intact.
        def module_route(route):
            if '/api/' in route.request.url:route.continue_()
            else:route.fulfill(response=route.fetch(url=route.request.url.replace('127.0.0.1:31487','127.0.0.1:31234',1)))
        context.route('http://127.0.0.1:31487/**',module_route)
        page=context.new_page();page.goto('http://127.0.0.1:31487/acceptance')
        business=page.evaluate('''async () => {
            const sync=await import('/src/lib/workspaceSync.ts'), db=await import('/src/lib/db.ts');
            await sync.trySyncWorkspace();
            const notes=await db.getAllNotes();
            if(!notes.some(n=>n.title==='iOS network business acceptance'))throw Error('iOS note missing in Web');
            if(!notes.some(n=>n.pdfPortableInk&&n.pdfDrawing))throw Error('Editable ink attachments missing in Web');
            const id=crypto.randomUUID(), deletedId=crypto.randomUUID(), now=Date.now();
            await db.putNote({id,title:'Web network business acceptance',content:'initial',createdAt:now,updatedAt:now});
            await sync.trySyncWorkspace();
            await db.putNote({id,title:'Web network business acceptance',content:'真实浏览器修改😀',createdAt:now,updatedAt:now+1});
            await db.putNote({id:deletedId,title:'Disposable deleted Web note',content:'delete',createdAt:now,updatedAt:now});
            await sync.trySyncWorkspace();await db.deleteNote(deletedId);await sync.trySyncWorkspace();
            return {webNoteId:id,webDeletedNoteId:deletedId,receivedIosBusiness:true,receivedInkReferences:true,nativeIndexedDB:true};
        }''')
        business['browserVersion']=browser.version
        (evidence/'web-business.json').write_text(json.dumps(business,indent=2),encoding='utf-8')
        metadata.update(business);(evidence/'cross-ink-network.json').write_text(json.dumps(metadata),encoding='utf-8')
        browser.close()
    run([adb,'-s',a.serial,'push',evidence/'cross-ink-network.json','/sdcard/Android/data/org.shufang.android.acceptance/files/cross-ink-network.json'],'push-web-metadata.log')
    instrument('receive')
    metadata['verifyOnly']=True;(evidence/'network-ink-verify.json').write_text(json.dumps(metadata),encoding='utf-8');sftp.put(str(evidence/'network-ink-verify.json'),mac+'/.network-ink-harness/network-ink.json')
    apple('verify')
    # Exercise the Web REST business contract using the same isolated account.
    notes=session.get('http://127.0.0.1:31487/fixture/notes',timeout=10);notes.raise_for_status()
    values=notes.json();assert any(row['value'].get('title')=='iOS network business acceptance' for row in values)
    (evidence/'server-notes.json').write_text(json.dumps(values,ensure_ascii=False,indent=2),encoding='utf-8')
    source_inputs=[root/'platforms/android/app/src/main/java/org/shufang/android/LibraryViewModel.kt',root/'platforms/android/app/src/main/java/org/shufang/android/PdfComparison.kt',root/'platforms/android/app/src/main/java/org/shufang/android/MainActivity.kt',root/'platforms/android/web/reader.ts',root/'platforms/android/web/index.html',root/'platforms/android/scripts/build-reader.mjs',root/'base/crates/application/src/library.rs',root/'base/crates/native/src/backup.rs',root/'base/crates/native/src/study_backup.rs',root/'base/crates/native/src/replication.rs',root/'app/src/lib/workspaceSync.ts',root/'app/src/lib/db.ts',root/'app/generated/core-bytes.ts']+list((root/'ios/Shufang/Core').glob('*.swift'))
    source_inputs += [root/path for path in ['base/crates/application/src/offline_conflicts.rs','base/crates/application/src/offline_copy.rs','base/crates/native/src/offline_sync.rs','base/crates/sqlite/src/lib.rs','platforms/android/app/src/main/java/org/shufang/android/SyncConflictPanel.kt','platforms/android/app/src/main/java/org/shufang/android/CoreRepository.kt','platforms/android/app/src/main/java/org/shufang/android/DocumentWebView.kt']]
    sources={str(path.relative_to(root)).replace('\\','/'):hashlib.sha256(path.read_bytes()).hexdigest() for path in source_inputs}
    (evidence/'results.json').write_text(json.dumps({**artifacts,'sourceFiles':sources,'androidPublish':True,'iosStudyStorePencilKitEdit':True,'androidContinueEditing':True,'iosFinalEditableStrokes':3,'reviewEvents':2,'studyZIPAndroidIosAndroid':True,'webBrowserBusinessCRUD':True,'isolatedServer':True,'webUIVerified':False},indent=2),encoding='utf-8')
    print('CROSS_INK_NETWORK_PASSED')
finally:
    if web_server:
        web_server.terminate();web_server.wait(timeout=20)
    if web_log:web_log.close()
    stopping.set()
    try:transport.cancel_port_forward('127.0.0.1',31487)
    except Exception:pass
    if simulator:
        try:ssh.exec_command('xcrun simctl shutdown '+simulator)[1].channel.recv_exit_status()
        except Exception:pass
    ssh.close();subprocess.run([str(adb),'-s',a.serial,'reverse','--remove','tcp:31487'],capture_output=True)
    server.terminate();server.wait(timeout=20);server_log.close()
