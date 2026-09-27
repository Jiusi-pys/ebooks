param(
  [string]$EnvFile = ".env",
  [switch]$AutoStart,
  [switch]$NoAutoStart
)
$ErrorActionPreference = "Stop"
if ($AutoStart -and $NoAutoStart) {
  throw "Choose either -AutoStart or -NoAutoStart"
}

$appDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appDirectory
$resolvedEnv = (Resolve-Path -LiteralPath $EnvFile).Path
foreach ($required in @("dist/boot.js", "dist/migrate.js")) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing $required; run npm run build in the app directory first"
  }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required and must be on PATH"
}
$nodeVersion = [version](& node -p "process.versions.node")
if ($nodeVersion -lt [version]"22.13.0") {
  throw "Node.js 22.13 or newer is required; found $nodeVersion"
}

if ($AutoStart) {
  $enable = $true
} elseif ($NoAutoStart) {
  $enable = $false
} else {
  $choice = Read-Host "Enable startup when this Windows user logs in? [y/N]"
  $enable = $choice -match "^(y|yes)$"
}

$taskName = "ShufangBookManager"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$shellPath = (Get-Process -Id $PID).Path
$startScript = Join-Path $PSScriptRoot "start-windows.ps1"
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -EnvFile "{1}"' -f $startScript, $resolvedEnv
$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Start the Shufang book manager at user logon" -Force | Out-Null
if ($enable) {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
  Write-Host "Automatic startup is enabled for $identity."
} else {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Write-Host "Startup task is installed but disabled. Enable it later in App Settings."
}
