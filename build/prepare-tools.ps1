param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cache = Join-Path $root 'build\cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

function Get-FileSha256([string]$LiteralPath) {
    $stream = [IO.File]::OpenRead($LiteralPath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-VerifiedFile([string]$Url, [string]$Target, [string]$Sha256) {
    if ($Sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Missing trusted SHA-256 digest' }
    if ((Test-Path -LiteralPath $Target) -and ((Get-FileSha256 $Target) -eq $Sha256)) { return }
    $temporary = "$Target.download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporary
        if ((Get-FileSha256 $temporary) -ne $Sha256) { throw "Checksum mismatch: $Url" }
        Move-Item -LiteralPath $temporary -Destination $Target -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
if ($FunctionsOnly) { return }

# Pinned to the official October 21, 2026 security release. Digests come from
# https://nodejs.org/en/blog/release/v22.23.4 and the versioned upstream LICENSE.
$nodeVersion = '22.23.4'
$nodeDirectory = Join-Path $cache "node-v$nodeVersion-win-x64"
New-Item -ItemType Directory -Force -Path $nodeDirectory | Out-Null
Get-VerifiedFile "https://nodejs.org/dist/v$nodeVersion/win-x64/node.exe" (Join-Path $nodeDirectory 'node.exe') 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f'
Get-VerifiedFile "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE" (Join-Path $nodeDirectory 'LICENSE') 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4'

$ffmpegDirectory = Join-Path $cache 'ffmpeg'
if (Test-Path -LiteralPath (Join-Path $ffmpegDirectory 'bin\ffmpeg.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ffmpegDirectory 'DOWNLOAD.json'))) {
        Write-Warning 'Reusing existing FFmpeg cache with unknown archive provenance. The package records binary hashes; obtain corresponding source before redistributing.'
    }
    exit 0
}

# Resolve the mutable release once, then verify the exact asset digest before
# extraction. Retain the receipt so the downloaded binary can be identified.
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'
$asset = @($release.assets | Where-Object { $_.name -eq 'ffmpeg-master-latest-win64-gpl-shared.zip' })
if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'FFmpeg release does not provide one expected asset with a SHA-256 digest' }
$expectedDigest = $asset[0].digest.Substring(7)
$asset = $asset[0]
$archive = Join-Path $cache 'ffmpeg.zip'
Get-VerifiedFile $asset.browser_download_url $archive $expectedDigest
$extract = [IO.Path]::GetFullPath((Join-Path $cache 'ffmpeg-extract'))
if (-not $extract.StartsWith("$cache\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction path' }
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $extract
$directories = @(Get-ChildItem -LiteralPath $extract -Directory)
if ($directories.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $directories[0].FullName 'bin\ffmpeg.exe')) -or -not (Test-Path -LiteralPath (Join-Path $directories[0].FullName 'bin\ffprobe.exe'))) { throw 'Unexpected FFmpeg archive layout' }
@{ source = $asset.browser_download_url; sha256 = $expectedDigest; assetId = $asset.id; release = $release.html_url; downloadedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directories[0].FullName 'DOWNLOAD.json') -Encoding UTF8
if (Test-Path -LiteralPath $ffmpegDirectory) { throw 'Incomplete FFmpeg cache exists; move build\cache\ffmpeg aside and retry' }
Move-Item -LiteralPath $directories[0].FullName -Destination $ffmpegDirectory
Remove-Item -LiteralPath $extract -Recurse -Force
Remove-Item -LiteralPath $archive -Force
