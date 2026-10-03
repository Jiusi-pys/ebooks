param([string]$Destination, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$source=[IO.Path]::GetFullPath($PSScriptRoot)
$manifest=Get-Content -LiteralPath (Join-Path $source 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$') { throw 'Invalid release version' }
if (!$Destination) { $Destination=Join-Path $env:LOCALAPPDATA "Programs/Shufang/$($manifest.version)" }
$target=[IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Choose a new installation directory; existing versions and workspaces are preserved.' }
foreach ($file in $manifest.files) {
  if ([IO.Path]::IsPathRooted($file.path) -or $file.path.Contains(':')) { throw 'Invalid manifest path' }
  $path=[IO.Path]::GetFullPath((Join-Path $source $file.path))
  if (!$path.StartsWith($source + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path' }
  if ((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Checksum mismatch: $($file.path)" }
}
New-Item -ItemType Directory -Path $target | Out-Null
# Copy only checked release files, never local runtime caches or unlisted additions.
foreach ($file in $manifest.files) {
  $destination=Join-Path $target $file.path
  New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($destination)) | Out-Null
  Copy-Item -LiteralPath (Join-Path $source $file.path) -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $source 'release-manifest.json') -Destination $target
if (!$NoShortcut) {
  $shell=New-Object -ComObject WScript.Shell
  $shortcutName = [string][char]0x4e66 + [char]0x623f + '.lnk'
  $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName))
  $link.TargetPath=Join-Path $target 'Shufang.Windows.exe';$link.WorkingDirectory=$target;$link.Save()
}
Write-Output "Installed at $target. No service or auto-start has been enabled."
