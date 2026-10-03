param([string]$InstallationDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallationDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$prefix=$root+[IO.Path]::DirectorySeparatorChar
$manifestPath=Join-Path $root 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
if($manifest.version -notmatch '^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$'){throw 'Invalid release manifest'}
$running=Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)}
if($running){throw 'Close the installed desktop, service and updater before uninstalling'}
# Validate every target before deleting any file. No recursive delete, and no
# removal of workspaces, originals, backups, modified or unlisted files.
$paths=@()
foreach($file in $manifest.files){
  if([IO.Path]::IsPathRooted($file.path) -or $file.path.Contains(':')){throw 'Invalid manifest path'}
  $path=[IO.Path]::GetFullPath((Join-Path $root $file.path))
  if(!$path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest escaped installation'}
  $paths+=@{path=$path;hash=$file.sha256}
}
$removed=0;$preserved=0
foreach($file in $paths){
  if(Test-Path -LiteralPath $file.path -PathType Leaf){
    if((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.hash){Remove-Item -LiteralPath $file.path -Force;$removed++}
    else{$preserved++}
  }
}
# Only installation-owned integration entries. Never disable another version
# or another workspace's startup registration.
$run=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run',$true)
try{
  if($run){foreach($name in $run.GetValueNames()){
    $entry=$run.GetValue($name)
    if($name.StartsWith('ShufangService-') -and $entry -is [string] -and $entry.StartsWith('"'+(Join-Path $root 'Shufang.Windows.exe')+'"',[StringComparison]::OrdinalIgnoreCase)){$run.DeleteValue($name,$false)}
  }}
}finally{if($run){$run.Dispose()}}
$shortcutName=[string][char]0x4e66+[char]0x623f+'.lnk'
$shortcut=Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName
if(Test-Path -LiteralPath $shortcut){
  $shell=New-Object -ComObject WScript.Shell
  $link=$shell.CreateShortcut($shortcut)
  if($link.TargetPath -eq (Join-Path $root 'Shufang.Windows.exe')){Remove-Item -LiteralPath $shortcut -Force}
}
Remove-Item -LiteralPath $manifestPath -Force
Get-ChildItem -LiteralPath $root -Directory -Recurse|Sort-Object {$_.FullName.Length} -Descending|ForEach-Object{
  if($_.FullName.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and !(Get-ChildItem -LiteralPath $_.FullName -Force)){Remove-Item -LiteralPath $_.FullName -Force}
}
if(!(Get-ChildItem -LiteralPath $root -Force)){Remove-Item -LiteralPath $root -Force}
Write-Output "Uninstalled $removed release files; preserved $preserved modified files and all unlisted data."
