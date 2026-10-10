param([string]$ReleaseDirectory=$PSScriptRoot,[string]$EvidenceDirectory,[switch]$CleanHostAttested)
$ErrorActionPreference='Stop'
if (![Environment]::Is64BitProcess) { throw 'Run 64-bit PowerShell.' }
$release=[IO.Path]::GetFullPath($ReleaseDirectory)
if (!$EvidenceDirectory) { $EvidenceDirectory=Join-Path $env:TEMP ('Shufang-acceptance-'+[Guid]::NewGuid().ToString('N')) }
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $evidence) { throw 'Evidence directory must be new; existing data is preserved.' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$manifest=Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json
foreach($file in $manifest.files) {
  $path=[IO.Path]::GetFullPath((Join-Path $release $file.path))
  if (!$path.StartsWith($release+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped release.' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "File hash mismatch: $($file.path)" }
}
# This bridge needs neither a development SDK nor Python, Node or MySQL.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class AcceptanceCore {
 [DllImport("kernel32",CharSet=CharSet.Unicode)] public static extern bool SetDllDirectory(string path);
 [DllImport("shufang_bindings",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr core_alloc(UIntPtr n);
 [DllImport("shufang_bindings",CallingConvention=CallingConvention.Cdecl)] static extern UIntPtr core_buffer_len(IntPtr p);
 [DllImport("shufang_bindings",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr core_execute(IntPtr p);
 [DllImport("shufang_bindings",CallingConvention=CallingConvention.Cdecl)] static extern void core_free(IntPtr p);
 public static string Execute(string json) { byte[] b=Encoding.UTF8.GetBytes(json); IntPtr p=core_alloc((UIntPtr)b.Length),r=IntPtr.Zero; try {Marshal.Copy(b,0,p,b.Length);r=core_execute(p);byte[] output=new byte[(int)core_buffer_len(r).ToUInt64()];Marshal.Copy(r,output,0,output.Length);return Encoding.UTF8.GetString(output);} finally{core_free(p);if(r!=IntPtr.Zero)core_free(r);} }
}
'@
[AcceptanceCore]::SetDllDirectory($release) | Out-Null
function Core($command,$fields) {
  $fields['version']=1;$fields['command']=$command
  $result=[AcceptanceCore]::Execute(($fields | ConvertTo-Json -Depth 30 -Compress)) | ConvertFrom-Json
  if (!$result.ok) { throw "Core error: $($result.error.code)" };return $result.value
}
function Assert($condition,$message) { if(!$condition){throw $message} }
$workspace=Join-Path $evidence 'workspace';New-Item -ItemType Directory -Path $workspace | Out-Null
$database=Join-Path $workspace 'library.sqlite3';$session=$null;$service=$null
$gates=@()
try {
  $session=(Core 'sessionOpen' @{path=$database;workspace='local-preview';replica='windows-preview'}).session
  $token=(Core 'sessionCommand' @{session=$session;action='serviceToken'}).token
  $saved=Core 'sessionCommand' @{session=$session;action='save';args=@{kind='notes';id='acceptance';expected=0;patch=@{title='Acceptance';content='Shared core survives reopen'}}}
  Assert ($saved.revision -eq 1) 'Initial revision failed'
  Core 'sessionClose' @{session=$session} | Out-Null;$session=$null
  $session=(Core 'sessionOpen' @{path=$database;workspace='local-preview';replica='windows-preview'}).session
  $note=Core 'sessionCommand' @{session=$session;action='get';args=@{kind='notes';id='acceptance'}}
  Assert ($note.value.content -eq 'Shared core survives reopen') 'Reopen lost data'
  $gates+='native-core/reopen'
  $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
  $service=Start-Process -FilePath (Join-Path $release 'shufang-service.exe') -ArgumentList @('--workspace',('"'+$workspace+'"'),'--port',$port) -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $evidence 'service.stderr.log') -RedirectStandardOutput (Join-Path $evidence 'service.stdout.log')
  # Windows PowerShell 5.1 must retain the process handle before exit; otherwise
  # a Start-Process object can report a null ExitCode after WaitForExit.
  $serviceHandle=$service.Handle
  $headers=@{'X-API-Key'=$token};$origin="http://127.0.0.1:$port";$ready=$false
  for($attempt=0;$attempt -lt 60;$attempt++) { try { $status=Invoke-RestMethod "$origin/admin/status" -Headers $headers -TimeoutSec 2; if($status.ok){$ready=$true;break} }catch{}; if($service.HasExited){throw 'Service exited during startup'};Start-Sleep -Milliseconds 200 }
  Assert $ready 'Service startup timeout'
  $wire=Invoke-RestMethod "$origin/api/v1/notes/acceptance" -Headers $headers
  Assert ($wire.content -eq $note.value.content) 'REST and desktop core disagree'
  Invoke-RestMethod "$origin/api/v1/notes" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"extId":"service","title":"Service","content":"Independent process"}' | Out-Null
  $rows=Core 'sessionCommand' @{session=$session;action='list';args=@{kind='notes'}}
  Assert ($rows.Count -eq 2) 'Independent service write not visible in core'
  Core 'sessionClose' @{session=$session}|Out-Null;$session=$null
  Assert ((Invoke-RestMethod "$origin/api/v1/notes" -Headers $headers).notes.Count -eq 2) 'Service stopped with desktop session'
  $denied=$false;try{Invoke-RestMethod "$origin/api/v1/notes"|Out-Null}catch{$denied=$_.Exception.Response.StatusCode.value__ -eq 401};Assert $denied 'Unauthenticated request was accepted'
  Invoke-RestMethod "$origin/admin/stop" -Method Post -Headers $headers|Out-Null
  Assert ($service.WaitForExit(10000)) 'Service stop timeout';Assert ($service.ExitCode -eq 0) 'Service failed';$service=$null
  $gates+='independent-service/auth/REST/shared-data'
  $backup=Join-Path $evidence 'backup.zip';Core 'sessionBackupClosed' @{database=$database;destination=$backup}|Out-Null
  Assert (Test-Path -LiteralPath $backup) 'Backup missing';$gates+='backup'
  @{version=$manifest.version;host=$env:COMPUTERNAME;os=[Environment]::OSVersion.VersionString;cleanHostAttested=[bool]$CleanHostAttested;automatedGates=$gates;manualGates=@('EPUB images and footnote return','advanced outline edit/jump/reopen','metadata lookup/apply','real AI with chosen provider','signed update success and failed-start recovery','uninstall preserves workspace');manualStatus='pending';observedTools=@('dotnet','node','python','mysql','codex')|ForEach-Object{@{name=$_;present=[bool](Get-Command $_ -ErrorAction SilentlyContinue)}}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'acceptance.json') -Encoding UTF8
  Write-Output "PASS automated release checks. Manual gates remain pending. Evidence: $evidence"
} finally {
  if($session){Core 'sessionClose' @{session=$session}|Out-Null}
  if($service -and !$service.HasExited){Stop-Process -Id $service.Id}
}
