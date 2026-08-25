import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryServiceError } from "../utils/error.js";

interface DesktopRuntimeConfig {
  baseUrl: string;
  localToken: string;
}

export interface AgentSourceView {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  available: boolean;
  status: "not_connected" | "skill_installed" | "plugin_installed";
  messageCount: number;
  lastScannedAt: string | null;
}

const BUILTIN_AGENT_SOURCES: ReadonlyArray<Pick<AgentSourceView, "sourceId" | "displayName">> = [
  { sourceId: "cursor", displayName: "Cursor" },
  { sourceId: "claude_code", displayName: "Claude Code" },
  { sourceId: "codex", displayName: "Codex" },
  { sourceId: "opencode", displayName: "OpenCode" },
  { sourceId: "openclaw", displayName: "OpenClaw" },
  { sourceId: "hermes", displayName: "Hermes" },
  { sourceId: "deepseek_harness", displayName: "DeepSeek Harness" },
  { sourceId: "workbuddy", displayName: "WorkBuddy" },
  { sourceId: "pi", displayName: "Pi" },
  { sourceId: "qwenwork", displayName: "QwenWork" }
];

export async function listAgentSources(): Promise<{
  executorAvailable: boolean;
  sources: AgentSourceView[];
}> {
  try {
    const sources = await desktopRequest<AgentSourceView[]>("/api/agent-sources");
    return { executorAvailable: true, sources };
  } catch {
    return {
      executorAvailable: false,
      sources: BUILTIN_AGENT_SOURCES.map((source) => ({
        ...source,
        dataPath: "",
        builtin: true,
        available: false,
        status: "not_connected",
        messageCount: 0,
        lastScannedAt: null
      }))
    };
  }
}

export async function startAgentSourceScan(input: unknown): Promise<unknown> {
  return desktopRequest("/api/agent-sources/scan", {
    method: "POST",
    body: JSON.stringify(normalizeScanInput(input))
  });
}

export async function agentSourceScanStatus(): Promise<unknown> {
  return desktopRequest("/api/agent-sources/scan/status");
}

export async function mutateAgentSourceConnection(
  sourceId: string,
  kind: "plugin" | "skill",
  method: "POST" | "DELETE"
): Promise<unknown> {
  return desktopRequest(`/api/agent-sources/${encodeURIComponent(sourceId)}/${kind}`, {
    method,
    ...(kind === "plugin" ? { body: "{}" } : {})
  });
}

async function desktopRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const runtime = await readDesktopRuntime();
  if (!runtime) {
    throw new MemoryServiceError(
      "conflict",
      "The Memmy Desktop scan executor is not running"
    );
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, runtime.baseUrl), {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-memmy-local-token": runtime.localToken,
        ...init.headers
      },
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new MemoryServiceError(
      "conflict",
      "The Memmy Desktop scan executor is not running"
    );
  }
  const payload = await parseResponse(response);
  if (!response.ok) {
    const error = record(record(payload).error);
    throw new MemoryServiceError(
      "conflict",
      typeof error.message === "string" ? error.message : `Agent source request failed with HTTP ${response.status}`
    );
  }
  return payload as T;
}

async function readDesktopRuntime(): Promise<DesktopRuntimeConfig | null> {
  const path = process.env.MEMMY_RUNTIME_CONFIG_PATH
    ?? join(homedir(), ".memmy", "runtime.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const runtime = record(parsed);
    if (typeof runtime.baseUrl !== "string" || typeof runtime.localToken !== "string") return null;
    const endpoint = new URL(runtime.baseUrl);
    if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)) return null;
    return { baseUrl: endpoint.toString(), localToken: runtime.localToken };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

function normalizeScanInput(value: unknown): { sourceId: string; mode?: "initial_subset" | "incremental" | "full" } {
  const input = record(value);
  const sourceId = typeof input.sourceId === "string" && input.sourceId.trim()
    ? input.sourceId.trim()
    : "all";
  const mode = input.mode === "initial_subset" || input.mode === "incremental" || input.mode === "full"
    ? input.mode
    : undefined;
  return { sourceId, ...(mode ? { mode } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
