param(
  [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Workspace)
$app = Join-Path $root 'app'
$release = Join-Path $root 'build\output\WatchParty'
function Assert-LocalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install path escaped workspace' }
  $parent = $full
  while ($parent -and $parent.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Install path contains a junction or symlink' }
    $parent = Split-Path -Parent $parent
  }
}
Assert-LocalPath $app
Assert-LocalPath $release
if (-not (Test-Path -LiteralPath (Join-Path $release 'WatchParty.exe') -PathType Leaf)) { throw 'Build output is missing WatchParty.exe' }
$legacy = @('config.json','watch-history.json','cache','bin','LICENSES','BUILD-MANIFEST.json','_update')
foreach ($name in $legacy) {
  $source = Join-Path $root $name
  $target = Join-Path $app $name
  Assert-LocalPath $source
  Assert-LocalPath $target
  if ((Test-Path -LiteralPath $source) -and (Test-Path -LiteralPath $target)) { throw "Both root and app contain $name. Resolve the duplicate before installing; neither was changed." }
}
$executables = @((Join-Path $root 'WatchParty.exe'),(Join-Path $app 'WatchParty.exe'))
Get-Process -Name WatchParty -ErrorAction SilentlyContinue | Where-Object { $_.Path -in $executables } | ForEach-Object {
  $processId = $_.Id
  Stop-Process -Id $processId -Force
  Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $app -Force | Out-Null
foreach ($name in $legacy) {
  $source = Join-Path $root $name
  if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination (Join-Path $app $name) }
}
# Preserve the meaning of relative media folders and nondefault cache paths after relocation.
$configFile = Join-Path $app 'config.json'
if (Test-Path -LiteralPath $configFile) {
  $original = [IO.File]::ReadAllText($configFile)
  $config = $original | ConvertFrom-Json
  $changed = $false
  if ($config.folders) {
    $config.folders = @($config.folders | ForEach-Object {
      if ([IO.Path]::IsPathRooted($_)) { $_ } else { $changed = $true; [IO.Path]::GetFullPath((Join-Path $root $_)) }
    })
  }
  if ($config.cacheDir -and $config.cacheDir -ne 'cache' -and -not [IO.Path]::IsPathRooted($config.cacheDir)) {
    $config.cacheDir = [IO.Path]::GetFullPath((Join-Path $root $config.cacheDir))
    $changed = $true
  }
  if ($changed) {
    $backup = Join-Path $app 'cache\migration'
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $backup 'config.original.json'), $original, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
  }
}
foreach ($folder in @('bin','extension','LICENSES','docs')) {
  $source = Join-Path $release $folder
  if (Test-Path -LiteralPath $source -PathType Container) { Copy-Item -LiteralPath $source -Destination $app -Recurse -Force }
}
foreach ($name in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md','BUILD-MANIFEST.json')) {
  $source = Join-Path $release $name
  if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $app $name) -Force }
}
$executable = Join-Path $root 'WatchParty.exe'
Assert-LocalPath $executable
Copy-Item -LiteralPath (Join-Path $release 'WatchParty.exe') -Destination $executable -Force
$iconRefresh = Join-Path $app 'bin\refresh-icon.ps1'
if (Test-Path -LiteralPath $iconRefresh -PathType Leaf) { & $iconRefresh -Executable $executable }
# Remove only the obsolete executable/launcher left by the previous local layout.
foreach ($name in @('WatchParty.exe','refresh.bat')) {
  $obsolete = Join-Path $app $name
  Assert-LocalPath $obsolete
  if (Test-Path -LiteralPath $obsolete -PathType Leaf) { Remove-Item -LiteralPath $obsolete -Force }
}
Write-Output "Installed: $executable"
if (-not $NoLaunch) { Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden }
