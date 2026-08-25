import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  currentInstalledRuntime,
  installMemoryRuntime,
  runtimeTarget
} from "../src/cli/runtime-installer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Memory runtime installer", () => {
  it("maps all supported release targets", () => {
    expect(runtimeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(runtimeTarget("darwin", "x64")).toBe("darwin-x64");
    expect(runtimeTarget("linux", "arm64")).toBe("linux-arm64");
    expect(runtimeTarget("linux", "x64")).toBe("linux-x64");
    expect(runtimeTarget("win32", "arm64")).toBe("windows-arm64");
    expect(runtimeTarget("win32", "x64")).toBe("windows-x64");
    expect(() => runtimeTarget("freebsd", "x64")).toThrow("unsupported platform");
  });

  it("compares stable and prerelease versions", () => {
    expect(compareVersions("2.1.0", "2.0.9")).toBe(1);
    expect(compareVersions("2.1.0", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBe(-1);
  });

  it("plans a service-only install without downloading or mutating disk", async () => {
    const home = tempRoot();
    const result = await installMemoryRuntime({ home, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, home });
    expect(await currentInstalledRuntime(home)).toBeUndefined();
  });

  it("installs and atomically activates a verified local runtime", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const fixture = createRuntimeArchive(root, "2.1.0");
    const result = await installMemoryRuntime({
      home,
      version: "2.1.0",
      runtimeAsset: fixture.archive,
      runtimeSha256: fixture.sha256,
      skipServiceRegistration: true,
      skipHealthCheck: true,
      agents: ["openclaw", "hermes"]
    });
    expect(result).toMatchObject({ ok: true, version: "2.1.0", target: fixture.target });
    const pointer = await currentInstalledRuntime(home);
    expect(pointer?.version).toBe("2.1.0");
    expect(readFileSync(pointer!.entrypoint, "utf8")).toContain("runtime fixture");
    const launcher = readFileSync(join(home, "bin", "memmy-memory-service.cjs"), "utf8");
    expect(launcher).toContain(`MEMMY_HOME: ${JSON.stringify(home)}`);
    expect(launcher).toContain(`MEMMY_CONFIG: ${JSON.stringify(join(home, "config.yaml"))}`);
    expect(launcher).toContain("MEMMY_EMBEDDING_MODEL_ROOT");
    expect(JSON.parse(readFileSync(join(home, "memory-service", "installation.json"), "utf8"))).toMatchObject({
      agents: ["openclaw", "hermes"]
    });
  });

  it("activates the unpacked offline runtime bundled with Desktop", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    const result = await installMemoryRuntime({
      home,
      runtimeDirectory,
      skipServiceRegistration: true,
      skipHealthCheck: true
    });
    expect(result).toMatchObject({ ok: true, version: "2.1.0" });
    const pointer = await currentInstalledRuntime(home);
    expect(pointer?.runtimeDir).not.toBe(runtimeDirectory);
    expect(readFileSync(pointer!.entrypoint, "utf8")).toContain("runtime fixture");
  });

  it("keeps the original runtime executable when another installer reuses the same version", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    await installMemoryRuntime({
      home,
      runtimeDirectory,
      nodeExecutable: "/original/node",
      skipServiceRegistration: true,
      skipHealthCheck: true
    });

    const reused = await installMemoryRuntime({
      home,
      runtimeDirectory,
      nodeExecutable: "/desktop/electron",
      preferInstalledCompatible: true,
      skipServiceRegistration: true,
      skipHealthCheck: true
    });

    expect(reused).toMatchObject({ reused: true, runtimeExecutable: "/original/node" });
    const launcher = readFileSync(join(home, "bin", process.platform === "win32" ? "memmy-memory-service.cmd" : "memmy-memory-service"), "utf8");
    expect(launcher).toContain("/original/node");
    expect(launcher).not.toContain("/desktop/electron");
  });

  it("rejects checksum failures without activating the staged runtime", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const fixture = createRuntimeArchive(root, "2.1.0");
    await expect(installMemoryRuntime({
      home,
      runtimeAsset: fixture.archive,
      runtimeSha256: "f".repeat(64),
      skipServiceRegistration: true,
      skipHealthCheck: true
    })).rejects.toThrow("checksum mismatch");
    expect(await currentInstalledRuntime(home)).toBeUndefined();
  });

  it("never replaces a newer installed version with an older one", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "memory-service"), { recursive: true });
    writeFileSync(join(home, "memory-service", "current.json"), JSON.stringify({
      version: "3.0.0",
      protocolVersion: 1,
      target: runtimeTarget(process.platform, process.arch),
      runtimeDir: join(home, "runtime-3"),
      entrypoint: join(home, "runtime-3", "index.js"),
      activatedAt: new Date().toISOString()
    }));
    await expect(installMemoryRuntime({ home, version: "2.1.0", dryRun: true }))
      .rejects.toThrow("refusing to downgrade");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-runtime-installer-"));
  roots.push(root);
  return root;
}

function createRuntimeArchive(root: string, version: string): { archive: string; sha256: string; target: string } {
  const target = runtimeTarget(process.platform, process.arch);
  const stage = createRuntimeDirectory(root, version);
  const archive = join(root, `memmy-memory-runtime-${version}-${target}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "failed to create runtime fixture");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, sha256, target };
}

function createRuntimeDirectory(root: string, version: string): string {
  const target = runtimeTarget(process.platform, process.arch);
  const stage = join(root, `runtime-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(stage, "dist", "src", "server"), { recursive: true });
  writeFileSync(join(stage, "dist", "src", "server", "index.js"), "// runtime fixture\n");
  writeFileSync(join(stage, "memory-runtime.json"), `${JSON.stringify({ version, protocolVersion: 1, target })}\n`);
  return stage;
}
