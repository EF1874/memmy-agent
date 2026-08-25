import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listAgentSources,
  startAgentSourceScan
} from "../src/server/agent-source-bridge.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Viewer Agent source bridge", () => {
  it("shows every supported source when Desktop is offline", async () => {
    vi.stubEnv("MEMMY_RUNTIME_CONFIG_PATH", join(tempRoot(), "missing-runtime.json"));
    const result = await listAgentSources();

    expect(result.executorAvailable).toBe(false);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "opencode",
      "openclaw",
      "hermes",
      "deepseek_harness",
      "workbuddy",
      "pi",
      "qwenwork"
    ]);
  });

  it("uses the authenticated Desktop runtime for scans", async () => {
    const root = tempRoot();
    const runtimePath = join(root, "runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      baseUrl: "http://127.0.0.1:24680",
      localToken: "desktop-token"
    }));
    vi.stubEnv("MEMMY_RUNTIME_CONFIG_PATH", runtimePath);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobId: "scan-1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startAgentSourceScan({ sourceId: "codex", mode: "full" }))
      .resolves.toEqual({ jobId: "scan-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:24680/api/agent-sources/scan"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sourceId: "codex", mode: "full" }),
        headers: expect.objectContaining({ "x-memmy-local-token": "desktop-token" })
      })
    );
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-bridge-"));
  roots.push(root);
  return root;
}
