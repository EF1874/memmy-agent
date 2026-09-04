import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizePublicCloudService,
  writeDesktopEditionManifest,
} from "../scripts/internal/shared/write-desktop-edition-manifest-lib.mjs";
import { pruneRuntimeEnvFiles } from "../scripts/internal/shared/prune-runtime-env-files-lib.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("packaged desktop runtime configuration", () => {
  it("writes exactly the public allowlist and never serializes env decoys", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "dist", "main", "desktop-edition.json");
    writeFileSync(envFile, [
      "MEMMY_CLOUD_SERVICE=https://manifest.example.test/",
      "MEMMY_PRIVATE_TOKEN=must-not-be-packaged",
      "MEMMY_LEGAL_CN_BASE_URL=https://legal.example.test",
    ].join("\n"));

    await writeDesktopEditionManifest({
      output,
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      environment: {
        MEMMY_WINDOWS_STORE_MIGRATION_ENABLED: "true",
        MEMMY_WINDOWS_STORE_ACQUISITION_URI_CN:
          "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6",
        MEMMY_STORE_LOCAL_PFX_PASSWORD: "store-secret-must-not-be-packaged",
      },
      envFile,
    });

    const manifestText = readFileSync(output, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toEqual({
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      cloudService: "https://manifest.example.test",
    });
    expect(manifestText).not.toContain("MEMMY_PRIVATE_TOKEN");
    expect(manifestText).not.toContain("must-not-be-packaged");
    expect(manifestText).not.toContain("MEMMY_LEGAL_CN_BASE_URL");
    expect(manifestText).not.toContain("windowsStoreMigration");
    expect(manifestText).not.toContain("store-secret-must-not-be-packaged");
  });

  it.each([
    {
      edition: "cn",
      accountChannel: "phone",
      storeId: "9MZGLKWMZZV6",
      packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
      aumid: "Memtensor.Memmy_eyack96k521x2!Memmy",
      acquisitionVariable: "MEMMY_WINDOWS_STORE_ACQUISITION_URI_CN",
      acquisitionUri: "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6",
    },
    {
      edition: "intl",
      accountChannel: "email",
      storeId: "9NFVJC9K7ZK9",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
      aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
      acquisitionVariable: "MEMMY_WINDOWS_STORE_ACQUISITION_URI_INTL",
      acquisitionUri: "https://apps.microsoft.com/detail/9NFVJC9K7ZK9",
    },
  ])(
    "writes the exact public $edition Store destination from the company profile",
    async ({
      edition,
      accountChannel,
      storeId,
      packageFamilyName,
      aumid,
      acquisitionVariable,
      acquisitionUri,
    }) => {
      const root = fixtureRoot();
      const output = join(root, "desktop-edition.json");
      const publishingConfig = writeStorePublishingProfiles(root);
      const environment = {
        MEMMY_CLOUD_SERVICE: "https://manifest.example.test",
        MEMMY_WINDOWS_STORE_MIGRATION_ENABLED: "true",
        MEMMY_WINDOWS_STORE_ACQUISITION_URI_CN:
          "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6",
        MEMMY_WINDOWS_STORE_ACQUISITION_URI_INTL:
          "https://apps.microsoft.com/detail/9NFVJC9K7ZK9",
        MEMMY_STORE_LOCAL_PFX_PASSWORD: "pfx-secret-decoy",
        WIN_CSC_KEY_PASSWORD: "codesign-secret-decoy",
      };
      environment[acquisitionVariable] = acquisitionUri;

      const manifest = await writeDesktopEditionManifest({
        output,
        edition,
        accountChannel,
        signing: "signed",
        environment,
        windowsStorePublishingConfig: publishingConfig,
      });

      expect(manifest).toEqual({
        edition,
        accountChannel,
        signing: "signed",
        cloudService: "https://manifest.example.test",
        windowsStoreMigration: {
          internalEnabled: true,
          storeDestination: {
            edition,
            storeId,
            packageFamilyName,
            aumid,
            acquisitionUri,
          },
        },
      });
      const manifestText = readFileSync(output, "utf8");
      expect(manifestText).not.toContain("pfx-secret-decoy");
      expect(manifestText).not.toContain("codesign-secret-decoy");
      expect(manifestText).not.toContain("publisherDisplayName");
      expect(manifestText).not.toContain("storeListingDisplayName");
      expect(manifestText).not.toContain("legacyNsisAumid");
      expect(manifestText).not.toContain("cn.memtensor.memmy");
    },
  );

  it.each(["", " cn.memtensor.memmy"])(
    "rejects an empty or padded legacy NSIS AUMID: %j",
    async (legacyNsisAumid) => {
      const root = fixtureRoot();
      const publishingConfig = writeStorePublishingProfiles(root);
      const config = JSON.parse(readFileSync(publishingConfig, "utf8"));
      config.legacyNsisAumid = legacyNsisAumid;
      writeFixtureJson(publishingConfig, config);

      await expect(writeDesktopEditionManifest({
        output: join(root, "desktop-edition.json"),
        edition: "cn",
        accountChannel: "phone",
        signing: "signed",
        environment: { MEMMY_CLOUD_SERVICE: "https://manifest.example.test" },
        windowsStorePublishingConfig: publishingConfig,
      })).rejects.toThrow(
        "Windows Store publishing config legacyNsisAumid must be a non-empty string without surrounding whitespace",
      );
    },
  );

  it("rejects a legacy NSIS AUMID that is not the canonical company value", async () => {
    const root = fixtureRoot();
    const publishingConfig = writeStorePublishingProfiles(root);
    const config = JSON.parse(readFileSync(publishingConfig, "utf8"));
    config.legacyNsisAumid = "Memtensor.Memmy_eyack96k521x2!Memmy";
    writeFixtureJson(publishingConfig, config);

    await expect(writeDesktopEditionManifest({
      output: join(root, "desktop-edition.json"),
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      environment: { MEMMY_CLOUD_SERVICE: "https://manifest.example.test" },
      windowsStorePublishingConfig: publishingConfig,
    })).rejects.toThrow(
      "Windows Store publishing config legacyNsisAumid must exactly match cn.memtensor.memmy",
    );
  });

  it("accepts the production Store publishing config without exposing the legacy NSIS AUMID", async () => {
    const root = fixtureRoot();
    const publishingConfig = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "App",
      "shell",
      "desktop",
      "build",
      "store-publishing-profiles.json",
    );
    const productionConfig = JSON.parse(readFileSync(publishingConfig, "utf8"));
    expect(productionConfig.legacyNsisAumid).toBe("cn.memtensor.memmy");

    const output = join(root, "desktop-edition.json");
    const manifest = await writeDesktopEditionManifest({
      output,
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      environment: { MEMMY_CLOUD_SERVICE: "https://manifest.example.test" },
      windowsStorePublishingConfig: publishingConfig,
    });

    expect(manifest.windowsStoreMigration.storeDestination).not.toHaveProperty("legacyNsisAumid");
    expect(readFileSync(output, "utf8")).not.toContain("cn.memtensor.memmy");
  });

  it("defaults Store migration metadata to enabled and omits only a missing acquisition URI", async () => {
    const root = fixtureRoot();
    const output = join(root, "desktop-edition.json");

    const manifest = await writeDesktopEditionManifest({
      output,
      edition: "cn",
      accountChannel: "phone",
      signing: "unsigned",
      environment: { MEMMY_CLOUD_SERVICE: "https://manifest.example.test" },
      windowsStorePublishingConfig: writeStorePublishingProfiles(root),
    });

    expect(manifest.windowsStoreMigration).toEqual({
      internalEnabled: true,
      storeDestination: {
        edition: "cn",
        storeId: "9MZGLKWMZZV6",
        packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
        aumid: "Memtensor.Memmy_eyack96k521x2!Memmy",
      },
    });
    expect(manifest.windowsStoreMigration.storeDestination).not.toHaveProperty("acquisitionUri");
  });

  it("writes Store migration metadata disabled when the internal build switch is false", async () => {
    const root = fixtureRoot();
    const output = join(root, "desktop-edition.json");

    const manifest = await writeDesktopEditionManifest({
      output,
      edition: "intl",
      accountChannel: "email",
      signing: "signed",
      environment: {
        MEMMY_CLOUD_SERVICE: "https://manifest.example.test",
        MEMMY_WINDOWS_STORE_MIGRATION_ENABLED: "false",
        MEMMY_WINDOWS_STORE_ACQUISITION_URI_INTL:
          "ms-windows-store://pdp/?ProductId=9NFVJC9K7ZK9",
      },
      windowsStorePublishingConfig: writeStorePublishingProfiles(root),
    });

    expect(manifest).toEqual({
      edition: "intl",
      accountChannel: "email",
      signing: "signed",
      cloudService: "https://manifest.example.test",
      windowsStoreMigration: {
        internalEnabled: false,
        storeDestination: {
          edition: "intl",
          storeId: "9NFVJC9K7ZK9",
          packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
          aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
          acquisitionUri: "ms-windows-store://pdp/?ProductId=9NFVJC9K7ZK9",
        },
      },
    });
  });

  it.each(["", "TRUE", "False", "1", " true"])(
    "rejects an invalid Store migration build switch: %j",
    async (value) => {
      const root = fixtureRoot();
      await expect(writeDesktopEditionManifest({
        output: join(root, "desktop-edition.json"),
        edition: "cn",
        accountChannel: "phone",
        signing: "signed",
        environment: {
          MEMMY_CLOUD_SERVICE: "https://manifest.example.test",
          MEMMY_WINDOWS_STORE_MIGRATION_ENABLED: value,
        },
        windowsStorePublishingConfig: writeStorePublishingProfiles(root),
      })).rejects.toThrow("MEMMY_WINDOWS_STORE_MIGRATION_ENABLED must be true or false");
    },
  );

  it("uses an explicit environment origin before the root env file", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "desktop-edition.json");
    writeFileSync(envFile, "MEMMY_CLOUD_SERVICE=https://file.example.test\n");

    await writeDesktopEditionManifest({
      output,
      edition: "intl",
      accountChannel: "email",
      signing: "unsigned",
      environment: { MEMMY_CLOUD_SERVICE: "https://external.example.test" },
      envFile,
    });

    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe(
      "https://external.example.test",
    );
  });

  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?token=value",
    "https://api.example.test/#fragment",
  ])("rejects a non-public cloud-service value: %s", (value) => {
    expect(() => normalizePublicCloudService(value)).toThrow(/MEMMY_CLOUD_SERVICE/);
  });

  it("removes runtime env files and symlinks without touching normal files", async () => {
    const root = fixtureRoot();
    const dependency = join(root, "node_modules", "dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, ".env"), "REDIS_HOST=127.0.0.1\n");
    writeFileSync(join(dependency, ".env.local"), "TOKEN=decoy\n");
    writeFileSync(join(dependency, "runtime.js"), "export {};\n");
    try {
      symlinkSync(join(dependency, "runtime.js"), join(dependency, ".env.production"));
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      writeFileSync(join(dependency, ".env.production"), "TOKEN=platform-fallback\n");
    }

    expect(await pruneRuntimeEnvFiles(root)).toBe(3);
    expect(existsSync(join(dependency, ".env"))).toBe(false);
    expect(existsSync(join(dependency, ".env.local"))).toBe(false);
    expect(existsSync(join(dependency, ".env.production"))).toBe(false);
    expect(existsSync(join(dependency, "runtime.js"))).toBe(true);
    expect(await pruneRuntimeEnvFiles(root)).toBe(0);
  });

  it("executes the writer and pruner CLI entrypoints", () => {
    const root = fixtureRoot();
    const output = join(root, "desktop-edition.json");
    const writer = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "write-desktop-edition-manifest.mjs",
    );
    const writerResult = spawnSync(process.execPath, [
      writer,
      "--output", output,
      "--edition", "cn",
      "--account-channel", "phone",
      "--signing", "unsigned",
    ], {
      encoding: "utf8",
      env: { ...process.env, MEMMY_CLOUD_SERVICE: "https://cli.example.test" },
    });
    expect(writerResult.status, writerResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe("https://cli.example.test");

    const storeOutput = join(root, "desktop-edition-store.json");
    const storeWriterResult = spawnSync(process.execPath, [
      writer,
      "--output", storeOutput,
      "--edition", "intl",
      "--account-channel", "email",
      "--signing", "unsigned",
      "--windows-store-publishing-config", writeStorePublishingProfiles(root),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMMY_CLOUD_SERVICE: "https://cli.example.test",
        MEMMY_WINDOWS_STORE_MIGRATION_ENABLED: "true",
        MEMMY_WINDOWS_STORE_ACQUISITION_URI_INTL:
          "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9",
      },
    });
    expect(storeWriterResult.status, storeWriterResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(storeOutput, "utf8")).windowsStoreMigration).toEqual({
      internalEnabled: true,
      storeDestination: {
        edition: "intl",
        storeId: "9NFVJC9K7ZK9",
        packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
        aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
        acquisitionUri: "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9",
      },
    });

    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, ".env"), "TOKEN=decoy\n");
    const pruner = join(dirname(writer), "prune-runtime-env-files.mjs");
    const pruneResult = spawnSync(process.execPath, [pruner, runtime], { encoding: "utf8" });
    expect(pruneResult.status, pruneResult.stderr).toBe(0);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
  });

  it("creates a standalone Windows Memory manifest with its local private workspace dependency", () => {
    const root = fixtureRoot();
    const sourcePackage = join(root, "Memory", "package.json");
    const agentSourceCorePackage = join(root, "AgentSourceCore", "package.json");
    const runtimePackage = join(root, "runtime", "package.json");
    const runtimeMetadata = join(root, "runtime", "memory-runtime.json");
    writeFixtureJson(sourcePackage, {
      name: "@memmy/memory",
      version: "2.1.0",
      dependencies: {
        "@memmy/agent-source-core": "0.0.0",
        zod: "^4.4.3",
      },
    });
    writeFixtureJson(agentSourceCorePackage, {
      name: "@memmy/agent-source-core",
      version: "0.0.0",
    });
    const generator = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "create-memory-runtime-manifest.mjs",
    );

    const args = [
      generator,
      sourcePackage,
      agentSourceCorePackage,
      runtimePackage,
      runtimeMetadata,
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(runtimePackage, "utf8"))).toEqual({
      name: "@memmy/packaged-memory-runtime",
      version: "2.1.0",
      private: true,
      type: "module",
      dependencies: {
        "@memmy/agent-source-core": "file:./workspace-packages/agent-source-core",
        zod: "^4.4.3",
      },
    });
    expect(JSON.parse(readFileSync(runtimeMetadata, "utf8"))).toEqual({
      version: "2.1.0",
      protocolVersion: 1,
      target: "windows-x64",
      entrypoint: "dist/src/server/index.js",
      viewer: "dist/viewer/index.html",
    });

    writeFixtureJson(agentSourceCorePackage, {
      name: "@memmy/agent-source-core",
      version: "0.0.1",
    });
    const mismatch = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("workspace versions do not match");
  });

  it("fails closed on ASAR env files, Windows runtime duplication, and stale embedded versions", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const goodAsar = await createAsarFixture(root, "good", "1.1.1");
    const good = spawnSync(process.execPath, [verifier, ...verifierArgs(goodAsar, "1.1.1")], {
      encoding: "utf8",
    });
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("desktop version 1.1.1; Memory is external");

    const staleMemoryAsar = await createAsarFixture(
      root,
      "stale-memory",
      "1.1.1",
      false,
      true,
      [],
      "darwin",
      "2.0.9",
    );
    const staleMemory = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(staleMemoryAsar, "1.1.1", "darwin", "arm64")],
      { encoding: "utf8" },
    );
    expect(staleMemory.status).not.toBe(0);
    expect(staleMemory.stderr).toContain(
      "does not match the requested version: dist/runtime/memory/package.json",
    );

    const missingExpectedMemory = spawnSync(process.execPath, [
      verifier,
      "--asar", goodAsar,
      "--expected", "1.1.1",
      "--platform", "win32",
      "--arch", "x64",
    ], { encoding: "utf8" });
    expect(missingExpectedMemory.status).not.toBe(0);
    expect(missingExpectedMemory.stderr).toContain("--expected-memory");

    const invalidExpectedMemory = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(goodAsar, "1.1.1", "win32", "x64", "2.1")],
      { encoding: "utf8" },
    );
    expect(invalidExpectedMemory.status).not.toBe(0);
    expect(invalidExpectedMemory.stderr).toContain(
      "Expected packaged Memory version must use semantic version syntax",
    );

    const darwinAsar = await createAsarFixture(root, "darwin", "1.0.8", false, true, [], "darwin");
    const darwin = spawnSync(process.execPath, [verifier, ...verifierArgs(darwinAsar, "1.0.8", "darwin", "arm64")], {
      encoding: "utf8",
    });
    expect(darwin.status, darwin.stderr).toBe(0);

    const noLocksAsar = await createAsarFixture(root, "without-locks", "1.0.8", false, false);
    const withoutLocks = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(noLocksAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(withoutLocks.status, withoutLocks.stderr).toBe(0);

    const staleAsar = await createAsarFixture(root, "stale", "1.0.7");
    const stale = spawnSync(process.execPath, [verifier, ...verifierArgs(staleAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("does not match the requested version");

    const staleAgentAsar = await createAsarFixture(
      root,
      "stale-agent",
      "1.0.8",
      false,
      true,
      [],
      "win32",
      "2.1.0",
      "1.0.7",
    );
    const staleAgent = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(staleAgentAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(staleAgent.status).not.toBe(0);
    expect(staleAgent.stderr).toContain(
      "does not match the requested version: dist/runtime/memmy-agent/package.json",
    );

    const envAsar = await createAsarFixture(root, "with-env", "1.0.8", true);
    const withEnv = spawnSync(process.execPath, [verifier, ...verifierArgs(envAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(withEnv.status).not.toBe(0);
    expect(withEnv.stderr).toContain("forbidden environment file");

    const forbiddenMemoryAsar = await createAsarFixture(root, "forbidden-memory", "1.0.8", false, true, [
      ["dist/runtime/memory/package.json", "{}\n"],
    ]);
    const forbiddenMemory = spawnSync(process.execPath, [verifier, ...verifierArgs(forbiddenMemoryAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(forbiddenMemory.status).not.toBe(0);
    expect(forbiddenMemory.stderr).toContain("forbidden Memory runtime");

    const forbiddenEmbeddingAsar = await createAsarFixture(root, "forbidden-embedding", "1.0.8", false, true, [
      ["dist/embedding-models/model.onnx", "duplicate-model"],
    ]);
    const forbiddenEmbedding = spawnSync(process.execPath, [verifier, ...verifierArgs(forbiddenEmbeddingAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(forbiddenEmbedding.status).not.toBe(0);
    expect(forbiddenEmbedding.stderr).toContain("forbidden embedding models");

    const toolchainAsar = await createAsarFixture(root, "toolchain", "1.0.8", false, true, [
      ["dist/runtime/memmy-agent/node_modules/vitest/index.js", "test-only"],
    ]);
    const toolchain = spawnSync(process.execPath, [verifier, ...verifierArgs(toolchainAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(toolchain.status).not.toBe(0);
    expect(toolchain.stderr).toContain("optional-peer test toolchain");

    const thirdPartyMapAsar = await createAsarFixture(root, "third-party-map", "1.0.8", false, true, [
      ["dist/runtime/memmy-agent/node_modules/dependency/dist/index.js.map", "third-party-map"],
    ]);
    const thirdPartyMap = spawnSync(process.execPath, [verifier, ...verifierArgs(thirdPartyMapAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(thirdPartyMap.status).not.toBe(0);
    expect(thirdPartyMap.stderr).toContain("third-party production source map");
  });

  it("passes the defined Windows package architecture to the shared ASAR verifier", () => {
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "build-nsis.sh",
    ), "utf8");
    const verifierCall = buildScript.slice(
      buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"'),
      buildScript.indexOf("\n}", buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"')),
    );

    expect(verifierCall).toContain('--arch "$PACKAGE_ARCH"');
    expect(verifierCall).toContain('--expected-memory "$expected_memory_version"');
    expect(verifierCall).not.toContain("TARGET_ARCH");
  });

  it("passes the staged Memory version to both packaged ASAR verifiers", () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const windowsBuild = readFileSync(
      join(repositoryRoot, "scripts", "internal", "win", "build-nsis.sh"),
      "utf8",
    );
    const macBuild = readFileSync(
      join(repositoryRoot, "scripts", "internal", "mac", "build-dmg.sh"),
      "utf8",
    );

    expect(windowsBuild).toContain(
      'expected_memory_version="$(read_package_version "$RUNTIME_DIR/memory/package.json")"',
    );
    expect(macBuild).toContain(
      'expected_memory_version="$(node -p "require(\'$RUNTIME_DIR/memory/package.json\').version")"',
    );
    for (const source of [windowsBuild, macBuild]) {
      expect(source).toContain('--expected-memory "$expected_memory_version"');
    }
  });

  it("passes the company publishing config only from the Windows build", () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const windowsBuild = readFileSync(
      join(repositoryRoot, "scripts", "internal", "win", "build-nsis.sh"),
      "utf8",
    );
    const macBuild = readFileSync(
      join(repositoryRoot, "scripts", "internal", "mac", "build-dmg.sh"),
      "utf8",
    );

    expect(windowsBuild).toContain(
      '--windows-store-publishing-config "$DESKTOP_DIR/build/store-publishing-profiles.json"',
    );
    expect(macBuild).not.toContain("--windows-store-publishing-config");
  });

  it("stages the private AgentSourceCore package without resolving it from npm", () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const buildScript = readFileSync(
      join(repositoryRoot, "scripts", "internal", "win", "build-nsis.sh"),
      "utf8",
    );
    const generatorSource = readFileSync(
      join(
        repositoryRoot,
        "scripts",
        "internal",
        "win",
        "create-memory-runtime-manifest.mjs",
      ),
      "utf8",
    );

    expect(buildScript).toContain('AGENT_SOURCE_CORE_DIR="$ROOT_DIR/AgentSourceCore"');
    expect(buildScript).toContain(
      'node "$ROOT_DIR/scripts/internal/win/create-memory-runtime-manifest.mjs"',
    );
    expect(buildScript).toContain('"$AGENT_SOURCE_CORE_DIR/package.json"');
    expect(generatorSource).toContain(
      'dependencies[agentSourceCorePackage.name] = "file:./workspace-packages/agent-source-core"',
    );
    expect(buildScript).toContain(
      'cp "$AGENT_SOURCE_CORE_DIR/dist/src/index.js" "$RUNTIME_DIR/memory/workspace-packages/agent-source-core/dist/src/index.js"',
    );
    expect(buildScript).toContain(
      'RUNTIME_MEMORY_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"',
    );
    expect(buildScript).toContain(
      'cp "$AGENT_SOURCE_CORE_DIR/dist/src/index.js" "$RUNTIME_MEMORY_AGENT_SOURCE_CORE_DIR/dist/src/index.js"',
    );
    expect(buildScript.indexOf('npm_ci_win_x64 "$RUNTIME_DIR/memory"')).toBeLessThan(
      buildScript.indexOf('RUNTIME_MEMORY_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"'),
    );
    expect(buildScript).toContain(
      'local packaged_agent_source_core="$packaged_memory_runtime/node_modules/@memmy/agent-source-core"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/package.json"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/dist/src/index.js"',
    );
  });
});

async function createAsarFixture(
  root,
  name,
  version,
  includeEnv = false,
  includeLocks = true,
  extraFiles = [],
  platform = "win32",
  memoryVersion = "2.1.0",
  agentVersion = version,
) {
  const source = join(root, `${name}-source`);
  const asar = join(root, `${name}.asar`);
  const manifest = { version };
  writeFixtureJson(join(source, "package.json"), manifest);
  writeFixtureJson(join(source, "dist/main/desktop-edition.json"), {
    cloudService: "https://manifest.example.test",
  });
  const agentManifest = { version: agentVersion };
  const agentLock = { version: agentVersion, packages: { "": { version: agentVersion } } };
  writeFixtureJson(join(source, "dist/runtime/memmy-agent/package.json"), agentManifest);
  if (includeLocks) {
    writeFixtureJson(join(source, "dist/runtime/memmy-agent/package-lock.json"), agentLock);
  }
  const contracts = join(
    source,
    "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  );
  mkdirSync(dirname(contracts), { recursive: true });
  writeFileSync(contracts, "export {};\n");
  if (platform === "win32") {
    const ownSourceMap = join(source, "dist/runtime/memmy-agent/dist/main.js.map");
    mkdirSync(dirname(ownSourceMap), { recursive: true });
    writeFileSync(ownSourceMap, "own-production-map\n");
  }
  if (platform !== "win32") {
    const memoryManifest = { version: memoryVersion };
    const memoryLock = { version: memoryVersion, packages: { "": { version: memoryVersion } } };
    writeFixtureJson(join(source, "dist/runtime/memory/package.json"), memoryManifest);
    if (includeLocks) {
      writeFixtureJson(join(source, "dist/runtime/memory/package-lock.json"), memoryLock);
    }
    const targetArch = platform === "darwin" ? "arm64" : "x64";
    const onnxRuntimeRoot = join(source, `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${targetArch}`);
    mkdirSync(onnxRuntimeRoot, { recursive: true });
    writeFileSync(join(onnxRuntimeRoot, "onnxruntime_binding.node"), `${platform}-${targetArch}-node`);
  }
  const lifecycleSidecar = join(
    source,
    "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
  );
  mkdirSync(dirname(lifecycleSidecar), { recursive: true });
  writeFileSync(lifecycleSidecar, "export {};\n");
  for (const [relativePath, contents] of extraFiles) {
    const targetPath = join(source, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
  if (includeEnv) writeFileSync(join(source, ".env.production"), "TOKEN=decoy\n");
  await createPackage(source, asar);
  return asar;
}

function verifierArgs(
  asar,
  expected,
  platform = "win32",
  arch = "x64",
  expectedMemory = "2.1.0",
) {
  return [
    "--asar", asar,
    "--expected", expected,
    "--expected-memory", expectedMemory,
    "--platform", platform,
    "--arch", arch,
  ];
}

function writeFixtureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeStorePublishingProfiles(root) {
  const path = join(root, "store-publishing-profiles.json");
  writeFixtureJson(path, {
    schemaVersion: 2,
    publisher: "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0",
    publisherDisplayName: "Memtensor",
    windowsDisplayName: "Memmy",
    legacyNsisAumid: "cn.memtensor.memmy",
    applications: {
      cn: {
        storeListingDisplayName: "Memmy",
        storeProductId: "9MZGLKWMZZV6",
        identityName: "Memtensor.Memmy",
        manifestApplicationId: "Memmy",
        packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
      },
      intl: {
        storeListingDisplayName: "Memmy Agent",
        storeProductId: "9NFVJC9K7ZK9",
        identityName: "Memtensor.MemmyAgent",
        manifestApplicationId: "Memmy",
        packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
      },
    },
  });
  return path;
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "memmy-packaged-runtime-"));
  roots.push(root);
  return root;
}
