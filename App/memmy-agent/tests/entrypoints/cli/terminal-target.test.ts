import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import {
  listTerminalSessions,
  resolveTerminalTarget,
} from "../../../src/entrypoints/cli/commands.js";

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function makeLoop(): { root: string; workspace: string; loop: AgentLoop } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-terminal-target-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const loop = new AgentLoop({
    config: new Config({
      fileMemory: { enabled: false },
      memmyMemory: { enabled: false },
    }),
    provider: {
      generation: { maxTokens: 128 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(),
    },
    workspace,
    sessionDir: path.join(workspace, "sessions"),
    model: "test-model",
  });
  return { root, workspace: fs.realpathSync(workspace), loop };
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("terminal target resolution", () => {
  it("creates cli:direct as a fixed standalone session by default", () => {
    const { loop, workspace } = makeLoop();
    const target = resolveTerminalTarget(loop);
    expect(target).toMatchObject({
      sessionId: "cli:direct",
      target: "standalone",
      projectId: null,
      cwd: workspace,
    });
    expect(loop.sessions.loadSession("cli:direct")?.metadata).toMatchObject({
      webui: true,
      webuiProjectId: null,
      webuiWorkspaceCwd: workspace,
    });
  });

  it("creates new standalone sessions and resumes them only by full cli session ID", () => {
    const { loop } = makeLoop();
    const created = resolveTerminalTarget(loop, { standalone: true });
    expect(created.sessionId).toMatch(/^cli:[0-9a-f-]{36}$/);
    expect(resolveTerminalTarget(loop, { sessionId: created.sessionId })).toEqual(created);
    expect(() => resolveTerminalTarget(loop, { sessionId: "telegram:123" }))
      .toThrow("--session only accepts");
    expect(() => resolveTerminalTarget(loop, {
      sessionId: created.sessionId,
      standalone: true,
    })).toThrow("mutually exclusive");
  });

  it("accepts project paths, reuses the registered canonical root, and fixes each binding", () => {
    const { root, loop } = makeLoop();
    const projectPath = path.join(root, "code", "memmy");
    fs.mkdirSync(projectPath, { recursive: true });
    const first = resolveTerminalTarget(loop, {
      project: path.relative(root, projectPath),
      invocationCwd: root,
    });
    const second = resolveTerminalTarget(loop, { project: projectPath });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.projectId).toBe(second.projectId);
    expect(first).toMatchObject({
      target: "project",
      projectName: "memmy",
      cwd: fs.realpathSync(projectPath),
    });
    expect(resolveTerminalTarget(loop, { sessionId: first.sessionId })).toEqual(first);
  });

  it("does not expose non-cli projected sessions through session listing", () => {
    const { loop, workspace } = makeLoop();
    resolveTerminalTarget(loop);
    const im = loop.sessions.getOrCreate("telegram:123");
    im.metadata.webui = true;
    im.metadata.webuiProjectId = null;
    im.metadata.webuiWorkspaceCwd = workspace;
    loop.sessions.save(im);

    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(loop);
    const rows = listTerminalSessions();
    expect(rows.map((row) => row.sessionId)).toEqual(["cli:direct"]);
  });
});
