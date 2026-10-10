param([string]$AndroidSdk="$env:LOCALAPPDATA/Android/Sdk")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$lock=Get-Content "$repo/platforms/android/llama.lock.json" | ConvertFrom-Json
$source="$repo/.tools/llama-android-source"
if(!(Test-Path "$source/.git")){& git clone --no-checkout $lock.repository $source;if($LASTEXITCODE){throw 'Model runtime source download failed'}}
& git -C $source fetch origin $lock.commit --depth 1
if($LASTEXITCODE){throw 'Pinned model runtime unavailable'}
& git -C $source checkout --detach $lock.commit
if($LASTEXITCODE){throw 'Cannot select pinned runtime'}
$ndk="$AndroidSdk/ndk/28.2.13676358"
if(!(Test-Path "$ndk/build/cmake/android.toolchain.cmake")){$ndk=(Resolve-Path "$repo/.tools/android-downloads/android-ndk-r28c").Path.Replace("\","/")}
$ninja="$env:USERPROFILE/scoop/apps/ninja/current/ninja.exe"
foreach($abi in @('x86_64','arm64-v8a')){
    $build="$env:LOCALAPPDATA/Shufang/llm-$abi"
    & cmake -S "$repo/platforms/android/llm" -B $build -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" "-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake" "-DANDROID_ABI=$abi" -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_static -DCMAKE_BUILD_TYPE=Release "-DLLAMA_SOURCE=$source"
    if($LASTEXITCODE){throw "Model runtime configure failed: $abi"}
    & cmake --build $build --target shufang_llm -j 4
    if($LASTEXITCODE){throw "Model runtime build failed: $abi"}
    $destination="$repo/platforms/android/app/src/main/jniLibs/$abi"
    New-Item -ItemType Directory -Force $destination | Out-Null
    Copy-Item -LiteralPath "$build/libshufang_llm.so" -Destination "$destination/libshufang_llm.so"
    & "$ndk/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe" --strip-unneeded "$destination/libshufang_llm.so"
    if($LASTEXITCODE){throw "Model runtime stripping failed: $abi"}
}
