import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  canonicalJson,
  sha256Hex,
  type ProjectWorkspaceOperation
} from "@memmy/local-api-contracts";
import {
  MEMMY_WORKSPACE_BRIDGE_RUNTIME_ASSET,
  MEMMY_WORKSPACE_BRIDGE_RUNTIME_SHA256
} from "./runtime-asset.js";
import {
  RuntimeWorkspaceBridge,
  openRuntimeSession,
  readRuntimeConfig,
  syncRuntimeEnvironment,
  type RuntimeSession
} from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace bridge runtime", () => {
  it("defaults workspace scanning on and honors explicit boolean settings", async () => {
    const fixture = createFixture();
    const configUrl = pathToFileURL(join(fixture, "memmy-memory-config.json"));
    const configPath = join(fixture, "config.yaml");
    writeFileSync(configUrl, JSON.stringify({
      memmy_config_path: configPath,
      userId: "installed-owner",
      workspaceHostId: "a".repeat(64)
    }));

    writeFileSync(configPath, "memmyMemory: {}\n");
    expect((await readRuntimeConfig(configUrl, true)).workspaceBridgeEnabled).toBe(true);

    for (const value of ["true", 1, null]) {
      writeFileSync(configPath, `memmyMemory:\n  workspaceBridge:\n    enabled: ${JSON.stringify(value)}\n`);
      expect((await readRuntimeConfig(configUrl, true)).workspaceBridgeEnabled).toBe(false);
    }

    writeFileSync(configPath, "memmyMemory:\n  workspaceBridge:\n    enabled: true\n");
    const enabled = await readRuntimeConfig(configUrl, true);
    expect(enabled.workspaceBridgeEnabled).toBe(true);
    expect(enabled.userId).toBe("installed-owner");

    writeFileSync(configPath, "memmyMemory:\n  workspaceBridge:\n    enabled: false\n");
    expect((await readRuntimeConfig(configUrl, true)).workspaceBridgeEnabled).toBe(false);
  });

  it("builds a stable, bounded inventory without reading ordinary source or sensitive files", async () => {
    const fixture = createWorkspace();
    const bridge = new RuntimeWorkspaceBridge(fixture.root);
    const operation: ProjectWorkspaceOperation = {
      operationId: "inventory-1",
      kind: "inventory",
      mode: "full",
      policy: PROJECT_ENVIRONMENT_SCAN_POLICY_V1
    };

    const evidence = await bridge.execute(operation);
    const accepted = evidence.filter((item) => item.kind === "inventory" && item.status === "accepted");
    expect(accepted.length).toBeGreaterThan(0);
    const entries = accepted.flatMap((item) => item.kind === "inventory" && item.status === "accepted" ? item.entries : []);
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
    expect(entries.some((entry) => entry.relativePath.includes("secret"))).toBe(false);
    expect(entries.some((entry) => entry.relativePath.includes("ignored"))).toBe(false);
    expect(entries.some((entry) => entry.relativePath.includes("outside"))).toBe(false);

    for (const item of accepted) {
      if (item.kind !== "inventory" || item.status !== "accepted") continue;
      expect(item.pageHash).toBe(sha256Hex(canonicalJson({
        operationId: item.operationId,
        pageIndex: item.pageIndex,
        isLast: item.isLast,
        omittedCount: item.omittedCount ?? null,
        entries: item.entries
      })));
      expect(Buffer.byteLength(JSON.stringify({ evidence: { entries: item.entries } }), "utf8")).toBeLessThan(2 * 1024 * 1024);
    }

    const repeated = await bridge.execute(operation);
    expect(repeated).toEqual(evidence);
  });

  it("returns exact manifest text, rejects symlinks and refuses a workspace-owned runtime shim", async () => {
    const fixture = createWorkspace();
    const bridge = new RuntimeWorkspaceBridge(fixture.root);
    const accepted = await bridge.execute({
      operationId: "read-1",
      kind: "read_text",
      relativePath: "package.json",
      expectedSha256: sha256Hex(fixture.packageText),
      maxBytes: 1024 * 1024
    });
    expect(accepted).toEqual([{
      operationId: "read-1",
      kind: "read_text",
      status: "accepted",
      relativePath: "package.json",
      sha256: sha256Hex(fixture.packageText),
      text: fixture.packageText
    }]);

    const symlink = await bridge.execute({
      operationId: "read-2",
      kind: "read_text",
      relativePath: "linked-package.json",
      expectedSha256: sha256Hex(fixture.packageText),
      maxBytes: 1024 * 1024
    });
    expect(symlink).toEqual([expect.objectContaining({ status: "unsupported", reason: "unsafe_path" })]);

    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const shim = join(bin, process.platform === "win32" ? "node.cmd" : "node");
    writeFileSync(shim, process.platform === "win32" ? "@echo v0.0.0\r\n" : "#!/bin/sh\necho v0.0.0\n");
    chmodSync(shim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      const probe = await bridge.execute({ operationId: "probe-1", kind: "runtime_probe", probe: "node_version" });
      expect(probe).toEqual([expect.objectContaining({ status: "unsupported", reason: "unsafe_probe" })]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("ships a reproducible self-contained Node asset", () => {
    expect(createHash("sha256").update(MEMMY_WORKSPACE_BRIDGE_RUNTIME_ASSET).digest("hex"))
      .toBe(MEMMY_WORKSPACE_BRIDGE_RUNTIME_SHA256);
    const imports = [...MEMMY_WORKSPACE_BRIDGE_RUNTIME_ASSET.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
  });

  it("does not contact Memory when any Bridge gate is absent", async () => {
    const fixture = createFixture();
    const session = runtimeSession(fixture);
    await expect(syncRuntimeEnvironment({
      ...session,
      config: { ...session.config, workspaceBridgeEnabled: false }
    }, "session_start")).resolves.toBeNull();
    await expect(syncRuntimeEnvironment({ ...session, workspaceBridgeSupported: false }, "session_start"))
      .resolves.toBeNull();
    await expect(syncRuntimeEnvironment({ ...session, projectId: null }, "session_start")).resolves.toBeNull();
  });

  it("keeps the v2 Turn pipeline when an explicit workspace cannot be used", async () => {
    const fixture = createFixture();
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = request.method === "POST" ? JSON.parse(await readBody(request)) as Record<string, unknown> : {};
      if (request.url === "/api/v1/health") return json(response, 200, {
        features: { l3WorldModelProtocolVersions: [2], workspaceBridgeProtocolVersions: ["1"] }
      });
      requests.push(body);
      return json(response, 200, { sessionId: "memory-session-1", projectId: null });
    });
    const endpoint = await listen(server);
    const configUrl = runtimeConfig(fixture, endpoint);
    try {
      const session = await openRuntimeSession({
        configUrl,
        source: "codex",
        sessionKey: "codex-memory-invalid-root",
        workspaceRoot: process.platform === "win32" ? "C:\\" : "/",
        transition: "allow_legacy_rollover",
        pinnedOwner: true
      });
      expect(session).toMatchObject({ protocol: "v2", projectId: null, workspaceRoot: null });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ l3WorldModelProtocolVersion: 2 });
      expect(requests[0]).not.toHaveProperty("workspaceUri");
      expect(requests[0]).not.toHaveProperty("workspaceHostId");
    } finally {
      await close(server);
    }
  });

  it("falls back to the exact legacy request only for a resume-only legacy conflict", async () => {
    const fixture = createFixture();
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = request.method === "POST" ? JSON.parse(await readBody(request)) as Record<string, unknown> : {};
      if (request.url === "/api/v1/health") return json(response, 200, {
        features: { l3WorldModelProtocolVersions: [2] }
      });
      requests.push(body);
      if (requests.length === 1) {
        return json(response, 409, {
          error: { code: "l3_world_model_v2_session_not_open", message: "l3_world_model_v2_session_not_open" }
        });
      }
      return json(response, 200, { sessionId: "legacy-memory-session" });
    });
    const endpoint = await listen(server);
    const configUrl = runtimeConfig(fixture, endpoint);
    try {
      const session = await openRuntimeSession({
        configUrl,
        source: "claude_code",
        sessionKey: "claude_code-memory-existing",
        transition: "resume_only",
        pinnedOwner: true
      });
      expect(session).toMatchObject({ protocol: "legacy", sessionId: "legacy-memory-session" });
      expect(requests[0]).toMatchObject({
        l3WorldModelProtocolVersion: 2,
        l3WorldModelTransition: "resume_only"
      });
      expect(requests[1]).toEqual({
        sessionId: "claude_code-memory-existing",
        source: "claude_code"
      });
    } finally {
      await close(server);
    }
  });

  it("lets the detached asset finish a sync after the caller returns without writing state files", async () => {
    const fixture = createFixture();
    const assetPath = join(fixture, "memmy-workspace-bridge.mjs");
    writeFileSync(assetPath, MEMMY_WORKSPACE_BRIDGE_RUNTIME_ASSET);
    const requestSeen = new Promise<void>((resolve) => {
      const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method === "POST") for await (const _chunk of request) void _chunk;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ syncId: "sync-1", scanId: "scan-1", status: "clean", operations: [] }));
        resolve();
      });
      server.listen(0, "127.0.0.1", async () => {
        const port = (server.address() as { port: number }).port;
        const runtime = await import(`${pathToFileURL(assetPath).href}?test=${Date.now()}`) as {
          syncRuntimeEnvironmentDetached(session: RuntimeSession, trigger: "session_start"): boolean;
        };
        const session = runtimeSession(fixture);
        session.config.endpoint = `http://127.0.0.1:${port}`;
        expect(runtime.syncRuntimeEnvironmentDetached(session, "session_start")).toBe(true);
        requestSeen.finally(() => server.close());
      });
    });

    await expect(Promise.race([
      requestSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("detached sync timed out")), 5_000))
    ])).resolves.toBeUndefined();
    expect(readdirSync(fixture).sort()).toEqual(["memmy-workspace-bridge.mjs"]);
  });
});

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-runtime-bridge-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createWorkspace(): { root: string; packageText: string } {
  const root = createFixture();
  const outside = createFixture();
  const packageText = '{"name":"bridge-fixture","scripts":{"test":"vitest"}}';
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "ignored"));
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  writeFileSync(join(root, "package.json"), packageText);
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "ignored", "ignored.ts"), "ignored\n");
  writeFileSync(join(root, ".env"), "secret=true\n");
  writeFileSync(join(outside, "outside.json"), packageText);
  symlinkSync(join(root, "package.json"), join(root, "linked-package.json"));
  symlinkSync(join(outside, "outside.json"), join(root, "outside.json"));
  return { root: realpathSync(root), packageText };
}

function runtimeSession(workspaceRoot: string): RuntimeSession {
  return {
    protocol: "v2",
    workspaceBridgeSupported: true,
    sessionId: "session-1",
    projectId: "project-1",
    sessionKey: "codex-memory-session-1",
    source: "codex",
    adapterId: "memmy-codex-hook",
    profileId: "default",
    workspaceRoot,
    config: {
      endpoint: "http://127.0.0.1:1",
      token: "",
      userId: "user-1",
      workspaceHostId: "a".repeat(64),
      workspaceBridgeEnabled: true
    }
  };
}

function runtimeConfig(directory: string, endpoint: string): URL {
  const configUrl = pathToFileURL(join(directory, "memmy-memory-config.json"));
  writeFileSync(configUrl, JSON.stringify({
    endpoint,
    userId: "installed-owner",
    workspaceHostId: "a".repeat(64),
    memmy_config_path: join(directory, "missing.yaml")
  }));
  return configUrl;
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
