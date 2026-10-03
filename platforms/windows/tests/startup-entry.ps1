param([Parameter(Mandatory)][string]$ReleaseDirectory,[Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$entryEvidence=[IO.Path]::GetFullPath($EvidenceDirectory)
# First establishes a fresh isolated workspace/token and stops its service.
. (Join-Path $PSScriptRoot '../acceptance.ps1') -ReleaseDirectory $ReleaseDirectory -EvidenceDirectory $entryEvidence
$entry=Start-Process -FilePath (Join-Path $release 'Shufang.Windows.exe') -ArgumentList @('--service-start','--workspace',('"'+$workspace+'"'),'--port',$port) -WindowStyle Hidden -PassThru
$entryHandle=$entry.Handle
try{
  if(!$entry.WaitForExit(30000) -or $entry.ExitCode -ne 0){throw 'Headless entry failed'}
  $status=Invoke-RestMethod "$origin/admin/status" -Headers $headers -TimeoutSec 3
  if(!$status.ok){throw 'Headless entry did not leave independent service running'}
  $owner=Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -eq (Join-Path $release 'shufang-service.exe') -and $_.CommandLine.Contains($workspace)}
  if(@($owner).Count -ne 1){throw 'Cannot uniquely identify test service'}
  $ownedProcess=Get-Process -Id $owner.ProcessId
  $ownedHandle=$ownedProcess.Handle
  Invoke-RestMethod "$origin/admin/stop" -Method Post -Headers $headers|Out-Null
  if(!$ownedProcess.WaitForExit(10000)){throw 'Headless service failed to stop'}
  @{ok=$true;gate='headless startup command and independent lifetime';actualLoginOrReboot=$false}|ConvertTo-Json|Set-Content (Join-Path $entryEvidence 'startup-entry.json')
  Write-Output 'PASS headless startup entry; actual login/reboot remains a separate environment gate'
}finally{
  try{Invoke-RestMethod "$origin/admin/stop" -Method Post -Headers $headers -TimeoutSec 2|Out-Null}catch{}
  if(!$entry.HasExited){Stop-Process -Id $entry.Id}
}
