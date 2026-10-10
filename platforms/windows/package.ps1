param([string]$Dotnet = 'dotnet', [string]$Cargo = 'cargo', [string]$Version = '0.3.3', [string]$SigningKey, [string]$PackageUrl)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$') { throw 'Invalid version' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = Join-Path $repository ".tools/releases/Shufang-$Version-win-x64"
if (Test-Path -LiteralPath $output) { throw 'Release output already exists; choose a fresh version' }
& (Join-Path $PSScriptRoot 'native/build.ps1')
& $Cargo build --manifest-path (Join-Path $repository 'base/Cargo.toml') -p shufang-bindings -p shufang-service --release --locked
if ($LASTEXITCODE -ne 0) { throw 'Rust release failed' }
& $Dotnet publish (Join-Path $PSScriptRoot 'Shufang.Windows/Shufang.Windows.csproj') -c Release -p:Platform=x64 "-p:Version=$Version" --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw 'WinUI publish failed' }
& $Dotnet publish (Join-Path $PSScriptRoot 'Updater/Updater.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $output 'Updater')
if ($LASTEXITCODE -ne 0) { throw 'Updater publish failed' }
Copy-Item -LiteralPath (Join-Path $repository 'base/target/release/shufang_bindings.dll') -Destination (Join-Path $output 'Updater')
$migrationRoot=Join-Path $output 'migrations'
New-Item -ItemType Directory -Force $migrationRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'base/crates/sqlite/migrations') -Destination (Join-Path $migrationRoot 'sqlite') -Recurse
Copy-Item -LiteralPath (Join-Path $repository 'app/db/migration-history') -Destination (Join-Path $migrationRoot 'history') -Recurse
Copy-Item -LiteralPath (Join-Path $repository 'base/Cargo.lock') -Destination (Join-Path $output 'Cargo.lock')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'acceptance.ps1') -Destination $output
$documents = Join-Path $output 'docs'
New-Item -ItemType Directory -Force $documents | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'docs/windows-delivery.md'),(Join-Path $repository 'docs/native-core-migration.md'),(Join-Path $repository 'docs/windows-completion-plan.md'),(Join-Path $repository 'docs/windows-completion-acceptance-20261003.md') -Destination $documents
Copy-Item -LiteralPath (Join-Path $repository 'docs/windows-final-acceptance-plan.md'),(Join-Path $repository 'docs/windows-final-acceptance-20261003.md') -Destination $documents
Copy-Item -LiteralPath (Join-Path $repository 'docs/evidence') -Destination $documents -Recurse
# Preserve the exact native source behind this uncommitted development build.
# Only allowlisted source roots are archived, never workspaces, secrets or build output.
$sources = git -C $repository ls-files --cached --others --exclude-standard -- base platforms/windows app docs .github/workflows/native-core.yml .gitattributes
$sources = $sources | Where-Object { $_ -notmatch '(^|/)(target|bin|obj|node_modules|dist|uploads)/' -and $_ -notmatch '(^|/)\.env($|\.(?!example$))' -and $_ -notmatch '\.(pfx|p12|pem|key)$' }
$sourceList = Join-Path $repository '.tools/release-source-list.txt'
$sources | Set-Content -LiteralPath $sourceList -Encoding utf8NoBOM
tar -czf (Join-Path $output 'native-source.tar.gz') -C $repository -T $sourceList
if ($LASTEXITCODE -ne 0) { throw 'Native source archive failed' }
$files=Get-ChildItem -LiteralPath $output -Recurse -File | ForEach-Object { @{path=[IO.Path]::GetRelativePath($output,$_.FullName).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()} }
@{version=$Version;schemaVersion=3;sourceCommit=(git -C $repository rev-parse HEAD);workingTree=(git -C $repository status --porcelain);files=$files} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output 'release-manifest.json')
Compress-Archive -LiteralPath $output -DestinationPath "$output.zip"
if ($SigningKey) {
  if (!$PackageUrl) { throw 'Signed feed requires PackageUrl' }
  & $Dotnet run --project (Join-Path $PSScriptRoot 'UpdatePublisher/UpdatePublisher.csproj') -- $Version $PackageUrl "$output.zip" $SigningKey "$output.feed.json"
  if ($LASTEXITCODE -ne 0) { throw 'Signed feed creation failed' }
}
Get-FileHash -LiteralPath "$output.zip" | Format-List
Write-Output "Release available at $output"
