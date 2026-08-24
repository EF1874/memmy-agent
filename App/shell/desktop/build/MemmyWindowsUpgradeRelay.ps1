param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][int]$OriginalInstallerPid,
  [Parameter(Mandatory = $true)][int]$LegacyHelperPid,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][ValidateSet('0', '1')][string]$ReopenAfterInstall,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$normalizedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$dataPath = Join-Path $normalizedInstallDir 'data'
$backupParent = "$normalizedInstallDir.memmy-upgrade-backup"
$backupRoot = Join-Path $backupParent (Split-Path -Leaf $WorkDir)
$backupPath = Join-Path $backupRoot 'data-backup'
$installerDataPath = Join-Path $backupRoot 'installer-created-data'
$stagingRoot = Split-Path -Parent $WorkDir
$lockPath = Join-Path $stagingRoot 'active.lock'
$lockStatePath = Join-Path $stagingRoot 'active.lock\state.json'
$appExe = Join-Path $normalizedInstallDir 'Memmy.exe'
$normalizedInstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
$installerExit = 1
$installerProcess = $null
$dataMoved = $false
$dataRestored = $false
$lockAcquired = $false
$relayPhase = 'relay-ready'
$resolvedReopenAfterInstall = $ReopenAfterInstall
$relayStartedAtUtc = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')

function Write-MemmyUpgradeLog([string]$Message) {
  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value ('[{0:O}] {1}' -f (Get-Date), $Message)
}

function Resolve-MemmyLegacyHelperReopenIntent([int]$HelperPid, [string]$MarkerPath, [string]$Fallback) {
  try {
    $helper = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $HelperPid) -ErrorAction Stop
    $commandLine = [string]$helper.CommandLine
    if (-not $commandLine) {
      throw "legacy helper command line is unavailable"
    }
    $pattern = '(?:^|\s)"?(?<intent>[01])"?\s+"?' + [Regex]::Escape($MarkerPath) + '"?(?:\s|$)'
    $match = [Regex]::Match($commandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
      throw "legacy helper reopen argument is unavailable"
    }
    $intent = $match.Groups['intent'].Value
    Write-MemmyUpgradeLog "reopen intent resolved from legacy helper pid ${HelperPid}: $intent"
    return $intent
  } catch {
    Write-MemmyUpgradeLog "reopen intent fallback=$Fallback legacyHelperPid=$HelperPid reason=$($_.Exception.Message)"
    return $Fallback
  }
}

function Wait-MemmyProcessExit([int]$ProcessId, [int]$TimeoutSeconds) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
  }
  Write-MemmyUpgradeLog "waiting for original installer pid $ProcessId"
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    throw "original installer pid $ProcessId did not exit"
  }
}

function Assert-MemmySameVolume([string]$Source, [string]$Destination) {
  $sourceRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Source))
  $destinationRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Destination))
  if (-not [string]::Equals($sourceRoot, $destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing cross-volume directory move: $Source -> $Destination"
  }
}

function Move-MemmyDirectory([string]$Source, [string]$Destination) {
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

function Write-MemmyRelayState {
  $installerPid = $null
  $installerStartedAtUtc = $null
  if ($null -ne $installerProcess) {
    $installerPid = $installerProcess.Id
    try {
      $installerStartedAtUtc = $installerProcess.StartTime.ToUniversalTime().ToString('O')
    } catch {
      $installerStartedAtUtc = $null
    }
  }
  $state = [ordered]@{
    schemaVersion = 2
    phase = $relayPhase
    stateUpdatedAtUtc = [DateTime]::UtcNow.ToString('O')
    relayPid = $PID
    relayStartedAtUtc = $relayStartedAtUtc
    installerPid = $installerPid
    installerStartedAtUtc = $installerStartedAtUtc
    installerPath = $normalizedInstallerPath
    installDir = $normalizedInstallDir
    workDir = [System.IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
    backupRoot = $backupRoot
  }
  $temporaryStatePath = "$lockStatePath.tmp"
  [System.IO.File]::WriteAllText($temporaryStatePath, ($state | ConvertTo-Json -Compress))
  Move-Item -LiteralPath $temporaryStatePath -Destination $lockStatePath -Force
}

function Restore-MemmyData {
  if (-not $dataMoved) {
    $script:dataRestored = $true
    return
  }
  if (-not (Test-Path -LiteralPath $backupPath -PathType Container)) {
    if (Test-Path -LiteralPath $dataPath -PathType Container) {
      $script:dataRestored = $true
      Write-MemmyUpgradeLog "data restore verified by child installer $dataPath"
      return
    }
    throw "data backup is missing: $backupPath"
  }
  if (Test-Path -LiteralPath $dataPath) {
    if (Test-Path -LiteralPath $installerDataPath) {
      throw "installer-created data backup already exists: $installerDataPath"
    }
    Move-MemmyDirectory -Source $dataPath -Destination $installerDataPath
    Write-MemmyUpgradeLog "preserved installer-created data at $installerDataPath"
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Move-MemmyDirectory -Source $backupPath -Destination $dataPath
  if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
    throw "restored data directory is unavailable: $dataPath"
  }
  $script:dataRestored = $true
  Write-MemmyUpgradeLog "data restore verified $dataPath"
}

function Get-MemmyInstalledVersion {
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    return ''
  }
  $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe)
  foreach ($value in @($versionInfo.ProductVersion, $versionInfo.FileVersion)) {
    if ($value) {
      return $value
    }
  }
  return ''
}

function Clear-MemmyUpdateMarkers {
  $markerPath = Join-Path $dataPath 'Memmy\prepared-required-update.json'
  foreach ($path in @($markerPath, "$markerPath.lock", "$markerPath.prompt", "$markerPath.attempt")) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Start-MemmyInstalledApp {
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    Write-MemmyUpgradeLog "app executable is unavailable for reopen: $appExe"
    return
  }
  Start-Process -FilePath $appExe -WorkingDirectory $InstallDir -WindowStyle Normal
  Write-MemmyUpgradeLog "started app $appExe"
}

function Test-MemmyInstalledAppRunning {
  $expectedPath = [System.IO.Path]::GetFullPath($appExe)
  foreach ($process in @(Get-Process -Name 'Memmy' -ErrorAction SilentlyContinue)) {
    try {
      if ([string]::Equals([System.IO.Path]::GetFullPath($process.Path), $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    } catch {
      continue
    }
  }
  return $false
}

function Ensure-MemmyInstalledAppStarted {
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    if (Test-MemmyInstalledAppRunning) {
      Write-MemmyUpgradeLog "app already started by child installer $appExe"
      return
    }
    if ($attempt -lt 4) {
      Start-Sleep -Milliseconds 100
    }
  }
  Start-MemmyInstalledApp
}

function Schedule-MemmyStagingCleanup {
  $cleanupScriptPath = Join-Path $WorkDir 'MemmyWindowsUpgradeCleanup.ps1'
  if (-not (Test-Path -LiteralPath $cleanupScriptPath -PathType Leaf)) {
    return
  }
  $powershellPath = Join-Path $PSHOME 'powershell.exe'
  $cleanupArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$cleanupScriptPath`" -WorkDir `"$WorkDir`" -BackupRoot `"$backupRoot`""
  Start-Process -FilePath $powershellPath -ArgumentList $cleanupArguments -WorkingDirectory $stagingRoot -WindowStyle Hidden
}

try {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  Write-MemmyUpgradeLog "relay starting installer=$InstallerPath installDir=$InstallDir expected=$ExpectedVersion reopenFallback=$ReopenAfterInstall"
  $markerPath = Join-Path $dataPath 'Memmy\prepared-required-update.json'
  $resolvedReopenAfterInstall = Resolve-MemmyLegacyHelperReopenIntent -HelperPid $LegacyHelperPid -MarkerPath $markerPath -Fallback $ReopenAfterInstall
  New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
  $lockAcquired = $true
  Write-MemmyRelayState
  [System.IO.File]::WriteAllText($ReadyPath, $resolvedReopenAfterInstall)
  Write-MemmyUpgradeLog "relay ready reopen=$resolvedReopenAfterInstall"
  Wait-MemmyProcessExit -ProcessId $OriginalInstallerPid -TimeoutSeconds 120

  if (Test-Path -LiteralPath $dataPath -PathType Container) {
    if (Test-Path -LiteralPath $backupRoot) {
      throw "refusing to overwrite existing upgrade backup root: $backupRoot"
    }
    Move-MemmyDirectory -Source $dataPath -Destination $backupPath
    $dataMoved = $true
    $relayPhase = 'data-moved'
    Write-MemmyRelayState
    Write-MemmyUpgradeLog "data moved to $backupPath"
  }

  $arguments = @('/S', '--updated', '--memmy-upgrade-relayed', '/currentuser', ('/D=' + $InstallDir))
  $env:MEMMY_UPGRADE_WORK_DIR = $WorkDir
  $env:MEMMY_UPGRADE_BACKUP_ROOT = $backupRoot
  $env:MEMMY_UPGRADE_REOPEN_AFTER_INSTALL = $resolvedReopenAfterInstall
  Write-MemmyUpgradeLog "child installer context workDir=$env:MEMMY_UPGRADE_WORK_DIR backupRoot=$env:MEMMY_UPGRADE_BACKUP_ROOT reopen=$env:MEMMY_UPGRADE_REOPEN_AFTER_INSTALL"
  $relayPhase = 'installer-starting'
  Write-MemmyRelayState
  $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $installerProcess.WaitForExit()
  $installerExit = if ($null -eq $installerProcess.ExitCode) { 1 } else { $installerProcess.ExitCode }
  Write-MemmyUpgradeLog "installer exit $installerExit"
} catch {
  Write-MemmyUpgradeLog ('relay error: ' + ($_ | Out-String))
  if ($installerExit -eq 0) {
    $installerExit = 1
  }
} finally {
  try {
    Restore-MemmyData
  } catch {
    Write-MemmyUpgradeLog ('data restore failed: ' + ($_ | Out-String))
    $dataRestored = $false
  }
  if ($lockAcquired -and $dataRestored) {
    Remove-Item -LiteralPath $lockPath -Recurse -Force -ErrorAction SilentlyContinue
  } elseif ($lockAcquired) {
    Write-MemmyUpgradeLog "active lock retained for automatic recovery $lockPath"
  }
}

if (-not $dataRestored) {
  Write-MemmyUpgradeLog "upgrade stopped with recoverable data backup $backupPath"
  exit 3
}

$installedVersion = Get-MemmyInstalledVersion
$upgradeVerified = $installerExit -eq 0 -and $installedVersion.StartsWith($ExpectedVersion, [System.StringComparison]::OrdinalIgnoreCase)
if ($upgradeVerified) {
  Clear-MemmyUpdateMarkers
  Write-MemmyUpgradeLog "upgrade verified installedVersion=$installedVersion"
  if ($resolvedReopenAfterInstall -eq '1') {
    Ensure-MemmyInstalledAppStarted
  }
  Schedule-MemmyStagingCleanup
  exit 0
}

Write-MemmyUpgradeLog "upgrade not verified installedVersion=$installedVersion installerExit=$installerExit"
if ($resolvedReopenAfterInstall -eq '1') {
  Start-MemmyInstalledApp
}
exit $(if ($installerExit -ne 0) { $installerExit } else { 4 })
