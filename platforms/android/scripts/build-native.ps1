param([string]$Ndk = "$PSScriptRoot/../../../.tools/android-downloads/android-ndk-r28c", [string[]]$Abis = @('x86_64','arm64-v8a'))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../../..").Path
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:CARGO_BUILD_JOBS = '2'
$toolchain = (Resolve-Path "$Ndk/toolchains/llvm/prebuilt/windows-x86_64/bin").Path
foreach ($abi in $Abis) {
    $target = if ($abi -eq 'arm64-v8a') { 'aarch64-linux-android' } elseif ($abi -eq 'x86_64') { 'x86_64-linux-android' } else { throw "Unsupported ABI: $abi" }
    $linker = "$toolchain/$($target)26-clang.cmd"
    $cxx = "$toolchain/$($target)26-clang++.cmd"
    $suffix = $target.Replace('-','_')
    [Environment]::SetEnvironmentVariable("CARGO_TARGET_$($suffix.ToUpper())_LINKER", $linker, 'Process')
    [Environment]::SetEnvironmentVariable("CC_$suffix", $linker, 'Process')
    [Environment]::SetEnvironmentVariable("CXX_$suffix", $cxx, 'Process')
    [Environment]::SetEnvironmentVariable("AR_$suffix", "$toolchain/llvm-ar.exe", 'Process')
    [Environment]::SetEnvironmentVariable("CARGO_TARGET_$($suffix.ToUpper())_RUSTFLAGS", '-C link-arg=-Wl,-z,max-page-size=16384', 'Process')
    & cargo build --manifest-path "$repo/base/Cargo.toml" --locked --release --target $target -p shufang-bindings
    if ($LASTEXITCODE) { throw "Rust build failed: $abi" }
    $output = "$repo/platforms/android/app/src/main/jniLibs/$abi"
    New-Item -ItemType Directory -Force $output | Out-Null
    Copy-Item -LiteralPath "$repo/base/target/$target/release/libshufang_bindings.so" -Destination $output
    & $cxx -shared -fPIC -O2 -static-libstdc++ '-Wl,-z,max-page-size=16384' '-Wl,-soname,libshufang_jni.so' '-Wl,-rpath,$ORIGIN' "$repo/platforms/android/app/src/main/cpp/bridge.cpp" "-I$repo/base/crates/bindings/include" "-L$output" -lshufang_bindings -o "$output/libshufang_jni.so"
    if ($LASTEXITCODE) { throw "JNI build failed: $abi" }
    & "$toolchain/llvm-strip.exe" --strip-unneeded "$output/libshufang_bindings.so" "$output/libshufang_jni.so"
    if ($LASTEXITCODE) { throw "Native symbol stripping failed: $abi" }
    & "$toolchain/llvm-readelf.exe" -l "$output/libshufang_bindings.so"
    & "$toolchain/llvm-readelf.exe" -l "$output/libshufang_jni.so"
}
