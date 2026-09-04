[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("StoreUpload", "LocalTest")]
  [string]$Mode,
  [ValidateSet("cn", "intl")]
  [string]$Channel,
  [string]$Version,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$desktopDirectory = Join-Path $root "App\shell\desktop"
$profileResolverPath = Join-Path $PSScriptRoot "windows-store-publishing-profile.ps1"
. $profileResolverPath
$manifestVerifierPath = Join-Path $PSScriptRoot "windows-store-msix-manifest.ps1"
. $manifestVerifierPath

function Get-WindowsSdkTool {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "x64\$Name" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }
  throw "Windows SDK tool was not found: $Name"
}

function Enter-MemmyStorePublicationLock {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
  try {
    return [IO.File]::Open(
      $LockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "Another Memmy Windows Store package is publishing canonical or local-test MSIX artifacts. Wait for it to finish."
  }
}

function Assert-SigningCertificatePublisher {
  param(
    [Parameter(Mandatory = $true)]
    [Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher
  )

  if (-not [string]::Equals(
    $Certificate.Subject,
    $ExpectedPublisher,
    [StringComparison]::Ordinal
  )) {
    throw "Signing certificate subject '$($Certificate.Subject)' does not exactly match manifest publisher '$ExpectedPublisher'."
  }
  if (-not $Certificate.HasPrivateKey) {
    throw "The local-test signing certificate does not expose a private key."
  }
}

function Resolve-LocalSigningConfiguration {
  param([Parameter(Mandatory = $true)][string]$ExpectedPublisher)

  $certificateSha1 = $env:MEMMY_STORE_LOCAL_CERT_SHA1
  $pfxPath = $env:MEMMY_STORE_LOCAL_PFX
  $pfxPassword = $env:MEMMY_STORE_LOCAL_PFX_PASSWORD
  $certificateStore = if ($env:MEMMY_STORE_LOCAL_CERT_STORE) {
    $env:MEMMY_STORE_LOCAL_CERT_STORE
  } else {
    "CurrentUser"
  }
  $timestampUrl = $env:MEMMY_STORE_LOCAL_TIMESTAMP_URL

  if ($certificateSha1 -and $pfxPath) {
    throw "Choose exactly one local signing source: MEMMY_STORE_LOCAL_CERT_SHA1 or MEMMY_STORE_LOCAL_PFX."
  }
  if (-not $certificateSha1 -and -not $pfxPath) {
    throw "LocalTest requires MEMMY_STORE_LOCAL_CERT_SHA1 or MEMMY_STORE_LOCAL_PFX."
  }
  if ($certificateStore -notin @("CurrentUser", "LocalMachine")) {
    throw "MEMMY_STORE_LOCAL_CERT_STORE must be CurrentUser or LocalMachine."
  }
  if ($timestampUrl) {
    $parsedTimestampUrl = $null
    if (
      -not [Uri]::TryCreate($timestampUrl, [UriKind]::Absolute, [ref]$parsedTimestampUrl) -or
      $parsedTimestampUrl.Scheme -ne "https"
    ) {
      throw "MEMMY_STORE_LOCAL_TIMESTAMP_URL must be an absolute HTTPS URL."
    }
  }

  if ($certificateSha1) {
    $normalizedThumbprint = $certificateSha1.Replace(" ", "").ToUpperInvariant()
    if ($normalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
      throw "MEMMY_STORE_LOCAL_CERT_SHA1 must be a 40-character SHA-1 thumbprint."
    }
    $certificatePath = "Cert:\$certificateStore\My\$normalizedThumbprint"
    $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction SilentlyContinue
    if (-not $certificate) {
      throw "Local-test signing certificate was not found: $certificatePath"
    }
    Assert-SigningCertificatePublisher `
      -Certificate $certificate `
      -ExpectedPublisher $ExpectedPublisher
    return [pscustomobject]@{
      Kind = "CertificateStore"
      Thumbprint = $normalizedThumbprint
      Publisher = $certificate.Subject
      Store = $certificateStore
      PfxPath = $null
      PfxPassword = $null
      TimestampUrl = $timestampUrl
    }
  }

  $resolvedPfxPath = (Resolve-Path -LiteralPath $pfxPath).Path
  $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $resolvedPfxPath,
    $pfxPassword,
    $flags
  )
  try {
    Assert-SigningCertificatePublisher `
      -Certificate $certificate `
      -ExpectedPublisher $ExpectedPublisher
    $pfxThumbprint = $certificate.Thumbprint.ToUpperInvariant()
    $pfxPublisher = $certificate.Subject
  } finally {
    $certificate.Dispose()
  }
  return [pscustomobject]@{
    Kind = "Pfx"
    Thumbprint = $pfxThumbprint
    Publisher = $pfxPublisher
    Store = $null
    PfxPath = $resolvedPfxPath
    PfxPassword = $pfxPassword
    TimestampUrl = $timestampUrl
  }
}

function Assert-MsixIsUnsigned {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    if ($archive.GetEntry("AppxSignature.p7x")) {
      throw "StoreUpload artifact unexpectedly contains AppxSignature.p7x: $PackagePath"
    }
  } finally {
    $archive.Dispose()
  }
}

function Assert-MsixContainsWindowsStoreTransitionHelper {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expectedEntryPath = "app/resources/native/MemmyStoreUpdate.exe"
  $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    $entry = $archive.GetEntry($expectedEntryPath)
    if (-not $entry -or $entry.Length -le 0) {
      throw "MSIX is missing the packaged Windows Store transition helper '$expectedEntryPath': $PackagePath"
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-MsixPayloadEntries {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $signatureMetadataPaths = @(
    "AppxSignature.p7x",
    "[Content_Types].xml",
    "AppxMetadata/CodeIntegrity.cat"
  )
  $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    foreach ($entry in ($archive.Entries | Sort-Object FullName)) {
      if (-not $entry.Name -or $entry.FullName -in $signatureMetadataPaths) {
        continue
      }
      $stream = $entry.Open()
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try {
        $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
      } finally {
        $sha256.Dispose()
        $stream.Dispose()
      }
      [pscustomobject]@{
        Path = $entry.FullName
        SHA256 = $hash
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Assert-MsixPayloadParity {
  param(
    [Parameter(Mandatory = $true)][string]$UnsignedPackagePath,
    [Parameter(Mandatory = $true)][string]$SignedPackagePath
  )

  $unsignedEntries = @(Get-MsixPayloadEntries -PackagePath $UnsignedPackagePath)
  $signedEntries = @(Get-MsixPayloadEntries -PackagePath $SignedPackagePath)
  $differences = Compare-Object `
    -ReferenceObject $unsignedEntries `
    -DifferenceObject $signedEntries `
    -Property Path, SHA256
  if ($differences) {
    $details = ($differences | ForEach-Object {
      "$($_.SideIndicator) $($_.Path) $($_.SHA256)"
    }) -join "; "
    throw "Local-test signed MSIX payload differs from the canonical unsigned package: $details"
  }
}

function Sign-LocalTestMsix {
  param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)]$SigningConfiguration
  )

  $signTool = Get-WindowsSdkTool -Name "signtool.exe"
  $arguments = @("sign", "/fd", "SHA256")
  if ($SigningConfiguration.Kind -eq "CertificateStore") {
    $arguments += @("/sha1", $SigningConfiguration.Thumbprint)
    if ($SigningConfiguration.Store -eq "LocalMachine") {
      $arguments += "/sm"
    }
  } else {
    $arguments += @("/f", $SigningConfiguration.PfxPath)
    if ($null -ne $SigningConfiguration.PfxPassword) {
      $arguments += @("/p", $SigningConfiguration.PfxPassword)
    }
  }
  if ($SigningConfiguration.TimestampUrl) {
    $arguments += @(
      "/tr",
      $SigningConfiguration.TimestampUrl,
      "/td",
      "SHA256"
    )
  }
  $arguments += $PackagePath

  & $signTool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK SignTool signing failed with exit code $LASTEXITCODE"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $PackagePath
  if (-not $signature.SignerCertificate) {
    throw "Local-test MSIX does not contain an Authenticode signer certificate: $PackagePath"
  }
  $actualThumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
  if (-not [string]::Equals(
    $actualThumbprint,
    $SigningConfiguration.Thumbprint,
    [StringComparison]::Ordinal
  )) {
    throw "Local-test MSIX signer thumbprint mismatch. Expected '$($SigningConfiguration.Thumbprint)', found '$actualThumbprint'."
  }
  if (-not [string]::Equals(
    $signature.SignerCertificate.Subject,
    $SigningConfiguration.Publisher,
    [StringComparison]::Ordinal
  )) {
    throw "Local-test MSIX signer publisher mismatch. Expected '$($SigningConfiguration.Publisher)', found '$($signature.SignerCertificate.Subject)'."
  }
  if ($signature.Status -eq [Management.Automation.SignatureStatus]::Valid) {
    return
  }
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::UnknownError) {
    throw "Local-test MSIX Authenticode verification failed with status '$($signature.Status)': $($signature.StatusMessage)"
  }

  $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $chain.ChainPolicy.RevocationMode = `
      [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    [void]$chain.Build($signature.SignerCertificate)
    $chainStatuses = @($chain.ChainStatus | ForEach-Object { $_.Status })
    if (
      $chainStatuses.Count -ne 1 -or
      $chainStatuses[0] -ne `
        [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::UntrustedRoot
    ) {
      $statusText = (@($chain.ChainStatus) | ForEach-Object {
        "$($_.Status): $($_.StatusInformation.Trim())"
      }) -join "; "
      throw "Local-test MSIX certificate chain failed for an unexpected reason: $statusText"
    }
  } finally {
    $chain.Dispose()
  }
}

$resolvedChannel = if ($Channel) {
  $Channel
} elseif ($env:MEMMY_ACCOUNT_CHANNEL -eq "phone") {
  "cn"
} elseif ($env:MEMMY_ACCOUNT_CHANNEL -eq "email") {
  "intl"
} else {
  throw "Choose -Channel cn|intl or set MEMMY_ACCOUNT_CHANNEL=phone|email."
}
$resolvedVersion = if ($Version) {
  $Version
} else {
  (Get-Content -Raw -LiteralPath (Join-Path $desktopDirectory "package.json") |
    ConvertFrom-Json).version
}
if ($resolvedVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw "Windows Store package version must be a three-part SemVer."
}
foreach ($segment in $resolvedVersion.Split(".")) {
  [uint32]$segmentValue = 0
  if (-not [uint32]::TryParse($segment, [ref]$segmentValue) -or $segmentValue -gt 65535) {
    throw "MSIX version segments must be between 0 and 65535: $resolvedVersion"
  }
}
$expectedMsixPackageVersion = "$resolvedVersion.0"

if ($env:MEMMY_STORE_PUBLISHING_CONFIG_PATH) {
  throw "MEMMY_STORE_PUBLISHING_CONFIG_PATH is not supported by the canonical Windows Store packaging entrypoint."
}
$resolvedPublishingConfigPath = Join-Path `
  $desktopDirectory `
  "build\store-publishing-profiles.json"
$profile = Resolve-MemmyStorePublishingProfile `
  -ConfigPath $resolvedPublishingConfigPath `
  -Channel $resolvedChannel

$localSigningVariableNames = @(
  "MEMMY_STORE_LOCAL_CERT_SHA1",
  "MEMMY_STORE_LOCAL_CERT_STORE",
  "MEMMY_STORE_LOCAL_PFX",
  "MEMMY_STORE_LOCAL_PFX_PASSWORD",
  "MEMMY_STORE_LOCAL_TIMESTAMP_URL"
)
if ($Mode -eq "StoreUpload") {
  foreach ($name in $localSigningVariableNames) {
    if ([Environment]::GetEnvironmentVariable($name, "Process")) {
      throw "$name is local-test only and must be unset for StoreUpload."
    }
  }
  if ($Install) {
    throw "StoreUpload produces a canonical unsigned submission artifact and cannot be installed directly."
  }
  $signingConfiguration = $null
} else {
  $signingConfiguration = Resolve-LocalSigningConfiguration `
    -ExpectedPublisher $profile.Publisher
}

$unsignedArtifactName = "Memmy-$resolvedVersion-win32-x64-$resolvedChannel-store-upload.msix"
$unsignedArtifactPath = Join-Path $desktopDirectory "release\$unsignedArtifactName"
$localTestArtifactName = "Memmy-$resolvedVersion-win32-x64-$resolvedChannel-local-test.msix"
$localTestArtifactPath = Join-Path $desktopDirectory "release\$localTestArtifactName"
$stagingId = "$PID-$([Guid]::NewGuid().ToString('N'))"
$unsignedStagingArtifactName = "Memmy-$resolvedVersion-win32-x64-$resolvedChannel-store-staging-$stagingId.msix"
$unsignedStagingArtifactPath = Join-Path `
  $desktopDirectory `
  "release\$unsignedStagingArtifactName"
$localTestStagingArtifactPath = Join-Path `
  $desktopDirectory `
  "release\Memmy-$resolvedVersion-win32-x64-$resolvedChannel-local-test-staging-$stagingId.msix"
$extensionsTemplatePath = Join-Path $desktopDirectory "build\appx-extensions.xml"
$generatedExtensionsRelativePath = "build/appx-extensions.generated.$PID.xml"
$generatedExtensionsPath = Join-Path $desktopDirectory $generatedExtensionsRelativePath
$extensionsTemplate = Get-Content -Raw -LiteralPath $extensionsTemplatePath
foreach ($placeholder in @(
  "__MEMMY_LEGACY_NSIS_AUMID__",
  "__MEMMY_STORE_EXECUTABLE__"
)) {
  if (-not $extensionsTemplate.Contains($placeholder)) {
    throw "Store extensions template is missing $placeholder`: $extensionsTemplatePath"
  }
}
$generatedExtensions = $extensionsTemplate.Replace(
  "__MEMMY_LEGACY_NSIS_AUMID__",
  [Security.SecurityElement]::Escape($profile.LegacyNsisAumid)
)
$generatedExtensions = $generatedExtensions.Replace(
  "__MEMMY_STORE_EXECUTABLE__",
  "app\Memmy.exe"
)

$packagingEnvironment = [ordered]@{
  MEMMY_WINDOWS_TARGET = "appx"
  MEMMY_WINDOWS_BUILDER_CONFIG = "electron-builder.store.unsigned.yml"
  MEMMY_WINDOWS_APPX_IDENTITY_NAME = $profile.IdentityName
  MEMMY_WINDOWS_APPX_APPLICATION_ID = $profile.ApplicationId
  MEMMY_WINDOWS_APPX_PUBLISHER = $profile.Publisher
  MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME = $profile.PublisherDisplayName
  MEMMY_WINDOWS_APPX_DISPLAY_NAME = $profile.WindowsDisplayName
  MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH = "build/appx-manifest.xml"
  MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH = $generatedExtensionsRelativePath
  MEMMY_WINDOWS_APPX_ARTIFACT_NAME = $unsignedStagingArtifactName
  MEMMY_WINDOWS_ARTIFACT_NAME = $unsignedStagingArtifactName
  MEMMY_WINDOWS_FINAL_ARTIFACT = $unsignedStagingArtifactPath.Replace("\", "/")
  MEMMY_STORE_PRODUCT_ID = $profile.StoreProductId
  MEMMY_STORE_LISTING_DISPLAY_NAME = $profile.StoreListingDisplayName
  MEMMY_STORE_PUBLISHER = $profile.Publisher
  MEMMY_STORE_PUBLISHER_DISPLAY_NAME = $profile.PublisherDisplayName
  MEMMY_STORE_WINDOWS_DISPLAY_NAME = $profile.WindowsDisplayName
  MEMMY_STORE_IDENTITY_NAME = $profile.IdentityName
  MEMMY_STORE_APPLICATION_ID = $profile.ApplicationId
  MEMMY_STORE_PACKAGE_FAMILY_NAME = $profile.PackageFamilyName
  MEMMY_STORE_AUMID = $profile.Aumid
  MEMMY_STORE_LEGACY_NSIS_AUMID = $profile.LegacyNsisAumid
  MEMMY_WINDOWS_BUILD_LOCK_HELD = $null
  MEMMY_WINDOWS_BUILD_LOCK_TOKEN = $null
  MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID = $null
  MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE = $null
  MEMMY_STORE_LOCAL_CERT_SHA1 = $null
  MEMMY_STORE_LOCAL_CERT_STORE = $null
  MEMMY_STORE_LOCAL_PFX = $null
  MEMMY_STORE_LOCAL_PFX_PASSWORD = $null
  MEMMY_STORE_LOCAL_TIMESTAMP_URL = $null
  CSC_LINK = $null
  CSC_KEY_PASSWORD = $null
  WIN_CSC_LINK = $null
  WIN_CSC_KEY_PASSWORD = $null
  WIN_CSC_SHA1 = $null
  WIN_CSC_SUBJECT_NAME = $null
  WIN_CSC_TIMESTAMP_SERVER = $null
}
$originalPackagingEnvironment = @{}
foreach ($name in $packagingEnvironment.Keys) {
  $originalPackagingEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}
$originalSkipCodesign = [Environment]::GetEnvironmentVariable(
  "MEMMY_SKIP_CODESIGN",
  [EnvironmentVariableTarget]::Process
)
$makeAppx = Get-WindowsSdkTool -Name "makeappx.exe"
$publicationLockPath = Join-Path $desktopDirectory "release\.memmy-store-publication"

try {
  [IO.File]::WriteAllText(
    $generatedExtensionsPath,
    $generatedExtensions,
    [Text.UTF8Encoding]::new($false)
  )
  foreach ($name in $packagingEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $packagingEnvironment[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
  $env:MEMMY_SKIP_CODESIGN = "1"

  Remove-Item -LiteralPath $unsignedStagingArtifactPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $localTestStagingArtifactPath -Force -ErrorAction SilentlyContinue
  $bash = (Get-Command bash -ErrorAction Stop).Source
  $packageScript = (Join-Path $root "scripts\package-win.sh").Replace("\", "/")
  & $bash `
    $packageScript `
    --version $resolvedVersion `
    --arch x64 `
    --edition $resolvedChannel `
    --sign unsigned
  if ($LASTEXITCODE -ne 0) {
    throw "Windows Store MSIX packaging failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $unsignedStagingArtifactPath -PathType Leaf)) {
    throw "Canonical unsigned Store staging artifact was not created: $unsignedStagingArtifactPath"
  }
  $publicationLock = Enter-MemmyStorePublicationLock `
    -LockPath $publicationLockPath
  try {
    Assert-MsixIsUnsigned -PackagePath $unsignedStagingArtifactPath
    Assert-MsixContainsWindowsStoreTransitionHelper `
      -PackagePath $unsignedStagingArtifactPath
    Assert-MemmyWindowsStoreMsixManifest `
      -PackagePath $unsignedStagingArtifactPath `
      -Profile $profile `
      -MakeAppxPath $makeAppx `
      -ExpectedPackageVersion $expectedMsixPackageVersion `
      -ExpectedExecutable "app\Memmy.exe" `
      -ExpectedLegacyNsisAumid $profile.LegacyNsisAumid | Out-Null

    if ($Mode -eq "LocalTest") {
      Copy-Item `
        -LiteralPath $unsignedStagingArtifactPath `
        -Destination $localTestStagingArtifactPath `
        -Force
      Sign-LocalTestMsix `
        -PackagePath $localTestStagingArtifactPath `
        -SigningConfiguration $signingConfiguration
      Assert-MsixPayloadParity `
        -UnsignedPackagePath $unsignedStagingArtifactPath `
        -SignedPackagePath $localTestStagingArtifactPath
      Assert-MsixContainsWindowsStoreTransitionHelper `
        -PackagePath $localTestStagingArtifactPath
      Assert-MemmyWindowsStoreMsixManifest `
        -PackagePath $localTestStagingArtifactPath `
        -Profile $profile `
        -MakeAppxPath $makeAppx `
        -ExpectedPackageVersion $expectedMsixPackageVersion `
        -ExpectedExecutable "app\Memmy.exe" `
        -ExpectedLegacyNsisAumid $profile.LegacyNsisAumid | Out-Null
      Move-Item `
        -LiteralPath $unsignedStagingArtifactPath `
        -Destination $unsignedArtifactPath `
        -Force
      Move-Item `
        -LiteralPath $localTestStagingArtifactPath `
        -Destination $localTestArtifactPath `
        -Force
      if ($Install) {
        Add-AppxPackage -Path $localTestArtifactPath -ForceApplicationShutdown
      }
      Write-Host "Created local-test MSIX: $localTestArtifactPath"
    } else {
      Move-Item `
        -LiteralPath $unsignedStagingArtifactPath `
        -Destination $unsignedArtifactPath `
        -Force
      Write-Host "Created canonical unsigned Store upload MSIX: $unsignedArtifactPath"
    }
  } finally {
    $publicationLock.Dispose()
    Remove-Item -LiteralPath $publicationLockPath -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Store listing: $($profile.StoreListingDisplayName) ($($profile.StoreProductId))"
  Write-Host "Package identity: $($profile.IdentityName); AUMID: $($profile.Aumid)"
} finally {
  Remove-Item -LiteralPath $generatedExtensionsPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $unsignedStagingArtifactPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $localTestStagingArtifactPath -Force -ErrorAction SilentlyContinue
  foreach ($name in $packagingEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $originalPackagingEnvironment[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
  [Environment]::SetEnvironmentVariable(
    "MEMMY_SKIP_CODESIGN",
    $originalSkipCodesign,
    [EnvironmentVariableTarget]::Process
  )
}
