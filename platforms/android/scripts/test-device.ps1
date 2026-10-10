param([string]$Serial='127.0.0.1:16416',[string]$AndroidSdk="$env:LOCALAPPDATA\Android\Sdk",[string]$JavaHome='C:\Program Files\Android\Android Studio\jbr',[string]$TestClass='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH";$env:JAVA_HOME=$JavaHome;$env:ANDROID_HOME=$AndroidSdk
$adb="$AndroidSdk/platform-tools/adb.exe"
& $adb connect $Serial | Out-Null
$readyDevice=$false
for($attempt=0;$attempt -lt 120;$attempt++) {
    $taskOldPreference=$ErrorActionPreference
    try {$ErrorActionPreference='Continue';$package=(& $adb -s $Serial shell pm path android 2>$null | Out-String)} finally {$ErrorActionPreference=$taskOldPreference}
    if($package -match 'package:'){$readyDevice=$true;break}
    Start-Sleep -Milliseconds 500
}
if(!$readyDevice){throw 'Android package service is not ready; start/recover the emulator first'}
& node "$PSScriptRoot/build-reader.mjs"
if($LASTEXITCODE){throw 'Reader assets failed'}
& cargo build --manifest-path "$repo/base/Cargo.toml" --locked -p shufang-service --example android_fixture_server
if($LASTEXITCODE){throw 'Fixture server build failed'}
$root="$repo/.tools/android-fixture-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force $root | Out-Null
$process=Start-Process -FilePath "$repo/base/target/debug/examples/android_fixture_server.exe" -ArgumentList $root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$root/server.log" -RedirectStandardError "$root/server-error.log"
try {
    $ready=$false
    for($attempt=0;$attempt -lt 50;$attempt++) {
        if($process.HasExited){throw "Fixture exited; inspect $root/server-error.log"}
        $client=[System.Net.Sockets.TcpClient]::new()
        try {$client.Connect('127.0.0.1',31487);$ready=$true;break}catch {Start-Sleep -Milliseconds 100}finally {$client.Dispose()}
    }
    if(!$ready){throw 'Fixture startup timed out'}
    & $adb -s $Serial reverse tcp:31487 tcp:31487
    if($LASTEXITCODE){throw 'ADB reverse failed'}
    & "$repo/platforms/android/gradlew.bat" -p "$repo/platforms/android" --no-daemon assembleDebug assembleDebugAndroidTest -PshufangAcceptance=true
    if($LASTEXITCODE){throw 'Test APK build failed'}
    $buildRoot=if($env:SHUFANG_ANDROID_BUILD_DIR){$env:SHUFANG_ANDROID_BUILD_DIR}else{"$env:LOCALAPPDATA/Shufang/android-build"}
    & $adb -s $Serial install -r "$buildRoot/app/outputs/apk/debug/app-debug.apk"
    if($LASTEXITCODE){throw 'App install failed'}
    & $adb -s $Serial install -r "$buildRoot/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
    if($LASTEXITCODE){throw 'Test install failed'}
    $selection=@();if($TestClass){if($TestClass -notmatch '^org\.shufang\.android\.[A-Za-z0-9_]+(#[A-Za-z0-9_]+)?$'){throw 'Invalid test selection'};$selection=@('-e','class',$TestClass)}
    $result=(& $adb -s $Serial shell am instrument -w @selection org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner | Out-String)
    $result | Set-Content -Encoding utf8 "$root/device-results.log"
    Write-Output $result
    if($result -notmatch 'OK \(\d+ tests\)' -or $result -match 'FAILURES|INSTRUMENTATION_FAILED'){throw 'Device acceptance failed'}
    Write-Output "Acceptance evidence: $root"
}finally {
    if(!$process.HasExited){Stop-Process -Id $process.Id}
    & $adb -s $Serial reverse --remove tcp:31487
}
