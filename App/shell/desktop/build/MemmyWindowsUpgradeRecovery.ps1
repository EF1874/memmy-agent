param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LockPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$normalizedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$dataPath = Join-Path $normalizedInstallDir 'data'
$expectedBackupParent = "$normalizedInstallDir.memmy-upgrade-backup"
$normalizedLockPath = [System.IO.Path]::GetFullPath($LockPath).TrimEnd('\')
$expectedStagingRoot = Split-Path -Parent $normalizedLockPath
$statePath = Join-Path $LockPath 'state.json'

function Write-MemmyUpgradeRecoveryLog([string]$Message) {
  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value ('[{0:O}] recovery: {1}' -f (Get-Date), $Message)
}

function Resolve-MemmyNormalizedPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-MemmyUpgradeProcessRunning($ProcessId, $StartedAtUtc, [string]$ExpectedPath = '') {
  $parsedProcessId = 0
  if (-not [int]::TryParse([string]$ProcessId, [ref]$parsedProcessId) -or $parsedProcessId -le 0) {
    return $false
  }
  $process = Get-Process -Id $parsedProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $false
  }
  try {
    if ($ExpectedPath) {
      $actualPath = Resolve-MemmyNormalizedPath $process.Path
      $normalizedExpectedPath = Resolve-MemmyNormalizedPath $ExpectedPath
      if (-not [string]::Equals($actualPath, $normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
      }
    }
    if (-not $StartedAtUtc) {
      return $true
    }
    $expectedStart = [DateTime]::Parse([string]$StartedAtUtc).ToUniversalTime()
    $actualStart = $process.StartTime.ToUniversalTime()
    return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 5
  } catch {
    return $true
  }
}

function Test-MemmyInstallerPathRunning([string]$InstallerPath) {
  if (-not $InstallerPath) {
    return $false
  }
  $normalizedExpectedPath = Resolve-MemmyNormalizedPath $InstallerPath
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    Write-MemmyUpgradeRecoveryLog "unable to enumerate installer processes; leaving recovery locked: $($_.Exception.Message)"
    return $true
  }
  foreach ($process in $processes) {
    if (-not $process.ExecutablePath) {
      continue
    }
    try {
      $actualPath = Resolve-MemmyNormalizedPath ([string]$process.ExecutablePath)
      if ([string]::Equals($actualPath, $normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    } catch {
      continue
    }
  }
  return $false
}

function Assert-MemmySameVolume([string]$Source, [string]$Destination) {
  $sourceRoot = [System.IO.Path]::GetPathRoot((Resolve-MemmyNormalizedPath $Source))
  $destinationRoot = [System.IO.Path]::GetPathRoot((Resolve-MemmyNormalizedPath $Destination))
  if (-not [string]::Equals($sourceRoot, $destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing cross-volume directory move: $Source -> $Destination"
  }
}

function Move-MemmyRecoveryDirectory([string]$Source, [string]$Destination) {
  Assert-MemmySameVolume -Source $Source -Destination $Destination
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    try {
      [System.IO.Directory]::Move($Source, $Destination)
      return
    } catch {
      if ($attempt -eq 120) {
        throw
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Clear-MemmyRecoveryTransientMarkers {
  $markerPath = Join-Path $dataPath 'Memmy\prepared-required-update.json'
  foreach ($path in @("$markerPath.lock", "$markerPath.prompt")) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-MemmyUpgradeRecoveryLog "cleared transient prepared-update lock and prompt markers"
}

if (-not (Test-Path -LiteralPath $LockPath -PathType Container)) {
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $lockAge = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
    if ($lockAge.TotalMinutes -lt 2 -or -not (Test-Path -LiteralPath $dataPath -PathType Container)) {
      Write-MemmyUpgradeRecoveryLog "active lock has no recovery state; leaving it in place"
      exit 2
    }
    Clear-MemmyRecoveryTransientMarkers
    Remove-Item -LiteralPath $LockPath -Recurse -Force
    Write-MemmyUpgradeRecoveryLog "cleared stale state-less lock because installed data is present"
    exit 0
  }

  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $phase = [string]$state.phase
  if (@('relay-ready', 'data-moved', 'installer-starting', 'installer-running', 'installer-exited') -notcontains $phase) {
    throw "recovery state has an unsupported phase: $phase"
  }
  $stateInstallDir = Resolve-MemmyNormalizedPath ([string]$state.installDir)
  $stateWorkDir = Resolve-MemmyNormalizedPath ([string]$state.workDir)
  $stateInstallerPath = Resolve-MemmyNormalizedPath ([string]$state.installerPath)
  $backupRoot = Resolve-MemmyNormalizedPath ([string]$state.backupRoot)
  if (-not [string]::Equals($stateInstallDir, $normalizedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state install directory does not match launcher install directory"
  }
  if (-not [string]::Equals((Split-Path -Parent $stateWorkDir), $expectedStagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state work directory is outside the expected staging directory"
  }
  $workLeaf = Split-Path -Leaf $stateWorkDir
  if (-not $workLeaf -or [string]::Equals($workLeaf, 'active.lock', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state work directory has an invalid leaf"
  }
  if (-not [string]::Equals((Split-Path -Parent $stateInstallerPath), $stateWorkDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state installer path is outside its work directory"
  }
  $expectedBackupRoot = Resolve-MemmyNormalizedPath (Join-Path $expectedBackupParent $workLeaf)
  if (-not [string]::Equals($backupRoot, $expectedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state backup root does not match the expected install-local sibling"
  }
  if ((Test-MemmyUpgradeProcessRunning $state.relayPid $state.relayStartedAtUtc) -or
      (Test-MemmyUpgradeProcessRunning $state.installerPid $state.installerStartedAtUtc $stateInstallerPath) -or
      ($phase -eq 'installer-starting' -and (Test-MemmyInstallerPathRunning $stateInstallerPath))) {
    Write-MemmyUpgradeRecoveryLog "upgrade process is still running; leaving active lock in place"
    exit 2
  }

  $backupPath = Join-Path $backupRoot 'data-backup'
  $installerDataPath = Join-Path $backupRoot 'installer-created-data'
  if (Test-Path -LiteralPath $backupPath -PathType Container) {
    if (Test-Path -LiteralPath $dataPath) {
      if (Test-Path -LiteralPath $installerDataPath) {
        throw "installer-created data backup already exists: $installerDataPath"
      }
      Move-MemmyRecoveryDirectory -Source $dataPath -Destination $installerDataPath
      Write-MemmyUpgradeRecoveryLog "preserved installer-created data at $installerDataPath"
    }
    Move-MemmyRecoveryDirectory -Source $backupPath -Destination $dataPath
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
      throw "restored data directory is unavailable: $dataPath"
    }
    Write-MemmyUpgradeRecoveryLog "stale upgrade data restored from $backupPath"
  } elseif (Test-Path -LiteralPath $dataPath -PathType Container) {
    Write-MemmyUpgradeRecoveryLog "stale upgrade already has installed data; clearing lock"
  } else {
    throw "both installed data and upgrade backup are missing"
  }

  Clear-MemmyRecoveryTransientMarkers
  Remove-Item -LiteralPath $LockPath -Recurse -Force
  Write-MemmyUpgradeRecoveryLog "stale active lock cleared"
  if (Test-Path -LiteralPath $stateWorkDir -PathType Container) {
    try {
      Remove-Item -LiteralPath $stateWorkDir -Recurse -Force -ErrorAction Stop
      Write-MemmyUpgradeRecoveryLog "stale staging work directory removed: $stateWorkDir"
    } catch {
      Write-MemmyUpgradeRecoveryLog "unable to remove stale staging work directory ${stateWorkDir}: $($_.Exception.Message)"
    }
  }
  exit 0
} catch {
  Write-MemmyUpgradeRecoveryLog ('automatic recovery failed: ' + ($_ | Out-String))
  exit 3
}
