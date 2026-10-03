$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$nativeRoot = Join-Path $repository '.tools/native'
New-Item -ItemType Directory -Force $nativeRoot | Out-Null
$pdfArchive = Join-Path $nativeRoot 'pdfium.tgz'
$pdfHash = '808d36da9bc5a3104315fb307c80998121f565ee53953633bf33e80d7429e5ac'
if (!(Test-Path -LiteralPath $pdfArchive)) {
  Invoke-WebRequest 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8076/pdfium-win-x64.tgz' -OutFile $pdfArchive
}
if ((Get-FileHash -LiteralPath $pdfArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pdfHash) { throw 'PDFium archive checksum mismatch' }
$pdfRoot = Join-Path $nativeRoot 'pdfium'
New-Item -ItemType Directory -Force $pdfRoot | Out-Null
tar -xzf $pdfArchive -C $pdfRoot
if ($LASTEXITCODE -ne 0) { throw 'PDFium extraction failed' }
$mobiSource = Join-Path $nativeRoot 'libmobi'
if (!(Test-Path -LiteralPath $mobiSource)) {
  git clone --depth 1 --branch v0.12 https://github.com/bfabiszewski/libmobi.git $mobiSource
  if ($LASTEXITCODE -ne 0) { throw 'libmobi fetch failed' }
}
$mobiCommit = git -C $mobiSource rev-parse HEAD
if ($mobiCommit -ne '85dcfe803fc2a21020ddcf15c3eb66b93d388add') { throw 'libmobi source identity mismatch' }
if (git -C $mobiSource status --porcelain) { throw 'libmobi source has local changes' }
cmake -S $PSScriptRoot -B (Join-Path $nativeRoot 'build') -G 'Visual Studio 17 2022' -A x64 "-DLIBMOBI_SOURCE=$mobiSource"
if ($LASTEXITCODE -ne 0) { throw 'Native dependency configuration failed' }
cmake --build (Join-Path $nativeRoot 'build') --config Release --target mobitool
if ($LASTEXITCODE -ne 0) { throw 'Native dependency build failed' }
$output = Join-Path $nativeRoot 'dist'
New-Item -ItemType Directory -Force $output | Out-Null
Copy-Item -LiteralPath (Join-Path $pdfRoot 'bin/pdfium.dll') -Destination $output
Copy-Item -LiteralPath (Join-Path $nativeRoot 'build/mobi/src/Release/mobi.dll') -Destination $output
Copy-Item -LiteralPath (Join-Path $nativeRoot 'build/mobi/tools/Release/mobitool.exe') -Destination $output
Copy-Item -LiteralPath (Join-Path $mobiSource 'COPYING') -Destination (Join-Path $output 'libmobi-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $pdfRoot 'LICENSE') -Destination (Join-Path $output 'pdfium-LICENSE.txt')
$licenses = Join-Path $output 'pdfium-licenses'
New-Item -ItemType Directory -Force $licenses | Out-Null
Get-ChildItem -LiteralPath (Join-Path $pdfRoot 'licenses') | Copy-Item -Destination $licenses -Recurse -Force
$mobiArchive = Join-Path $output 'libmobi-v0.12-source.tar.gz'
git -C $mobiSource archive --format=tar.gz "--output=$mobiArchive" HEAD
if ($LASTEXITCODE -ne 0) { throw 'libmobi source archive failed' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CMakeLists.txt') -Destination (Join-Path $output 'libmobi-build-CMakeLists.txt')
Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'sha256.json' | ForEach-Object { [PSCustomObject]@{ name=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() } } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output 'sha256.json')
Write-Output "Native dependencies available at $output"
