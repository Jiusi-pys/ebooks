param(
  [Parameter(Mandatory)][string]$ReleaseZip,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$OldDirectory,
  [Parameter(Mandatory)][string]$OldVersion,
  [Parameter(Mandatory)][string]$WorkspaceSeed,
  [Parameter(Mandatory)][string]$EvidenceDirectory,
  [ValidateSet('success','failed-start')][string]$Scenario='success'
)
# PowerShell 7. Uses an ephemeral test key and isolated copies only. No shortcuts
# or startup registration. Run with no other Shufang desktop/service processes.
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($EvidenceDirectory)
if(Test-Path -LiteralPath $root){throw 'Evidence directory must be new'}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid release version'}
New-Item -ItemType Directory $root|Out-Null
$stage=Join-Path $root 'stage'
Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $stage
$staged=Join-Path $stage "Shufang-$Version-win-x64"
$helperPath=Join-Path $staged 'Updater/Shufang.Updater.exe'
$archive=Join-Path $stage 'download.zip'
$manifestPath=Join-Path $staged 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
if($Scenario -eq 'failed-start'){
  Copy-Item -LiteralPath (Join-Path $staged 'shufang-service.exe') -Destination (Join-Path $staged 'Shufang.Windows.exe') -Force
  ($manifest.files|Where-Object path -eq 'Shufang.Windows.exe').sha256=(Get-FileHash -LiteralPath (Join-Path $staged 'Shufang.Windows.exe')).Hash.ToLowerInvariant()
  $manifest|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
  Compress-Archive -LiteralPath $staged -DestinationPath $archive
}else{
  Copy-Item -LiteralPath $ReleaseZip -Destination $archive
  Add-Content -LiteralPath (Join-Path $staged 'Reader/reader.js') -Value 'tampered mutable stage'
  ($manifest.files|Where-Object path -eq 'Reader/reader.js').sha256=(Get-FileHash -LiteralPath (Join-Path $staged 'Reader/reader.js')).Hash.ToLowerInvariant()
  $manifest|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
}
$workspace=Join-Path $root 'workspace'
Copy-Item -LiteralPath $WorkspaceSeed -Destination $workspace -Recurse
$rsa=[Security.Cryptography.RSA]::Create(3072)
try{
  $public=$rsa.ExportSubjectPublicKeyInfoPem()
  $payload=[Text.Encoding]::UTF8.GetBytes((@{formatVersion=1;version=$Version;platform='win-x64';schemaVersion=(@($manifest.files | Where-Object { $_.path -match '^migrations/sqlite/[0-9]{4}\.sql$' }).Count);url='https://example.test/test.zip';size=(Get-Item -LiteralPath $archive).Length;sha256=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant();notes='Isolated test'}|ConvertTo-Json -Compress))
  $envelope=@{payload=[Convert]::ToBase64String($payload);signature=[Convert]::ToBase64String($rsa.SignData($payload,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1))}|ConvertTo-Json -Compress
}finally{$rsa.Dispose()}
$plan=@{ParentPid=999999;Workspace=$workspace;CurrentDirectory=[IO.Path]::GetFullPath($OldDirectory);CurrentVersion=$OldVersion;StagedDirectory=$staged;Envelope=$envelope;PublicKey=$public;InstallRoot=(Join-Path $root 'versions');UpdateShortcuts=$false}
$planPath=Join-Path $root 'plan.json'
$plan|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $planPath -Encoding utf8NoBOM
$helper=Start-Process -FilePath $helperPath -ArgumentList @('--apply',('"'+$planPath+'"')) -WindowStyle Hidden -PassThru
$helper.Id|Set-Content (Join-Path $root 'helper.pid')
Write-Output "Started isolated $Scenario helper PID $($helper.Id). Inspect workspace/.updates/update-result.json and ready-*.json; close only the GUI launched with this evidence workspace."
