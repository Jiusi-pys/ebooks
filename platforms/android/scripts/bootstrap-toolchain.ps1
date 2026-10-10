param([string]$AndroidSdk="$env:LOCALAPPDATA\Android\Sdk")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$cache="$repo/.tools/android-downloads"
New-Item -ItemType Directory -Force $cache | Out-Null
if(!(Test-Path -LiteralPath "$AndroidSdk/build-tools/36.0.0") -or !(Test-Path -LiteralPath "$AndroidSdk/platform-tools/adb.exe") -or (!(Test-Path -LiteralPath "$AndroidSdk/platforms/android-37/android.jar") -and !(Test-Path -LiteralPath "$AndroidSdk/platforms/android-37.0/android.jar"))) {throw 'Install Android SDK platform 37, build-tools 36.0.0 and platform-tools through Android Studio SDK Manager first.'}
$archive="$cache/android-ndk-r28c-windows.zip"
$ndk="$cache/android-ndk-r28c"
if(!(Test-Path -LiteralPath "$ndk/source.properties")) {
    if(!(Test-Path -LiteralPath $archive)) {Invoke-WebRequest 'https://dl.google.com/android/repository/android-ndk-r28c-windows.zip' -OutFile $archive}
    if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne '6BEC98AC2354D8A919760889A1A41D020132E5E8CFA1B1FE51610A72C36A466B'){throw 'NDK checksum mismatch'}
    Expand-Archive -LiteralPath $archive -DestinationPath $cache
}
if((Get-Content -LiteralPath "$ndk/source.properties" | Out-String) -notmatch '28\.2\.13676358'){throw 'Unexpected NDK version'}
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
& rustup target add aarch64-linux-android x86_64-linux-android
if($LASTEXITCODE){throw 'Rust Android target install failed'}
Write-Output "NDK ready: $ndk"
