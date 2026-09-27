param([string]$EnvFile = ".env.sync")
$ErrorActionPreference = "Stop"
$appDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appDirectory
$resolvedEnv = (Resolve-Path -LiteralPath $EnvFile).Path
& node "--env-file=$resolvedEnv" dist/migrate.js
if ($LASTEXITCODE -ne 0) { throw "Database migration failed" }
& node "--env-file=$resolvedEnv" dist/boot.js
exit $LASTEXITCODE
