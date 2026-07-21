[CmdletBinding()]
param([string]$AumId)

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
  $package = Get-AppxPackage | Where-Object PackageFamilyName -EQ $packageFamilyName | Select-Object -First 1
  if (-not (Test-MemmyStorePackageStatus $package)) {
    exit 2
  }

  try {
    $result = Invoke-MemmyStoreActivation -TargetAumId $AumId
    if ($result.HResult -ge 0 -and $result.ProcessId -gt 0) {
      exit 0
    }
  } catch {
    exit 3
  }
  exit 3
}
