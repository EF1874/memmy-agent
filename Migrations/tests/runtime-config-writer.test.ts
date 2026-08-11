import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  mutateRuntimeConfigSync,
} from "../src/runtime-config-writer.js";
import { withRuntimeConfigWriteLock } from "../src/runtime-config-lock.js";

const roots: string[] = [];

async function configFixture(config: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-runtime-config-writer-"));
  roots.push(root);
  const configPath = path.join(root, "config.yaml");
  await fs.writeFile(configPath, YAML.stringify(config), { mode: 0o644 });
  return configPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime config writer", () => {
  it("serializes concurrent patches against the latest raw YAML without losing unknown fields", async () => {
    const configPath = await configFixture({
      futureSection: { keepMe: true },
      providers: { openai: { futureProvider: true } },
    });
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = mutateRuntimeConfig(configPath, async (config) => {
      await firstMayFinish;
      config.backend = { port: 18990 };
      return "backend";
    });
    const second = mutateRuntimeConfig(configPath, (config) => {
      config.memory = { endpoint: "http://127.0.0.1:18888" };
      return "memory";
    });
    releaseFirst();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.value)).toEqual(["backend", "memory"]);
    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config).toMatchObject({
      futureSection: { keepMe: true },
      providers: { openai: { futureProvider: true } },
      backend: { port: 18990 },
      memory: { endpoint: "http://127.0.0.1:18888" },
    });
    expect((await fs.readdir(path.dirname(configPath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("supports synchronous mutation and preserves a definitely-present return value", async () => {
    const configPath = await configFixture({ unknownRoot: { keep: true } });
    const result = mutateRuntimeConfigSync(configPath, (config) => {
      config.syncWriter = true;
      return 42;
    });
    expect(result).toEqual({ changed: true, value: 42, sourceExists: true });
    expect(YAML.parse(fsSync.readFileSync(configPath, "utf8"))).toMatchObject({
      unknownRoot: { keep: true },
      syncWriter: true,
    });
  });

  it("uses the lock-held variant and rejects accidental re-entry", async () => {
    const configPath = await configFixture({});
    await withRuntimeConfigWriteLock(configPath, async (lock) => {
      await expect(mutateRuntimeConfigLockHeld(lock, (config) => {
        config.held = true;
      })).resolves.toMatchObject({ changed: true, sourceExists: true });
      await expect(mutateRuntimeConfig(configPath, () => undefined)).rejects.toMatchObject({
        code: "migration_lock_reentrant",
      });
    });
  });

  it("detects an out-of-band source change before rename", async () => {
    const configPath = await configFixture({ before: true });
    await expect(mutateRuntimeConfig(configPath, (config) => {
      config.after = true;
    }, {
      beforeCommit: async () => fs.writeFile(configPath, "replacement: true\n", "utf8"),
    })).rejects.toMatchObject({ code: "migration_source_changed" });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe("replacement: true\n");
  });

  it("enforces POSIX 0600 or a protected Windows current-user and SYSTEM DACL", async () => {
    const configPath = await configFixture({});
    await mutateRuntimeConfig(configPath, (config) => { config.secure = true; });
    if (process.platform !== "win32") {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      return;
    }
    const acl = execFileSync("icacls", [configPath], { encoding: "utf8", windowsHide: true });
    expect(acl).not.toContain("(I)");
    expect(acl.match(/\(F\)/g)).toHaveLength(2);
  });
});
