[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Yes,
    [string]$Package,
    [string]$PortableRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'Continue'
$Root = if ($PortableRoot) {
    (Resolve-Path -LiteralPath $PortableRoot.Trim().Trim('"')).Path.TrimEnd('\')
} else {
    $PSScriptRoot.TrimEnd('\')
}
$Work = Join-Path $Root 'update'
$Staging = Join-Path $Work 'staging'
$Backup = Join-Path $Work 'backup'
$Download = Join-Path $Work 'opencode-desktop-win-x64-portable.zip'
$MetadataFile = Join-Path $Root 'portable-build.json'
$Repository = 'peddalion/opencode'

function Read-Metadata([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Test-Digest([string]$Path, [string]$Digest) {
    if ($Digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { return $false }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Matches[1]
}

function Save-Download([string]$Uri, [string]$Path, [long]$ExpectedLength) {
    Add-Type -AssemblyName System.Net.Http
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $true
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.DefaultRequestHeaders.UserAgent.ParseAdd('OpenCode-Portable-Updater')
    $Response = $null
    $InputStream = $null
    $OutputStream = $null
    try {
        $Response = $Client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $null = $Response.EnsureSuccessStatusCode()
        $Total = if ($Response.Content.Headers.ContentLength.HasValue) {
            $Response.Content.Headers.ContentLength.Value
        } else {
            $ExpectedLength
        }
        $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $OutputStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $Buffer = New-Object byte[] (1024 * 1024)
        $Written = [long]0
        $LastPercent = -1
        $Timer = [System.Diagnostics.Stopwatch]::StartNew()

        while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $OutputStream.Write($Buffer, 0, $Read)
            $Written += $Read
            if ($Total -le 0) {
                Write-Host -NoNewline ("`rDownload: {0:N1} MB" -f ($Written / 1MB))
                continue
            }

            $Percent = [Math]::Min(100, [int][Math]::Floor(($Written * 100) / $Total))
            if ($Percent -eq $LastPercent) { continue }
            $LastPercent = $Percent
            $Filled = [int][Math]::Floor($Percent * 30 / 100)
            $Bar = ('#' * $Filled).PadRight(30, '.')
            $Rate = if ($Timer.Elapsed.TotalSeconds -gt 0) { ($Written / 1MB) / $Timer.Elapsed.TotalSeconds } else { 0 }
            $Status = "`rDownload: {0,3}% [{1}] {2,7:N1}/{3:N1} MB  {4:N1} MB/s" -f $Percent, $Bar, ($Written / 1MB), ($Total / 1MB), $Rate
            Write-Host -NoNewline $Status.PadRight(100)
        }
        Write-Host ''
    } finally {
        if ($OutputStream) { $OutputStream.Dispose() }
        if ($InputStream) { $InputStream.Dispose() }
        if ($Response) { $Response.Dispose() }
        $Client.Dispose()
        $Handler.Dispose()
    }
}

function Get-PortableRelease {
    $Headers = @{
        'User-Agent' = 'OpenCode-Portable-Updater'
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $Headers
    $PackageAsset = $Release.assets | Where-Object { $_.name -eq 'opencode-desktop-win-x64-portable.zip' } | Select-Object -First 1
    $MetadataAsset = $Release.assets | Where-Object { $_.name -eq 'portable-build.json' } | Select-Object -First 1
    if (-not $PackageAsset -or -not $MetadataAsset) {
        throw 'Der GitHub-Release enthaelt keinen vollstaendigen Portable-Build.'
    }
    return [pscustomobject]@{
        Package = $PackageAsset
        Metadata = Invoke-RestMethod -Uri $MetadataAsset.browser_download_url -Headers $Headers
    }
}

Write-Host ''
Write-Host 'OpenCode Portable Updater' -ForegroundColor Cyan
Write-Host '=========================' -ForegroundColor Cyan

$Current = Read-Metadata $MetadataFile
$ExpectedMetadata = $null
$ExpectedDigest = $null

if ($Package) {
    $Download = (Resolve-Path -LiteralPath $Package).Path
} else {
    Write-Host 'Pruefe GitHub auf einen neuen Portable-Build ...'
    $Info = Get-PortableRelease
    $ExpectedMetadata = $Info.Metadata
    $ExpectedDigest = [string]$Info.Package.digest
    if ($Current -and $Current.commit -eq $ExpectedMetadata.commit) {
        Write-Host "OpenCode Portable ist aktuell: $($Current.version)" -ForegroundColor Green
        exit 0
    }
    if ($CheckOnly) {
        Write-Host "Update verfuegbar: $($Current.version) -> $($ExpectedMetadata.version)" -ForegroundColor Yellow
        exit 2
    }

    New-Item -ItemType Directory -Force -Path $Work | Out-Null
    $Verified = (Test-Path -LiteralPath $Download -PathType Leaf) -and (Test-Digest $Download $ExpectedDigest)
    if ($Verified) {
        Write-Host 'Verwende den bereits geprueften Download.'
    } else {
        foreach ($Attempt in 1..3) {
            if ($Attempt -gt 1) {
                Write-Host "Download wird erneut versucht ($Attempt/3) ..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
                $Info = Get-PortableRelease
                $ExpectedMetadata = $Info.Metadata
                $ExpectedDigest = [string]$Info.Package.digest
            }
            $Partial = "$Download.partial"
            Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $Download -Force -ErrorAction SilentlyContinue
            Save-Download $Info.Package.browser_download_url $Partial ([long]$Info.Package.size)
            Move-Item -LiteralPath $Partial -Destination $Download -Force
            if (Test-Digest $Download $ExpectedDigest) {
                $Verified = $true
                break
            }
        }
    }
    if (-not $Verified) {
        Remove-Item -LiteralPath $Download -Force -ErrorAction SilentlyContinue
        throw 'SHA-256-Pruefung des Downloads ist nach drei Versuchen fehlgeschlagen.'
    }
}

$DesktopExecutable = Join-Path $Root 'OpenCode.exe'
$Running = Get-Process -Name 'OpenCode' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.Equals($DesktopExecutable, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
}
if ($Running) {
    throw 'OpenCode laeuft noch. Die App vollstaendig beenden und den Updater erneut starten.'
}

if (-not $Yes) {
    $Answer = Read-Host 'Update jetzt installieren? [J/N]'
    if ($Answer -notmatch '^(j|ja|y|yes)$') {
        Write-Host 'Abgebrochen.'
        exit 0
    }
}

Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Staging, $Backup | Out-Null

& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $Download -C $Staging
if ($LASTEXITCODE -ne 0) { throw "Entpacken fehlgeschlagen, tar.exe Exitcode $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath (Join-Path $Staging 'OpenCode.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $Staging 'portable.flag') -PathType Leaf)) {
    throw 'Das Update-Paket ist kein gueltiger OpenCode Portable-Build.'
}

$StagedMetadata = Read-Metadata (Join-Path $Staging 'portable-build.json')
if (-not $StagedMetadata) { throw 'Dem Update-Paket fehlen Build-Metadaten.' }
if ($ExpectedMetadata -and $StagedMetadata.commit -ne $ExpectedMetadata.commit) {
    throw 'Die Build-Metadaten stimmen nicht mit dem GitHub-Release ueberein.'
}

$NewFiles = [System.Collections.Generic.List[string]]::new()
try {
    foreach ($File in Get-ChildItem -LiteralPath $Staging -Recurse -File) {
        $Relative = $File.FullName.Substring($Staging.Length).TrimStart('\')
        $Destination = Join-Path $Root $Relative
        $DestinationDirectory = Split-Path -Parent $Destination
        New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            $BackupFile = Join-Path $Backup $Relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BackupFile) | Out-Null
            Copy-Item -LiteralPath $Destination -Destination $BackupFile -Force
        } else {
            $NewFiles.Add($Destination)
        }
        Copy-Item -LiteralPath $File.FullName -Destination $Destination -Force
    }
} catch {
    foreach ($File in Get-ChildItem -LiteralPath $Backup -Recurse -File -ErrorAction SilentlyContinue) {
        $Relative = $File.FullName.Substring($Backup.Length).TrimStart('\')
        $Destination = Join-Path $Root $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $File.FullName -Destination $Destination -Force
    }
    $NewFiles | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    throw
} finally {
    Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "Update auf OpenCode Portable $($StagedMetadata.version) erfolgreich." -ForegroundColor Green
Write-Host "Rollback-Kopie: $Backup"
