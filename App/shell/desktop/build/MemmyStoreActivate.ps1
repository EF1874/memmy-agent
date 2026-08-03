[CmdletBinding()]
param(
  [string]$AumId,
  [string]$InstallerPath,
  [int]$LegacyProcessId = 0,
  [string]$LegacyExecutablePath,
  [int]$LegacyExitTimeoutSeconds = 15,
  [int]$WaitForPackageSeconds = 0,
  [int]$WaitForReadySeconds = 0
)

$ErrorActionPreference = "Stop"

function Test-MemmyStorePackageStatus {
  param($Package)

  return $null -ne $Package -and [string]($Package.Status) -eq "Ok"
}

function Test-MemmyStoreActivationResult {
  param(
    [int]$HResult,
    [uint32]$ProcessId
  )

  return $HResult -ge 0 -and $ProcessId -gt 0
}

function Resolve-MemmyComparablePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    return [IO.Path]::GetFullPath($Path).TrimEnd("\", "/").ToLowerInvariant()
  } catch {
    return $null
  }
}

function Test-MemmyPathWithinDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Directory
  )

  $candidate = Resolve-MemmyComparablePath -Path $Path
  $root = Resolve-MemmyComparablePath -Path $Directory
  if (-not $candidate -or -not $root -or $candidate.Length -le $root.Length) {
    return $false
  }
  return $candidate.StartsWith($root + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Test-MemmyWindowsAppsPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not $env:ProgramFiles) {
    return $false
  }
  return Test-MemmyPathWithinDirectory `
    -Path $Path `
    -Directory (Join-Path $env:ProgramFiles "WindowsApps")
}

function Test-MemmyLegacyExecutablePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not $env:LOCALAPPDATA) {
    return $false
  }
  return (
    -not (Test-MemmyWindowsAppsPath -Path $Path) -and
    (Test-MemmyPathWithinDirectory `
      -Path $Path `
      -Directory (Join-Path $env:LOCALAPPDATA "Programs\Memmy"))
  )
}

function Test-MemmyLegacyProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
  )

  if (-not (Test-MemmyLegacyExecutablePath -Path $ExpectedExecutablePath)) {
    return $false
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) {
    return $false
  }
  $actualPath = Resolve-MemmyComparablePath -Path ([string]$process.ExecutablePath)
  $expectedPath = Resolve-MemmyComparablePath -Path $ExpectedExecutablePath
  return $actualPath -and $expectedPath -and $actualPath -eq $expectedPath
}

function Wait-MemmyLegacyProcessExit {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
    [int]$TimeoutSeconds = 15
  )

  if (-not (Test-MemmyLegacyExecutablePath -Path $ExpectedExecutablePath)) {
    throw "The legacy Memmy executable path is outside the validated install directory."
  }
  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSeconds))
  do {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) {
      return $true
    }
    $actualPath = Resolve-MemmyComparablePath -Path ([string]$process.ExecutablePath)
    $expectedPath = Resolve-MemmyComparablePath -Path $ExpectedExecutablePath
    if (-not $actualPath) {
      throw "Unable to verify the running legacy Memmy executable path."
    }
    if ($actualPath -ne $expectedPath) {
      return $true
    }
    if ((Get-Date) -ge $deadline) {
      return $false
    }
    Start-Sleep -Milliseconds 250
  } while ($true)
}

function Stop-MemmyLegacyProcessTree {
  param(
    [int]$ExpectedProcessId = 0,
    [string]$ExpectedExecutablePath
  )

  if ($ExpectedProcessId -gt 0) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ExpectedProcessId" -ErrorAction SilentlyContinue
    if ($process -and -not (
      Test-MemmyLegacyProcessIdentity `
        -ProcessId $ExpectedProcessId `
        -ExpectedExecutablePath $ExpectedExecutablePath
    )) {
      throw "Refusing to stop a process whose executable path does not match the legacy Memmy app."
    }
  }

  $takeoverHelperPath = Join-Path $PSScriptRoot "MemmyStoreUpdate.exe"
  if (-not (Test-Path -LiteralPath $takeoverHelperPath -PathType Leaf)) {
    throw "The native legacy takeover helper is unavailable."
  }
  $legacyInstallDirectory = Join-Path $env:LOCALAPPDATA "Programs\Memmy"
  $helperOutput = @(
    & $takeoverHelperPath `
      "prepare-legacy-takeover" `
      "--legacy-install-directory" `
      $legacyInstallDirectory 2>&1
  )
  if ($LASTEXITCODE -ne 0) {
    $details = ($helperOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    throw "The native legacy takeover helper failed with exit code $LASTEXITCODE. $details"
  }
}

function Watch-MemmyLegacyRelaunch {
  Stop-MemmyLegacyProcessTree
}

function Get-MemmyStoreMigrationMarkerPath {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is unavailable."
  }
  return Join-Path $env:LOCALAPPDATA "Memmy\launcher\store-migration-in-progress-v1.json"
}

function Write-MemmyStoreMigrationMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TargetAumId,
    [Parameter(Mandatory = $true)][string]$TargetInstallerPath,
    [Parameter(Mandatory = $true)][int]$TargetLegacyProcessId,
    [Parameter(Mandatory = $true)][string]$TargetLegacyExecutablePath
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $value = [ordered]@{
    version = 1
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    aumid = $TargetAumId
    installerPath = $TargetInstallerPath
    legacyProcessId = $TargetLegacyProcessId
    legacyExecutablePath = $TargetLegacyExecutablePath
  }
  Set-Content -LiteralPath $Path -Value ($value | ConvertTo-Json -Compress) -Encoding UTF8
}

function Remove-MemmyLegacyLauncherDirectory {
  $launcherDirectory = Split-Path -Parent (Get-MemmyStoreMigrationMarkerPath)
  if (Test-Path -LiteralPath $launcherDirectory -PathType Container) {
    Remove-Item `
      -LiteralPath $launcherDirectory `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
}

function Test-MemmyShortcutReferencesLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$LauncherPath
  )

  if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    return $false
  }

  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $arguments = ([string]$shortcut.Arguments).Trim()
    if ($arguments.Length -ge 2 -and $arguments[0] -eq '"' -and $arguments[$arguments.Length - 1] -eq '"') {
      $arguments = $arguments.Substring(1, $arguments.Length - 2)
    }
    $actualLauncherPath = Resolve-MemmyComparablePath -Path $arguments
    $expectedLauncherPath = Resolve-MemmyComparablePath -Path $LauncherPath
    return (
      $actualLauncherPath -and
      $expectedLauncherPath -and
      $actualLauncherPath -eq $expectedLauncherPath
    )
  } catch {
    # Preserve the launcher on any inspection failure so an existing proxy never points at a
    # script that the migration watcher has already deleted.
    return $true
  } finally {
    if ($shortcut) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    if ($shell) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
  }
}

function Test-MemmyLegacyLaunchProxyHandoff {
  $launcherPath = Join-Path (
    Split-Path -Parent (Get-MemmyStoreMigrationMarkerPath)
  ) "MemmyLauncher.vbs"
  $shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Memmy.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "Memmy.lnk")
  )
  foreach ($shortcutPath in $shortcutPaths) {
    if (
      Test-MemmyShortcutReferencesLauncher `
        -ShortcutPath $shortcutPath `
        -LauncherPath $launcherPath
    ) {
      return $false
    }
  }
  return $true
}

function Remove-MemmyLegacyRegistration {
  $legacyRegistryKeys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\886615f7-a04c-57ec-a2dd-9161dbe1a7c4",
    "HKCU:\Software\886615f7-a04c-57ec-a2dd-9161dbe1a7c4"
  )
  foreach ($legacyRegistryKey in $legacyRegistryKeys) {
    if (Test-Path -LiteralPath $legacyRegistryKey) {
      Remove-Item -LiteralPath $legacyRegistryKey -Recurse -Force
    }
  }

  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($valueName in @("Memmy", "memmy")) {
    if (Get-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue) {
      Remove-ItemProperty -LiteralPath $runKey -Name $valueName -Force
    }
  }
}

function Get-MemmyStorePackage {
  param([Parameter(Mandatory = $true)][string]$PackageFamilyName)

  return Get-AppxPackage |
    Where-Object PackageFamilyName -EQ $PackageFamilyName |
    Select-Object -First 1
}

function Wait-MemmyStorePackage {
  param(
    [Parameter(Mandatory = $true)][string]$PackageFamilyName,
    [int]$TimeoutSeconds,
    [switch]$BlockLegacyRelaunch
  )

  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSeconds))
  do {
    if ($BlockLegacyRelaunch) {
      Watch-MemmyLegacyRelaunch
    }
    $package = Get-MemmyStorePackage -PackageFamilyName $PackageFamilyName
    if (Test-MemmyStorePackageStatus $package) {
      return $package
    }
    if ((Get-Date) -ge $deadline) {
      return $null
    }
    Start-Sleep -Seconds 2
  } while ($true)
}

function Test-MemmyStoreReadyMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedAumId
  )

  try {
    $value = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    return [int]$value.version -eq 1 -and [string]$value.aumid -eq $ExpectedAumId
  } catch {
    return $false
  }
}

function Wait-MemmyStoreReadyMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedAumId,
    [int]$TimeoutSeconds,
    [switch]$BlockLegacyRelaunch
  )

  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSeconds))
  do {
    if ($BlockLegacyRelaunch) {
      Watch-MemmyLegacyRelaunch
    }
    if (Test-MemmyStoreReadyMarker -Path $Path -ExpectedAumId $ExpectedAumId) {
      return $true
    }
    if ((Get-Date) -ge $deadline) {
      return $false
    }
    Start-Sleep -Milliseconds 500
  } while ($true)
}

function Invoke-MemmyStoreActivation {
  param([Parameter(Mandatory = $true)][string]$TargetAumId)

  if (-not ("Memmy.StoreActivation" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace Memmy
{
    [Flags]
    internal enum ActivateOptions
    {
        None = 0
    }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);

        [PreserveSig]
        int ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    internal class ApplicationActivationManager
    {
    }

    public sealed class StoreActivationResult
    {
        public int HResult { get; set; }
        public uint ProcessId { get; set; }
    }

    public static class StoreActivation
    {
        public static StoreActivationResult Activate(string aumid)
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            var hresult = manager.ActivateApplication(aumid, null, ActivateOptions.None, out processId);
            return new StoreActivationResult { HResult = hresult, ProcessId = processId };
        }
    }
}
"@
  }

  return [Memmy.StoreActivation]::Activate($TargetAumId)
}

if ($MyInvocation.InvocationName -ne ".") {
  if ($AumId -notmatch '^[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}$') {
    exit 4
  }

  $packageFamilyName = $AumId.Split("!", 2)[0]
  $mutexName = "Local\MemmyStoreMigration_v1"
  $mutex = [Threading.Mutex]::new($false, $mutexName)
  $ownsMutex = $false
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }
  if (-not $ownsMutex) {
    $mutex.Dispose()
    exit 0
  }

  $isMigrationWatcher = (
    $InstallerPath -or
    $LegacyProcessId -gt 0 -or
    $LegacyExecutablePath
  )
  $migrationMarkerPath = $null
  try {
    # Owning the migration mutex proves that no active watcher still owns this marker. The same
    # finally block therefore clears stale barriers for normal launcher activation failures.
    $migrationMarkerPath = Get-MemmyStoreMigrationMarkerPath
    if ($isMigrationWatcher) {
      if (
        -not $InstallerPath -or
        $LegacyProcessId -le 0 -or
        -not $LegacyExecutablePath -or
        -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf) -or
        -not $InstallerPath.ToLowerInvariant().EndsWith(".store-web-installer.exe") -or
        -not (Test-MemmyLegacyExecutablePath -Path $LegacyExecutablePath)
      ) {
        exit 4
      }

      Write-MemmyStoreMigrationMarker `
        -Path $migrationMarkerPath `
        -TargetAumId $AumId `
        -TargetInstallerPath $InstallerPath `
        -TargetLegacyProcessId $LegacyProcessId `
        -TargetLegacyExecutablePath $LegacyExecutablePath

      if (-not (
        Wait-MemmyLegacyProcessExit `
          -ProcessId $LegacyProcessId `
          -ExpectedExecutablePath $LegacyExecutablePath `
          -TimeoutSeconds $LegacyExitTimeoutSeconds
      )) {
        Stop-MemmyLegacyProcessTree `
          -ExpectedProcessId $LegacyProcessId `
          -ExpectedExecutablePath $LegacyExecutablePath
      }
      Watch-MemmyLegacyRelaunch
      Start-Process -FilePath $InstallerPath | Out-Null
    }

    $package = if ($WaitForPackageSeconds -gt 0) {
      Wait-MemmyStorePackage `
        -PackageFamilyName $packageFamilyName `
        -TimeoutSeconds $WaitForPackageSeconds `
        -BlockLegacyRelaunch:$isMigrationWatcher
    } else {
      Get-MemmyStorePackage -PackageFamilyName $packageFamilyName
    }
    if (-not (Test-MemmyStorePackageStatus $package)) {
      exit 2
    }

    $readyMarkerPath = Join-Path $env:LOCALAPPDATA (
      "Packages\{0}\LocalState\Memmy\legacy-cleanup-completed-v1.json" -f $packageFamilyName
    )
    if ($WaitForPackageSeconds -gt 0) {
      Remove-Item -LiteralPath $readyMarkerPath -Force -ErrorAction SilentlyContinue
    }
    $result = Invoke-MemmyStoreActivation -TargetAumId $AumId
    if (Test-MemmyStoreActivationResult -HResult $result.HResult -ProcessId $result.ProcessId) {
      if ($WaitForReadySeconds -gt 0 -and -not (
        Wait-MemmyStoreReadyMarker `
          -Path $readyMarkerPath `
          -ExpectedAumId $AumId `
          -TimeoutSeconds $WaitForReadySeconds `
          -BlockLegacyRelaunch:$isMigrationWatcher
      )) {
        exit 5
      }
      # This script runs from the unpackaged NSIS launch proxy. Delete the real HKCU legacy
      # registration only after Windows confirms activation and, for migration watchers, after
      # the Store app has completed its first-boot cleanup.
      Remove-MemmyLegacyRegistration
      if (Test-MemmyLegacyLaunchProxyHandoff) {
        Remove-MemmyLegacyLauncherDirectory
      }
      exit 0
    }
  } catch {
    exit 3
  } finally {
    if ($migrationMarkerPath) {
      Remove-Item -LiteralPath $migrationMarkerPath -Force -ErrorAction SilentlyContinue
    }
    if ($ownsMutex) {
      $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
  }
  exit 3
}
