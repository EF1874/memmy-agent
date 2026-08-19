import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  canonicalJson,
  sha256Hex,
  type ProjectEnvironmentSyncResponse,
  type ProjectWorkspaceOperation
} from "@memmy/local-api-contracts";
import type { MemmyMemoryClient } from "../../src/memmy-memory/client.js";
import {
  MemmyWorkspaceBridge,
  driveWorkspaceBridge,
  normalizeWorkspaceRoot
} from "../../src/memmy-memory/workspace-bridge.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Memmy workspace bridge", () => {
  it("rejects filesystem and user-home roots", async () => {
    expect(await normalizeWorkspaceRoot(join(realpathSync(homedir()), "."))).toBeNull();
    expect(await normalizeWorkspaceRoot(process.platform === "win32" ? "C:\\" : "/")).toBeNull();
    expect(await normalizeWorkspaceRoot("relative/workspace")).toBeNull();
  });

  it("builds stable paged inventory and hashes only deterministic candidates", async () => {
    const fixture = createWorkspace();
    const bridge = await MemmyWorkspaceBridge.create(fixture.root);
    expect(bridge).not.toBeNull();
    const operation: ProjectWorkspaceOperation = {
      operationId: "inventory-1",
      kind: "inventory",
      mode: "full",
      policy: PROJECT_ENVIRONMENT_SCAN_POLICY_V1
    };
    const evidence = await bridge!.execute(operation);
    const pages = evidence.filter((item) => item.kind === "inventory" && item.status === "accepted");
    const entries = pages.flatMap((item) => item.kind === "inventory" && item.status === "accepted" ? item.entries : []);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      ".git",
      ".gitignore",
      "package.json",
      "src",
      "src/index.ts"
    ]);
    expect(entries.find((entry) => entry.relativePath === "package.json")).toMatchObject({
      sha256: sha256Hex(fixture.packageText)
    });
    expect(entries.find((entry) => entry.relativePath === "src/index.ts")).not.toHaveProperty("sha256");
    expect(entries.some((entry) => entry.relativePath.includes("ignored"))).toBe(false);
    expect(entries.some((entry) => entry.relativePath.includes("secret"))).toBe(false);
    for (const page of pages) {
      if (page.kind !== "inventory" || page.status !== "accepted") continue;
      expect(page.pageHash).toBe(sha256Hex(canonicalJson({
        operationId: page.operationId,
        pageIndex: page.pageIndex,
        isLast: page.isLast,
        omittedCount: page.omittedCount ?? null,
        entries: page.entries
      })));
      expect(Buffer.byteLength(JSON.stringify({ evidence: { entries: page.entries } }), "utf8"))
        .toBeLessThan(2 * 1024 * 1024);
    }
    expect(await bridge!.execute(operation)).toEqual(evidence);
  });

  it("reads exact manifest evidence and rejects symlinks, stale hashes and project shims", async () => {
    const fixture = createWorkspace();
    const bridge = await MemmyWorkspaceBridge.create(fixture.root);
    expect(await bridge!.execute({
      operationId: "read-1",
      kind: "read_text",
      relativePath: "package.json",
      expectedSha256: sha256Hex(fixture.packageText),
      maxBytes: 1024 * 1024
    })).toEqual([expect.objectContaining({ status: "accepted", text: fixture.packageText })]);
    expect(await bridge!.execute({
      operationId: "read-2",
      kind: "read_text",
      relativePath: "linked-package.json",
      expectedSha256: sha256Hex(fixture.packageText),
      maxBytes: 1024 * 1024
    })).toEqual([expect.objectContaining({ status: "unsupported", reason: "unsafe_path" })]);
    expect(await bridge!.execute({
      operationId: "read-3",
      kind: "read_text",
      relativePath: "package.json",
      expectedSha256: "0".repeat(64),
      maxBytes: 1024 * 1024
    })).toEqual([expect.objectContaining({ status: "stale", actualSha256: sha256Hex(fixture.packageText) })]);

    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const shim = join(bin, process.platform === "win32" ? "node.cmd" : "node");
    writeFileSync(shim, process.platform === "win32" ? "@echo v0.0.0\r\n" : "#!/bin/sh\necho v0.0.0\n");
    chmodSync(shim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      expect(await bridge!.execute({ operationId: "probe-1", kind: "runtime_probe", probe: "node_version" }))
        .toEqual([expect.objectContaining({ status: "unsupported", reason: "unsafe_probe" })]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("drives only the operations returned by Memory and preserves request scope", async () => {
    const fixture = createWorkspace();
    const inventory: ProjectWorkspaceOperation = {
      operationId: "inventory-1",
      kind: "inventory",
      mode: "full",
      policy: PROJECT_ENVIRONMENT_SCAN_POLICY_V1
    };
    const clean: ProjectEnvironmentSyncResponse = {
      syncId: "sync-1",
      scanId: "scan-1",
      status: "clean",
      operations: []
    };
    const projectEnvironmentSyncStart = vi.fn().mockResolvedValue({
      syncId: "sync-1",
      scanId: null,
      status: "collecting_inventory",
      operations: [inventory]
    });
    const projectEnvironmentSyncEvidence = vi.fn().mockResolvedValue(clean);
    const projectEnvironmentSyncStatus = vi.fn().mockResolvedValue(clean);
    const client = {
      projectEnvironmentSyncStart,
      projectEnvironmentSyncEvidence,
      projectEnvironmentSyncStatus
    } as unknown as MemmyMemoryClient;
    const envelope = {
      requestId: "805c5f50-5724-4b26-9abc-a53ef5c277ba",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      namespace: {
        source: "memmy-agent",
        profileId: "default",
        sessionKey: "memmy-agent-session-1",
        userId: "user-1",
        projectId: "project-1"
      }
    } as const;
    await expect(driveWorkspaceBridge({
      client,
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      envelope,
      root: fixture.root
    })).resolves.toEqual(clean);
    expect(projectEnvironmentSyncStart).toHaveBeenCalledWith("project-1", expect.objectContaining({
      sessionId: "session-1",
      trigger: "session_start",
      namespace: envelope.namespace
    }));
    expect(projectEnvironmentSyncEvidence).toHaveBeenCalledWith("project-1", "sync-1", expect.objectContaining({
      sessionId: "session-1",
      namespace: envelope.namespace,
      evidence: expect.objectContaining({ kind: "inventory", status: "accepted" })
    }));
    expect(projectEnvironmentSyncStatus).toHaveBeenCalledWith(
      "project-1",
      "sync-1",
      "session-1",
      expect.objectContaining({ namespace: envelope.namespace })
    );
  });
});

function createWorkspace(): { root: string; packageText: string } {
  const root = createFixture();
  const packageText = '{"name":"memmy-bridge-fixture"}';
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "ignored"));
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  writeFileSync(join(root, "package.json"), packageText);
  writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "ignored", "ignored.ts"), "ignored\n");
  writeFileSync(join(root, ".env"), "secret=true\n");
  symlinkSync(join(root, "package.json"), join(root, "linked-package.json"));
  return { root: realpathSync(root), packageText };
}

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-agent-workspace-bridge-"));
  temporaryDirectories.push(directory);
  return directory;
}
