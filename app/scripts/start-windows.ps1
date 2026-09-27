param([string]$EnvFile = ".env")
$ErrorActionPreference = "Stop"
$appDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appDirectory
$resolvedEnv = (Resolve-Path -LiteralPath $EnvFile).Path
$env:NODE_ENV = "production"
& node "--env-file=$resolvedEnv" dist/migrate.js
if ($LASTEXITCODE -ne 0) { throw "Database migration failed" }
& node "--env-file=$resolvedEnv" dist/boot.js
exit $LASTEXITCODE
