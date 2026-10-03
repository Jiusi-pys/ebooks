param([Parameter(Mandatory)][string]$ReleaseDirectory,[Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($EvidenceDirectory)
if(Test-Path -LiteralPath $root){throw 'Evidence directory must be new'}
New-Item -ItemType Directory $root|Out-Null
$install=Join-Path $root 'installation'
& (Join-Path $ReleaseDirectory 'install.ps1') -Destination $install -NoShortcut
$data=Join-Path $root 'acceptance'
& "$env:WINDIR/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -File (Join-Path $install 'acceptance.ps1') -EvidenceDirectory $data
if($LASTEXITCODE -ne 0){throw 'Installed acceptance failed'}
$workspace=Join-Path $data 'workspace'
$hashes=Get-ChildItem -LiteralPath $workspace -Recurse -File|ForEach-Object{@{path=$_.FullName;hash=(Get-FileHash -LiteralPath $_.FullName).Hash}}
New-Item -ItemType Directory (Join-Path $install 'workspace')|Out-Null
$unmanaged=Join-Path $install 'workspace/user-note.txt'
'Preserve nested user data'|Set-Content -LiteralPath $unmanaged
$readme=Join-Path $install 'README.md'
'User modified documentation'|Add-Content -LiteralPath $readme
& (Join-Path $PSScriptRoot '../uninstall.ps1') -InstallationDirectory $install
if(Test-Path -LiteralPath (Join-Path $install 'Shufang.Windows.exe')){throw 'Executable still installed'}
foreach($file in $hashes){if((Get-FileHash -LiteralPath $file.path).Hash -ne $file.hash){throw 'Uninstall changed workspace data'}}
if(!(Test-Path -LiteralPath $unmanaged) -or !(Test-Path -LiteralPath $readme)){throw 'Uninstall removed unmanaged or modified files'}
@{ok=$true;gate='uninstall preserves independent workspace';files=$hashes.Count}|ConvertTo-Json|Set-Content (Join-Path $root 'uninstall-result.json')
Write-Output 'PASS uninstall removed installation and preserved every workspace file'
