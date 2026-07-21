[CmdletBinding()]
param(
  [switch]$GenerateDevelopmentCertificate,
  [switch]$TrustDevelopmentCertificate,
  [switch]$Unsigned,
  [switch]$Install,
  [string]$SigningCertificatePath,
  [string]$SigningCertificatePassword
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
$publisher = if ($env:MEMMY_STORE_PUBLISHER) { $env:MEMMY_STORE_PUBLISHER } else { "CN=Memmy Development" }
$identityName = if ($env:MEMMY_STORE_IDENTITY_NAME) { $env:MEMMY_STORE_IDENTITY_NAME } else { "Memmy.Development" }
$storeAumid = if ($env:MEMMY_STORE_AUMID) { $env:MEMMY_STORE_AUMID } else { "Memmy.Development_fvzhnh4ztget6!Memmy" }
if ($storeAumid -notmatch '^[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}$') {
  throw "MEMMY_STORE_AUMID must be <package-family-name>!<application-id> using only letters, digits, dot, underscore, or hyphen."
}
$version = if ($env:MEMMY_DESKTOP_VERSION) {
  $env:MEMMY_DESKTOP_VERSION
} else {
  (Get-Content -Raw (Join-Path $desktopDirectory "package.json") | ConvertFrom-Json).version
}
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "MEMMY_DESKTOP_VERSION must be a three-part SemVer such as 0.1.0; MSIX writes it as 0.1.0.0."
}
$accountChannel = if ($env:MEMMY_ACCOUNT_CHANNEL) { $env:MEMMY_ACCOUNT_CHANNEL } else { "phone" }
$edition = switch ($accountChannel) {
  "phone" { "cn" }
  "email" { "intl" }
  default { throw "Unsupported MEMMY_ACCOUNT_CHANNEL: $accountChannel" }
}
$packageSigning = if ($Unsigned) { "unsigned" } else { "signed" }
$artifactName = "Memmy-$version-win32-x64-$edition-$packageSigning.msix"
$artifactPath = Join-Path $desktopDirectory "release\$artifactName"

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

  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Trusting the development certificate requires an elevated PowerShell. Re-run this command as Administrator with -TrustDevelopmentCertificate."
  }

  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
  Write-Host "Development certificate trusted for this computer (LocalMachine\\TrustedPeople)."
}

function Get-WindowsSdkSignTool {
  $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*\x64\signtool.exe" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $signTool) {
    throw "Windows SDK SignTool was not found. Install the Windows 10/11 SDK."
  }

  return $signTool.FullName
}

function Test-MsixSignatureWithWindowsSdk {
  $signTool = Get-WindowsSdkSignTool
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $signTool verify /pa $artifactPath | Out-Host
    $verified = $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $verified
}

function Sign-DevelopmentMsixWithWindowsSdk {
  $signTool = Get-WindowsSdkSignTool

  & $signTool sign /fd SHA256 /f $effectivePfxPath /p $effectivePfxPassword $artifactPath
  if ($LASTEXITCODE -ne 0) {
    throw "Windows SDK SignTool failed with exit code $LASTEXITCODE"
  }
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

if ($GenerateDevelopmentCertificate) {
  New-DevelopmentCertificate
}
if ($TrustDevelopmentCertificate) {
  Trust-DevelopmentCertificate
}
if (($GenerateDevelopmentCertificate -or $TrustDevelopmentCertificate) -and -not $Install) {
  return
}

$env:MEMMY_WINDOWS_TARGET = "appx"
$env:MEMMY_STORE_AUMID = $storeAumid
$env:MEMMY_WINDOWS_ARTIFACT_NAME = $artifactName
$env:MEMMY_WINDOWS_FINAL_ARTIFACT = $artifactPath
$env:MEMMY_SKIP_AGENT_INSTALL_SCRIPTS = "1"

if ($Unsigned) {
  if ($Install) {
    throw "Unsigned MSIX packages cannot be installed by this script. Build signed or omit -Install."
  }
  $env:MEMMY_SKIP_CODESIGN = "1"
  $env:MEMMY_WINDOWS_BUILDER_CONFIG = "electron-builder.store.unsigned.yml"
} else {
  $effectivePfxPath = if ($SigningCertificatePath) {
    $SigningCertificatePath
  } elseif ($env:WIN_CSC_LINK) {
    $env:WIN_CSC_LINK
  } elseif ($env:CSC_LINK) {
    $env:CSC_LINK
  } else {
    $pfxPath
  }
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

$builderOverrides = @(
  "--config.appx.identityName=$identityName",
  "--config.appx.publisher=$publisher",
  "--config.appx.artifactName=$artifactName",
  "--config.appx.customExtensionsPath=$generatedExtensionsPath"
)
$packageScript = (Join-Path $root "scripts\internal\package-win-x64.sh").Replace("\", "/")

if ($env:MEMMY_WINDOWS_RUNTIME_PREPARED -ne "1") {
  $env:MEMMY_WINDOWS_STOP_BEFORE_AGENT_RUNTIME_INSTALL = "1"
  & $bash $packageScript @builderOverrides
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
  $env:MEMMY_WINDOWS_RUNTIME_PREPARED = "1"
} else {
  Write-Warning "Reusing explicitly prepared Windows Store runtime."
}

Remove-Item -LiteralPath $artifactPath -Force -ErrorAction SilentlyContinue
& $bash $packageScript @builderOverrides
$packageExitCode = $LASTEXITCODE
if ($packageExitCode -ne 0) {
  $unsignedArtifactExists = -not $Unsigned -and
    (Test-Path -LiteralPath $artifactPath) -and
    -not (Test-MsixSignatureWithWindowsSdk)
  if ($unsignedArtifactExists) {
    Write-Warning "electron-builder could not sign the MSIX; retrying with Windows SDK SignTool."
    Sign-DevelopmentMsixWithWindowsSdk
  } else {
    throw "MSIX packaging failed with exit code $packageExitCode"
  }
}
if (-not (Test-Path -LiteralPath $artifactPath)) {
  throw "MSIX artifact was not created: $artifactPath"
}

if (-not $Unsigned) {
  if (-not (Test-MsixSignatureWithWindowsSdk)) {
    throw "MSIX signature verification failed."
  }
  Write-Host "Valid MSIX signature for publisher: $publisher"
}

if ($Install) {
  Add-AppxPackage -Path $artifactPath -ForceApplicationShutdown -ForceUpdateFromAnyVersion
  Write-Host "Installed $artifactPath"
} else {
  Write-Host "Created $artifactPath"
}
