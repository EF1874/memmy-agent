import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runMigrations } = vi.hoisted(() => ({
  runMigrations: vi.fn(async () => []),
}));

vi.mock("@memmy/migrations", () => ({ runMigrations }));

import {
  MIGRATIONS_READY_CONFIG_ENV,
  MIGRATIONS_READY_WORKSPACE_ENV,
  prepareStartupMigrations,
  resolveStartupMigrationTarget,
} from "../../../src/entrypoints/cli/startup-migrations.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-startup-migrations-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  runMigrations.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("startup migrations", () => {
  it("resolves explicit targets to stable absolute and canonical paths", () => {
    const root = tempRoot();
    const configInput = path.join(root, "nested", "..", "config.yaml");
    const workspaceInput = path.join(root, "nested", "..", "workspace");
    const target = resolveStartupMigrationTarget(
      { config: configInput, workspace: workspaceInput },
      { HOME: root },
    );

    expect(target).toEqual({
      runtimeConfigFile: path.join(root, "config.yaml"),
      agentWorkspace: fs.realpathSync(path.join(root, "workspace")),
    });
  });

  it("uses the workspace configured in the target config", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "configured-workspace");
    fs.writeFileSync(
      configPath,
      `agents:\n  defaults:\n    workspace: ${JSON.stringify(workspace)}\n`,
      "utf8",
    );

    expect(resolveStartupMigrationTarget({ config: configPath }, { HOME: root })).toEqual({
      runtimeConfigFile: configPath,
      agentWorkspace: fs.realpathSync(workspace),
    });
  });

  it("executes once when no matching parent marker exists", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");

    const result = await prepareStartupMigrations(
      { config: configPath, workspace },
      { HOME: root },
    );

    expect(result.source).toBe("executed");
    expect(runMigrations).toHaveBeenCalledOnce();
    expect(runMigrations).toHaveBeenCalledWith(expect.objectContaining({
      targets: result.target,
    }));
  });

  it("skips only when both prepared target markers match", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const env = {
      HOME: root,
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
    };

    const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

    expect(result.source).toBe("prepared-parent");
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it.each(["config", "workspace"] as const)(
    "executes when the prepared %s target differs",
    async (differentTarget) => {
      const root = tempRoot();
      const configPath = path.join(root, "config.yaml");
      const workspace = path.join(root, "workspace");
      const env = {
        HOME: root,
        [MIGRATIONS_READY_CONFIG_ENV]: differentTarget === "config"
          ? path.join(root, "other.yaml")
          : configPath,
        [MIGRATIONS_READY_WORKSPACE_ENV]: differentTarget === "workspace"
          ? path.join(root, "other-workspace")
          : workspace,
      };

      const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

      expect(result.source).toBe("executed");
      expect(runMigrations).toHaveBeenCalledOnce();
    },
  );

  it("force ignores matching parent markers", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const env = {
      HOME: root,
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
    };

    await prepareStartupMigrations(
      { config: configPath, workspace },
      env,
      { force: true },
    );

    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it("propagates migration failures", async () => {
    const failure = Object.assign(new Error("migration failed"), {
      code: "migration_failed",
    });
    runMigrations.mockRejectedValueOnce(failure);
    const root = tempRoot();

    await expect(prepareStartupMigrations({
      config: path.join(root, "config.yaml"),
      workspace: path.join(root, "workspace"),
    }, { HOME: root })).rejects.toBe(failure);
  });
});
