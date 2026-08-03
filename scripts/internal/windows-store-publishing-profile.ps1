Set-StrictMode -Version Latest

if (-not ([Management.Automation.PSTypeName]"Memmy.StorePublishing.PackageIdentityNative").Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Memmy.StorePublishing {
  public static class PackageIdentityNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PackageId {
      public UInt32 Reserved;
      public UInt32 ProcessorArchitecture;
      public UInt64 Version;
      [MarshalAs(UnmanagedType.LPWStr)] public string Name;
      [MarshalAs(UnmanagedType.LPWStr)] public string Publisher;
      [MarshalAs(UnmanagedType.LPWStr)] public string ResourceId;
      [MarshalAs(UnmanagedType.LPWStr)] public string PublisherId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int PackageFamilyNameFromId(
      ref PackageId packageId,
      ref UInt32 packageFamilyNameLength,
      StringBuilder packageFamilyName
    );

    public static string GetPackageFamilyName(string name, string publisher) {
      var packageId = new PackageId {
        Name = name,
        Publisher = publisher,
        ResourceId = String.Empty,
        PublisherId = null
      };
      UInt32 length = 0;
      var result = PackageFamilyNameFromId(ref packageId, ref length, null);
      const int ErrorInsufficientBuffer = 122;
      if (result != ErrorInsufficientBuffer) {
        throw new InvalidOperationException("PackageFamilyNameFromId size query failed with error " + result + ".");
      }
      var value = new StringBuilder((int)length);
      result = PackageFamilyNameFromId(ref packageId, ref length, value);
      if (result != 0) {
        throw new InvalidOperationException("PackageFamilyNameFromId failed with error " + result + ".");
      }
      return value.ToString();
    }
  }
}
'@
}

function Get-RequiredStorePublishingValue {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$PropertyName,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  $property = $Object.PSObject.Properties[$PropertyName]
  if (-not $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    throw "Windows Store publishing profile '$ProfileName' is not configured: missing $PropertyName."
  }
  return [string]$property.Value
}

function Register-UniqueStorePublishingValue {
  param(
    [Parameter(Mandatory = $true)][hashtable]$SeenValues,
    [Parameter(Mandatory = $true)][string]$FieldName,
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }
  if ($SeenValues.ContainsKey($Value)) {
    throw "Windows Store publishing profiles '$($SeenValues[$Value])' and '$ProfileName' reuse $FieldName '$Value'. Each configured profile must use a unique Store product identity."
  }
  $SeenValues[$Value] = $ProfileName
}

function Assert-UniqueStorePublishingIdentities {
  param([Parameter(Mandatory = $true)]$Config)

  $seenStoreProductIds = @{}
  $seenPackageFamilyNames = @{}
  $seenAumids = @{}
  foreach ($environmentProperty in $Config.environments.PSObject.Properties) {
    $applicationsProperty = $environmentProperty.Value.PSObject.Properties["applications"]
    if (-not $applicationsProperty -or $null -eq $applicationsProperty.Value) {
      continue
    }
    foreach ($applicationProperty in $applicationsProperty.Value.PSObject.Properties) {
      if ($null -eq $applicationProperty.Value) {
        continue
      }
      $profileName = "$($environmentProperty.Name)/$($applicationProperty.Name)"
      $applicationConfig = $applicationProperty.Value
      $storeProductIdProperty = $applicationConfig.PSObject.Properties["storeProductId"]
      $packageFamilyNameProperty = $applicationConfig.PSObject.Properties["packageFamilyName"]
      $manifestApplicationIdProperty = $applicationConfig.PSObject.Properties["manifestApplicationId"]
      $storeProductId = if ($storeProductIdProperty) { [string]$storeProductIdProperty.Value } else { "" }
      $packageFamilyName = if ($packageFamilyNameProperty) { [string]$packageFamilyNameProperty.Value } else { "" }
      $manifestApplicationId = if ($manifestApplicationIdProperty) {
        [string]$manifestApplicationIdProperty.Value
      } else {
        ""
      }
      $aumid = if ($packageFamilyName -and $manifestApplicationId) {
        "$packageFamilyName!$manifestApplicationId"
      } else {
        ""
      }

      Register-UniqueStorePublishingValue `
        -SeenValues $seenStoreProductIds `
        -FieldName "storeProductId" `
        -Value $storeProductId `
        -ProfileName $profileName
      Register-UniqueStorePublishingValue `
        -SeenValues $seenAumids `
        -FieldName "AUMID" `
        -Value $aumid `
        -ProfileName $profileName
      Register-UniqueStorePublishingValue `
        -SeenValues $seenPackageFamilyNames `
        -FieldName "packageFamilyName" `
        -Value $packageFamilyName `
        -ProfileName $profileName
    }
  }
}

function Resolve-MemmyStorePublishingProfile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][ValidateSet("cn", "intl")][string]$Channel
  )

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Windows Store publishing config was not found: $ConfigPath"
  }

  try {
    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  } catch {
    throw "Windows Store publishing config is invalid JSON: $ConfigPath. $($_.Exception.Message)"
  }
  Assert-UniqueStorePublishingIdentities -Config $config

  $installedDisplayName = Get-RequiredStorePublishingValue `
    -Object $config `
    -PropertyName "installedDisplayName" `
    -ProfileName "$Environment/$Channel"

  $environmentProperty = $config.environments.PSObject.Properties[$Environment]
  if (-not $environmentProperty -or $null -eq $environmentProperty.Value) {
    throw "Windows Store publishing environment '$Environment' is not configured in $ConfigPath."
  }

  $environmentConfig = $environmentProperty.Value
  $profileName = "$Environment/$Channel"
  $applicationProperty = $environmentConfig.applications.PSObject.Properties[$Channel]
  if (-not $applicationProperty -or $null -eq $applicationProperty.Value) {
    throw "Windows Store publishing profile '$profileName' is not configured."
  }

  $applicationConfig = $applicationProperty.Value
  $publisher = Get-RequiredStorePublishingValue `
    -Object $environmentConfig `
    -PropertyName "publisher" `
    -ProfileName $profileName
  $publisherDisplayName = Get-RequiredStorePublishingValue `
    -Object $environmentConfig `
    -PropertyName "publisherDisplayName" `
    -ProfileName $profileName
  $storeProductId = Get-RequiredStorePublishingValue `
    -Object $applicationConfig `
    -PropertyName "storeProductId" `
    -ProfileName $profileName
  $identityName = Get-RequiredStorePublishingValue `
    -Object $applicationConfig `
    -PropertyName "identityName" `
    -ProfileName $profileName
  $applicationId = Get-RequiredStorePublishingValue `
    -Object $applicationConfig `
    -PropertyName "manifestApplicationId" `
    -ProfileName $profileName
  $displayName = Get-RequiredStorePublishingValue `
    -Object $applicationConfig `
    -PropertyName "displayName" `
    -ProfileName $profileName
  $packageFamilyName = Get-RequiredStorePublishingValue `
    -Object $applicationConfig `
    -PropertyName "packageFamilyName" `
    -ProfileName $profileName

  $restrictedApplicationIds = @(
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
  )
  if ($storeProductId -notmatch '^[A-Z0-9]{12}$') {
    throw "Windows Store publishing profile '$profileName' has an invalid storeProductId."
  }
  if (
    $identityName -notmatch '^[A-Za-z0-9.-]{3,50}$' -or
    $restrictedApplicationIds -contains $identityName.ToUpperInvariant()
  ) {
    throw "Windows Store publishing profile '$profileName' has an invalid identityName."
  }
  if (
    $applicationId.Length -gt 64 -or
    $applicationId -notmatch '^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$' -or
    $restrictedApplicationIds -contains $applicationId.ToUpperInvariant()
  ) {
    throw "Windows Store publishing profile '$profileName' has an invalid manifestApplicationId."
  }
  if (
    $packageFamilyName -notmatch '^[A-Za-z0-9.-]+_[a-z0-9]{13}$' -or
    -not $packageFamilyName.StartsWith("$identityName`_", [StringComparison]::Ordinal)
  ) {
    throw "Windows Store publishing profile '$profileName' has a packageFamilyName that does not match identityName."
  }
  $expectedPackageFamilyName = [Memmy.StorePublishing.PackageIdentityNative]::GetPackageFamilyName(
    $identityName,
    $publisher
  )
  if (-not [string]::Equals($packageFamilyName, $expectedPackageFamilyName, [StringComparison]::Ordinal)) {
    throw "Windows Store publishing profile '$profileName' packageFamilyName does not match identityName and publisher; expected '$expectedPackageFamilyName'."
  }

  $aumid = "$packageFamilyName!$applicationId"
  return [pscustomobject]@{
    Environment = $Environment
    Channel = $Channel
    Publisher = $publisher
    PublisherDisplayName = $publisherDisplayName
    StoreProductId = $storeProductId
    IdentityName = $identityName
    ApplicationId = $applicationId
    DisplayName = $displayName
    InstalledDisplayName = $installedDisplayName
    PackageFamilyName = $packageFamilyName
    Aumid = $aumid
    ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
  }
}
