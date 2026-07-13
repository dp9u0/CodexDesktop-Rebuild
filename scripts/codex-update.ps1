param(
  [string]$Repository = "CoolKingMM/CodexDesktop-Rebuild",
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "CodexDesktop-Rebuild"),
  [switch]$Launch,
  [switch]$Force,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"

$AppDir = Join-Path $InstallRoot "app"
$StatePath = Join-Path $InstallRoot "current-version.json"
$Headers = @{
  "User-Agent" = "CodexDesktop-Rebuild-Updater"
  "Accept" = "application/vnd.github+json"
}

function Write-Step {
  param([string]$Message)
  Write-Host "[codex-update] $Message"
}

function Get-RelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$FullPath
  )

  $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\", "/")
  $path = [System.IO.Path]::GetFullPath($FullPath)
  return $path.Substring($base.Length).TrimStart("\", "/")
}

function Read-CurrentVersion {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    return $null
  }

  try {
    return (Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json).version
  } catch {
    return $null
  }
}

function Get-LatestManifest {
  $manifestUrl = "https://github.com/$Repository/releases/latest/download/latest.json"
  Write-Step "checking $manifestUrl"
  $client = New-Object System.Net.WebClient
  foreach ($key in $Headers.Keys) {
    $client.Headers.Add($key, $Headers[$key])
  }

  try {
    $bytes = $client.DownloadData($manifestUrl)
  } finally {
    $client.Dispose()
  }

  $text = [System.Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
  return $text | ConvertFrom-Json
}

function Expand-Zip {
  param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -xf $ZipPath -C $Destination
    if ($LASTEXITCODE -ne 0) {
      throw "tar extraction failed with exit code $LASTEXITCODE"
    }
    return
  }

  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Stop-InstalledAppProcesses {
  if (-not (Test-Path -LiteralPath $AppDir)) {
    return
  }

  $root = [System.IO.Path]::GetFullPath($AppDir).TrimEnd("\", "/") + "\"
  $matches = @(Get-CimInstance Win32_Process | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    try {
      return [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      return $false
    }
  })

  if ($matches.Count -eq 0) {
    return
  }

  Write-Step "closing $($matches.Count) running process(es)"

  foreach ($item in $matches) {
    try {
      $proc = Get-Process -Id $item.ProcessId -ErrorAction Stop
      if ($proc.MainWindowHandle -ne 0) {
        [void]$proc.CloseMainWindow()
      }
    } catch {}
  }

  Start-Sleep -Seconds 5

  foreach ($item in $matches) {
    try {
      $proc = Get-Process -Id $item.ProcessId -ErrorAction Stop
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
    } catch {}
  }
}

function Test-SameFile {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Destination)) {
    return $false
  }

  $destItem = Get-Item -LiteralPath $Destination
  if ($destItem.Length -ne $Source.Length) {
    return $false
  }

  $srcHash = (Get-FileHash -LiteralPath $Source.FullName -Algorithm SHA256).Hash
  $destHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
  return $srcHash -eq $destHash
}

function Remove-EmptyDirectories {
  if (-not (Test-Path -LiteralPath $AppDir)) {
    return
  }

  Get-ChildItem -LiteralPath $AppDir -Directory -Recurse -Force |
    Sort-Object FullName -Descending |
    ForEach-Object {
      $hasChildren = Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $hasChildren) {
        Remove-Item -LiteralPath $_.FullName -Force
      }
    }
}

function Remove-DirectoryBestEffort {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    return
  } catch {
    Write-Step "standard cleanup failed; retrying with robocopy mirror"
  }

  $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-empty-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
  try {
    & robocopy.exe $emptyDir $Path /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -LiteralPath $emptyDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Update-AppFiles {
  param(
    [Parameter(Mandatory = $true)][string]$NewAppDir,
    [Parameter(Mandatory = $true)][string]$BackupDir
  )

  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if (-not $robocopy) {
    throw "robocopy.exe was not found"
  }

  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

  & $robocopy.Source $NewAppDir $AppDir /MIR /FFT /R:2 /W:2 /MT:8 /NP
  $exitCode = $LASTEXITCODE
  if ($exitCode -ge 8) {
    throw "robocopy failed with exit code $exitCode"
  }

  return [ordered]@{
    changed = "robocopy"
    unchanged = ""
    removed = ""
    robocopyExitCode = $exitCode
  }

  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

  $newFiles = @(Get-ChildItem -LiteralPath $NewAppDir -File -Recurse -Force)
  $newRelSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $newOnly = New-Object 'System.Collections.Generic.List[string]'
  $backupRelSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  function Backup-ExistingFile {
    param([string]$RelativePath)

    if ($backupRelSet.Contains($RelativePath)) {
      return
    }

    $destPath = Join-Path $AppDir $RelativePath
    if (-not (Test-Path -LiteralPath $destPath)) {
      return
    }

    $backupPath = Join-Path $BackupDir $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
    Copy-Item -LiteralPath $destPath -Destination $backupPath -Force
    [void]$backupRelSet.Add($RelativePath)
  }

  $changed = 0
  $unchanged = 0
  $removed = 0

  try {
    foreach ($file in $newFiles) {
      $rel = Get-RelativePath -BasePath $NewAppDir -FullPath $file.FullName
      [void]$newRelSet.Add($rel)

      $dest = Join-Path $AppDir $rel
      $destExists = Test-Path -LiteralPath $dest

      if ($destExists -and (Test-SameFile -Source $file -Destination $dest)) {
        $unchanged++
        continue
      }

      Backup-ExistingFile -RelativePath $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $dest -Force

      if (-not $destExists) {
        $newOnly.Add($rel)
      }
      $changed++
    }

    if (Test-Path -LiteralPath $AppDir) {
      $oldFiles = @(Get-ChildItem -LiteralPath $AppDir -File -Recurse -Force)
      foreach ($old in $oldFiles) {
        $rel = Get-RelativePath -BasePath $AppDir -FullPath $old.FullName
        if (-not $newRelSet.Contains($rel)) {
          Backup-ExistingFile -RelativePath $rel
          Remove-Item -LiteralPath $old.FullName -Force
          $removed++
        }
      }
    }

    Remove-EmptyDirectories
    return [ordered]@{
      changed = $changed
      unchanged = $unchanged
      removed = $removed
    }
  } catch {
    Write-Step "update failed; restoring backup"

    foreach ($rel in $newOnly) {
      $dest = Join-Path $AppDir $rel
      if (Test-Path -LiteralPath $dest) {
        Remove-Item -LiteralPath $dest -Force
      }
    }

    if (Test-Path -LiteralPath $BackupDir) {
      Get-ChildItem -LiteralPath $BackupDir -File -Recurse -Force | ForEach-Object {
        $rel = Get-RelativePath -BasePath $BackupDir -FullPath $_.FullName
        $dest = Join-Path $AppDir $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
      }
    }

    throw
  }
}

function Start-Codex {
  $exePath = Join-Path $AppDir "Codex.exe"
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Codex.exe was not found at $exePath"
  }

  Write-Step "launching $exePath"
  Start-Process -FilePath $exePath
}

$tempRoot = $null

try {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  $manifest = Get-LatestManifest
  if (-not $manifest.version -or -not $manifest.url -or -not $manifest.assetName) {
    throw "latest.json is missing version, url, or assetName"
  }

  $currentVersion = Read-CurrentVersion
  $currentVersionLabel = $currentVersion
  if (-not $currentVersionLabel) {
    $currentVersionLabel = "<none>"
  }
  Write-Step "current version: $currentVersionLabel"
  Write-Step "latest version:  $($manifest.version)"

  if (-not $Force -and $currentVersion -eq $manifest.version) {
    Write-Step "already up to date"
    if ($Launch) {
      Start-Codex
    }
    exit 0
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-update-" + [guid]::NewGuid().ToString("N"))
  $downloadDir = Join-Path $tempRoot "download"
  $extractDir = Join-Path $tempRoot "extract"
  $backupDir = Join-Path $tempRoot "backup"

  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  $zipPath = Join-Path $downloadDir $manifest.assetName

  Write-Step "downloading $($manifest.assetName)"
  Invoke-WebRequest -Uri $manifest.url -Headers $Headers -OutFile $zipPath

  if ($manifest.sha256) {
    $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne ([string]$manifest.sha256).ToLowerInvariant()) {
      throw "SHA256 mismatch. expected=$($manifest.sha256) actual=$actualSha"
    }
    Write-Step "sha256 verified"
  }

  Write-Step "extracting package"
  Expand-Zip -ZipPath $zipPath -Destination $extractDir

  Stop-InstalledAppProcesses

  Write-Step "applying changed files"
  $summary = Update-AppFiles -NewAppDir $extractDir -BackupDir $backupDir
  Write-Step "changed=$($summary.changed), unchanged=$($summary.unchanged), removed=$($summary.removed)"

  $state = [ordered]@{
    version = $manifest.version
    tag = $manifest.tag
    assetName = $manifest.assetName
    sha256 = $manifest.sha256
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    repository = $Repository
  }
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8

  Write-Step "updated to $($manifest.version)"

  if ($Launch) {
    Start-Codex
  }
} finally {
  if (-not $KeepTemp -and $tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    Write-Step "cleaning temporary files"
    Remove-DirectoryBestEffort -Path $tempRoot
  } elseif ($KeepTemp -and $tempRoot) {
    Write-Step "temporary files kept at $tempRoot"
  }
}
