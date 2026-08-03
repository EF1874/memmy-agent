[CmdletBinding()]
param(
  [switch]$GenerateDevelopmentCertificate,
  [switch]$TrustDevelopmentCertificate,
  [switch]$GenerateLocalTestCertificate,
  [switch]$TrustLocalTestCertificate,
  [switch]$Unsigned,
  [switch]$Install,
  [string]$SigningCertificatePath,
  [string]$SigningCertificatePassword,
  [string]$SigningCertificateThumbprint,
  [ValidateSet("CurrentUser", "LocalMachine")]
  [string]$SigningCertificateStoreLocation = "CurrentUser",
  [string]$SigningTimestampServer,
  [ValidateSet("development", "personal", "company")]
  [string]$PublishingEnvironment,
  [ValidateSet("cn", "intl")]
  [string]$Channel,
  [string]$Version,
  [string]$PublishingConfigPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$desktopDirectory = Join-Path $root "App\shell\desktop"
$agentDirectory = Join-Path $root "App\memmy-agent"
$signingDirectory = Join-Path $root ".signing-local"
$pfxPath = Join-Path $signingDirectory "windows-store-development.pfx"
$cerPath = Join-Path $signingDirectory "windows-store-development.cer"
$passwordPath = Join-Path $signingDirectory "windows-store-development-password.txt"
$profileResolverPath = Join-Path $root "scripts\internal\windows-store-publishing-profile.ps1"
. $profileResolverPath

$publishingEnvironment = if ($PublishingEnvironment) {
  $PublishingEnvironment
} elseif ($env:MEMMY_STORE_PUBLISHING_ENV) {
  $env:MEMMY_STORE_PUBLISHING_ENV
} elseif ($Unsigned) {
  "personal"
} else {
  "development"
}
if ($publishingEnvironment -notin @("development", "personal", "company")) {
  throw "MEMMY_STORE_PUBLISHING_ENV must be development, personal, or company."
}
if ($Unsigned -and $publishingEnvironment -eq "development") {
  throw "Unsigned Store upload packages require personal or company publishing configuration."
}
if ($SigningCertificatePath -and $SigningCertificateThumbprint) {
  throw "Choose either a PFX signing certificate or a Windows certificate store thumbprint, not both."
}
if (
  $Unsigned -and
  ($SigningCertificatePath -or $SigningCertificateThumbprint -or $PSBoundParameters.ContainsKey("SigningCertificatePassword"))
) {
  throw "Unsigned Store upload packages cannot use signing certificate parameters."
}
if (
  ($GenerateDevelopmentCertificate -or $TrustDevelopmentCertificate) -and
  $publishingEnvironment -ne "development"
) {
  throw "Production Store profiles cannot generate or trust development certificates. Use -PublishingEnvironment development."
}
if (
  ($GenerateLocalTestCertificate -or $TrustLocalTestCertificate) -and
  $publishingEnvironment -eq "development"
) {
  throw "Local-test certificates require a personal or company Store publishing profile."
}

$channel = if ($Channel) {
  $Channel
} elseif ($env:MEMMY_ACCOUNT_CHANNEL -eq "phone") {
  "cn"
} elseif ($env:MEMMY_ACCOUNT_CHANNEL -eq "email") {
  "intl"
} elseif ($env:MEMMY_ACCOUNT_CHANNEL) {
  throw "Unsupported MEMMY_ACCOUNT_CHANNEL: $($env:MEMMY_ACCOUNT_CHANNEL)"
} elseif ($publishingEnvironment -eq "development") {
  "cn"
} else {
  throw "Choose -Channel cn|intl or set MEMMY_ACCOUNT_CHANNEL=phone|email for Store publishing."
}

$resolvedPublishingConfigPath = if ($PublishingConfigPath) {
  $PublishingConfigPath
} elseif ($env:MEMMY_STORE_PUBLISHING_CONFIG_PATH) {
  $env:MEMMY_STORE_PUBLISHING_CONFIG_PATH
} else {
  Join-Path $desktopDirectory "build\store-publishing-profiles.json"
}
if (-not [IO.Path]::IsPathRooted($resolvedPublishingConfigPath)) {
  $resolvedPublishingConfigPath = Join-Path $root $resolvedPublishingConfigPath
}

if ($publishingEnvironment -eq "development") {
  $storeProductId = $null
  $publisher = if ($env:MEMMY_STORE_PUBLISHER) { $env:MEMMY_STORE_PUBLISHER } else { "CN=Memmy Development" }
  $identityName = if ($env:MEMMY_STORE_IDENTITY_NAME) { $env:MEMMY_STORE_IDENTITY_NAME } else { "Memmy.Development" }
  $publisherDisplayName = if ($env:MEMMY_STORE_PUBLISHER_DISPLAY_NAME) {
    $env:MEMMY_STORE_PUBLISHER_DISPLAY_NAME
  } else {
    "Memmy Development"
  }
  $storeDisplayName = if ($env:MEMMY_STORE_DISPLAY_NAME) { $env:MEMMY_STORE_DISPLAY_NAME } else { "Memmy" }
  $installedDisplayName = if ($env:MEMMY_STORE_INSTALLED_DISPLAY_NAME) {
    $env:MEMMY_STORE_INSTALLED_DISPLAY_NAME
  } else {
    "Memmy"
  }
  $applicationId = if ($env:MEMMY_STORE_APPLICATION_ID) { $env:MEMMY_STORE_APPLICATION_ID } else { "Memmy" }
  $packageFamilyName = "Memmy.Development_fvzhnh4ztget6"
  $storeAumid = if ($env:MEMMY_STORE_AUMID) {
    $env:MEMMY_STORE_AUMID
  } else {
    "$packageFamilyName!$applicationId"
  }
} else {
  $publishingProfile = Resolve-MemmyStorePublishingProfile `
    -ConfigPath $resolvedPublishingConfigPath `
    -Environment $publishingEnvironment `
    -Channel $channel
  $storeProductId = $publishingProfile.StoreProductId
  $publisher = $publishingProfile.Publisher
  $identityName = $publishingProfile.IdentityName
  $publisherDisplayName = $publishingProfile.PublisherDisplayName
  $storeDisplayName = $publishingProfile.DisplayName
  $installedDisplayName = $publishingProfile.InstalledDisplayName
  $applicationId = $publishingProfile.ApplicationId
  $packageFamilyName = $publishingProfile.PackageFamilyName
  $storeAumid = $publishingProfile.Aumid
}

if ($storeAumid -notmatch '^[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}$') {
  throw "MEMMY_STORE_AUMID must be <package-family-name>!<application-id> using only letters, digits, dot, underscore, or hyphen."
}
$version = if ($Version) {
  $Version
} elseif ($env:MEMMY_DESKTOP_VERSION) {
  $env:MEMMY_DESKTOP_VERSION
} else {
  (Get-Content -Raw (Join-Path $desktopDirectory "package.json") | ConvertFrom-Json).version
}
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw "MEMMY_DESKTOP_VERSION must be a three-part SemVer such as 0.1.0; MSIX writes it as 0.1.0.0."
}
$versionSegments = $version.Split(".")
foreach ($segment in $versionSegments) {
  [uint32]$segmentValue = 0
  if (
    -not [uint32]::TryParse($segment, [ref]$segmentValue) -or
    $segmentValue -gt 65535
  ) {
    throw "MSIX version segments must be between 0 and 65535: $version"
  }
}
$accountChannel = if ($channel -eq "cn") { "phone" } else { "email" }
$edition = switch ($accountChannel) {
  "phone" { "cn" }
  "email" { "intl" }
  default { throw "Unsupported MEMMY_ACCOUNT_CHANNEL: $accountChannel" }
}
$unsignedArtifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-unsigned.msix"
$localTestSignedArtifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-local-test-signed.msix"
$developmentSignedArtifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-signed.msix"
$unsignedArtifactPath = Join-Path $desktopDirectory "release\$unsignedArtifactName"
$localTestSignedArtifactPath = Join-Path $desktopDirectory "release\$localTestSignedArtifactName"
$developmentSignedArtifactPath = Join-Path $desktopDirectory "release\$developmentSignedArtifactName"
$packageSigning = if ($Unsigned) {
  "unsigned"
} elseif ($publishingEnvironment -eq "development") {
  "signed"
} else {
  "local-test-signed"
}
$artifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-$packageSigning.msix"
$artifactPath = Join-Path $desktopDirectory "release\$artifactName"
$buildArtifactName = if ($publishingEnvironment -eq "development") {
  $developmentSignedArtifactName
} else {
  $unsignedArtifactName
}
$buildArtifactPath = if ($publishingEnvironment -eq "development") {
  $developmentSignedArtifactPath
} else {
  $unsignedArtifactPath
}
$localTestCertificateStem = "windows-store-$publishingEnvironment-$channel-local-test"
$localTestCertificatePath = Join-Path $signingDirectory "$localTestCertificateStem.cer"
$localTestCertificateFriendlyName = "Memmy Store Local Test ($publishingEnvironment/$channel)"
$localTestCertificateArtifactStem = ($storeDisplayName -replace '[^A-Za-z0-9._-]+', '-').Trim('-')
if (-not $localTestCertificateArtifactStem) {
  $localTestCertificateArtifactStem = "Memmy-$publishingEnvironment-$channel"
}
$localTestCertificateArtifactPath = Join-Path `
  $desktopDirectory `
  "release\$localTestCertificateArtifactStem-Local-Test.cer"
Write-Host "Store package profile: $publishingEnvironment/$channel"
if ($storeProductId) {
  Write-Host "Store product ID: $storeProductId"
}
Write-Host "Store package identity: $identityName ($publisher)"
Write-Host "Store package AUMID: $storeAumid"
Write-Host "Installed application display name: $installedDisplayName"
Write-Host "Store package artifact: $artifactName"

function New-DevelopmentCertificate {
  New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null
  $password = [Guid]::NewGuid().ToString("N")
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $publisher `
    -FriendlyName "Memmy Store Development" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyUsage DigitalSignature `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
    -NotAfter (Get-Date).AddYears(3)

  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
  Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
  Set-Content -LiteralPath $passwordPath -Value $password -NoNewline
  Write-Host "Development certificate created at $pfxPath"
}

function Trust-DevelopmentCertificate {
  if (-not (Test-Path -LiteralPath $cerPath)) {
    throw "Development certificate not found: $cerPath"
  }

  $developmentCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($cerPath)
  try {
    if (
      -not [string]::Equals(
        $developmentCertificate.Subject.Trim(),
        $publisher.Trim(),
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Development certificate subject '$($developmentCertificate.Subject)' does not match development publisher '$publisher'."
    }
  } finally {
    $developmentCertificate.Dispose()
  }

  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Trusting the development certificate requires an elevated PowerShell. Re-run this command as Administrator with -TrustDevelopmentCertificate."
  }

  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
  Write-Host "Development certificate trusted for this computer (LocalMachine\\TrustedPeople)."
}

function Get-LocalTestCertificate {
  return Get-ChildItem -Path "Cert:\CurrentUser\My" |
    Where-Object {
      $_.HasPrivateKey -and
      $_.NotAfter -gt (Get-Date) -and
      [string]::Equals($_.Subject.Trim(), $publisher.Trim(), [StringComparison]::OrdinalIgnoreCase) -and
      $_.FriendlyName -eq $localTestCertificateFriendlyName
    } |
    Sort-Object NotBefore -Descending |
    Select-Object -First 1
}

function New-LocalTestCertificate {
  New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null
  $certificate = Get-LocalTestCertificate
  if (-not $certificate) {
    $certificate = New-SelfSignedCertificate `
      -Type Custom `
      -Subject $publisher `
      -FriendlyName $localTestCertificateFriendlyName `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyUsage DigitalSignature `
      -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
      -NotAfter (Get-Date).AddYears(3)
  }
  Export-Certificate -Cert $certificate -FilePath $localTestCertificatePath -Force | Out-Null
  Write-Host "Local-test certificate ready: $($certificate.Thumbprint) ($localTestCertificatePath)"
}

function Trust-LocalTestCertificate {
  if (-not (Test-Path -LiteralPath $localTestCertificatePath -PathType Leaf)) {
    throw "Local-test certificate not found: $localTestCertificatePath. Run with -GenerateLocalTestCertificate first."
  }
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($localTestCertificatePath)
  try {
    if (-not [string]::Equals(
      $certificate.Subject.Trim(),
      $publisher.Trim(),
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Local-test certificate subject '$($certificate.Subject)' does not match Store publisher '$publisher'."
    }
  } finally {
    $certificate.Dispose()
  }

  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Trusting the local-test certificate requires an elevated PowerShell. Re-run this command as Administrator with -TrustLocalTestCertificate."
  }

  Import-Certificate -FilePath $localTestCertificatePath -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
  Write-Host "Local-test certificate trusted for this computer (LocalMachine\\TrustedPeople)."
}

function Get-WindowsSdkTool {
  param([Parameter(Mandatory = $true)][string]$Name)

  $tool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*\x64\$Name" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $tool) {
    throw "Windows SDK $Name was not found. Install the Windows 10/11 SDK."
  }

  return $tool.FullName
}

function Test-MsixSignatureWithWindowsSdk {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  $signTool = Get-WindowsSdkTool -Name "signtool.exe"
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $signTool verify /pa $PackagePath | Out-Host
    $verified = $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $verified
}

function Sign-MsixWithPfxCertificate {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  $signTool = Get-WindowsSdkTool -Name "signtool.exe"
  $arguments = @("sign", "/fd", "SHA256", "/f", $effectivePfxPath, "/p", $effectivePfxPassword)
  if ($effectiveTimestampServer) {
    $arguments += @("/tr", $effectiveTimestampServer, "/td", "SHA256")
  }
  $arguments += $PackagePath

  & $signTool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK SignTool PFX signing failed with exit code $LASTEXITCODE"
  }
}

function Sign-MsixWithCertificateStore {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  $signTool = Get-WindowsSdkTool -Name "signtool.exe"
  $arguments = @("sign", "/fd", "SHA256", "/sha1", $effectiveCertificateThumbprint)
  if ($SigningCertificateStoreLocation -eq "LocalMachine") {
    $arguments += "/sm"
  }
  if ($effectiveTimestampServer) {
    $arguments += @("/tr", $effectiveTimestampServer, "/td", "SHA256")
  }
  $arguments += $PackagePath

  & $signTool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK SignTool certificate store signing failed with exit code $LASTEXITCODE"
  }
}

function Sign-MsixWithWindowsSdk {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  if ($signingMode -eq "certificate-store") {
    Sign-MsixWithCertificateStore -PackagePath $PackagePath
    return
  }
  Sign-MsixWithPfxCertificate -PackagePath $PackagePath
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
    $entries = foreach ($entry in ($archive.Entries | Sort-Object FullName)) {
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
    return $entries
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
    $details = ($differences | ForEach-Object { "$($_.SideIndicator) $($_.Path) $($_.SHA256)" }) -join "; "
    throw "Local-test signed MSIX payload differs from the canonical unsigned package: $details"
  }
  Write-Host "Verified local-test signature-only parity with $UnsignedPackagePath"
}

function Assert-SigningCertificatePublisher {
  param(
    [Parameter(Mandatory = $true)][string]$CertificatePath,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CertificatePassword
  )

  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $CertificatePath,
    $CertificatePassword,
    $flags
  )
  try {
    if (-not [string]::Equals($certificate.Subject.Trim(), $publisher.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Signing certificate subject '$($certificate.Subject)' does not match manifest publisher '$publisher'."
    }
  } finally {
    $certificate.Dispose()
  }
}

function Assert-SigningCertificateStorePublisher {
  param(
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [Parameter(Mandatory = $true)][ValidateSet("CurrentUser", "LocalMachine")][string]$StoreLocation
  )

  $normalizedThumbprint = $Thumbprint.Replace(" ", "").ToUpperInvariant()
  if ($normalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
    throw "Signing certificate thumbprint must be a 40-character SHA-1 value."
  }

  $certificatePath = "Cert:\$StoreLocation\My\$normalizedThumbprint"
  $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction SilentlyContinue
  if (-not $certificate) {
    throw "Signing certificate was not found in $StoreLocation\\My: $normalizedThumbprint"
  }
  if (-not [string]::Equals(
    $certificate.Subject.Trim(),
    $publisher.Trim(),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Signing certificate subject '$($certificate.Subject)' does not match manifest publisher '$publisher'."
  }
  if (-not $certificate.HasPrivateKey) {
    throw "Signing certificate does not expose a private key through $StoreLocation\\My: $normalizedThumbprint"
  }

  return $normalizedThumbprint
}

function New-MsixWithWindowsSdk {
  param(
    [Parameter(Mandatory = $true)][string]$AppOutDirectory,
    [Parameter(Mandatory = $true)][string]$StageDirectory
  )

  $manifestPath = Join-Path $StageDirectory "AppxManifest.xml"
  $assetDirectory = Join-Path $StageDirectory "appx\assets"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Generated AppX manifest was not found: $manifestPath"
  }
  if (-not (Test-Path -LiteralPath $assetDirectory -PathType Container)) {
    throw "Generated AppX asset directory was not found: $assetDirectory"
  }

  $makePri = Get-WindowsSdkTool -Name "makepri.exe"
  $makeAppx = Get-WindowsSdkTool -Name "makeappx.exe"
  $resourcePriPath = Join-Path $StageDirectory "resources.pri"
  $mappingPath = Join-Path $StageDirectory "mapping.sdk.txt"

  Get-ChildItem -LiteralPath $StageDirectory -File -Filter "resources*.pri" -ErrorAction SilentlyContinue |
    Remove-Item -Force
  & $makePri new `
    /Overwrite `
    /Manifest $manifestPath `
    /ProjectRoot (Split-Path -Parent $assetDirectory) `
    /ConfigXml (Join-Path $root "node_modules\app-builder-lib\templates\appx\priconfig.xml") `
    /OutputFile $resourcePriPath
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK MakePri failed with exit code $LASTEXITCODE"
  }

  $mapping = [Collections.Generic.List[string]]::new()
  $mapping.Add("[Files]")
  Get-ChildItem -LiteralPath $AppOutDirectory -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = $_.FullName.Substring($AppOutDirectory.Length).TrimStart("\")
      $mapping.Add("""$($_.FullName)"" ""app\$relativePath""")
    }
  Get-ChildItem -LiteralPath $assetDirectory -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = $_.FullName.Substring($assetDirectory.Length).TrimStart("\")
      $mapping.Add("""$($_.FullName)"" ""assets\$relativePath""")
    }
  $mapping.Add("""$manifestPath"" ""AppxManifest.xml""")
  Get-ChildItem -LiteralPath $StageDirectory -File -Filter "resources*.pri" |
    Sort-Object Name |
    ForEach-Object {
      $mapping.Add("""$($_.FullName)"" ""$($_.Name)""")
    }
  [IO.File]::WriteAllLines($mappingPath, $mapping, [Text.UTF8Encoding]::new($false))

  Remove-Item -LiteralPath $buildArtifactPath -Force -ErrorAction SilentlyContinue
  & $makeAppx pack /o /f $mappingPath /p $buildArtifactPath
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK MakeAppx failed with exit code $LASTEXITCODE"
  }
}

if ($GenerateDevelopmentCertificate) {
  New-DevelopmentCertificate
}
if ($TrustDevelopmentCertificate) {
  Trust-DevelopmentCertificate
}
if ($GenerateLocalTestCertificate) {
  New-LocalTestCertificate
}
if ($TrustLocalTestCertificate) {
  Trust-LocalTestCertificate
}
if ((
  $GenerateDevelopmentCertificate -or
  $TrustDevelopmentCertificate -or
  $GenerateLocalTestCertificate -or
  $TrustLocalTestCertificate
) -and -not $Install) {
  return
}

$packagingEnvironmentVariableNames = @(
  "MEMMY_WINDOWS_TARGET",
  "MEMMY_DESKTOP_VERSION",
  "MEMMY_ACCOUNT_CHANNEL",
  "MEMMY_STORE_PUBLISHER",
  "MEMMY_STORE_IDENTITY_NAME",
  "MEMMY_STORE_PUBLISHER_DISPLAY_NAME",
  "MEMMY_STORE_DISPLAY_NAME",
  "MEMMY_STORE_INSTALLED_DISPLAY_NAME",
  "MEMMY_STORE_APPLICATION_ID",
  "MEMMY_STORE_AUMID",
  "MEMMY_STORE_TRANSITION_COMPATIBLE",
  "MEMMY_WINDOWS_ARTIFACT_NAME",
  "MEMMY_WINDOWS_FINAL_ARTIFACT",
  "MEMMY_SKIP_AGENT_INSTALL_SCRIPTS",
  "MEMMY_SKIP_CODESIGN",
  "MEMMY_WINDOWS_BUILDER_CONFIG",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "WIN_CSC_SHA1",
  "WIN_CSC_SUBJECT_NAME",
  "WIN_CSC_TIMESTAMP_SERVER",
  "npm_config_script_shell",
  "NPM_CONFIG_SCRIPT_SHELL",
  "MEMMY_WINDOWS_SOURCES_PREBUILT",
  "MEMMY_WINDOWS_STOP_BEFORE_AGENT_RUNTIME_INSTALL",
  "MEMMY_WINDOWS_RUNTIME_PREPARED",
  "MEMMY_WINDOWS_APPX_IDENTITY_NAME",
  "MEMMY_WINDOWS_APPX_APPLICATION_ID",
  "MEMMY_WINDOWS_APPX_PUBLISHER",
  "MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME",
  "MEMMY_WINDOWS_APPX_DISPLAY_NAME",
  "MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH",
  "MEMMY_WINDOWS_APPX_ARTIFACT_NAME",
  "MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH"
)
$originalPackagingEnvironment = @{}
foreach ($name in $packagingEnvironmentVariableNames) {
  $originalPackagingEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}

try {
$env:MEMMY_WINDOWS_TARGET = "appx"
$env:MEMMY_DESKTOP_VERSION = $version
$env:MEMMY_ACCOUNT_CHANNEL = $accountChannel
$env:MEMMY_STORE_PUBLISHER = $publisher
$env:MEMMY_STORE_IDENTITY_NAME = $identityName
$env:MEMMY_STORE_PUBLISHER_DISPLAY_NAME = $publisherDisplayName
$env:MEMMY_STORE_DISPLAY_NAME = $storeDisplayName
$env:MEMMY_STORE_INSTALLED_DISPLAY_NAME = $installedDisplayName
$env:MEMMY_STORE_APPLICATION_ID = $applicationId
$env:MEMMY_STORE_AUMID = $storeAumid
$env:MEMMY_STORE_TRANSITION_COMPATIBLE = "0"
$env:MEMMY_WINDOWS_ARTIFACT_NAME = $buildArtifactName
$env:MEMMY_WINDOWS_FINAL_ARTIFACT = $buildArtifactPath
$env:MEMMY_SKIP_AGENT_INSTALL_SCRIPTS = "1"

if ($Unsigned -and $Install) {
  throw "Unsigned MSIX packages cannot be installed by this script. Build signed or omit -Install."
}

$usingProfileLocalTestCertificate = $false
if (-not $Unsigned) {
  $configuredPfxPath = if ($SigningCertificatePath) {
    $SigningCertificatePath
  } elseif ($env:WIN_CSC_LINK) {
    $env:WIN_CSC_LINK
  } elseif ($env:CSC_LINK) {
    $env:CSC_LINK
  } else {
    $null
  }
  $configuredCertificateThumbprint = if ($SigningCertificateThumbprint) {
    $SigningCertificateThumbprint
  } elseif ($env:WIN_CSC_SHA1) {
    $env:WIN_CSC_SHA1
  } elseif ($env:CSC_SHA1) {
    $env:CSC_SHA1
  } else {
    $null
  }
  if (-not $configuredPfxPath -and -not $configuredCertificateThumbprint -and $publishingEnvironment -ne "development") {
    $localTestCertificate = Get-LocalTestCertificate
    if (-not $localTestCertificate) {
      throw "No matching local-test certificate exists for $publishingEnvironment/$channel. Run with -GenerateLocalTestCertificate and -TrustLocalTestCertificate first."
    }
    $usingProfileLocalTestCertificate = $true
    $configuredCertificateThumbprint = $localTestCertificate.Thumbprint
  }
  if ($configuredPfxPath -and $configuredCertificateThumbprint) {
    throw "Choose either a PFX signing certificate or a Windows certificate store thumbprint, not both."
  }
  $effectiveTimestampServer = if ($SigningTimestampServer) {
    $SigningTimestampServer
  } elseif ($env:WIN_CSC_TIMESTAMP_SERVER) {
    $env:WIN_CSC_TIMESTAMP_SERVER
  } elseif ($env:CSC_TIMESTAMP_SERVER) {
    $env:CSC_TIMESTAMP_SERVER
  } elseif ($publishingEnvironment -ne "development") {
    "http://timestamp.digicert.com"
  } else {
    $null
  }

  if ($configuredCertificateThumbprint) {
    if ($PSBoundParameters.ContainsKey("SigningCertificatePassword")) {
      throw "SigningCertificatePassword can only be used with a PFX signing certificate."
    }
    $signingMode = "certificate-store"
    $effectiveCertificateThumbprint = Assert-SigningCertificateStorePublisher `
      -Thumbprint $configuredCertificateThumbprint `
      -StoreLocation $SigningCertificateStoreLocation
    Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    $env:WIN_CSC_SHA1 = $effectiveCertificateThumbprint
    $env:WIN_CSC_SUBJECT_NAME = $publisher
    if ($effectiveTimestampServer) {
      $env:WIN_CSC_TIMESTAMP_SERVER = $effectiveTimestampServer
    } else {
      Remove-Item Env:WIN_CSC_TIMESTAMP_SERVER -ErrorAction SilentlyContinue
    }
  } else {
    $signingMode = "pfx"
    $effectivePfxPath = if ($configuredPfxPath) { $configuredPfxPath } else { $pfxPath }
    if (-not [System.IO.Path]::IsPathRooted($effectivePfxPath)) {
      $effectivePfxPath = Join-Path $root $effectivePfxPath
    }
    if (-not (Test-Path -LiteralPath $effectivePfxPath -PathType Leaf)) {
      throw "Signing certificate PFX not found: $effectivePfxPath. Generate the development certificate or pass -SigningCertificatePath."
    }
    $effectivePfxPath = (Resolve-Path -LiteralPath $effectivePfxPath).Path
    $effectivePfxPassword = if ($PSBoundParameters.ContainsKey("SigningCertificatePassword")) {
      $SigningCertificatePassword
    } elseif ($env:WIN_CSC_KEY_PASSWORD) {
      $env:WIN_CSC_KEY_PASSWORD
    } elseif ($env:CSC_KEY_PASSWORD) {
      $env:CSC_KEY_PASSWORD
    } elseif ($effectivePfxPath -eq $pfxPath -and (Test-Path -LiteralPath $passwordPath)) {
      Get-Content -Raw -LiteralPath $passwordPath
    } else {
      ""
    }
    Assert-SigningCertificatePublisher -CertificatePath $effectivePfxPath -CertificatePassword $effectivePfxPassword
    $env:WIN_CSC_LINK = $effectivePfxPath
    $env:WIN_CSC_KEY_PASSWORD = $effectivePfxPassword
    Remove-Item Env:WIN_CSC_SHA1 -ErrorAction SilentlyContinue
    Remove-Item Env:WIN_CSC_SUBJECT_NAME -ErrorAction SilentlyContinue
    if ($effectiveTimestampServer) {
      $env:WIN_CSC_TIMESTAMP_SERVER = $effectiveTimestampServer
    } else {
      Remove-Item Env:WIN_CSC_TIMESTAMP_SERVER -ErrorAction SilentlyContinue
    }
  }
}

$buildCanonicalUnsignedPackage = $Unsigned -or $publishingEnvironment -ne "development"
if ($buildCanonicalUnsignedPackage) {
  Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:WIN_CSC_SHA1 -ErrorAction SilentlyContinue
  Remove-Item Env:WIN_CSC_SUBJECT_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:WIN_CSC_TIMESTAMP_SERVER -ErrorAction SilentlyContinue
  $env:MEMMY_SKIP_CODESIGN = "1"
  $env:MEMMY_WINDOWS_BUILDER_CONFIG = "electron-builder.store.unsigned.yml"
} else {
  $env:MEMMY_WINDOWS_BUILDER_CONFIG = "electron-builder.store.yml"
  Remove-Item Env:MEMMY_SKIP_CODESIGN -ErrorAction SilentlyContinue
}

$bash = @(
  $env:MEMMY_NPM_SCRIPT_SHELL,
  (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
  (Get-Command bash.exe -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $bash) {
  throw "Git Bash was not found. Install Git for Windows or set MEMMY_NPM_SCRIPT_SHELL."
}

function Invoke-NpmCommand {
  param([Parameter(Mandatory = $true)][string[]]$NpmArguments)

  & npm.cmd --script-shell $bash @NpmArguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm command failed with exit code ${LASTEXITCODE}: npm $($NpmArguments -join ' ')"
  }
}

function Build-MemmyAgent {
  $typescriptCompiler = Join-Path $agentDirectory "node_modules\typescript\bin\tsc"
  & node.exe $typescriptCompiler -p (Join-Path $agentDirectory "tsconfig.build.json")
  if ($LASTEXITCODE -ne 0) {
    throw "memmy-agent TypeScript build failed with exit code $LASTEXITCODE"
  }

  foreach ($sourceName in @("templates", "skills")) {
    $sourceDirectory = Join-Path $agentDirectory "src\$sourceName"
    $targetDirectory = Join-Path $agentDirectory "dist\$sourceName"
    Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File |
      Where-Object { $_.Extension -ne ".ts" } |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($sourceDirectory.Length).TrimStart("\")
        $targetPath = Join-Path $targetDirectory $relativePath
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Force
      }
  }
}

function Install-MemmyAgentBetterSqlite3 {
  param([Parameter(Mandatory = $true)][string]$RuntimeAgentDirectory)

  $electronPackagePath = Join-Path $desktopDirectory "node_modules\electron\package.json"
  $electronVersion = (Get-Content -Raw -LiteralPath $electronPackagePath | ConvertFrom-Json).version
  $betterSqliteDirectory = Join-Path $RuntimeAgentDirectory "node_modules\better-sqlite3"
  $prebuildInstall = Join-Path $RuntimeAgentDirectory "node_modules\.bin\prebuild-install.cmd"
  if (-not (Test-Path -LiteralPath $prebuildInstall -PathType Leaf)) {
    throw "better-sqlite3 prebuild installer was not found: $prebuildInstall"
  }

  Push-Location $betterSqliteDirectory
  try {
    & $prebuildInstall --platform win32 --arch x64 --runtime electron --target $electronVersion
    if ($LASTEXITCODE -ne 0) {
      throw "memmy-agent better-sqlite3 prebuild installation failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  $nativeModule = Join-Path $betterSqliteDirectory "build\Release\better_sqlite3.node"
  if (-not (Test-Path -LiteralPath $nativeModule -PathType Leaf)) {
    throw "memmy-agent better-sqlite3 native module was not created: $nativeModule"
  }
}

$env:npm_config_script_shell = $bash
$env:NPM_CONFIG_SCRIPT_SHELL = $bash
if ($env:MEMMY_WINDOWS_SOURCES_PREBUILT -ne "1") {
  if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules") -PathType Container)) {
    Invoke-NpmCommand -NpmArguments @("install")
  }
  Invoke-NpmCommand -NpmArguments @("install", "--workspace", "@memmy/migrations", "--include=dev")
  Invoke-NpmCommand -NpmArguments @("run", "build", "--prefix", (Join-Path $root "Migrations"))
  Invoke-NpmCommand -NpmArguments @("ci", "--prefix", $agentDirectory, "--ignore-scripts")
  Invoke-NpmCommand -NpmArguments @("run", "build", "-w", "@memmy/memory")
  Build-MemmyAgent
  Invoke-NpmCommand -NpmArguments @("run", "build", "-w", "@memmy/desktop")
  $env:MEMMY_WINDOWS_SOURCES_PREBUILT = "1"
} else {
  Write-Warning "Reusing explicitly prebuilt Windows Store sources."
}

$storeUpdateHelperBuildScript = Join-Path $root "scripts\internal\build-windows-store-update-helper.ps1"
& $storeUpdateHelperBuildScript
if ($LASTEXITCODE -ne 0) {
  throw "Store update helper build failed with exit code $LASTEXITCODE"
}

$manifestTemplatePath = Join-Path $desktopDirectory "build\appx-manifest.xml"
$generatedManifestPath = "dist/appx-manifest.generated.xml"
$generatedManifestFilePath = Join-Path $desktopDirectory $generatedManifestPath
$manifestTemplate = Get-Content -Raw -LiteralPath $manifestTemplatePath
if (-not $manifestTemplate.Contains("__MEMMY_INSTALLED_DISPLAY_NAME__")) {
  throw "Store manifest template is missing __MEMMY_INSTALLED_DISPLAY_NAME__: $manifestTemplatePath"
}
$escapedInstalledDisplayName = [Security.SecurityElement]::Escape($installedDisplayName)
$generatedManifest = $manifestTemplate.Replace(
  "__MEMMY_INSTALLED_DISPLAY_NAME__",
  $escapedInstalledDisplayName
)
[IO.File]::WriteAllText($generatedManifestFilePath, $generatedManifest, [Text.UTF8Encoding]::new($false))

$extensionsTemplatePath = Join-Path $desktopDirectory "build\appx-extensions.xml"
$generatedExtensionsPath = "dist/appx-extensions.generated.xml"
$generatedExtensionsFilePath = Join-Path $desktopDirectory $generatedExtensionsPath
$extensionsTemplate = Get-Content -Raw -LiteralPath $extensionsTemplatePath
if (-not $extensionsTemplate.Contains("__MEMMY_STORE_AUMID__")) {
  throw "Store extensions template is missing __MEMMY_STORE_AUMID__: $extensionsTemplatePath"
}
$escapedStoreAumid = [Security.SecurityElement]::Escape($storeAumid)
$generatedExtensions = $extensionsTemplate.Replace("__MEMMY_STORE_AUMID__", $escapedStoreAumid)
[IO.File]::WriteAllText($generatedExtensionsFilePath, $generatedExtensions, [Text.UTF8Encoding]::new($false))

$env:MEMMY_WINDOWS_APPX_IDENTITY_NAME = $identityName
$env:MEMMY_WINDOWS_APPX_APPLICATION_ID = $applicationId
$env:MEMMY_WINDOWS_APPX_PUBLISHER = $publisher
$env:MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME = $publisherDisplayName
$env:MEMMY_WINDOWS_APPX_DISPLAY_NAME = $storeDisplayName
$env:MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH = $generatedManifestPath
$env:MEMMY_WINDOWS_APPX_ARTIFACT_NAME = $buildArtifactName
$env:MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH = $generatedExtensionsPath
$packageScript = (Join-Path $root "scripts\internal\package-win-x64.sh").Replace("\", "/")

if ($env:MEMMY_WINDOWS_RUNTIME_PREPARED -ne "1") {
  $env:MEMMY_WINDOWS_STOP_BEFORE_AGENT_RUNTIME_INSTALL = "1"
  & $bash $packageScript
  $runtimePreparationExitCode = $LASTEXITCODE
  Remove-Item Env:MEMMY_WINDOWS_STOP_BEFORE_AGENT_RUNTIME_INSTALL -ErrorAction SilentlyContinue
  if ($runtimePreparationExitCode -ne 0) {
    throw "Windows runtime preparation failed with exit code $runtimePreparationExitCode"
  }

  $runtimeAgentDirectory = Join-Path $desktopDirectory "dist\runtime\memmy-agent"
  Invoke-NpmCommand -NpmArguments @(
    "ci",
    "--prefix", $runtimeAgentDirectory,
    "--omit=dev",
    "--ignore-scripts",
    "--os=win32",
    "--cpu=x64"
  )
  Install-MemmyAgentBetterSqlite3 -RuntimeAgentDirectory $runtimeAgentDirectory
  $env:MEMMY_WINDOWS_RUNTIME_PREPARED = "1"
} else {
  Write-Warning "Reusing explicitly prepared Windows Store runtime."
}

Remove-Item -LiteralPath $buildArtifactPath -Force -ErrorAction SilentlyContinue
if ($localTestSignedArtifactPath -ne $buildArtifactPath) {
  Remove-Item -LiteralPath $localTestSignedArtifactPath -Force -ErrorAction SilentlyContinue
}
$packageStartedAt = Get-Date
& $bash $packageScript
$packageExitCode = $LASTEXITCODE
if ($packageExitCode -ne 0) {
  $appOutDirectory = Join-Path $desktopDirectory "release\win-unpacked"
  $stageDirectory = Join-Path $desktopDirectory "release\__appx-x64"
  $generatedManifest = Join-Path $stageDirectory "AppxManifest.xml"
  $canUseWindowsSdkFallback =
    (Test-Path -LiteralPath $appOutDirectory -PathType Container) -and
    (Test-Path -LiteralPath $generatedManifest -PathType Leaf) -and
    ((Get-Item -LiteralPath $generatedManifest).LastWriteTime -ge $packageStartedAt.AddSeconds(-5))
  if ($canUseWindowsSdkFallback) {
    Write-Warning "electron-builder AppX tooling failed; packaging the generated manifest with the installed Windows SDK."
    New-MsixWithWindowsSdk -AppOutDirectory $appOutDirectory -StageDirectory $stageDirectory
  } elseif (
    $publishingEnvironment -eq "development" -and
    (Test-Path -LiteralPath $buildArtifactPath) -and
    -not (Test-MsixSignatureWithWindowsSdk -PackagePath $buildArtifactPath)
  ) {
    Write-Warning "electron-builder could not sign the MSIX; retrying with Windows SDK SignTool."
    Sign-MsixWithWindowsSdk -PackagePath $buildArtifactPath
  } else {
    throw "MSIX packaging failed with exit code $packageExitCode"
  }
}
if (-not (Test-Path -LiteralPath $buildArtifactPath)) {
  throw "MSIX artifact was not created: $buildArtifactPath"
}

if (-not $Unsigned -and $publishingEnvironment -eq "development") {
  if (-not (Test-MsixSignatureWithWindowsSdk -PackagePath $buildArtifactPath)) {
    Write-Warning "MSIX is not signed yet; signing it with Windows SDK SignTool."
    Sign-MsixWithWindowsSdk -PackagePath $buildArtifactPath
  }
  if (-not (Test-MsixSignatureWithWindowsSdk -PackagePath $buildArtifactPath)) {
    throw "MSIX signature verification failed after Windows SDK signing."
  }
  Write-Host "Valid MSIX signature for publisher: $publisher"
} elseif (-not $Unsigned) {
  Copy-Item -LiteralPath $unsignedArtifactPath -Destination $localTestSignedArtifactPath -Force
  Sign-MsixWithWindowsSdk -PackagePath $localTestSignedArtifactPath
  if (-not (Test-MsixSignatureWithWindowsSdk -PackagePath $localTestSignedArtifactPath)) {
    throw "Local-test MSIX signature verification failed."
  }
  Assert-MsixPayloadParity `
    -UnsignedPackagePath $unsignedArtifactPath `
    -SignedPackagePath $localTestSignedArtifactPath
  if ($usingProfileLocalTestCertificate) {
    Export-Certificate -Cert $localTestCertificate -FilePath $localTestCertificateArtifactPath -Force | Out-Null
    Write-Host "Local-test public certificate: $localTestCertificateArtifactPath"
  }
  Write-Host "Valid local-test MSIX signature for publisher: $publisher"
}

if ($Install) {
  Add-AppxPackage -Path $artifactPath -ForceApplicationShutdown -ForceUpdateFromAnyVersion
  Write-Host "Installed $artifactPath"
} else {
  Write-Host "Created $artifactPath"
}
} finally {
  foreach ($name in $packagingEnvironmentVariableNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $originalPackagingEnvironment[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
}
