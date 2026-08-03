import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));
const preloadSourcePath = fileURLToPath(new URL("../src/preload/preload.cts", import.meta.url));
const runtimeServicesPath = fileURLToPath(new URL("../src/main/runtime-services.ts", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));
const devMemorySupervisorPath = fileURLToPath(new URL("../../../../scripts/internal/dev-memory-supervisor.mjs", import.meta.url));
const clearAllPath = fileURLToPath(new URL("../../../../scripts/clear-all.sh", import.meta.url));
const packageMacDmgPath = fileURLToPath(new URL("../../../../scripts/internal/package-mac-dmg.sh", import.meta.url));
const signedMacArm64PackagePath = fileURLToPath(
  new URL("../../../../scripts/internal/package-mac-arm64-signed-base.sh", import.meta.url)
);
const packageWinX64Path = fileURLToPath(new URL("../../../../scripts/internal/package-win-x64.sh", import.meta.url));
const winX64CnUnsignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-cn-unsigned.sh", import.meta.url)
);
const winX64CnSignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-cn-signed.sh", import.meta.url)
);
const winX64IntlUnsignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-intl-unsigned.sh", import.meta.url)
);
const winX64IntlSignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-intl-signed.sh", import.meta.url)
);
const winUnsignedBuilderPath = fileURLToPath(new URL("../electron-builder.win.unsigned.yml", import.meta.url));
const winUnsignedInstallerIncludePath = fileURLToPath(new URL("../build/installer-win-unsigned.nsh", import.meta.url));
const desktopInterfacePath = fileURLToPath(new URL("../interface/src/index.ts", import.meta.url));
const localApiContractsPath = fileURLToPath(new URL("../../../../App/backend/local-api-contracts/src/index.ts", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const rootPackageLockPath = fileURLToPath(new URL("../../../../package-lock.json", import.meta.url));
const migrationsPackagePath = fileURLToPath(new URL("../../../../Migrations/package.json", import.meta.url));
const memoryPackagePath = fileURLToPath(new URL("../../../../Memory/package.json", import.meta.url));
const backendPackagePath = fileURLToPath(new URL("../../../../App/backend/package.json", import.meta.url));
const frontendPackagePath = fileURLToPath(new URL("../../../../App/frontend/desktop/package.json", import.meta.url));
const desktopPackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const agentPackagePath = fileURLToPath(new URL("../../../../App/memmy-agent/package.json", import.meta.url));
const agentPackageLockPath = fileURLToPath(new URL("../../../../App/memmy-agent/package-lock.json", import.meta.url));
const electronBuilderPath = fileURLToPath(new URL("../electron-builder.yml", import.meta.url));
const unsignedElectronBuilderPath = fileURLToPath(new URL("../electron-builder.unsigned.yml", import.meta.url));
const macEntitlementsPath = fileURLToPath(new URL("../build/entitlements.mac.plist", import.meta.url));
const macEntitlementsInheritPath = fileURLToPath(new URL("../build/entitlements.mac.inherit.plist", import.meta.url));
const winElectronBuilderPath = fileURLToPath(new URL("../electron-builder.win.yml", import.meta.url));
const storeElectronBuilderPath = fileURLToPath(new URL("../electron-builder.store.yml", import.meta.url));
const storeUnsignedElectronBuilderPath = fileURLToPath(new URL("../electron-builder.store.unsigned.yml", import.meta.url));
const storeManifestPath = fileURLToPath(new URL("../build/appx-manifest.xml", import.meta.url));
const storeExtensionsPath = fileURLToPath(new URL("../build/appx-extensions.xml", import.meta.url));
const storePublishingProfilesPath = fileURLToPath(
  new URL("../build/store-publishing-profiles.json", import.meta.url)
);
const storeIconTargetSizes = [16, 20, 24, 30, 32, 36, 40, 44, 48, 60, 64, 72, 80, 96, 256] as const;
const storeAssetPaths = [
  ["StoreLogo.png", 50, 50],
  ["Square44x44Logo.png", 44, 44],
  ["Square44x44Logo.scale-125.png", 55, 55],
  ["Square44x44Logo.scale-150.png", 66, 66],
  ["Square44x44Logo.scale-200.png", 88, 88],
  ["Square44x44Logo.scale-400.png", 176, 176],
  ...storeIconTargetSizes.flatMap((size) => [
    [`Square44x44Logo.targetsize-${size}.png`, size, size] as const,
    [`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size] as const,
    [`Square44x44Logo.targetsize-${size}_altform-lightunplated.png`, size, size] as const
  ]),
  ["Square150x150Logo.png", 150, 150],
  ["Wide310x150Logo.png", 310, 150]
] as const;
const packageWindowsStorePath = fileURLToPath(new URL("../../../../scripts/internal/package-windows-store.ps1", import.meta.url));
const storePublishingProfileResolverPath = fileURLToPath(
  new URL("../../../../scripts/internal/windows-store-publishing-profile.ps1", import.meta.url)
);
const winUpdatePromptScriptPath = fileURLToPath(new URL("../build/MemmyUpdatePrompt.ps1", import.meta.url));
const winStoreActivateScriptPath = fileURLToPath(new URL("../build/MemmyStoreActivate.ps1", import.meta.url));
const winStoreCleanupPath = fileURLToPath(new URL("../src/main/windows-store-cleanup.ts", import.meta.url));
const winStoreUpdatePath = fileURLToPath(new URL("../src/main/windows-store-update.ts", import.meta.url));
const winStoreUpdateNativePath = fileURLToPath(new URL("../native/windows-store-update/MemmyStoreUpdate.cpp", import.meta.url));
const winStoreUpdateHelperBuildPath = fileURLToPath(
  new URL("../../../../scripts/internal/build-windows-store-update-helper.ps1", import.meta.url)
);
const winStoreUpdateHelperPath = fileURLToPath(
  new URL("../dist/native/MemmyStoreUpdate.exe", import.meta.url)
);
const legacyApplicationSupportDir = ["Application Support/Memmy", "+"].join("");
const legacyProductPattern = new RegExp([
  "Memmy\\+",
  ["Memmy", "Plus"].join(""),
  ["memmy", "plus"].join(""),
  "Application Support/Memmy\\+"
].join("|"));

interface PackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

describe("desktop packaged runtime boundaries", () => {
  it("keeps Memory runtime dependencies owned by the Memory workspace", () => {
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const memoryPackage = readJson<PackageJson>(memoryPackagePath);
    const backendPackage = readJson<PackageJson>(backendPackagePath);
    const frontendPackage = readJson<PackageJson>(frontendPackagePath);
    const desktopPackage = readJson<PackageJson>(desktopPackagePath);

    expect(rootPackage.workspaces).toContain("Memory");
    expect(rootPackage.bin).toBeUndefined();
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("@huggingface/transformers");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("yaml");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("zod");
    expect(rootPackage.devDependencies ?? {}).not.toHaveProperty("@types/better-sqlite3");
    expect(memoryPackage).toMatchObject({
      name: "@memmy/memory",
      bin: { "memmy-memory": "./dist/src/cli/index.js" }
    });
    expect(memoryPackage.dependencies).toMatchObject({
      "@huggingface/transformers": expect.any(String),
      "better-sqlite3": expect.any(String),
      "sqlite-vec": "0.1.9",
      yaml: expect.any(String)
    });
    expect(memoryPackage.dependencies ?? {}).not.toHaveProperty("zod");
    expect(backendPackage.dependencies).toHaveProperty("zod");
    expect(backendPackage.dependencies).toHaveProperty("sqlite-vec", "0.1.9");
    expect(frontendPackage.dependencies).toHaveProperty("zod");
    expect(desktopPackage.dependencies).toHaveProperty("yaml");
    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty("zod");
  });

  it("pins the in-process Playwright MCP runtime in the agent package", () => {
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentLock = readJson<any>(agentPackageLockPath);

    expect(agentPackage.dependencies).toMatchObject({
      "@playwright/mcp": "0.0.78",
      playwright: "1.62.0-alpha-1783623505000",
    });
    expect(agentLock.packages["node_modules/@playwright/mcp"].version).toBe(
      "0.0.78",
    );
    expect(agentLock.packages["node_modules/playwright"].version).toBe(
      "1.62.0-alpha-1783623505000",
    );
  });

  it("builds migrations as a private root workspace consumed by memmy-agent", () => {
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const rootLock = readJson<any>(rootPackageLockPath);
    const migrationsPackage = readJson<any>(migrationsPackagePath);
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentLock = readJson<any>(agentPackageLockPath);

    expect(rootPackage.workspaces).toContain("Migrations");
    expect(rootLock.packages.Migrations).toMatchObject({
      name: "@memmy/migrations",
      version: "0.0.0",
      dependencies: { "proper-lockfile": "^4.1.2" },
    });
    expect(rootLock.packages["node_modules/@memmy/migrations"]).toEqual({
      resolved: "Migrations",
      link: true,
    });
    expect(migrationsPackage).toMatchObject({
      name: "@memmy/migrations",
      version: "0.0.0",
      private: true,
      type: "module",
      files: ["dist/**/*"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    });
    expect(agentPackage.dependencies).toHaveProperty(
      "@memmy/migrations",
      "file:../../Migrations",
    );
    expect(agentLock.packages[""]?.dependencies).toHaveProperty(
      "@memmy/migrations",
      "file:../../Migrations",
    );
    expect(agentLock.packages["node_modules/@memmy/migrations"]).toEqual({
      resolved: "../../Migrations",
      link: true,
    });
    for (const scriptName of ["prebuild", "pretypecheck", "pretest"]) {
      expect(agentPackage.scripts?.[scriptName]).toBe(
        "npm run version:sync && npm --prefix ../../Migrations run build",
      );
    }
  });

  it("materializes the compiled migrations package in macOS and Windows runtimes", () => {
    const macSource = readFileSync(packageMacDmgPath, "utf8");
    const winSource = readFileSync(packageWinX64Path, "utf8");

    for (const source of [macSource, winSource]) {
      expect(source).toContain('MIGRATIONS_DIR="$ROOT_DIR/Migrations"');
      expect(source).toContain('MIGRATIONS_STAGING_DIR="$DESKTOP_DIR/dist/Migrations"');
      expect(source).toContain("install --workspace @memmy/migrations --include=dev");
      expect(source).toContain('cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"');
      expect(source).toContain('cp -R "$MIGRATIONS_DIR/dist" "$MIGRATIONS_STAGING_DIR/dist"');
      expect(source).toContain('RUNTIME_MIGRATIONS_DIR="$RUNTIME_DIR/memmy-agent/node_modules/@memmy/migrations"');
      expect(source).toContain('rm -rf "$RUNTIME_MIGRATIONS_DIR"');
      expect(source).toContain('mkdir -p "$RUNTIME_MIGRATIONS_DIR"');
      expect(source).toContain('cp "$MIGRATIONS_STAGING_DIR/package.json" "$RUNTIME_MIGRATIONS_DIR/package.json"');
      expect(source).toContain('cp -R "$MIGRATIONS_STAGING_DIR/dist" "$RUNTIME_MIGRATIONS_DIR/dist"');
      expect(source).toContain('if [ -L "$RUNTIME_MIGRATIONS_DIR" ]; then');
      expect(source).toContain('if [ ! -f "$RUNTIME_MIGRATIONS_DIR/dist/index.js" ]; then');
      expect(source).toContain('if [ -e "$MIGRATIONS_STAGING_DIR" ]; then');
      expect(source).toContain('import { runMigrations } from "@memmy/migrations";');
      expect(source).toContain(
        'if (typeof runMigrations !== "function") throw new Error("Migrations runtime export is unavailable")',
      );
      expect(source).toContain(
        '$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/index.js',
      );
      expect(source).toContain(
        '[ -L "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations" ]',
      );

      const stageIndex = source.indexOf(
        'cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"',
      );
      const runtimeInstallIndex = source.indexOf(
        source === macSource
          ? 'npm ci --prefix "$RUNTIME_DIR/memmy-agent"'
          : 'npm_ci_win_x64 "$RUNTIME_DIR/memmy-agent"',
      );
      const materializeIndex = source.indexOf('rm -rf "$RUNTIME_MIGRATIONS_DIR"');
      const cleanupIndex = source.indexOf('rm -rf "$MIGRATIONS_STAGING_DIR"', stageIndex + 1);
      const builderIndex = source.indexOf("npx electron-builder");
      expect(stageIndex).toBeGreaterThanOrEqual(0);
      expect(runtimeInstallIndex).toBeGreaterThan(stageIndex);
      expect(materializeIndex).toBeGreaterThan(runtimeInstallIndex);
      expect(cleanupIndex).toBeGreaterThan(materializeIndex);
      expect(builderIndex).toBeGreaterThan(cleanupIndex);
    }

    expect(macSource.indexOf('npm --prefix "$MIGRATIONS_DIR" run build')).toBeLessThan(
      macSource.indexOf('npm ci --prefix "$AGENT_DIR"'),
    );
    expect(winSource.indexOf('run build --prefix "$MIGRATIONS_DIR"')).toBeLessThan(
      winSource.indexOf('ci --prefix "$AGENT_DIR"'),
    );
  });

  it("unpacks the migrations runtime in every desktop package variant", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = parseYaml(readFileSync(configPath, "utf8")) as {
        asarUnpack?: string[];
      };
      expect(config.asarUnpack).toContain(
        "dist/runtime/memmy-agent/node_modules/@memmy/migrations/**"
      );
    }
  });

  it("unpacks the sqlite-vec native extension in every desktop package variant", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/node_modules/sqlite-vec-*/vec0.*"');
    }
  });

  it("unpacks ONNX Runtime native libraries next to their native bindings", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/onnxruntime-node/bin/napi-v3/darwin/**/*.dylib"');
    }
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/onnxruntime-node/bin/napi-v3/win32/x64/**/*.dll"');
    }
  });

  it("unpacks Sharp libvips native libraries next to the Sharp native binding", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@img/sharp-libvips-darwin-*/lib/libvips*.dylib"');
    }
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@img/sharp-win32-x64/lib/libvips*.dll"');
    }
  });

  it("unpacks Windows node-pty ConPTY runtime files for dynamic loading", () => {
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/**"');
    }
  });

  it("unpacks macOS node-pty spawn helpers used by the native pty binding", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@lydell/node-pty-darwin-*/prebuilds/darwin-*/spawn-helper"');
    }
  });

  it("builds a literal MSIX with the existing Windows payload and Store manifest", () => {
    const config = readFileSync(storeElectronBuilderPath, "utf8");
    const unsignedConfig = readFileSync(storeUnsignedElectronBuilderPath, "utf8");
    const manifest = readFileSync(storeManifestPath, "utf8");
    const extensions = readFileSync(storeExtensionsPath, "utf8");
    const script = readFileSync(packageWindowsStorePath, "utf8");
    const helperBuildScript = readFileSync(winStoreUpdateHelperBuildPath, "utf8");
    const profileResolver = readFileSync(storePublishingProfileResolverPath, "utf8");
    const publishingProfiles = JSON.parse(readFileSync(storePublishingProfilesPath, "utf8"));
    const winPackageScript = readFileSync(packageWinX64Path, "utf8");

    expect(config).toContain("extends: electron-builder.win.yml");
    expect(config).toContain("artifactName: Memmy-${version}-${arch}.msix");
    expect(config).toContain("backgroundColor: transparent");
    expect(config).toContain("publisherDisplayName: Memmy Development");
    expect(config).not.toContain("publisherDisplayName: Leason");
    expect(config).not.toContain("publisherDisplayName: MemTensor");
    expect(config).toContain("customManifestPath: build/appx-manifest.xml");
    expect(config).toContain("customExtensionsPath: build/appx-extensions.xml");
    expect(config).toContain("minVersion: 10.0.17763.0");
    expect(unsignedConfig).toContain("extends: electron-builder.store.yml");
    expect(manifest).toContain('xmlns:rescap3="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities/3"');
    expect(manifest).toContain('xmlns:desktop7="http://schemas.microsoft.com/appx/manifest/desktop/windows10/7"');
    expect(manifest).toContain('IgnorableNamespaces="uap desktop desktop7 rescap rescap3"');
    expect(manifest).toContain("<DisplayName>${displayName}</DisplayName>");
    expect(manifest).toContain('DisplayName="__MEMMY_INSTALLED_DISPLAY_NAME__"');
    expect(manifest).not.toContain("RegistryWriteVirtualization");
    expect(manifest).not.toContain("virtualization:ExcludedKey");
    expect(manifest).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(manifest).not.toContain('uap10:RuntimeBehavior="win32App"');
    expect(config).toContain("- runFullTrust");
    expect(config).not.toContain("unvirtualizedResources");
    expect(extensions).toContain('Category="windows.desktopAppMigration"');
    expect(extensions).toContain('AumId="__MEMMY_STORE_AUMID__"');
    expect(extensions).toContain('Category="windows.shortcut"');
    expect(extensions).toContain('File="$(Desktop)\\Memmy.lnk"');
    expect(extensions).toContain('Icon="$(Package)\\app\\resources\\icon.ico"');
    expect(script).toContain("New-SelfSignedCertificate");
    expect(script).toContain("Get-WindowsSdkTool");
    expect(script).toContain("verify /pa");
    expect(script).not.toContain("Get-AuthenticodeSignature");
    expect(script).toContain("Add-AppxPackage");
    expect(script).toContain("SigningCertificatePath");
    expect(script).toContain("Assert-SigningCertificatePublisher");
    expect(script).toContain('Cert:\\LocalMachine\\TrustedPeople');
    expect(script).not.toContain('Cert:\\CurrentUser\\Root');
    expect(script).toContain('"Memmy-$version-win32-x64-$edition-$publishingEnvironment-$packageSigning.msix"');
    expect(script).toContain('[ValidateSet("development", "personal", "company")]');
    expect(script).toContain('[ValidateSet("cn", "intl")]');
    expect(script).toContain('$env:MEMMY_STORE_PUBLISHING_ENV');
    expect(script).toContain('$env:MEMMY_STORE_PUBLISHING_CONFIG_PATH');
    expect(script).toContain("Resolve-MemmyStorePublishingProfile");
    expect(script).toContain("$originalPackagingEnvironment");
    expect(script).toContain("[Environment]::SetEnvironmentVariable");
    expect(script).not.toContain("conflicts with publishing profile");
    expect(script).toContain('$env:MEMMY_ACCOUNT_CHANNEL');
    expect(script).toContain('$version = if ($Version)');
    expect(script).toContain('$env:MEMMY_DESKTOP_VERSION = $version');
    expect(script).toContain("MEMMY_DESKTOP_VERSION must be a three-part SemVer");
    expect(script).toContain("MSIX version segments must be between 0 and 65535");
    expect(script).toContain("Production Store profiles cannot generate or trust development certificates");
    expect(script).toContain("Development certificate subject");
    expect(script).toContain("[switch]$GenerateLocalTestCertificate");
    expect(script).toContain("[switch]$TrustLocalTestCertificate");
    expect(script).toContain("New-LocalTestCertificate");
    expect(script).toContain("Trust-LocalTestCertificate");
    expect(script).toContain("Trusting the local-test certificate requires an elevated PowerShell");
    expect(script).toContain('Cert:\\LocalMachine\\TrustedPeople');
    expect(script).toContain("Local-test certificate trusted for this computer");
    expect(script).toContain("$localTestCertificateArtifactStem");
    expect(script).toContain('"release\\$localTestCertificateArtifactStem-Local-Test.cer"');
    expect(script).toContain("Export-Certificate -Cert $localTestCertificate -FilePath $localTestCertificateArtifactPath -Force");
    expect(script).toContain("Local-test public certificate:");
    expect(script).toContain('$unsignedArtifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-unsigned.msix"');
    expect(script).toContain('$localTestSignedArtifactName = "Memmy-$version-win32-x64-$edition-$publishingEnvironment-local-test-signed.msix"');
    expect(script).toContain("Copy-Item -LiteralPath $unsignedArtifactPath -Destination $localTestSignedArtifactPath -Force");
    expect(script).toContain("Assert-MsixPayloadParity");
    expect(script).toContain("[string]$SigningCertificateThumbprint");
    expect(script).toContain('[ValidateSet("CurrentUser", "LocalMachine")]');
    expect(script).toContain("Assert-SigningCertificateStorePublisher");
    expect(script).toContain("Sign-MsixWithCertificateStore");
    expect(script).toContain('$effectiveTimestampServer = if ($SigningTimestampServer)');
    expect(script).toContain('$arguments += @("/tr", $effectiveTimestampServer, "/td", "SHA256")');
    expect(script).toContain("$env:WIN_CSC_SHA1");
    expect(script).toContain("$env:WIN_CSC_SUBJECT_NAME = $publisher");
    expect(script).toContain("$env:WIN_CSC_TIMESTAMP_SERVER");
    expect(script).toContain('$env:MEMMY_STORE_AUMID');
    expect(script).toContain('$env:MEMMY_STORE_TRANSITION_COMPATIBLE = "0"');
    expect(script).toContain('$packageFamilyName = "Memmy.Development_fvzhnh4ztget6"');
    expect(script).toContain('"$packageFamilyName!$applicationId"');
    expect(script).toContain('$env:MEMMY_STORE_DISPLAY_NAME');
    expect(script).toContain('$env:MEMMY_STORE_INSTALLED_DISPLAY_NAME');
    expect(script).toContain('$env:MEMMY_STORE_PUBLISHER_DISPLAY_NAME');
    expect(script).toContain('$env:MEMMY_WINDOWS_APPX_DISPLAY_NAME = $storeDisplayName');
    expect(script).toContain('$env:MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH = $generatedManifestPath');
    expect(script).toContain('$env:MEMMY_WINDOWS_APPX_APPLICATION_ID = $applicationId');
    expect(winPackageScript).toContain('--config.appx.publisher="$MEMMY_WINDOWS_APPX_PUBLISHER"');
    expect(winPackageScript).toContain('--config.appx.displayName="$MEMMY_WINDOWS_APPX_DISPLAY_NAME"');
    expect(winPackageScript).toContain('--config.appx.customManifestPath="$MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH"');
    expect(winPackageScript).toContain('--config.appx.applicationId="$MEMMY_WINDOWS_APPX_APPLICATION_ID"');
    expect(profileResolver).toContain("function Resolve-MemmyStorePublishingProfile");
    expect(profileResolver).toContain("PackageFamilyNameFromId");
    expect(profileResolver).toContain('"storeProductId"');
    expect(profileResolver).toContain('"manifestApplicationId"');
    expect(profileResolver).toContain('-PropertyName "installedDisplayName"');
    expect(profileResolver).toContain("InstalledDisplayName = $installedDisplayName");
    expect(profileResolver).toContain("Assert-UniqueStorePublishingIdentities");
    expect(profileResolver).toContain('-FieldName "storeProductId"');
    expect(profileResolver).toContain('-FieldName "packageFamilyName"');
    expect(profileResolver).toContain('-FieldName "AUMID"');
    expect(profileResolver).toContain('$aumid = "$packageFamilyName!$applicationId"');
    expect(profileResolver).toContain("is not configured");
    expect(publishingProfiles.environments.personal.publisher)
      .toBe("CN=D0FAE30D-03A3-4022-BECC-83DCFCFAC00B");
    expect(publishingProfiles.environments.personal.publisherDisplayName).toBe("Leason");
    expect(publishingProfiles.installedDisplayName).toBe("Memmy");
    expect(publishingProfiles.environments.personal.applications.intl).toEqual({
      storeProductId: "9P7LQRSNG9SL",
      identityName: "Leason.MemmyStorePreview",
      manifestApplicationId: "Memmy",
      displayName: "Memmy Store Preview",
      packageFamilyName: "Leason.MemmyStorePreview_49qkyxp1vaee6"
    });
    expect(publishingProfiles.environments.personal.applications.cn).toBeNull();
    expect(publishingProfiles.environments.company.publisherDisplayName).toBe("MemTensor");
    expect(publishingProfiles.environments.company.applications.cn).toBeNull();
    expect(publishingProfiles.environments.company.applications.intl).toBeNull();
    expect(script).toContain('[Security.SecurityElement]::Escape($storeAumid)');
    expect(script).toContain('[Security.SecurityElement]::Escape($installedDisplayName)');
    expect(script).toContain('appx-manifest.generated.xml');
    expect(script).toContain('__MEMMY_INSTALLED_DISPLAY_NAME__');
    expect(script).toContain('appx-extensions.generated.xml');
    expect(script).toContain('__MEMMY_STORE_AUMID__');
    expect(script).toContain('$env:MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH = $generatedExtensionsPath');
    expect(script).toContain('$env:MEMMY_WINDOWS_APPX_ARTIFACT_NAME = $buildArtifactName');
    expect(script).toContain("Invoke-NpmCommand");
    expect(script).toContain("Remove-Item -LiteralPath $buildArtifactPath -Force");
    expect(script).toContain('$env:MEMMY_WINDOWS_SOURCES_PREBUILT = "1"');
    expect(script).not.toContain('$env:MEMMY_SKIP_RELEASE_GATE = "1"');
    expect(winPackageScript).toContain('STORE_AUMID="${MEMMY_STORE_AUMID:-}"');
    expect(winPackageScript).toContain("MEMMY_STORE_AUMID is required when MEMMY_STORE_TRANSITION_COMPATIBLE=1.");
    expect(winPackageScript).toContain('^[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}$');
    expect(winPackageScript).toContain('STORE_TRANSITION_COMPATIBLE="${MEMMY_STORE_TRANSITION_COMPATIBLE:-1}"');
    expect(winPackageScript).toContain('if [ "$STORE_TRANSITION_COMPATIBLE" = "1" ]');
    expect(winPackageScript).toContain('"storeTransitionCompatible": $store_transition_compatible');
    expect(winPackageScript).toContain('"storeAumid": "${STORE_AUMID:-}"');
    expect(winPackageScript).toContain('verify_windows_better_sqlite3_module "memmy-agent runtime"');
    expect(winPackageScript).toContain("prune_non_windows_x64_native_binaries");
    expect(winPackageScript).toContain("verify_no_non_windows_x64_native_binaries");
    expect(winPackageScript).toContain('if [ ! -f "$FINAL_ARTIFACT" ]');
    expect(winPackageScript).toContain('Windows artifact is ready: $FINAL_ARTIFACT');
    expect(helperBuildScript).toContain("/MT");
    expect(helperBuildScript).not.toContain("/MD");
    expect(helperBuildScript).toContain("dumpbin.exe");
    expect(helperBuildScript).toContain("MSVCP(?:[0-9_]+)?\\.dll");
    expect(helperBuildScript).toContain("VCRUNTIME(?:[0-9_]+)?\\.dll");

    for (const [fileName, expectedWidth, expectedHeight] of storeAssetPaths) {
      const asset = readFileSync(fileURLToPath(new URL(`../build/appx/${fileName}`, import.meta.url)));
      expect(asset.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(asset.readUInt32BE(16)).toBe(expectedWidth);
      expect(asset.readUInt32BE(20)).toBe(expectedHeight);
    }
    for (const size of storeIconTargetSizes) {
      const defaultAsset = readFileSync(fileURLToPath(new URL(`../build/appx/Square44x44Logo.targetsize-${size}.png`, import.meta.url)));
      expect(readFileSync(fileURLToPath(new URL(`../build/appx/Square44x44Logo.targetsize-${size}_altform-unplated.png`, import.meta.url))))
        .toEqual(defaultAsset);
      expect(readFileSync(fileURLToPath(new URL(`../build/appx/Square44x44Logo.targetsize-${size}_altform-lightunplated.png`, import.meta.url))))
        .toEqual(defaultAsset);
    }
    expect(readFileSync(fileURLToPath(new URL("../build/appx/Square44x44Logo.targetsize-44.png", import.meta.url))))
      .toEqual(readFileSync(fileURLToPath(new URL("../build/appx/Square44x44Logo.png", import.meta.url))));
  });

  it("resolves only configured Store publishing environment and channel pairs", () => {
    if (process.platform !== "win32") {
      return;
    }

    const quotePowerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const resolver = quotePowerShellLiteral(storePublishingProfileResolverPath);
    const config = quotePowerShellLiteral(storePublishingProfilesPath);
    const resolved = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${config} -Environment personal -Channel intl | ConvertTo-Json -Compress`
      ],
      { encoding: "utf8" }
    );
    expect(JSON.parse(resolved)).toMatchObject({
      Environment: "personal",
      Channel: "intl",
      Publisher: "CN=D0FAE30D-03A3-4022-BECC-83DCFCFAC00B",
      StoreProductId: "9P7LQRSNG9SL",
      IdentityName: "Leason.MemmyStorePreview",
      ApplicationId: "Memmy",
      PackageFamilyName: "Leason.MemmyStorePreview_49qkyxp1vaee6",
      Aumid: "Leason.MemmyStorePreview_49qkyxp1vaee6!Memmy"
    });

    for (const [environment, channel] of [
      ["personal", "cn"],
      ["company", "cn"],
      ["company", "intl"]
    ]) {
      const unavailable = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${config} -Environment ${environment} -Channel ${channel}`
        ],
        { encoding: "utf8" }
      );
      expect(unavailable.status).not.toBe(0);
      expect(`${unavailable.stdout}\n${unavailable.stderr}`).toContain(
        `Windows Store publishing profile '${environment}/${channel}' is not configured.`
      );
    }

    const invalidConfigDirectory = mkdtempSync(join(tmpdir(), "memmy-store-profile-"));
    try {
      const invalidConfigPath = join(invalidConfigDirectory, "profiles.json");
      const invalidConfig = JSON.parse(readFileSync(storePublishingProfilesPath, "utf8"));
      invalidConfig.environments.personal.publisher = "CN=Wrong Publisher";
      writeFileSync(invalidConfigPath, JSON.stringify(invalidConfig), "utf8");
      const invalidPublisher = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(invalidPublisher.status).not.toBe(0);
      expect(`${invalidPublisher.stdout}\n${invalidPublisher.stderr}`).toContain(
        "packageFamilyName does not match identityName and publisher"
      );

      invalidConfig.environments.personal.publisher =
        "CN=D0FAE30D-03A3-4022-BECC-83DCFCFAC00B";
      invalidConfig.environments.personal.applications.intl.storeProductId =
        "339e3382-1f43-4b44-be24-ae4e2b1d7b7a";
      writeFileSync(invalidConfigPath, JSON.stringify(invalidConfig), "utf8");
      const invalidStoreProductId = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(invalidStoreProductId.status).not.toBe(0);
      expect(`${invalidStoreProductId.stdout}\n${invalidStoreProductId.stderr}`).toContain(
        "invalid storeProductId"
      );

      invalidConfig.environments.personal.applications.intl.storeProductId =
        "9P7LQRSNG9SL";
      invalidConfig.environments.personal.applications.intl.manifestApplicationId = "_Bad";
      writeFileSync(invalidConfigPath, JSON.stringify(invalidConfig), "utf8");
      const invalidApplicationId = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(invalidApplicationId.status).not.toBe(0);
      expect(`${invalidApplicationId.stdout}\n${invalidApplicationId.stderr}`).toContain(
        "invalid manifestApplicationId"
      );

      const duplicateIdentityConfig = JSON.parse(
        readFileSync(storePublishingProfilesPath, "utf8")
      );
      duplicateIdentityConfig.environments.personal.applications.cn = {
        ...duplicateIdentityConfig.environments.personal.applications.intl
      };
      writeFileSync(invalidConfigPath, JSON.stringify(duplicateIdentityConfig), "utf8");
      const duplicateStoreProductId = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(duplicateStoreProductId.status).not.toBe(0);
      expect(`${duplicateStoreProductId.stdout}\n${duplicateStoreProductId.stderr}`).toContain(
        "reuse storeProductId '9P7LQRSNG9SL'"
      );

      duplicateIdentityConfig.environments.personal.applications.cn.storeProductId =
        "9P7LQRSNG9SM";
      writeFileSync(invalidConfigPath, JSON.stringify(duplicateIdentityConfig), "utf8");
      const duplicateAumid = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(duplicateAumid.status).not.toBe(0);
      expect(`${duplicateAumid.stdout}\n${duplicateAumid.stderr}`).toContain(
        "reuse AUMID"
      );

      duplicateIdentityConfig.environments.personal.applications.cn.manifestApplicationId =
        "MemmyCn";
      writeFileSync(invalidConfigPath, JSON.stringify(duplicateIdentityConfig), "utf8");
      const duplicatePackageFamilyName = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. ${resolver}; Resolve-MemmyStorePublishingProfile -ConfigPath ${quotePowerShellLiteral(invalidConfigPath)} -Environment personal -Channel intl`
        ],
        { encoding: "utf8" }
      );
      expect(duplicatePackageFamilyName.status).not.toBe(0);
      expect(`${duplicatePackageFamilyName.stdout}\n${duplicatePackageFamilyName.stderr}`).toContain(
        "reuse packageFamilyName"
      );
    } finally {
      rmSync(invalidConfigDirectory, { recursive: true, force: true });
    }

    for (const [invalidVersion, expectedMessage] of [
      ["01.0.9", "MEMMY_DESKTOP_VERSION must be a three-part SemVer"],
      ["1.70000.0", "MSIX version segments must be between 0 and 65535"]
    ]) {
      const invalidVersionResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          packageWindowsStorePath,
          "-Unsigned",
          "-PublishingEnvironment",
          "personal",
          "-Channel",
          "intl",
          "-Version",
          invalidVersion
        ],
        { encoding: "utf8" }
      );
      expect(invalidVersionResult.status).not.toBe(0);
      expect(`${invalidVersionResult.stdout}\n${invalidVersionResult.stderr}`).toContain(
        expectedMessage
      );
    }

    const productionCertificate = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        packageWindowsStorePath,
        "-PublishingEnvironment",
        "personal",
        "-Channel",
        "intl",
        "-GenerateDevelopmentCertificate"
      ],
      { encoding: "utf8" }
    );
    expect(productionCertificate.status).not.toBe(0);
    expect(`${productionCertificate.stdout}\n${productionCertificate.stderr}`).toContain(
      "Production Store profiles cannot generate or trust development certificates"
    );

    const packageScript = quotePowerShellLiteral(packageWindowsStorePath);
    const environmentRestoration = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$env:MEMMY_WINDOWS_TARGET='sentinel-target'; $env:MEMMY_DESKTOP_VERSION='7.7.7'; $env:MEMMY_ACCOUNT_CHANNEL='phone'; try { & ${packageScript} -PublishingEnvironment development -Channel intl -Version 1.0.9 -SigningCertificatePath 'D:\\definitely-missing\\memmy.pfx' } catch { if ($_.Exception.Message -notlike 'Signing certificate PFX not found:*') { throw } }; if ($env:MEMMY_WINDOWS_TARGET -ne 'sentinel-target' -or $env:MEMMY_DESKTOP_VERSION -ne '7.7.7' -or $env:MEMMY_ACCOUNT_CHANNEL -ne 'phone') { throw 'Packaging environment was not restored.' }; exit 0`
      ],
      { encoding: "utf8" }
    );
    expect(environmentRestoration.status).toBe(0);

    const conflictingSigningMethods = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        packageWindowsStorePath,
        "-PublishingEnvironment",
        "development",
        "-Channel",
        "intl",
        "-Version",
        "1.0.9",
        "-SigningCertificatePath",
        "D:\\missing\\memmy.pfx",
        "-SigningCertificateThumbprint",
        "0123456789ABCDEF0123456789ABCDEF01234567"
      ],
      { encoding: "utf8" }
    );
    expect(conflictingSigningMethods.status).not.toBe(0);
    expect(`${conflictingSigningMethods.stdout}\n${conflictingSigningMethods.stderr}`).toContain(
      "Choose either a PFX signing certificate or a Windows certificate store thumbprint"
    );
  }, 15_000);

  it("keeps the desktop main process on the shared Memmy identity and config path", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('app.setName("Memmy");');
    expect(source).toContain("resolveWindowsStoreUserDataPath");
    expect(source).toContain('app.setPath("userData", storeUserDataPath ?? legacyUserDataPath);');
    expect(source).toMatch(/runtimeServices = app\.isPackaged\s*\?\s*await startPackagedRuntimeServices\(/);
    expect(source).toContain("memmyConfigPath: process.env.MEMMY_CONFIG");
    expect(source).not.toContain("startDesktopRuntimeServices");
  });

  it("persists gtag client_id into the shared ~/.memmy analytics-client-id file", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    expect(mainSource).toContain('import { persistSharedAnalyticsClientId } from "./analytics-client-id-store.js"');
    expect(mainSource).toContain("persistSharedAnalyticsClientId(clientId)");
  });

  it("uses fresh Store data, native Store updates, and boot-ready legacy cleanup", () => {
    const source = readFileSync(mainSourcePath, "utf8");
    const bootSource = extractFunctionSource(source, "async function boot");
    const openStoreInstallerSource = extractFunctionSource(
      source,
      "async function openMicrosoftStoreWebInstaller"
    );
    const cleanupSource = readFileSync(winStoreCleanupPath, "utf8");
    const storeUpdateSource = readFileSync(winStoreUpdatePath, "utf8");
    const storeUpdateNativeSource = readFileSync(winStoreUpdateNativePath, "utf8");
    const storeActivateSource = readFileSync(winStoreActivateScriptPath, "utf8");
    const storeConfig = readFileSync(storeElectronBuilderPath, "utf8");

    expect(source).toContain('process.platform === "win32" && process.windowsStore === true');
    expect(source).toContain('? join(storeUserDataPath, "runtime")');
    expect(source).toContain("await runWindowsStoreLegacyCleanup()");
    expect(bootSource.indexOf("await runWindowsStoreLegacyCleanup()"))
      .toBeLessThan(bootSource.indexOf("await startPackagedRendererServerIfNeeded()"));
    expect(bootSource.indexOf("await runWindowsStoreLegacyCleanup()"))
      .toBeLessThan(bootSource.indexOf("await startPackagedRuntimeServices("));
    expect(bootSource.indexOf("await runWindowsStoreLegacyCleanup()"))
      .toBeLessThan(bootSource.indexOf("await startLocalApi(runtimeServices)"));
    expect(source).toContain('await import("./windows-store-cleanup.js")');
    expect(source).toContain('storeUserDataPath: app.getPath("userData")');
    expect(source).not.toContain("migrateWindowsStoreData");
    expect(source).not.toContain("claimLegacyWindowsInstance");
    expect(source).toContain("if (isWindowsStoreApp())");
    expect(source).toContain("if (!isWindowsStoreApp() && await installPreparedRequiredUpdateBeforeBoot())");
    expect(source).toContain('throw new Error("The legacy installer updater is unavailable in a Windows Store package")');
    expect(source).toContain('provider: "microsoft-store"');
    expect(source).toContain('command: isUserInitiated ? "download-user" : "download-silent"');
    expect(source).toContain('command: "install-user"');
    expect(source).toContain('command: "install-silent"');
    expect(source).toContain("isMicrosoftStoreWebInstallerUrl(downloadUrl)");
    expect(source).toContain("openMicrosoftStoreWebInstaller");
    expect(source).toContain("startLegacyWindowsStoreMigrationWatcher({");
    expect(openStoreInstallerSource).not.toContain("shell.openPath(filePath)");
    expect(openStoreInstallerSource.indexOf("startLegacyWindowsStoreMigrationWatcher"))
      .toBeLessThan(openStoreInstallerSource.indexOf("scheduleQuitForManualUpdateInstall"));
    expect(source).toContain("installerPath: filePath");
    expect(source).toContain("legacyProcessId: process.pid");
    expect(source).toContain("legacyExecutablePath: process.execPath");
    expect(source).toContain("resolveDesktopStoreAumid");
    expect(source).toContain('"-WaitForPackageSeconds"');
    expect(source).toContain('"900"');
    expect(source).toContain('"-WaitForReadySeconds"');
    expect(source).toContain('"180"');
    expect(storeUpdateSource).toContain('"download-user"');
    expect(storeUpdateSource).toContain('"install-user"');
    expect(cleanupSource).toContain("cleanupWindowsStoreLegacyInstallation");
    expect(cleanupSource).toContain('["prepare-legacy-takeover", "--legacy-install-directory", legacyInstallDirectory]');
    expect(cleanupSource.indexOf("await prepareLegacyTakeover"))
      .toBeLessThan(cleanupSource.indexOf("await hasCompletedCleanup"));
    expect(cleanupSource).toContain("existsSync(legacyInstallDirectory)");
    expect(cleanupSource).toContain("store-migration-in-progress-v1.json");
    expect(cleanupSource).toContain('source: "store-startup"');
    expect(cleanupSource).not.toContain("launchLegacyUninstaller");
    expect(cleanupSource).not.toContain("Uninstall Memmy.exe");
    expect(cleanupSource).toContain("Removing validated legacy files and data");
    expect(cleanupSource).not.toContain("legacyRuntimeHomePath");
    expect(cleanupSource).not.toContain('join(options.homePath, ".memmy")');
    expect(source).not.toContain("legacyRuntimeHomePath:");
    expect(cleanupSource).toContain("maxRetries: 6");
    expect(cleanupSource).toContain('const args = ["finalize-legacy-cleanup"]');
    expect(cleanupSource).not.toContain("for (const path of [\n    legacyInstallDirectory,");
    expect(cleanupSource).toContain("retryDelay: 500");
    expect(cleanupSource).not.toContain("powershell");
    expect(storeUpdateNativeSource).toContain("RegDeleteTreeW(HKEY_CURRENT_USER");
    expect(storeUpdateNativeSource).toContain("PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY");
    expect(storeUpdateNativeSource).toContain(
      "PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE"
    );
    expect(storeUpdateNativeSource).toContain(
      "PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE"
    );
    expect(storeUpdateNativeSource).toContain("finalize-legacy-cleanup-breakaway-launcher");
    expect(storeUpdateNativeSource).toContain("finalize-legacy-cleanup-unpackaged");
    expect(cleanupSource).toContain('args.push("--unpackaged-helper-path", legacyTakeoverHelperPath)');
    expect(storeUpdateNativeSource).toContain('argument == L"--unpackaged-helper-path"');
    expect(storeUpdateNativeSource).toContain("validate_unpacked_cleanup_helper_path");
    expect(storeUpdateNativeSource).toContain("GetCurrentPackageFullName");
    expect(storeUpdateNativeSource).toContain(
      "Refusing to mutate the real legacy registry from a packaged process"
    );
    expect(storeUpdateNativeSource).toContain(
      "Legacy uninstall registration is still present after cleanup"
    );
    expect(storeUpdateNativeSource).toContain("CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS");
    expect(storeUpdateNativeSource).toContain("QueryFullProcessImageNameW");
    expect(storeUpdateNativeSource).toContain("process.creation_time < parent_process.creation_time");
    expect(storeUpdateNativeSource).toContain("target.image_path");
    expect(storeUpdateNativeSource).toContain("GetWindowThreadProcessId");
    expect(storeUpdateNativeSource).toContain("WM_CLOSE");
    expect(storeUpdateNativeSource).toContain("TerminateProcess");
    expect(storeUpdateNativeSource).toContain("is_path_within_directory");
    expect(storeUpdateNativeSource).toContain("is_windows_apps_path");
    expect(storeUpdateNativeSource).toContain("prepare_legacy_takeover");
    expect(storeUpdateNativeSource).toContain('value == L"prepare-legacy-takeover"');
    const terminateLegacyTreeSource = storeUpdateNativeSource.slice(
      storeUpdateNativeSource.indexOf("void terminate_legacy_process_tree"),
      storeUpdateNativeSource.indexOf("void prepare_legacy_takeover")
    );
    expect(terminateLegacyTreeSource).toContain(
      "WaitForSingleObject(process, 0) != WAIT_TIMEOUT"
    );
    const finalizeCleanupSource = storeUpdateNativeSource.slice(
      storeUpdateNativeSource.indexOf("void finalize_legacy_cleanup"),
      storeUpdateNativeSource.indexOf("IVector<StorePackageUpdate> copy_updates")
    );
    expect(finalizeCleanupSource).toContain("prepare_legacy_takeover");
    expect(storeUpdateNativeSource).toContain("remove_legacy_cli_from_user_path()");
    expect(storeUpdateNativeSource).toContain("remove_legacy_install_directory()");
    expect(storeUpdateNativeSource).toContain("delete_directory_tree_once");
    expect(storeUpdateNativeSource).toContain("maximum_attempts = 20");
    expect(storeUpdateNativeSource).toContain('delete_registry_value_if_present(run_key, L"Memmy")');
    expect(storeUpdateNativeSource).toContain("WM_SETTINGCHANGE");
    expect(storeUpdateNativeSource).toContain("FOLDERID_AppsFolder");
    expect(storeUpdateNativeSource).toContain("SHCreateItemFromRelativeName");
    expect(storeUpdateNativeSource).toContain("SHCreateDataObject");
    expect(storeUpdateNativeSource).toContain("shortcut_targets_aumid(shortcut, aumid)");
    expect(storeUpdateNativeSource).toContain("if (!shortcut_targets_aumid(shortcut, aumid))");
    expect(storeUpdateNativeSource).toContain("create_apps_folder_shortcut(shortcut, aumid)");
    expect(storeActivateSource).toContain("[string]$InstallerPath");
    expect(storeActivateSource).toContain("[int]$LegacyProcessId");
    expect(storeActivateSource).toContain("[string]$LegacyExecutablePath");
    expect(storeActivateSource).toContain("store-migration-in-progress-v1.json");
    expect(storeActivateSource).toContain("Test-MemmyLegacyExecutablePath");
    expect(storeActivateSource).toContain("Stop-MemmyLegacyProcessTree");
    expect(storeActivateSource).toContain("Watch-MemmyLegacyRelaunch");
    expect(storeActivateSource).toContain("Test-MemmyLegacyLaunchProxyHandoff");
    expect(storeActivateSource).toContain("Remove-MemmyLegacyLauncherDirectory");
    expect(storeActivateSource).toContain('Join-Path $PSScriptRoot "MemmyStoreUpdate.exe"');
    expect(storeActivateSource).toContain('"prepare-legacy-takeover"');
    expect(storeActivateSource).not.toContain("Stop-Process -Id");
    const migrationWatcherEntrySource = storeActivateSource.slice(
      storeActivateSource.indexOf('if ($MyInvocation.InvocationName -ne ".")')
    );
    expect(migrationWatcherEntrySource.indexOf("Wait-MemmyLegacyProcessExit"))
      .toBeLessThan(migrationWatcherEntrySource.indexOf("Start-Process -FilePath $InstallerPath"));
    expect(migrationWatcherEntrySource.indexOf("Start-Process -FilePath $InstallerPath"))
      .toBeLessThan(migrationWatcherEntrySource.indexOf("Wait-MemmyStorePackage"));
    expect(storeConfig).not.toContain("MemmyStoreCleanup.ps1");
  });

  it.skipIf(process.platform !== "win32")(
    "terminates only the validated legacy process tree during native takeover",
    async () => {
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        winStoreUpdateHelperBuildPath
      ], { windowsHide: true });

      const testRoot = mkdtempSync(join(tmpdir(), "memmy-native-takeover-"));
      const legacyInstallDirectory = join(testRoot, "Programs", "Memmy");
      const controlDirectory = join(testRoot, "Other");
      const legacyExecutablePath = join(legacyInstallDirectory, "Memmy.exe");
      const controlExecutablePath = join(controlDirectory, "Memmy.exe");
      mkdirSync(legacyInstallDirectory, { recursive: true });
      mkdirSync(controlDirectory, { recursive: true });
      copyFileSync(process.execPath, legacyExecutablePath);
      copyFileSync(process.execPath, controlExecutablePath);

      const nodeProgram = [
        "const{spawn}=require('node:child_process');",
        "const child=spawn(process.env.SystemRoot+'\\\\System32\\\\ping.exe',['127.0.0.1','-n','120']);",
        "process.stdout.write(String(child.pid)+'\\n');",
        "setInterval(()=>{},1000)"
      ].join("");
      const startTree = async (executablePath: string) => {
        const rootProcess = spawn(executablePath, ["-e", nodeProgram], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true
        });
        const closed = new Promise<void>((resolvePromise) => {
          rootProcess.once("close", () => resolvePromise());
        });
        const childProcessId = await new Promise<number>((resolvePromise, reject) => {
          let output = "";
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for the test child process")),
            5000
          );
          rootProcess.once("error", reject);
          rootProcess.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
            const line = output.split(/\r?\n/u)[0]?.trim();
            if (!line) {
              return;
            }
            clearTimeout(timeout);
            resolvePromise(Number.parseInt(line, 10));
          });
        });
        return { rootProcess, childProcessId, closed };
      };
      const isRunning = (processId: number) => {
        try {
          process.kill(processId, 0);
          return true;
        } catch {
          return false;
        }
      };
      const stopIfRunning = (processId: number | undefined) => {
        if (!processId || !isRunning(processId)) {
          return;
        }
        try {
          process.kill(processId, "SIGKILL");
        } catch {
          // The process may exit between the liveness check and termination.
        }
      };
      const waitUntilStopped = async (processId: number | undefined) => {
        if (!processId) {
          return;
        }
        const deadline = Date.now() + 5000;
        while (isRunning(processId) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
      };

      let legacyTree: Awaited<ReturnType<typeof startTree>> | null = null;
      let controlTree: Awaited<ReturnType<typeof startTree>> | null = null;
      try {
        legacyTree = await startTree(legacyExecutablePath);
        controlTree = await startTree(controlExecutablePath);
        const helperEnvironment = { ...process.env, LOCALAPPDATA: testRoot };
        const invalidTarget = spawnSync(
          winStoreUpdateHelperPath,
          ["prepare-legacy-takeover", "--legacy-install-directory", controlDirectory],
          { env: helperEnvironment, windowsHide: true }
        );
        expect(invalidTarget.status).toBe(2);
        expect(isRunning(controlTree.rootProcess.pid!)).toBe(true);

        execFileSync(
          winStoreUpdateHelperPath,
          ["prepare-legacy-takeover", "--legacy-install-directory", legacyInstallDirectory],
          { env: helperEnvironment, windowsHide: true }
        );
        expect(isRunning(legacyTree.rootProcess.pid!)).toBe(false);
        expect(isRunning(legacyTree.childProcessId)).toBe(false);
        expect(isRunning(controlTree.rootProcess.pid!)).toBe(true);
        expect(isRunning(controlTree.childProcessId)).toBe(true);
      } finally {
        stopIfRunning(legacyTree?.childProcessId);
        stopIfRunning(legacyTree?.rootProcess.pid);
        stopIfRunning(controlTree?.childProcessId);
        stopIfRunning(controlTree?.rootProcess.pid);
        await Promise.all([
          waitUntilStopped(legacyTree?.childProcessId),
          waitUntilStopped(legacyTree?.rootProcess.pid),
          waitUntilStopped(controlTree?.childProcessId),
          waitUntilStopped(controlTree?.rootProcess.pid),
          legacyTree?.closed,
          controlTree?.closed
        ]);
        legacyTree?.rootProcess.stdout?.destroy();
        controlTree?.rootProcess.stdout?.destroy();
        rmSync(testRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100
        });
      }
    },
    30_000
  );

  it.skipIf(process.platform !== "win32")(
    "starts the Store installer only after legacy exit and blocks a relaunch while waiting",
    async () => {
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        winStoreUpdateHelperBuildPath
      ], { windowsHide: true });

      const testRoot = mkdtempSync(join(tmpdir(), "memmy-store-watcher-"));
      const legacyInstallDirectory = join(testRoot, "Programs", "Memmy");
      const launcherDirectory = join(testRoot, "Memmy", "launcher");
      const legacyExecutablePath = join(legacyInstallDirectory, "Memmy.exe");
      const installerPath = join(testRoot, "fake.store-web-installer.exe");
      const activationScriptPath = join(launcherDirectory, "MemmyStoreActivate.ps1");
      const launcherPath = join(launcherDirectory, "MemmyLauncher.vbs");
      const installerMarkerPath = join(testRoot, "installer-order.txt");
      const relaunchProcessIdPath = join(testRoot, "relaunch-pid.txt");
      const migrationMarkerPath = join(
        launcherDirectory,
        "store-migration-in-progress-v1.json"
      );
      const compilerPath = join(
        process.env.WINDIR ?? "C:\\Windows",
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe"
      );
      const legacySourcePath = join(testRoot, "Legacy.cs");
      const installerSourcePath = join(testRoot, "Installer.cs");
      mkdirSync(legacyInstallDirectory, { recursive: true });
      mkdirSync(launcherDirectory, { recursive: true });
      writeFileSync(legacySourcePath, [
        "using System.Threading;",
        "public static class Legacy {",
        "  public static void Main() { Thread.Sleep(60000); }",
        "}"
      ].join("\n"), "utf8");
      writeFileSync(installerSourcePath, [
        "using System;",
        "using System.Diagnostics;",
        "using System.IO;",
        "using System.Threading;",
        "public static class Installer {",
        "  public static void Main() {",
        "    var oldPid = int.Parse(Environment.GetEnvironmentVariable(\"MEMMY_TEST_OLD_PID\"));",
        "    var oldRunning = true;",
        "    try { oldRunning = !Process.GetProcessById(oldPid).HasExited; } catch { oldRunning = false; }",
        "    File.WriteAllText(Environment.GetEnvironmentVariable(\"MEMMY_TEST_INSTALLER_MARKER\"), oldRunning ? \"old-running\" : \"old-exited\");",
        "    var relaunch = Process.Start(new ProcessStartInfo {",
        "      FileName = Environment.GetEnvironmentVariable(\"MEMMY_TEST_LEGACY_EXE\"),",
        "      UseShellExecute = false,",
        "      CreateNoWindow = true",
        "    });",
        "    File.WriteAllText(Environment.GetEnvironmentVariable(\"MEMMY_TEST_RELAUNCH_PID\"), relaunch.Id.ToString());",
        "    Thread.Sleep(500);",
        "  }",
        "}"
      ].join("\n"), "utf8");
      execFileSync(compilerPath, [
        "/nologo",
        `/out:${legacyExecutablePath}`,
        legacySourcePath
      ], { windowsHide: true });
      execFileSync(compilerPath, [
        "/nologo",
        `/out:${installerPath}`,
        installerSourcePath
      ], { windowsHide: true });
      copyFileSync(winStoreActivateScriptPath, activationScriptPath);
      copyFileSync(winStoreUpdateHelperPath, join(launcherDirectory, "MemmyStoreUpdate.exe"));
      writeFileSync(launcherPath, "legacy recovery launcher", "utf8");

      const legacyProcess = spawn(legacyExecutablePath, [], {
        stdio: "ignore",
        windowsHide: true
      });
      const isRunning = (processId: number) => {
        try {
          process.kill(processId, 0);
          return true;
        } catch {
          return false;
        }
      };
      const stopIfRunning = (processId: number | undefined) => {
        if (!processId || !isRunning(processId)) {
          return;
        }
        try {
          process.kill(processId, "SIGKILL");
        } catch {
          // The process may exit between the liveness check and termination.
        }
      };
      let relaunchProcessId: number | undefined;
      try {
        const watcher = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          activationScriptPath,
          "-AumId",
          "Missing.Package_0000000000000!Memmy",
          "-InstallerPath",
          installerPath,
          "-LegacyProcessId",
          String(legacyProcess.pid),
          "-LegacyExecutablePath",
          legacyExecutablePath,
          "-LegacyExitTimeoutSeconds",
          "1",
          "-WaitForPackageSeconds",
          "4"
        ], {
          env: {
            ...process.env,
            LOCALAPPDATA: testRoot,
            MEMMY_TEST_OLD_PID: String(legacyProcess.pid),
            MEMMY_TEST_INSTALLER_MARKER: installerMarkerPath,
            MEMMY_TEST_LEGACY_EXE: legacyExecutablePath,
            MEMMY_TEST_RELAUNCH_PID: relaunchProcessIdPath
          },
          stdio: "ignore",
          windowsHide: true
        });
        const watcherExitCode = await new Promise<number | null>((resolvePromise, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for the Store migration watcher")),
            30_000
          );
          watcher.once("error", reject);
          watcher.once("close", (code) => {
            clearTimeout(timeout);
            resolvePromise(code);
          });
        });
        expect(watcherExitCode).toBe(2);
        expect(readFileSync(installerMarkerPath, "utf8")).toBe("old-exited");
        relaunchProcessId = Number.parseInt(readFileSync(relaunchProcessIdPath, "utf8"), 10);
        expect(isRunning(legacyProcess.pid!)).toBe(false);
        expect(isRunning(relaunchProcessId)).toBe(false);
        expect(existsSync(migrationMarkerPath)).toBe(false);
        expect(readFileSync(launcherPath, "utf8")).toBe("legacy recovery launcher");
      } finally {
        stopIfRunning(legacyProcess.pid);
        stopIfRunning(relaunchProcessId);
        rmSync(testRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100
        });
      }
    },
    45_000
  );

  it("omits empty agent gateway bootstrap secrets in development runtime config", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const contractsSource = readFileSync(localApiContractsPath, "utf8");

    expect(contractsSource).toContain("bootstrapSecret: z.string().min(1).optional()");
    expect(mainSource).toContain("if (agentGateway.bootstrapSecret) {");
    expect(mainSource).toContain("agentGatewayConfig.bootstrapSecret = agentGateway.bootstrapSecret;");
    expect(mainSource).not.toContain("bootstrapSecret: agentGateway.bootstrapSecret");
  });

  it("surfaces packaged startup failures through a log file and dialog", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("writePackagedStartupLog");
    expect(source).toContain('"startup.log"');
    expect(source).toContain('"boot:start"');
    expect(source).toContain('"boot:ready"');
    expect(source).toContain("boot:error");
    expect(source).toContain("showPackagedStartupError(error)");
    expect(source).toContain("dialog.showErrorBox");
    expect(source).toContain("Memmy 启动失败");
  });

  it("hides the default in-window menu bar outside macOS", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("hideInWindowMenuBar(targetMainWindow)");
    expect(source).toContain('process.platform === "darwin"');
    expect(source).toContain("targetWindow.setMenu(null)");
  });

  it("wires the settings menu bar icon toggle to a native macOS Tray", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");
    const signedBuilderConfig = readFileSync(electronBuilderPath, "utf8");
    const unsignedBuilderConfig = readFileSync(unsignedElectronBuilderPath, "utf8");

    expect(interfaceSource).toContain("export interface DesktopMenuBarIconResult");
    expect(preloadSource).toContain("setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:set-menu-bar-icon", enabled)');
    expect(mainSource).toContain("let menuBarTray: Tray | null = null");
    expect(mainSource).toContain('if (process.platform === "darwin")');
    expect(mainSource).toContain("syncMenuBarTray(resolveMenuBarIconEnabled())");
    expect(mainSource).toContain('ipcMain.handle("memmy:set-menu-bar-icon"');
    expect(mainSource).toContain("function isNativeTraySupported()");
    expect(mainSource).toContain('process.platform === "darwin" || process.platform === "win32"');
    expect(mainSource).toContain("new Tray(trayImage, MENU_BAR_TRAY_GUID)");
    expect(mainSource).toContain('join(process.resourcesPath, "MenuBarIconTemplate.png")');
    expect(mainSource).toContain('resolve(import.meta.dirname, "../../build/MenuBarIconTemplate.png")');
    expect(mainSource).toContain("setTemplateImage(true)");
    expect(mainSource).toContain("destroyMenuBarTray()");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:set-menu-bar-icon")');
    expect(mainSource).not.toContain("MenuBarFallbackIcon.png");
    expect(mainSource).not.toContain("syncMenuBarFallbackWindow");
    expect(signedBuilderConfig).toContain("MenuBarIconTemplate.png");
    expect(signedBuilderConfig).toContain("MenuBarIconTemplate@2x.png");
    expect(signedBuilderConfig).not.toContain("MenuBarFallbackIcon.png");
    expect(unsignedBuilderConfig).toContain("MenuBarIconTemplate.png");
    expect(unsignedBuilderConfig).toContain("MenuBarIconTemplate@2x.png");
    expect(unsignedBuilderConfig).not.toContain("MenuBarFallbackIcon.png");
  });

  it("keeps unsigned Windows uninstallers from failing NSIS CRC self-checks", () => {
    const builderConfig = readFileSync(winUnsignedBuilderPath, "utf8");
    const includeSource = readFileSync(winUnsignedInstallerIncludePath, "utf8");

    expect(builderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(includeSource).toContain("!ifdef BUILD_UNINSTALLER");
    expect(includeSource).toContain("CRCCheck off");
  });

  it("adds packaged Windows CLI launchers to the user PATH", () => {
    const signedBuilderConfig = readFileSync(winElectronBuilderPath, "utf8");
    const unsignedBuilderConfig = readFileSync(winUnsignedBuilderPath, "utf8");
    const includeSource = readFileSync(winUnsignedInstallerIncludePath, "utf8");
    const updatePromptSource = readFileSync(winUpdatePromptScriptPath, "utf8");

    expect(signedBuilderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(unsignedBuilderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(signedBuilderConfig).toContain("allowElevation: false");
    expect(unsignedBuilderConfig).toContain("allowElevation: false");
    expect(signedBuilderConfig).toContain("allowToChangeInstallationDirectory: true");
    expect(unsignedBuilderConfig).toContain("allowToChangeInstallationDirectory: true");
    expect(signedBuilderConfig).toContain("createDesktopShortcut: false");
    expect(unsignedBuilderConfig).toContain("createDesktopShortcut: false");
    expect(signedBuilderConfig).toContain("createStartMenuShortcut: true");
    expect(unsignedBuilderConfig).toContain("createStartMenuShortcut: true");
    expect(includeSource).toContain("!macro customInstall");
    expect(includeSource).toContain("Call MemmyAddCliToUserPath");
    expect(includeSource).toContain("Call MemmyInstallLaunchProxy");
    expect(includeSource).toContain("!insertmacro MemmyPointShortcutsToLaunchProxy");
    expect(includeSource).toContain("!macro customUnInstall");
    expect(includeSource).toContain("Call un.MemmyRemoveCliFromUserPath");
    expect(includeSource).toContain("Call un.MemmyRemoveLaunchProxy");
    expect(includeSource).not.toContain("Call un.MemmyPointShortcutsToInstalledApp");
    expect(includeSource).toContain('StrCpy $0 "$INSTDIR\\resources\\cli"');
    expect(includeSource).toContain('IfFileExists "$0\\memmy.cmd"');
    expect(includeSource).toContain('IfFileExists "$0\\memmy-memory.cmd"');
    expect(includeSource).toContain('ReadRegStr $1 HKCU "Environment" "Path"');
    expect(includeSource).toContain('WriteRegExpandStr HKCU "Environment" "Path"');
    expect(includeSource).toContain("MEMMY_WM_SETTINGCHANGE");
    expect(includeSource).toContain("!macro customInstallMode");
    expect(includeSource).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(includeSource).toContain('StrCpy $0 "$LOCALAPPDATA\\Memmy\\launcher"');
    expect(includeSource).toContain('File /oname=Memmy.ico "${BUILD_RESOURCES_DIR}\\icon.ico"');
    expect(includeSource).toContain('File /oname=MemmyUpdatePrompt.ps1 "${BUILD_RESOURCES_DIR}\\MemmyUpdatePrompt.ps1"');
    expect(includeSource).toContain('File /oname=MemmyStoreActivate.ps1 "${BUILD_RESOURCES_DIR}\\MemmyStoreActivate.ps1"');
    expect(includeSource).toContain(
      'File /oname=MemmyStoreUpdate.exe "${BUILD_RESOURCES_DIR}\\..\\dist\\native\\MemmyStoreUpdate.exe"'
    );
    expect(includeSource).toContain('FileOpen $1 "$0\\MemmyLauncher.vbs" w');
    expect(includeSource).toContain("shell.CurrentDirectory = shell.ExpandEnvironmentStrings");
    expect(includeSource).toContain('promptPath = $\\"$0\\MemmyUpdatePrompt.ps1$\\"');
    expect(includeSource).toContain('storeActivatePath = $\\"$0\\MemmyStoreActivate.ps1$\\"');
    expect(includeSource).toContain('migrationMarkerPath = $\\"$0\\store-migration-in-progress-v1.json$\\"');
    expect(includeSource).toContain("storeExitCode = shell.Run");
    expect(includeSource).toContain("-WaitForReadySeconds 180");
    expect(includeSource).toContain("If storeExitCode = 0 Then");
    expect(includeSource).toContain("If storeExitCode = 2 And Not fso.FileExists(appExe) Then");
    expect(includeSource).toContain("fso.DeleteFile desktopShortcutPath, True");
    expect(includeSource).toContain("fso.DeleteFile startMenuShortcutPath, True");
    expect(includeSource).toContain("If fso.FileExists(migrationMarkerPath) Then");
    expect(includeSource).toContain("WScript.Quit 0");
    expect(includeSource).toContain("WindowsPowerShell\\v1.0\\powershell.exe");
    expect(includeSource).toContain('promptMarkerPath = markerPath & $\\".prompt$\\"');
    expect(includeSource).toContain("If fso.FolderExists(lockPath) And fso.FileExists(promptMarkerPath) Then");
    expect(includeSource).toContain("If fso.FileExists(powerShellPath) And fso.FileExists(promptPath) Then");
    expect(includeSource).toContain("If fso.FolderExists(lockPath) Or Not fso.FileExists(appExe) Then");
    expect(includeSource).toContain("WScript.Quit 0");
    expect(includeSource).toContain("update-prompt-language.txt");
    expect(includeSource).toContain("prepared-required-update.json");
    expect(includeSource).toContain("-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File");
    expect(includeSource).toContain("-LockPath");
    expect(includeSource).toContain("-AppExe");
    expect(includeSource).toContain("-LanguagePath");
    expect(includeSource).not.toContain("shell.Popup");
    expect(includeSource).not.toContain("ChrW(&H6B63)");
    expect(includeSource).not.toContain("Please open Memmy again in a moment.");
    expect(includeSource).toContain('appExe = $\\"$INSTDIR\\${PRODUCT_FILENAME}.exe$\\"');
    expect(includeSource).toContain('StrCpy $3 "$newStartMenuLink"');
    expect(includeSource).toContain('CreateShortCut "$3" "$SYSDIR\\wscript.exe"');
    expect(includeSource).toContain('Push "no-desktop-shortcut"');
    expect(includeSource).not.toContain('StrCmp $keepShortcuts "false" memmy_point_new_desktop_shortcut');
    expect(includeSource).toContain("StrCmp $oldDesktopLink $newDesktopLink memmy_point_existing_new_desktop_shortcut");
    expect(includeSource).toContain('Rename "$oldDesktopLink" "$newDesktopLink"');
    expect(includeSource).toContain('StrCpy $3 "$newDesktopLink"');
    expect(includeSource).not.toContain('IfFileExists "$newDesktopLink" 0 memmy_point_shortcuts_done');
    expect(includeSource).toContain("An older NSIS uninstaller can remove the desktop shortcut");
    expect(includeSource).toContain('!if "${MEMMY_STORE_TRANSITION_COMPATIBLE}" == "1"');
    expect(includeSource).toContain('$%MEMMY_STORE_TRANSITION_COMPATIBLE%');
    expect(includeSource).toContain('$%MEMMY_STORE_AUMID%');
    expect(includeSource).not.toContain('!getenv');
    const desktopShortcutBlock = includeSource.slice(
      includeSource.indexOf("memmy_point_desktop_shortcut:"),
      includeSource.indexOf("memmy_point_shortcuts_done:")
    );
    expect(desktopShortcutBlock).toContain(
      "An older NSIS uninstaller can remove the desktop shortcut"
    );
    expect(desktopShortcutBlock.match(/Goto memmy_point_new_desktop_shortcut/g)).toHaveLength(2);
    expect(includeSource).toContain('StrCpy $4 "1"');
    expect(includeSource).toContain('StrCmp $4 "1" 0 memmy_point_no_shortcut_refresh');
    expect(includeSource).toContain("Shell32::SHChangeNotify");
    expect(includeSource).not.toContain("WinShell::SetLnkAUMI");
    expect(includeSource).not.toContain("Function un.MemmyPointShortcutsToInstalledApp");
    expect(includeSource).not.toContain("MemmyPointExistingShortcutToInstalledApp");
    expect(includeSource).not.toContain('CreateShortCut "${SHORTCUT_PATH}" "$INSTDIR\\${PRODUCT_FILENAME}.exe"');
    expect(includeSource).toContain('StrCpy $R0 "$CMDLINE"');
    expect(includeSource).toContain('StrCpy $R1 "keep-shortcuts"');
    expect(includeSource).toContain("un_memmy_keep_shortcuts_loop:");
    expect(includeSource).toContain("un_memmy_keep_launch_proxy:");
    expect(includeSource).toContain("un_memmy_remove_launch_proxy:");
    expect(includeSource).not.toContain("${if} ${isKeepShortcuts}");
    expect(includeSource).not.toContain("_isKeepShortcuts");
    expect(includeSource).not.toContain("StdUtils::TestParameter");
    expect(includeSource).toContain('ReadRegStr $0 SHELL_CONTEXT "Software\\${APP_GUID}" "ShortcutName"');
    expect(includeSource).toContain('Delete "$DESKTOP\\$0.lnk"');
    expect(includeSource).toContain('Delete "$DESKTOP\\${SHORTCUT_NAME}.lnk"');
    expect(includeSource).toContain('RMDir /r "$LOCALAPPDATA\\Memmy\\launcher"');
    expect(includeSource.indexOf('StrCpy $R1 "keep-shortcuts"')).toBeLessThan(
      includeSource.indexOf('RMDir /r "$LOCALAPPDATA\\Memmy\\launcher"')
    );
    expect(includeSource).not.toContain("MsgBox");
    expect(includeSource).not.toContain("MessageBox MB_OK|MB_ICONINFORMATION");
    expect(readFileSync(packageWinX64Path, "utf8")).toContain(
      "build-windows-store-update-helper.ps1"
    );
    expect(includeSource).not.toContain("Memmy 将安装到当前用户目录");
    expect(updatePromptSource).toContain("function Resolve-MemmyPromptLanguage");
    expect(updatePromptSource).toContain("function Test-MemmyUpdatePromptDone");
    expect(updatePromptSource).toContain("function Get-MemmyAppProcessIds");
    expect(updatePromptSource).toContain("function Test-MemmyAppOpenedAfterPrompt");
    expect(updatePromptSource).toContain("function Enter-MemmyUpdatePromptSingleton");
    expect(updatePromptSource).toContain("function Exit-MemmyUpdatePromptSingleton");
    expect(updatePromptSource).toContain("System.Threading.Mutex");
    expect(updatePromptSource).toContain(".WaitOne(0)");
    expect(updatePromptSource).toContain("ReleaseMutex");
    expect(updatePromptSource).toContain("$InitialAppProcessIds");
    expect(updatePromptSource).toContain("$PromptMarkerPath");
    expect(updatePromptSource).toContain("System.Windows.MessageBox");
    expect(updatePromptSource).toContain("Stop-Process");
    expect(updatePromptSource).toContain("Start-Sleep -Milliseconds 500");
    expect(updatePromptSource).toContain("0x6B63");
    expect(updatePromptSource).not.toContain("Start-Sleep -Seconds 30");
    expect(updatePromptSource).not.toContain("System.Windows.Forms");
    expect(updatePromptSource).not.toContain("DispatcherTimer");
    expect(updatePromptSource).not.toContain("CornerRadius");
  });

  it.skipIf(process.platform !== "win32")("keeps Store activation fallback deterministic", () => {
    const source = readFileSync(winStoreActivateScriptPath, "utf8");
    expect(source).toContain("Remove-MemmyLegacyRegistration");
    expect(source).toContain("Test-MemmyLegacyLaunchProxyHandoff");
    expect(source).toContain("if (Test-MemmyLegacyLaunchProxyHandoff)");
    expect(source).toContain("886615f7-a04c-57ec-a2dd-9161dbe1a7c4");
    expect(source).toContain("Remove-Item -LiteralPath $legacyRegistryKey -Recurse -Force");
    expect(source).toContain('foreach ($valueName in @("Memmy", "memmy"))');
    expect(source).toContain("Remove-ItemProperty -LiteralPath $runKey");
    expect(source).toContain("IApplicationActivationManager");
    expect(source).toContain("ActivateApplication");
    expect(source).toContain("Test-MemmyStoreActivationResult -HResult $result.HResult -ProcessId $result.ProcessId");
    expect(source.indexOf("Invoke-MemmyStoreActivation -TargetAumId $AumId"))
      .toBeLessThan(source.indexOf("Remove-MemmyLegacyRegistration", source.indexOf("if ($MyInvocation.InvocationName")));
    expect(source).not.toContain("Get-Process");
    expect(source).toContain("Wait-MemmyStorePackage");
    expect(source).toContain("Wait-MemmyStoreReadyMarker");
    expect(source).toContain("legacy-cleanup-completed-v1.json");
    expect(source).toContain("Threading.Mutex");
    expect(source).toContain('Local\\MemmyStoreMigration_v1');
    expect(source).toContain("Start-Sleep -Seconds 2");
    expect(source).toContain("Start-Sleep -Milliseconds 500");
    expect(source).toContain("Remove-MemmyLegacyRegistration");

    const escapedPath = winStoreActivateScriptPath.replace(/'/g, "''");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. '${escapedPath}'; if ((Test-MemmyStorePackageStatus $null) -or (Test-MemmyStorePackageStatus ([pscustomobject]@{ Status = 'Error' })) -or -not (Test-MemmyStorePackageStatus ([pscustomobject]@{ Status = 'Ok' })) -or (Test-MemmyStoreActivationResult -HResult -1 -ProcessId 42) -or (Test-MemmyStoreActivationResult -HResult 0 -ProcessId 0) -or -not (Test-MemmyStoreActivationResult -HResult 0 -ProcessId 42)) { exit 1 }`
    ]);
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. '${escapedPath}'; $expected = Join-Path $env:LOCALAPPDATA 'Programs\\Memmy\\Memmy.exe'; $sameNameElsewhere = Join-Path $env:LOCALAPPDATA 'Other\\Memmy.exe'; $storePath = Join-Path $env:ProgramFiles 'WindowsApps\\Memmy.exe'; if (-not (Test-MemmyLegacyExecutablePath -Path $expected) -or (Test-MemmyLegacyExecutablePath -Path $sameNameElsewhere) -or (Test-MemmyLegacyExecutablePath -Path $storePath)) { exit 1 }`
    ]);

    const baseArguments = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winStoreActivateScriptPath, "-AumId"];
    expect(spawnSync("powershell.exe", [...baseArguments, "invalid"], { windowsHide: true }).status).toBe(4);
    expect(spawnSync("powershell.exe", [...baseArguments, "Missing.Package_0000000000000!Memmy"], { windowsHide: true }).status).toBe(2);
  });

  it("exports a consistent memory.sqlite snapshot through the desktop save dialog", () => {
    const source = readFileSync(mainSourcePath, "utf8");
    const exportSource = extractFunctionSource(source, "async function exportMemoryDatabase");

    expect(source).toContain('ipcMain.handle("memmy:export-memory-database"');
    expect(exportSource).toContain("dialog.showSaveDialog");
    expect(exportSource).toContain("await backupSqliteDatabase(sourcePath, selected.filePath)");
    expect(exportSource).not.toContain("await copyFile(sourcePath, selected.filePath)");
    expect(exportSource).toContain("memory-${formatExportTimestamp(new Date())}.sqlite");
    expect(exportSource).not.toContain("filters:");
    expect(exportSource).not.toContain("All Files");
    expect(source).toContain('import { backupSqliteDatabase } from "./sqlite-backup.js"');
    expect(source).toContain('join(homedir(), ".memmy", "memory-service", "memory.sqlite")');
  });

  it("saves and copies generated images through native desktop APIs", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");

    expect(interfaceSource).toContain("export interface DesktopImageActionRequest");
    expect(interfaceSource).toContain("export type DesktopImageSaveResult");
    expect(preloadSource).toContain("copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;");
    expect(preloadSource).toContain("saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:copy-image-to-clipboard", request)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:save-image", request)');
    expect(mainSource).toContain('ipcMain.handle("memmy:copy-image-to-clipboard"');
    expect(mainSource).toContain('ipcMain.handle("memmy:save-image"');
    // Handles expect.
    expect(mainSource).toContain("if (request?.data && request.data.byteLength > 0)");
    expect(mainSource).toContain("Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength)");
    // Handles expect.
    expect(mainSource).toContain("function resolveLocalGatewayMediaFile");
    expect(mainSource).toContain('pathname.match(/^\\/api\\/media\\/[A-Za-z0-9_-]+\\/([A-Za-z0-9_-]+)$/u)');
    expect(mainSource).toContain('Buffer.from(payload, "base64url").toString("utf8")');
    expect(mainSource).toContain('join(dataDir, "media")');
    expect(mainSource).toContain("const buffer = await readFile(localMediaFile)");
    expect(mainSource).toContain("nativeImage.createFromBuffer(imageData.buffer)");
    expect(mainSource).toContain("clipboard.writeImage(image)");
    expect(mainSource).toContain("dialog.showSaveDialog(owner, options)");
    expect(mainSource).toContain("await writeFile(selected.filePath, imageData.buffer)");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:copy-image-to-clipboard")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:save-image")');
    // Handles expect.
    expect(mainSource).toContain("async function ensureAgentGatewayToken");
    expect(mainSource).toContain('new URL("/webui/bootstrap", gateway.baseUrl)');
    expect(mainSource).toContain('"X-Memmy-Agent-Auth": gateway.bootstrapSecret');
    expect(mainSource).toContain("Authorization: `Bearer ${bearer}`");
    expect(mainSource).toContain("if (response.status === 401)");
  });

  it("installs memmy-memory into ~/.local/bin through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const packageSource = normalizeLineEndings(readFileSync(packageMacDmgPath, "utf8"));

    expect(preloadSource).toContain("installCliTools(): Promise<unknown>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:install-cli-tools")');
    expect(mainSource).toContain('ipcMain.handle("memmy:install-cli-tools"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:install-cli-tools")');
    expect(mainSource).toContain("async function installCliTools");
    expect(mainSource).toContain('join(homedir(), ".local", "bin")');
    expect(mainSource).toContain('{ name: "memmy-memory", source: join(cliDirectory, "memmy-memory") }');
    expect(mainSource).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(packageSource).toContain("Default prefix:\n  ~/.local/bin");
    expect(packageSource).toContain('PREFIX="$HOME/.local/bin"');
    expect(packageSource).not.toContain("/usr/local/bin when writable");
  });

  it("restarts the Memory process through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const runtimeSource = readFileSync(runtimeServicesPath, "utf8");

    expect(preloadSource).toContain("restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:restart-memory-service")');
    expect(mainSource).toContain('ipcMain.handle("memmy:restart-memory-service"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:restart-memory-service")');
    expect(mainSource).toContain("await runtimeServices.restartMemory()");
    expect(runtimeSource).toContain("restartManagedMemoryService");
    expect(runtimeSource).toContain("/api/v1/admin/shutdown");
  });

  it("keeps packaged agent CLI installation on memmy only", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const packageSource = readFileSync(packageMacDmgPath, "utf8");
    const windowsPackageSource = readFileSync(packageWinX64Path, "utf8");
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentPackageLock = readJson<{ packages?: Record<string, PackageJson> }>(agentPackageLockPath);

    expect(agentPackage.bin).toEqual({ memmy: "./dist/main.js" });
    expect(agentPackageLock.packages?.[""]?.bin).toEqual({ memmy: "dist/main.js" });
    expect(mainSource).toContain('const memmyCli = join(cliDirectory, "memmy")');
    expect(mainSource).toContain('await Promise.all([access(memoryCli), access(memmyCli)])');
    expect(mainSource).toContain('installSymlink(memmyCli, join(binDirectory, "memmy"))');
    expect(mainSource).not.toContain(['join(cliDirectory, "', 'memmy-agent', '")'].join(""));
    expect(mainSource).not.toContain(['join(binDirectory, "', 'memmy-agent', '")'].join(""));
    expect(packageSource).toContain('create_cli_launcher "$CLI_BIN_DIR/memmy"');
    expect(packageSource).not.toContain(['create_cli_launcher "$CLI_BIN_DIR/', 'memmy-agent', '"'].join(""));
    expect(packageSource).not.toContain(['ln -sf "$SCRIPT_DIR/', 'memmy-agent', '"'].join(""));
    expect(windowsPackageSource).toContain('create_windows_cli_launcher "$CLI_BIN_DIR/memmy.cmd"');
    expect(windowsPackageSource).toContain('for %%I in ("%RESOURCES_DIR%\\..") do set "APP_DIR=%%~fI"');
    expect(windowsPackageSource).toContain('set "APP_EXEC=%APP_DIR%\\Memmy.exe"');
    expect(windowsPackageSource).not.toContain('set "APP_EXEC=%RESOURCES_DIR%\\Memmy.exe"');
    expect(windowsPackageSource).not.toContain(['create_windows_cli_launcher "$CLI_BIN_DIR/', 'memmy-agent', '.cmd"'].join(""));
  });

  it("wires developer diagnostics buttons through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");

    expect(preloadSource).toContain("openLogsDirectory(): Promise<void>;");
    expect(preloadSource).toContain("exportDiagnosticsReport(): Promise<DiagnosticsReportExportResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:open-logs-directory")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:export-diagnostics-report")');
    expect(mainSource).toContain('ipcMain.handle("memmy:open-logs-directory"');
    expect(mainSource).toContain('ipcMain.handle("memmy:export-diagnostics-report"');
    expect(mainSource).toContain("async function openLogsDirectory()");
    expect(mainSource).toContain("async function exportDiagnosticsReport");
    expect(mainSource).toContain("await shell.openPath(logsDirectory)");
    expect(mainSource).toContain("buildDiagnosticsReport()");
    expect(mainSource).toContain("await writeFile(selected.filePath, report, \"utf8\")");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:open-logs-directory")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:export-diagnostics-report")');
  });

  it("exposes app version and update checks through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const runtimeServicesSource = readFileSync(runtimeServicesPath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");
    const windowsPreparedUpdateSource = extractFunctionSource(mainSource, "async function waitForWindowsPreparedRequiredUpdateBeforeBoot");

    expect(interfaceSource).toContain("export interface DesktopAppInfo");
    expect(interfaceSource).toContain("export interface DesktopUpdateCheckResult");
    expect(interfaceSource).toContain("export interface DesktopUpdateInstallResult");
    expect(mainSource).toContain("resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE)");
    expect(mainSource).toContain('const UPDATE_MANIFEST_PATH = "/api/memmy/desktop/latest"');
    expect(mainSource).toContain("const DEFAULT_UPDATE_MANIFEST_URL = `${UPDATE_MANIFEST_BASE_URL}${UPDATE_MANIFEST_PATH}`");
    expect(mainSource).not.toContain("MEMMY_UPDATE_MANIFEST_URL");
    expect(mainSource).toContain("await installPreparedRequiredUpdateBeforeBoot()");
    expect(mainSource).toContain("startRequiredUpdateBackgroundChecks()");
    expect(mainSource).toContain("function startRequiredUpdateBackgroundChecks()");
    expect(mainSource).toContain("async function installPreparedRequiredUpdateBeforeBoot()");
    expect(mainSource).toContain("async function prepareRequiredUpdateAfterBoot()");
    expect(mainSource).toContain('url.searchParams.set("platformType", resolveCurrentDesktopPlatformType())');
    expect(mainSource).toContain("REQUIRED_UPDATE_BACKGROUND_FIRST_CHECK_DELAY_MS");
    expect(mainSource).toContain("REQUIRED_UPDATE_BACKGROUND_CHECK_INTERVAL_MS");
    expect(mainSource).toContain("requiredUpdateBackgroundFirstCheckTimer");
    expect(mainSource).toContain("setTimeout(() => {");
    expect(mainSource).toContain("clearTimeout(requiredUpdateBackgroundFirstCheckTimer)");
    expect(mainSource).toContain("isRequiredUpdateBackgroundCheckRunning");
    expect(mainSource).toContain("clearTimeout(requiredUpdateBackgroundCheckTimer)");
    expect(mainSource).toContain("prepared-required-update.json");
    expect(mainSource).toContain("async function resolvePreparedUpdatePackagePath");
    expect(mainSource).toContain("async function writePreparedRequiredUpdate");
    expect(mainSource).toContain("async function clearPreparedRequiredUpdate");
    expect(mainSource).toContain("function isRequiredUpdate(update: DesktopUpdateCheckResult)");
    expect(mainSource).toContain("function isManagedBackgroundUpdate(update: DesktopUpdateCheckResult)");
    expect(mainSource).toContain('update.updateMode === "silent" || isRequiredUpdate(update)');
    expect(mainSource).toContain("preparedManagedBackgroundUpdateVersion");
    expect(mainSource).toContain("await hasPreparedRequiredUpdate(update)");
    expect(mainSource).toContain("const preparedFilePath = update.preparedUpdatePath ?? (await downloadUpdate(update, { openInstaller: false })).filePath");
    expect(mainSource).toContain("await writePreparedRequiredUpdate(update, preparedFilePath)");
    expect(mainSource).toContain("async function installPreparedRequiredUpdateOnQuit");
    expect(mainSource).toContain("await installPreparedRequiredUpdateOnQuit()");
    expect(mainSource).toContain("openAfterInstall: false");
    expect(mainSource).not.toContain('openAfterInstall: process.platform === "win32"');
    expect(mainSource).toContain("function resolvePreparedRequiredUpdateLockPath");
    expect(mainSource).toContain("async function waitForPreparedRequiredUpdateLock");
    expect(mainSource).toContain("async function waitForWindowsPreparedRequiredUpdateBeforeBoot");
    expect(mainSource).toContain('boot:prepared-required-update waiting-for-lock win32');
    expect(mainSource).toContain("async function reopenInstalledAppAfterPreparedUpdate");
    expect(mainSource).toContain("WINDOWS_PREPARED_UPDATE_RELAUNCH_DELAY_MS");
    expect(mainSource).toContain("const opener = spawn(process.execPath");
    expect(mainSource).toContain("boot:prepared-required-update waiting-for-lock");
    expect(mainSource).toContain("async function showWindowsUpdateInProgressMessage");
    expect(mainSource).toContain("await showWindowsUpdateInProgressMessage()");
    expect(mainSource).toContain("type WindowsUpdatePromptLanguage");
    expect(mainSource).toContain('const WINDOWS_UPDATE_PROMPT_LANGUAGE_FILE = "update-prompt-language.txt"');
    expect(mainSource).toContain("function resolveWindowsUpdatePromptMarkerPath");
    expect(mainSource).toContain("async function writeWindowsUpdatePromptMarker");
    expect(mainSource).toContain("async function clearWindowsUpdatePromptMarker");
    expect(mainSource).toContain("existsSync(resolveWindowsUpdatePromptMarkerPath())");
    expect(mainSource).toContain("function resolveInstalledWindowsUpdatePromptScriptPath");
    expect(mainSource).toContain("function resolveWindowsPowerShellPath");
    expect(mainSource).toContain("startWindowsUpdatePromptProcess");
    expect(mainSource).toContain('join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")');
    expect(mainSource).toContain("function resolveWindowsUpdatePromptLanguageFromAppSettings");
    expect(mainSource).toContain('language === "zh-CN" || language === "en-US"');
    expect(mainSource).toContain('resolveCurrentDesktopEdition() === "intl" ? "en-US" : "zh-CN"');
    expect(mainSource).toContain("await writeWindowsUpdatePromptLanguage(resolveWindowsUpdatePromptLanguageFromAppSettings())");
    expect(mainSource).toContain("await writeWindowsUpdatePromptMarker()");
    expect(mainSource).toContain("showUpdatePrompt: shouldShowWindowsUpdatePromptForPreparedUpdate(update)");
    expect(mainSource).toContain("showUpdatePrompt: preparedUpdate.showUpdatePrompt === true");
    expect(mainSource).toContain("function shouldShowWindowsUpdatePromptForPreparedUpdate");
    expect(mainSource).toContain('update.updateMode === "silent" && !isRequiredUpdate(update)');
    expect(mainSource).toContain("options.showUpdatePrompt");
    expect(mainSource).toContain("await clearWindowsUpdatePromptMarker().catch(() => undefined)");
    expect(mainSource).toContain('$promptMarkerPath = "$MarkerPath.prompt"');
    expect(mainSource).not.toContain("WINDOWS_UPDATE_IN_PROGRESS_PROMPTS");
    expect(mainSource).not.toContain("Memmy 正在更新");
    expect(mainSource).toContain("boot:prepared-required-update win32");
    expect(mainSource).toContain("async function waitForPreparedRequiredUpdateLockStart");
    expect(windowsPreparedUpdateSource).toContain("openBackgroundUpdateInstaller(safeFilePath");
    expect(mainSource).toContain("$arguments = @('/S', '--updated', '/currentuser', ('/D=' + $appDir))");
    expect(mainSource).not.toContain("app reopened before install; deferring update");
    expect(mainSource).toContain("app processes still running before install; waiting");
    expect(mainSource).toContain("function hideMacDockForPreparedUpdateInstall");
    expect(mainSource).toContain("app.dock?.hide()");
    expect(mainSource).toContain("isManagedUpdateInstallerRunning");
    expect(mainSource).toContain("async function openBackgroundUpdateInstaller");
    expect(mainSource).toContain('ipcMain.handle("memmy:get-app-info"');
    expect(mainSource).toContain('ipcMain.handle("memmy:check-for-updates"');
    expect(mainSource).toContain('ipcMain.handle("memmy:download-update"');
    expect(mainSource).toContain('ipcMain.handle("memmy:open-update-installer"');
    expect(mainSource).toContain('ipcMain.handle("memmy:notify-update-available"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:get-app-info")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:check-for-updates")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:download-update")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:open-update-installer")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:notify-update-available")');
    expect(mainSource).toContain("app.getVersion()");
    expect(mainSource).toContain("function resolveDesktopAppVersion()");
    expect(mainSource).toContain("electronAppVersion !== process.versions.electron");
    expect(mainSource).toContain("function resolveDesktopPackageVersion()");
    expect(mainSource).toContain("resolveUpdateDownloadUrl");
    expect(mainSource).toContain("readManifestString(manifest, \"minSupportedVersion\")");
    expect(mainSource).toContain("const updateMode = readUpdateMode(manifest)");
    expect(mainSource).toContain('url.searchParams.set("platformType", resolveCurrentDesktopPlatformType())');
    expect(mainSource).toContain('url.searchParams.set("version", resolveDesktopAppVersion())');
    expect(mainSource).toContain("function readUpdateEnvelopeManifest");
    expect(mainSource).toContain('value.code !== 0');
    expect(mainSource).toContain('readManifestRecord(value, "data") ?? {}');
    expect(mainSource).toContain("async function downloadUpdate");
    expect(mainSource).toContain("function resolveUpdatesDirectory()");
    expect(mainSource).toContain('join(app.getPath("userData"), "updates")');
    expect(mainSource).toContain("function resolveDownloadedUpdatePath");
    expect(mainSource).toContain("shouldInstallMacDmgUpdateInBackground(safeFilePath)");
    expect(mainSource).toContain("function resolveMacUpdateDestinationAppPath()");
    expect(mainSource).toContain('const installedMemmyAppPath = "/Applications/Memmy.app"');
    expect(mainSource).toContain('join("/Applications", basename(currentAppPath))');
    expect(mainSource).toContain("async function installMacDmgUpdateInBackground");
    expect(mainSource).toContain("async function stageMacDmgUpdatePackage");
    expect(mainSource).toContain("function resolveStagedMacUpdateAppPath");
    expect(mainSource).toContain("function createMacDmgUpdateStageScript");
    expect(mainSource).toContain("await stageMacDmgUpdatePackage(filePath)");
    expect(mainSource).toContain("using staged Memmy app");
    expect(mainSource).toContain("STAGED_APP_PATH");
    expect(mainSource).toContain("function shouldInstallWindowsUpdateInBackground");
    expect(mainSource).toContain("async function installWindowsUpdateInBackground");
    expect(mainSource).toContain("launch-win-update-${Date.now()}.vbs");
    expect(mainSource).toContain("install-win-update-${Date.now()}.ps1");
    expect(mainSource).toContain('const helper = spawn("wscript.exe"');
    expect(mainSource).toContain("function createWindowsUpdateLauncherScript");
    expect(mainSource).toContain("$arguments = @('/S', '--updated', '/currentuser', ('/D=' + $appDir))");
    expect(mainSource).toContain("CURRENT_APP_PID");
    expect(mainSource).toContain("OPEN_AFTER_INSTALL");
    expect(mainSource).toContain('while /bin/kill -0 "$CURRENT_APP_PID"');
    expect(mainSource).toContain("terminating leftover Memmy runtime processes");
    expect(mainSource).toContain("-WindowStyle Hidden");
    expect(mainSource).not.toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command");
    expect(mainSource).not.toContain("install-win-update-${Date.now()}.cmd");
    expect(mainSource).not.toContain('spawn(process.env.ComSpec ?? "cmd.exe"');
    expect(mainSource).not.toContain("findstr /R");
    expect(mainSource).not.toContain("for _ in {1..120}");
    expect(mainSource).not.toContain("for /L %%i in (1,1,120)");
    expect(mainSource).toContain('spawn("/bin/zsh"');
    expect(mainSource).toContain("/usr/bin/hdiutil attach");
    expect(mainSource).toContain('/usr/bin/open -n "$DEST_APP_PATH"');
    expect(mainSource).toContain("await shell.openPath(safeFilePath)");
    expect(mainSource).toContain("function shouldQuitForManualUpdateInstall");
    expect(mainSource).toContain("function scheduleQuitForManualUpdateInstall");
    expect(mainSource).toContain("if (shouldInstallWindowsUpdateInBackground(safeFilePath))");
    expect(mainSource).toContain("const result = await installWindowsUpdateInBackground(safeFilePath)");
    expect(mainSource).toContain("UPDATE_INSTALL_QUIT_DELAY_MS");
    expect(mainSource).toContain("UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS");
    expect(mainSource).toContain("const forceExitDelayMs = process.platform === \"win32\" ? WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS : UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("APP_QUIT_ANALYTICS_GRACE_MS");
    expect(mainSource).toContain("const APP_QUIT_ANALYTICS_GRACE_MS = 150;");
    expect(mainSource).toContain("sendAppExitEventBeforeQuit()");
    expect(mainSource).toContain("Promise.race([exitEvent, delay(APP_QUIT_ANALYTICS_GRACE_MS)])");
    expect(mainSource).toContain("armQuitCleanupForceExitTimer()");
    expect(mainSource).toContain("clearQuitCleanupForceExitTimer()");
    expect(mainSource).toContain("hideAppShellForQuit()");
    expect(mainSource).toContain("function hideAppShellForQuit()");
    expect(mainSource).toContain("BrowserWindow.getAllWindows()");
    expect(mainSource).toContain("quit cleanup timed out; forcing app exit");
    expect(mainSource).toContain("quit:cleanup-failed");
    expect(mainSource).toContain("app.exit(0)");
    expect(mainSource).toContain("async function cleanupBeforeQuit()");
    expect(mainSource).toContain("event.preventDefault()");
    expect(mainSource).toContain("await services?.close()");
    expect(mainSource).toContain("app.quit()");
    expect(runtimeServicesSource).toContain("STOP_MANAGED_CHILD_GRACE_MS");
    expect(runtimeServicesSource).toContain("sleep(STOP_MANAGED_CHILD_GRACE_MS)");
    expect(interfaceSource).toContain("export type DesktopUpdateMode");
    expect(interfaceSource).toContain("export interface DesktopUpdateDownloadOptions");
    expect(interfaceSource).toContain("minSupportedVersion?: string");
    expect(interfaceSource).toContain("updateMode?: DesktopUpdateMode");
    expect(interfaceSource).toContain("force?: boolean");
    expect(interfaceSource).toContain("preparedUpdatePath?: string");
    expect(interfaceSource).toContain("willQuit?: boolean");
    expect(interfaceSource).toContain("background?: boolean");
    expect(preloadSource).toContain("getAppInfo(): Promise<DesktopAppInfo>;");
    expect(preloadSource).toContain("checkForUpdates(): Promise<DesktopUpdateCheckResult>;");
    expect(preloadSource).toContain("downloadUpdate(update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;");
    expect(preloadSource).toContain("openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;");
    expect(preloadSource).toContain("notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:get-app-info")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:check-for-updates")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:download-update", update, options)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:open-update-installer", filePath)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:notify-update-available", payload)');
  });

  it("declares macOS microphone usage and exposes microphone permission bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const electronBuilderSource = readFileSync(electronBuilderPath, "utf8");
    const macEntitlementsSource = readFileSync(macEntitlementsPath, "utf8");
    const macEntitlementsInheritSource = readFileSync(macEntitlementsInheritPath, "utf8");

    expect(electronBuilderSource).toContain("NSMicrophoneUsageDescription");
    expect(electronBuilderSource).toContain("entitlements: build/entitlements.mac.plist");
    expect(electronBuilderSource).toContain("entitlementsInherit: build/entitlements.mac.inherit.plist");
    expect(macEntitlementsSource).toContain("com.apple.security.device.audio-input");
    expect(macEntitlementsInheritSource).toContain("com.apple.security.device.audio-input");
    expect(mainSource).toContain('ipcMain.handle("memmy:get-microphone-access-status"');
    expect(mainSource).toContain('ipcMain.handle("memmy:request-microphone-access"');
    expect(preloadSource).toContain("getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus>;");
    expect(preloadSource).toContain("requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;");
  });

  it("uses the Memmy mascot icon for packaged app artifacts", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const macBuilderSource = readFileSync(electronBuilderPath, "utf8");
    const unsignedMacBuilderSource = readFileSync(unsignedElectronBuilderPath, "utf8");
    const winBuilderSource = readFileSync(winElectronBuilderPath, "utf8");
    const unsignedWinBuilderSource = readFileSync(winUnsignedBuilderPath, "utf8");

    expect(macBuilderSource).toContain("icon: build/icon.icns");
    expect(unsignedMacBuilderSource).toContain("icon: build/icon.icns");
    expect(winBuilderSource).toContain("icon: build/icon.ico");
    expect(unsignedWinBuilderSource).toContain("icon: build/icon.ico");
    expect(winBuilderSource).toContain("from: build/icon.ico");
    expect(winBuilderSource).toContain("to: icon.ico");
    expect(unsignedWinBuilderSource).toContain("from: build/icon.ico");
    expect(unsignedWinBuilderSource).toContain("to: icon.ico");
    expect(mainSource).toContain('const WINDOWS_APP_USER_MODEL_ID = "cn.memtensor.memmy";');
    expect(mainSource).toContain("resolveWindowsStoreAumid");
    expect(mainSource).toContain("app.setAppUserModelId(storeAumid ?? WINDOWS_APP_USER_MODEL_ID);");
    expect(mainSource).toContain("process.chdir(dirname(process.execPath));");
    expect(mainSource).toContain('join(process.resourcesPath, "icon.ico")');
    expect(mainSource).toContain("resolveWindowsTaskbarIconPath()");
    expect(mainSource).toContain('process.platform !== "win32" || isWindowsStoreApp()');
    expect(mainSource).toContain("function resolveWindowsTrayImage()");
    const windowsTrayResolverSource = mainSource.slice(
      mainSource.indexOf("function resolveWindowsTrayImage()"),
      mainSource.indexOf("function setDevelopmentDockIcon()")
    );
    expect(windowsTrayResolverSource).toContain('join(process.resourcesPath, "icon.ico")');
    expect(windowsTrayResolverSource).toContain('resolve(import.meta.dirname, "../../build/icon.ico")');
    expect(windowsTrayResolverSource).not.toContain("resolveWindowsTaskbarIconPath()");
    expect(mainSource).toContain("syncMenuBarTray(true);");
  });

  it("keeps runtime-services packaged-only and out of Electron userData", () => {
    const source = readFileSync(runtimeServicesPath, "utf8");

    expect(source).toContain("startPackagedRuntimeServices");
    expect(source).toContain('env.MEMMY_CONFIG ?? join(memmyHome, "config.yaml")');
    expect(source).toContain('env.MEMMY_AGENT_WORKSPACE ?? configuredWorkspace ?? defaultWorkspace');
    expect(source).toContain("syncBundledAgentSkills");
    expect(source).toContain('join(dirname(options.agentEntry), "skills")');
    expect(source).toContain('join(options.agentWorkspace, "skills")');
    expect(source).toContain("copyDirectoryContents");
    expect(source).toContain(
      "browserPreparation = startPackagedBrowserPreparation(",
    );
    expect(source).not.toContain("await preparePackagedBrowser(entries, runtimeConfig, options)");
    expect(source).toContain('[entries.agentEntry, "internal", "browser-prepare"]');
    expect(source.indexOf("browserPreparation = startPackagedBrowserPreparation")).toBeLessThan(
      source.indexOf("await ensureMemoryService"),
    );
    expect(source).toContain("browserPreparation?.stop()");
    expect(source).toContain("terminateProcessTreeSync(child)");
    expect(source).toContain('detached: process.platform !== "win32"');
    expect(source).toContain('process.kill(-pid, "SIGKILL")');
    expect(source).toContain('join(options.logDirectory, "browser-prepare.log")');
    expect(source).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(source).toContain("await readdir(sourceDirectory, { withFileTypes: true })");
    expect(source).toContain("await writeFile(targetPath, await readFile(sourcePath))");
    expect(source).not.toContain("startDesktopRuntimeServices");
    expect(source).not.toContain("DesktopRuntimeServices");
    expect(source).not.toContain("StartDesktopRuntimeServicesOptions");
    expect(source).not.toContain("userDataPath");
    expect(source).not.toContain("mainDir");
    expect(source).not.toContain("getFreePort");
    expect(source).not.toContain(legacyApplicationSupportDir);
    expect(source).not.toContain("dist/src/server/index.js");
    expect(source).not.toContain("App/memmy-agent/dist/main.js");
  });

  it("exports shared config and workspace paths from dev-start", () => {
    const source = readFileSync(devStartPath, "utf8");
    const supervisorSource = readFileSync(devMemorySupervisorPath, "utf8");
    const nativeRebuildIndex = source.indexOf("npm rebuild better-sqlite3");
    const electronRuntimeCheckIndex = source.indexOf("ensure_electron_runtime", nativeRebuildIndex);
    const desktopLaunchIndex = source.indexOf("npm run dev -w @memmy/desktop", electronRuntimeCheckIndex);

    expect(source).toContain('MEMORY_CLI_ENTRY="$ROOT_DIR/Memory/dist/src/cli/index.js"');
    expect(source).toContain('MEMMY_CONFIG_PATH="${MEMMY_CONFIG:-$HOME/.memmy/config.yaml}"');
    expect(source).toContain('MEMMY_WORKSPACE_DIR="${MEMMY_WORKSPACE:-$HOME/.memmy/workspace}"');
    expect(source).toContain('MEMMY_BIN_DIR="$HOME/.local/bin"');
    expect(source).toContain('export MEMMY_CONFIG="$MEMMY_CONFIG_PATH"');
    expect(source).toContain('export MEMMY_AGENT_WORKSPACE="$MEMMY_WORKSPACE_DIR"');
    expect(source).toContain('runtime_node_dir="$(cd "$(dirname "$MEMMY_RUNTIME_NODE_PATH")" && pwd)"');
    expect(source).toContain('export PATH="$runtime_node_dir:$PATH"');
    expect(source).not.toContain('MEMMY_BIN_DIR="$HOME/.memmy/bin"');
    expect(source).not.toContain('"bash -lc ');
    expect(source.match(/"bash -c /g)).toHaveLength(5);
    expect(source).toContain('const Database = require("better-sqlite3")');
    expect(source).toContain("npm run dev -w @memmy/desktop");
    expect(source).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci");
    expect(source).toContain(
      '"$MEMMY_RUNTIME_NODE_PATH" dist/main.js internal browser-prepare',
    );
    expect(source).toContain("env -u ELECTRON_RUN_AS_NODE npm run dev -w @memmy/desktop");
    expect(source).toContain("node scripts/internal/dev-memory-supervisor.mjs");
    expect(supervisorSource).toContain('["run", "memory:dev"]');
    expect(supervisorSource).toContain("Memory dev process stopped");
    expect(source).toContain('pgrep -f "/Memmy.app/Contents/MacOS/Memmy"');
    expect(source.match(/lsof -tiTCP:18997/g)).toHaveLength(2);
    expect(source.match(/lsof -tiTCP:18999/g)).toHaveLength(2);
    expect(nativeRebuildIndex).toBeGreaterThanOrEqual(0);
    expect(electronRuntimeCheckIndex).toBeGreaterThan(nativeRebuildIndex);
    expect(desktopLaunchIndex).toBeGreaterThan(electronRuntimeCheckIndex);
  });

  it("clears persisted Memmy environment and legacy CLI links during full uninstall", () => {
    const source = readFileSync(clearAllPath, "utf8");

    expect(source).toContain("launchctl unsetenv");
    expect(source).toContain("^(MEMMY_|MEMORY_SERVICE_)");
    expect(source).toContain('"$HOME/.zshenv"');
    expect(source).toContain('"$HOME/.bash_profile"');
    expect(source).toContain('"/usr/local/bin/memmy-memory"');
    expect(source).toContain("# Memmy CLI PATH");
    expect(source).toContain("Fully quit and reopen Codex");
  });

  it("keeps packaged CLI launchers on Memmy.app and ~/.memmy/config.yaml", () => {
    const source = readFileSync(packageMacDmgPath, "utf8");

    expect(source).toContain('APP_EXEC="\\$MACOS_DIR/Memmy"');
    expect(source).toContain('DEFAULT_CONFIG="\\$HOME/.memmy/config.yaml"');
    expect(source).toContain('APP_PATH="/Applications/Memmy.app"');
    expect(source).not.toMatch(legacyProductPattern);
    expect(source).not.toContain("agent/config.yaml");
    expect(source).not.toContain("memory-service/config.yaml");
  });

  it("packages Memory from its own workspace with an Electron-rebuilt sqlite addon", () => {
    const source = readFileSync(packageMacDmgPath, "utf8");

    expect(source).toContain('MEMORY_DIR="$ROOT_DIR/Memory"');
    expect(source).toContain("create_memory_runtime_manifest");
    expect(source).toContain("write_desktop_edition_manifest");
    expect(source).toContain('"signing": "$package_signing"');
    expect(source).toContain("npm run build -w @memmy/memory");
    expect(source).toContain("npm install --workspace @memmy/frontend-desktop --no-package-lock");
    expect(source).toContain('npm ci --prefix "$AGENT_DIR"');
    expect(source).toContain('import { createConnection } from "@playwright/mcp"');
    expect(source).toContain('require.resolve("playwright-core/package.json")');
    expect(source).toContain("./dist/entrypoints/cli/commands.js");
    expect(source).toContain('"browser-prepare"');
    expect(source).not.toContain('fs.readFileSync("./dist/main.js", "utf8").includes("browser-prepare")');
    expect(source).not.toContain('npm install --prefix "$AGENT_DIR"');
    expect(source).not.toContain('if [ ! -x "$AGENT_DIR/node_modules/.bin/tsc" ]');
    expect(source).toContain('cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"');
    expect(source).toContain('npm ci --prefix "$RUNTIME_DIR/memory" --omit=dev --os=darwin --cpu="$TARGET_CPU"');
    expect(source).toContain("node_modules/.bin/electron-rebuild");
    expect(source).toContain('-m "$RUNTIME_DIR/memory"');
    expect(source).not.toContain('cp -R "$ROOT_DIR/dist/src" "$RUNTIME_DIR/memory/src"');
  });

  it("builds signed arm64 DMGs through the shared mac packaging script", () => {
    const source = readFileSync(signedMacArm64PackagePath, "utf8");

    expect(source).toMatch(/bash "\$ROOT_DIR\/scripts\/internal\/package-mac-dmg\.sh" \\\s+--arm64 \\/);
    expect(source).not.toContain("npm run package:mac -- --arm64");
  });

  it("builds Windows x64 editions through one shared packaging script", () => {
    const wrappers = [
      [readFileSync(winX64CnUnsignedPackagePath, "utf8"), "phone", "cn", true],
      [readFileSync(winX64CnSignedPackagePath, "utf8"), "phone", "cn", false],
      [readFileSync(winX64IntlUnsignedPackagePath, "utf8"), "email", "intl", true],
      [readFileSync(winX64IntlSignedPackagePath, "utf8"), "email", "intl", false]
    ] as const;

    for (const [source, accountChannel, edition, unsigned] of wrappers) {
      expect(source).toContain(`export MEMMY_ACCOUNT_CHANNEL=${accountChannel}`);
      expect(source).toContain(`export MEMMY_APP_EDITION=${edition}`);
      expect(source).toContain('scripts/internal/package-win-x64.sh');
      if (unsigned) {
        expect(source).toContain("export MEMMY_SKIP_CODESIGN=1");
      } else {
        expect(source).toContain("unset MEMMY_SKIP_CODESIGN");
      }
    }
  });

  it("validates the bundled browser runtime during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    expect(source).toContain('import { createConnection } from "@playwright/mcp"');
    expect(source).toContain('require.resolve("playwright-core/package.json")');
    expect(source).toContain("./dist/entrypoints/cli/commands.js");
    expect(source).toContain('"browser-prepare"');
    expect(source).not.toContain('fs.readFileSync("./dist/main.js", "utf8").includes("browser-prepare")');
  });

  it("fails package preparation when required native runtime companion files are missing", () => {
    const macSource = readFileSync(packageMacDmgPath, "utf8");
    const winSource = readFileSync(packageWinX64Path, "utf8");

    expect(macSource).toContain("verify_mac_memory_native_artifacts");
    expect(macSource).toContain("verify_mac_agent_native_artifacts");
    expect(macSource).toContain("verify_packaged_mac_unpacked_artifacts");
    expect(macSource).toContain("libonnxruntime*.dylib");
    expect(macSource).toContain("sharp-libvips-darwin-$target_cpu/lib/libvips*.dylib");
    expect(macSource).toContain("node-pty-darwin-$target_cpu/prebuilds/darwin-$target_cpu");
    expect(macSource).toContain("app.asar.unpacked/dist/runtime");
    expect(macSource).toContain("spawn-helper");
    expect(winSource).toContain("verify_windows_onnxruntime_module");
    expect(winSource).toContain("verify_windows_sharp_module");
    expect(winSource).toContain("verify_windows_agent_native_artifacts");
    expect(winSource).toContain("verify_packaged_windows_unpacked_artifacts");
    expect(winSource).toContain('onnxruntime_dir="$(dirname "$onnxruntime_node")"');
    expect(winSource).toContain("onnxruntime.dll");
    expect(winSource).toContain("sharp-win32-x64/lib");
    expect(winSource).toContain("win-unpacked/resources/app.asar.unpacked/dist/runtime");
    expect(winSource).toContain("conpty/OpenConsole.exe");
    expect(winSource).toContain("sqlite-vec-windows-x64/vec0.*");
  });

  it("sets an explicit edition in macOS package wrappers", () => {
    for (const [name, accountChannel, edition] of [
      ["cn-unsigned", "phone", "cn"],
      ["cn-signed", "phone", "cn"],
      ["intl-unsigned", "email", "intl"],
      ["intl-signed", "email", "intl"]
    ] as const) {
      const path = fileURLToPath(new URL(`../../../../scripts/package-mac-arm64-${name}.sh`, import.meta.url));
      const source = readFileSync(path, "utf8");

      expect(source).toContain(`export MEMMY_ACCOUNT_CHANNEL=${accountChannel}`);
      expect(source).toContain(`export MEMMY_APP_EDITION=${edition}`);
    }
  });

  it("supports Windows signing through PFX files and SimplySign certificate store thumbprints", () => {
    const source = readFileSync(packageWinX64Path, "utf8");
    const builderConfig = readFileSync(winElectronBuilderPath, "utf8");

    expect(source).toContain("WIN_CSC_LINK");
    expect(source).toContain("WIN_CSC_KEY_PASSWORD");
    expect(source).toContain("WIN_CSC_SHA1");
    expect(source).toContain("WIN_CSC_SUBJECT_NAME");
    expect(source).toContain("WIN_CSC_TIMESTAMP_SERVER");
    expect(source).toContain("--config.win.signtoolOptions.certificateSha1=");
    expect(source).toContain("--config.win.signtoolOptions.certificateSubjectName=");
    expect(source).toContain("--config.win.signtoolOptions.rfc3161TimeStampServer=");
    expect(source).toContain('if [ "${#WINDOWS_SIGNING_BUILDER_ARGS[@]}" -gt 0 ]; then');
    expect(source).toContain('BUILDER_ARGS+=("${WINDOWS_SIGNING_BUILDER_ARGS[@]}")');
    expect(builderConfig).toContain("signingHashAlgorithms:");
    expect(builderConfig).toContain("- sha256");
  });

  it("reads Windows package versions through Node-readable paths", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("to_node_readable_path");
    expect(source).toContain("cygpath -w");
    expect(source).toContain('DESKTOP_VERSION="${MEMMY_DESKTOP_VERSION:-$(read_package_version "$DESKTOP_DIR/package.json")}"');
    expect(source).toContain(
      'electron_version="${MEMMY_ELECTRON_VERSION:-$(read_package_version "$DESKTOP_DIR/node_modules/electron/package.json")}"'
    );
    expect(source).not.toContain("require('$DESKTOP_DIR/package.json')");
    expect(source).not.toContain("require('$DESKTOP_DIR/node_modules/electron/package.json')");
  });

  it("runs npm lifecycle scripts through bash during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("configure_npm_script_shell");
    expect(source).toContain("npm_with_configured_script_shell");
    expect(source).toContain('npm --script-shell "$npm_config_script_shell" "$@"');
    expect(source).toContain("npm_config_script_shell");
    expect(source).toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(source).toContain("MEMMY_NPM_SCRIPT_SHELL");
    expect(source).toContain("command -v bash");
  });

  it("gates electron-builder uninstaller desktop refresh during keep-shortcuts updates", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("patch_electron_builder_nsis_refresh");
    expect(source).toContain("app-builder-lib/templates/nsis/uninstaller.nsh");
    expect(source).toContain("refresh the desktop after shortcuts were actually removed");
    expect(source).toContain('source.includes(marker)');
    expect(source).toContain('source.replace(original, replacement)');
    expect(source).toContain('patch_electron_builder_nsis_refresh');
    expect(source.indexOf("patch_electron_builder_nsis_refresh")).toBeLessThan(
      source.indexOf('npx electron-builder "${BUILDER_ARGS[@]}" --win nsis --x64')
    );
  });

  it("reuses the installed Electron dist during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("resolve_electron_dist");
    expect(source).toContain("node_modules/electron/dist/electron.exe");
    expect(source).toContain('to_node_readable_path "$electron_dist"');
    expect(source).toContain('BUILDER_ARGS+=(--config.electronDist="$ELECTRON_DIST")');
  });

  it("retries flaky native prebuild downloads during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("run_with_retries");
    expect(source).toContain("run_with_retries 3 ../.bin/prebuild-install");
    expect(source).toContain("install_better_sqlite3_prebuild_with_download_fallback");
    expect(source).toContain("--verbose 2>&1");
    expect(source).toContain("Invoke-WebRequest");
    expect(source).toContain('prebuild_file="prebuilds/$(basename "$prebuild_url")"');
  });

  it("keeps Windows packaging from mutating memmy-agent dependency locks", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain('npm_with_configured_script_shell ci --prefix "$AGENT_DIR"');
    expect(source).not.toContain('npm install --prefix "$AGENT_DIR"');
    expect(source).not.toContain('if [ ! -d "$AGENT_DIR/node_modules" ]');
  });

  it("writes Windows package edition identity and tagged installer names", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("write_desktop_edition_manifest");
    expect(source).toContain("desktop-edition.json");
    expect(source).toContain('"signing": "$PACKAGE_SIGNING"');
    expect(source).toContain('FINAL_EXE="$DESKTOP_DIR/release/Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.exe"');
    expect(source).toContain('ARTIFACT_NAME="Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.\\${ext}"');
    expect(source).toContain('BUILDER_ARGS+=(--config.extraMetadata.version="$DESKTOP_VERSION")');
    expect(source).toContain('npx electron-builder "${BUILDER_ARGS[@]}" --win nsis --x64 "$@" --config.artifactName="$ARTIFACT_NAME"');
    expect(source).not.toContain("use_final_artifact_name");
    expect(source).not.toContain("mv -f");
  });

  it("bundles the repo-root .env so packaged apps can resolve MEMMY_CLOUD_SERVICE", () => {
    const configs = [
      readFileSync(electronBuilderPath, "utf8"),
      readFileSync(unsignedElectronBuilderPath, "utf8"),
      readFileSync(winElectronBuilderPath, "utf8"),
      readFileSync(winUnsignedBuilderPath, "utf8")
    ];

    for (const config of configs) {
      expect(config).toContain("from: ../../../.env");
      expect(config).toContain("to: .env");
    }
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function extractFunctionSource(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextSection = source.indexOf("\n/**", start + declaration.length);
  expect(nextSection).toBeGreaterThan(start);
  return source.slice(start, nextSection);
}
