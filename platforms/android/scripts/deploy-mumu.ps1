param([int]$VmIndex=1)
$ErrorActionPreference='Stop'
$manager='C:\Program Files\Netease\MuMu\nx_main\MuMuManager.exe'
$adb="$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$state=(& $manager info -v $VmIndex | Out-String | ConvertFrom-Json)
if (!$state.is_android_started) {
    & $manager control -v $VmIndex launch
}
for($attempt=0;$attempt -lt 120;$attempt++) {
    $state=(& $manager info -v $VmIndex | Out-String | ConvertFrom-Json)
    if($state.is_android_started -and $state.adb_port){break}
    Start-Sleep -Milliseconds 500
}
if(!$state.is_android_started){throw 'MuMu startup timed out'}
if (!$state.adb_port) { throw 'MuMu has no ADB endpoint' }
$serial="$($state.adb_host_ip):$($state.adb_port)"
& $adb connect $serial
& $adb -s $serial install -r "$PSScriptRoot/../app/build/outputs/apk/debug/app-debug.apk"
if ($LASTEXITCODE) { throw 'APK install failed' }
& $adb -s $serial shell am start -n org.shufang.android/.MainActivity
