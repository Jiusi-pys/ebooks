param([switch]$SkipNative, [string]$JavaHome = 'C:\Program Files\Android\Android Studio\jbr', [string]$AndroidSdk = "$env:LOCALAPPDATA\Android\Sdk")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$env:JAVA_HOME=$JavaHome
$env:ANDROID_HOME=$AndroidSdk
if (!$SkipNative) { & "$PSScriptRoot/build-native.ps1"; & "$PSScriptRoot/build-llm.ps1" }
& npm --prefix "$repo/platforms/android/web" ci --ignore-scripts
if ($LASTEXITCODE) {throw "Reader dependencies failed"}
& node "$PSScriptRoot/build-reader.mjs"
if ($LASTEXITCODE) { throw 'Reader asset build failed' }
Push-Location "$repo/platforms/android"
try {
    & ./gradlew.bat --no-daemon testDebugUnitTest lintDebug assembleDebug
    if ($LASTEXITCODE) { throw 'Android checks failed' }
    $buildRoot=if($env:SHUFANG_ANDROID_BUILD_DIR){$env:SHUFANG_ANDROID_BUILD_DIR}else{"$env:LOCALAPPDATA/Shufang/android-build"}
    New-Item -ItemType Directory -Force app/build/outputs/apk/debug | Out-Null
    Copy-Item -LiteralPath "$buildRoot/app/outputs/apk/debug/app-debug.apk" -Destination app/build/outputs/apk/debug/app-debug.apk
    & "$PSScriptRoot/verify-apk.ps1" -AndroidSdk $AndroidSdk
    if ($LASTEXITCODE) { throw 'APK verification failed' }
    & python "$PSScriptRoot/write-receipt.py"
    if ($LASTEXITCODE) { throw 'Build receipt failed' }
} finally { Pop-Location }
