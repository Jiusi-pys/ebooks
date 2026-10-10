param([string]$Apk="$PSScriptRoot/../app/build/outputs/apk/debug/app-debug.apk",[string]$AndroidSdk="$env:LOCALAPPDATA/Android/Sdk",[string]$Ndk="$PSScriptRoot/../../../.tools/android-downloads/android-ndk-r28c")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$apkPath=(Resolve-Path -LiteralPath $Apk).Path
$directory="$repo/.tools/android-apk-check-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force $directory | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead($apkPath)
$abis=[System.Collections.Generic.HashSet[string]]::new()
try {
    foreach($entry in $archive.Entries) {
        if($entry.FullName -notlike 'lib/*.so'){continue}
        if($entry.FullName -notmatch '^lib/(arm64-v8a|x86_64)/([A-Za-z0-9_.-]+\.so)$'){throw "Unexpected native library: $($entry.FullName)"}
        $abi=$Matches[1];$name=$Matches[2];$null=$abis.Add($abi)
        $target=Join-Path $directory "$abi-$name"
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target)
        $headers=(& "$Ndk/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe" --program-headers --wide $target | Out-String)
        if($LASTEXITCODE){throw "ELF check failed: $name"}
        $loads=@($headers -split "`n" | Where-Object {$_ -match '^\s*LOAD\s'})
        if(!$loads.Count){throw "Missing ELF LOAD headers: $name"}
        foreach($line in $loads) {
            $alignment=($line.Trim() -split '\s+')[-1]
            if([Convert]::ToInt64($alignment.Substring(2),16) -lt 16384){throw "16 KiB ELF alignment failed: $abi/$name $alignment"}
        }
        Write-Output "16 KiB ELF: $abi/$name"
    }
}finally {$archive.Dispose()}
if($abis.Count -ne 2){throw 'Both arm64-v8a and x86_64 must be packaged'}
& "$AndroidSdk/build-tools/36.0.0/zipalign.exe" -c -P 16 4 $apkPath
if($LASTEXITCODE){throw 'APK 16 KiB ZIP alignment failed'}
& "$AndroidSdk/build-tools/36.0.0/apksigner.bat" verify $apkPath
if($LASTEXITCODE){throw 'APK signature verification failed'}
Get-FileHash -LiteralPath $apkPath -Algorithm SHA256
