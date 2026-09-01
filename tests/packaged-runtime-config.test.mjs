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
      environment: {},
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
  });

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

    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, ".env"), "TOKEN=decoy\n");
    const pruner = join(dirname(writer), "prune-runtime-env-files.mjs");
    const pruneResult = spawnSync(process.execPath, [pruner, runtime], { encoding: "utf8" });
    expect(pruneResult.status, pruneResult.stderr).toBe(0);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
  });

  it("fails closed on ASAR env files and stale embedded versions", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const goodAsar = await createAsarFixture(root, "good", "1.0.8");
    const good = spawnSync(process.execPath, [verifier, ...verifierArgs(goodAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(good.status, good.stderr).toBe(0);

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

    const envAsar = await createAsarFixture(root, "with-env", "1.0.8", true);
    const withEnv = spawnSync(process.execPath, [verifier, ...verifierArgs(envAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(withEnv.status).not.toBe(0);
    expect(withEnv.stderr).toContain("forbidden environment file");

    const foreignNativeAsar = await createAsarFixture(root, "foreign-native", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so", "foreign"],
    ]);
    const foreignNative = spawnSync(process.execPath, [verifier, ...verifierArgs(foreignNativeAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(foreignNative.status).not.toBe(0);
    expect(foreignNative.stderr).toContain("incompatible onnxruntime-node platform");

    const toolchainAsar = await createAsarFixture(root, "toolchain", "1.0.8", false, true, [
      ["dist/runtime/memmy-agent/node_modules/vitest/index.js", "test-only"],
    ]);
    const toolchain = spawnSync(process.execPath, [verifier, ...verifierArgs(toolchainAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(toolchain.status).not.toBe(0);
    expect(toolchain.stderr).toContain("optional-peer test toolchain");

    const thirdPartyMapAsar = await createAsarFixture(root, "third-party-map", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/dependency/dist/index.js.map", "third-party-map"],
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
    expect(verifierCall).not.toContain("TARGET_ARCH");
  });
});

async function createAsarFixture(root, name, version, includeEnv = false, includeLocks = true, extraFiles = [], platform = "win32") {
  const source = join(root, `${name}-source`);
  const asar = join(root, `${name}.asar`);
  const manifest = { version };
  const lock = { version, packages: { "": { version } } };
  writeFixtureJson(join(source, "package.json"), manifest);
  writeFixtureJson(join(source, "dist/main/desktop-edition.json"), {
    cloudService: "https://manifest.example.test",
  });
  for (const component of ["memory", "memmy-agent"]) {
    writeFixtureJson(join(source, `dist/runtime/${component}/package.json`), manifest);
    if (includeLocks) writeFixtureJson(join(source, `dist/runtime/${component}/package-lock.json`), lock);
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
  const targetArch = platform === "darwin" ? "arm64" : "x64";
  const onnxRuntimeRoot = join(source, `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${targetArch}`);
  mkdirSync(onnxRuntimeRoot, { recursive: true });
  writeFileSync(join(onnxRuntimeRoot, "onnxruntime_binding.node"), `${platform}-${targetArch}-node`);
  if (platform === "win32") writeFileSync(join(onnxRuntimeRoot, "onnxruntime.dll"), "win-x64-dll");
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

function verifierArgs(asar, expected, platform = "win32", arch = "x64") {
  return ["--asar", asar, "--expected", expected, "--platform", platform, "--arch", arch];
}

function writeFixtureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "memmy-packaged-runtime-"));
  roots.push(root);
  return root;
}
