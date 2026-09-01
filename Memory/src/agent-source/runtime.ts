import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import type { MemoryService } from "../service/memory-service.js";
import { MemoryServiceError } from "../utils/error.js";
import {
  resolveClaudeCodeHomeDirectory,
  resolveCodexHomeDirectory,
  resolveDeepseekHarnessHomeDirectory,
  resolveHermesHomeDirectory,
  resolveOpenclawStateDirectory,
  resolveOpencodeConfigDirectory,
  resolvePiAgentDirectory,
  resolveQwenworkHomeDirectory,
  resolveWorkbuddyHomeDirectory
} from "./agent-paths.js";
import { createClaudeCodeSourceAdapter } from "./adapters/claude-code/index.js";
import { createCodexSourceAdapter } from "./adapters/codex/index.js";
import { createCursorSourceAdapter } from "./adapters/cursor/index.js";
import { createDeepseekHarnessSourceAdapter } from "./adapters/deepseek-harness/index.js";
import { createHermesSourceAdapter } from "./adapters/hermes/index.js";
import { createOpenclawSourceAdapter } from "./adapters/openclaw/index.js";
import { createOpencodeSourceAdapter } from "./adapters/opencode/index.js";
import { createPiSourceAdapter } from "./adapters/pi/index.js";
import { createQwenworkSourceAdapter } from "./adapters/qwenwork/index.js";
import { createSourceRegistry, type SourceRegistry } from "./adapters/source-registry.js";
import type { ConversationMessage, ScanProgress } from "./adapters/types.js";
import { createWorkbuddySourceAdapter } from "./adapters/workbuddy/index.js";
import { createClaudeCodeSkillTarget } from "./integration/claude-code/index.js";
import { createCodexSkillTarget } from "./integration/codex/index.js";
import { createCursorSkillTarget } from "./integration/cursor/index.js";
import { createDeepseekHarnessSkillTarget } from "./integration/deepseek-harness/index.js";
import { createHermesSkillTarget } from "./integration/hermes/index.js";
import { createOpenclawSkillTarget } from "./integration/openclaw/index.js";
import { createOpencodeSkillTarget } from "./integration/opencode/index.js";
import { createPiSkillTarget } from "./integration/pi/index.js";
import { createQwenworkSkillTarget } from "./integration/qwenwork/index.js";
import {
  createSkillTargetRegistry,
  type SkillTargetRegistry
} from "./integration/target-registry.js";
import { renderMemmyDefaultSkillManifest } from "./integration/templates/memmy-default.js";
import { createWorkbuddySkillTarget } from "./integration/workbuddy/index.js";

const logger = createMemoryLogger("agent-source");
const INITIAL_SCAN_DELAY_MS = 5 * 60 * 1000;
const SCHEDULED_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_SCAN_MESSAGE_LIMIT = 1_000;

export type AgentConnectionStatus = "not_connected" | "skill_installed" | "plugin_installed";

export interface AgentSourceView {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  available: boolean;
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
}

export interface AgentSourceScanState {
  running: boolean;
  jobId: string | null;
  sourceId: string | null;
  mode: "initial_subset" | "incremental" | "full" | null;
  progress: ScanProgress | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface AgentSourceExecutor {
  list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }>;
  startScan(input: unknown): Promise<{ accepted: true; jobId: string }>;
  scanStatus(): AgentSourceScanState;
  pauseScan(): Promise<{ ok: true }>;
  cancelScan(): Promise<{ ok: true }>;
  mutateConnection(sourceId: string, kind: "plugin" | "skill", method: "POST" | "DELETE"): Promise<unknown>;
  startAutomation(): void;
  dispose(): void;
}

interface PersistedSourceState {
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
  latestSeenAt: string | null;
  importedRequestIds?: string[];
}

interface PersistedState {
  version: 1;
  sources: Record<string, PersistedSourceState>;
}

export interface CreateAgentSourceExecutorOptions {
  service: MemoryService;
  configPath?: string;
  sourceRegistry?: SourceRegistry;
  statePath?: string;
  initialScanDelayMs?: number;
  scheduledScanIntervalMs?: number;
  scheduleWorker?: () => void;
  integrationRegistry?: SkillTargetRegistry;
  /** Resolves the Agent root used for optional cross-Agent Skill ingestion. */
  resolveAgentSkillRoot?: (sourceId: string) => string | null;
}

export function createAgentSourceExecutor(options: CreateAgentSourceExecutorOptions): AgentSourceExecutor {
  const registry = options.sourceRegistry ?? createBuiltinSourceRegistry();
  const configPath = options.configPath ?? join(
    process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"),
    "config.yaml"
  );
  const integrationRegistry = options.integrationRegistry ?? createBuiltinIntegrationRegistry(configPath);
  const statePath = options.statePath ?? join(dirname(configPath), "memory-service", "agent-sources.json");
  let statePromise: Promise<PersistedState> | undefined;
  let scan: AgentSourceScanState = emptyScanState();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanAbortController: AbortController | undefined;
  let activeScanRequest: ReturnType<typeof normalizeScanInput> | undefined;
  let scanPaused = false;
  let progressBeforePause: ScanProgress | null = null;
  let resumePausedScan: (() => void) | undefined;
  let disposed = false;

  const readState = () => statePromise ??= loadState(statePath);
  const persist = async (state: PersistedState) => writeState(statePath, state);

  async function list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }> {
    const state = await readState();
    const sources = await Promise.all(registry.list().map(async (adapter) => {
      const stored = state.sources[adapter.descriptor.sourceId];
      const available = await adapter.detect();
      const target = integrationRegistry.get(adapter.descriptor.sourceId);
      const installed = target
        ? await target.isInstalled(adapter.descriptor.sourceId).catch((error) => {
            logger.warn("connection.status_read_failed", {
              sourceId: adapter.descriptor.sourceId,
              ...memoryErrorFields(error)
            });
            return false;
          })
        : false;
      return {
        ...adapter.descriptor,
        available,
        status: installed ? connectionStatus(adapter.descriptor.sourceId) : "not_connected",
        messageCount: stored?.messageCount ?? 0,
        lastScannedAt: stored?.lastScannedAt ?? null
      };
    }));
    return { executorAvailable: true, sources };
  }

  async function startScan(input: unknown): Promise<{ accepted: true; jobId: string }> {
    const request = normalizeScanInput(input);
    if (scan.running) throw new MemoryServiceError("conflict", "An Agent source scan is already running");
    if (scanPaused && scanAbortController && activeScanRequest && scan.jobId) {
      if (!sameScanRequest(activeScanRequest, request)) {
        throw new MemoryServiceError("conflict", "Resume or stop the paused Agent source scan first");
      }
      const jobId = scan.jobId;
      scanPaused = false;
      scan = {
        ...scan,
        running: true,
        progress: progressBeforePause ?? {
          sourceId: request.sourceId,
          phase: "scan",
          current: 0,
          total: 0,
          message: "Scanning Agent history"
        },
        error: null
      };
      resumePausedScan?.();
      resumePausedScan = undefined;
      logger.info("scan.resumed", { jobId, sourceId: request.sourceId });
      return { accepted: true, jobId };
    }
    if (scanPaused) {
      throw new MemoryServiceError("conflict", "Stop the paused Agent source scan before starting another scan");
    }
    const jobId = `agent-scan-${Date.now().toString(36)}`;
    scan = {
      running: true,
      jobId,
      sourceId: request.sourceId,
      mode: request.mode ?? null,
      progress: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };
    activeScanRequest = request;
    progressBeforePause = null;
    const controller = new AbortController();
    scanAbortController = controller;
    void runScan(request, controller.signal).then(() => {
      if (scan.jobId !== jobId) return;
      scan = { ...scan, running: false, completedAt: new Date().toISOString() };
      logger.info("scan.completed", { jobId, sourceId: request.sourceId });
    }).catch((error) => {
      if (scan.jobId !== jobId || controller.signal.aborted) return;
      scan = {
        ...scan,
        running: false,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      logger.error("scan.failed", { jobId, sourceId: request.sourceId, ...memoryErrorFields(error) });
    }).finally(() => {
      if (scanAbortController === controller) {
        scanAbortController = undefined;
        activeScanRequest = undefined;
        scanPaused = false;
        progressBeforePause = null;
        resumePausedScan = undefined;
      }
    });
    logger.info("scan.started", { jobId, sourceId: request.sourceId, mode: request.mode });
    return { accepted: true, jobId };
  }

  async function runScan(
    request: ReturnType<typeof normalizeScanInput>,
    signal: AbortSignal
  ): Promise<void> {
    const failures: string[] = [];
    const adapters = request.sourceId === "all"
      ? registry.list()
      : [registry.require(request.sourceId)];
    const state = await readState();
    for (const adapter of adapters) {
      await waitWhilePaused(signal);
      signal.throwIfAborted();
      if (!(await adapter.detect())) {
        if (request.sourceId !== "all") {
          throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
        }
        continue;
      }
      const stored = state.sources[adapter.descriptor.sourceId] ?? emptySourceState();
      const mode = request.mode ?? (stored.lastScannedAt ? "incremental" : "initial_subset");
      const messages: ConversationMessage[] = [];
      for await (const message of adapter.scan({
        ...(mode === "incremental" && stored.latestSeenAt ? { since: stored.latestSeenAt } : {}),
        ...(mode === "initial_subset" ? { maxMessages: INITIAL_SCAN_MESSAGE_LIMIT, maxScanTargets: INITIAL_SCAN_MESSAGE_LIMIT } : {}),
        order: mode === "initial_subset" ? "recent_first" : "source_default",
        signal,
        onProgress(progress) {
          if (!scanPaused) {
            progressBeforePause = progress;
            scan = { ...scan, progress };
          }
        }
      })) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        messages.push(message);
      }
      await waitWhilePaused(signal);
      signal.throwIfAborted();
      const importedRequestIds = new Set(stored.importedRequestIds ?? []);
      const result = ingestMessages(
        options.service,
        adapter.descriptor.sourceId,
        messages,
        importedRequestIds
      );
      const skillResult = await ingestAgentSkills(
        options.service,
        adapter.descriptor.sourceId,
        importedRequestIds,
        options.resolveAgentSkillRoot
      );
      failures.push(...result.errors, ...skillResult.errors);
      const now = new Date().toISOString();
      state.sources[adapter.descriptor.sourceId] = {
        ...stored,
        messageCount: stored.messageCount + result.messageCount,
        lastScannedAt: now,
        latestSeenAt: maxCreatedAt(messages) ?? stored.latestSeenAt,
        importedRequestIds: [...importedRequestIds]
      };
      await persist(state);
      const memoryIds = [...result.memoryIds, ...skillResult.memoryIds];
      if (memoryIds.length > 0) {
        options.service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, memoryIds);
        options.scheduleWorker?.();
      }
      scan = {
        ...scan,
        progress: {
          sourceId: adapter.descriptor.sourceId,
          phase: "done",
          current: messages.length,
          total: messages.length,
          message: `Imported ${result.written} memories and ${skillResult.written} skills`
        }
      };
    }
    if (failures.length > 0) {
      throw new Error(`Agent source scan completed with ${failures.length} import failure${failures.length === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}`);
    }
  }

  async function pauseScan(): Promise<{ ok: true }> {
    if (scanPaused) return { ok: true };
    if (!scan.running || !scanAbortController || !activeScanRequest) {
      throw new MemoryServiceError("conflict", "No Agent source scan is running");
    }
    progressBeforePause = scan.progress;
    scanPaused = true;
    scan = {
      ...scan,
      running: false,
      progress: {
        sourceId: scan.progress?.sourceId ?? activeScanRequest.sourceId,
        phase: "stopped",
        current: scan.progress?.current ?? 0,
        total: scan.progress?.total ?? 0,
        message: "Agent source scan paused"
      }
    };
    logger.info("scan.paused", { jobId: scan.jobId, sourceId: activeScanRequest.sourceId });
    return { ok: true };
  }

  async function cancelScan(): Promise<{ ok: true }> {
    const controller = scanAbortController;
    if (!controller && !scanPaused) return { ok: true };
    const jobId = scan.jobId;
    const sourceId = activeScanRequest?.sourceId;
    scanPaused = false;
    controller?.abort();
    resumePausedScan?.();
    resumePausedScan = undefined;
    scan = emptyScanState();
    activeScanRequest = undefined;
    progressBeforePause = null;
    logger.info("scan.canceled", { jobId, sourceId });
    return { ok: true };
  }

  async function waitWhilePaused(signal: AbortSignal): Promise<void> {
    while (scanPaused) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          resumePausedScan = undefined;
          reject(signal.reason ?? new Error("Agent source scan canceled"));
        };
        resumePausedScan = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  async function mutateConnection(
    sourceId: string,
    kind: "plugin" | "skill",
    method: "POST" | "DELETE"
  ): Promise<unknown> {
    const adapter = registry.require(sourceId);
    if (!(await adapter.detect())) {
      throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
    }
    const target = integrationRegistry.get(sourceId);
    if (!target) throw new MemoryServiceError("invalid_argument", `Agent source ${sourceId} cannot be connected automatically`);
    if (method === "POST") {
      if (!(await target.resolveRootDirectory())) {
        throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      if (kind === "plugin") {
        if (!target.installPlugin) {
          throw new MemoryServiceError("invalid_argument", `${adapter.descriptor.displayName} does not support automatic Hook or plugin installation`);
        }
        await target.installPlugin(sourceId);
      } else {
        await target.install(renderMemmyDefaultSkillManifest(sourceId));
      }
    } else {
      if (kind === "plugin" && target.uninstallPlugin) await target.uninstallPlugin(sourceId);
      await target.uninstall(sourceId);
    }
    const state = await readState();
    const stored = state.sources[sourceId] ?? emptySourceState();
    state.sources[sourceId] = {
      ...stored,
      status: method === "POST" ? connectionStatus(sourceId) : "not_connected"
    };
    await persist(state);
    logger.info(method === "POST" ? "connection.installed" : "connection.removed", { sourceId, kind });
    return { ok: true, sourceId, status: state.sources[sourceId].status };
  }

  function scheduleAutomation(delay: number, startup: boolean): void {
    if (disposed) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void runAutomation(startup)
        .catch((error) => logger.warn("automation.failed", memoryErrorFields(error)))
        .finally(() => scheduleAutomation(
          options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
          false
        ));
    }, delay);
    scanTimer.unref?.();
  }

  async function runAutomation(startup: boolean): Promise<void> {
    if (disposed || scan.running) return;
    const config = loadMemmyConfig(configPath).config.agentAccess;
    if (config.autoInjectSkill) {
      const discovered = await list();
      for (const source of discovered.sources) {
        if (!source.available || source.status !== "not_connected") continue;
        try {
          await mutateConnection(source.sourceId, agentConnectionKind(source.sourceId), "POST");
        } catch (error) {
          logger.warn("connection.auto_install_failed", { sourceId: source.sourceId, ...memoryErrorFields(error) });
        }
      }
    }
    const enabled = startup ? config.autoScanKnownAgents : config.watchFileChanges;
    if (enabled) await startScan({ sourceId: "all" });
  }

  return {
    list,
    startScan,
    scanStatus: () => scan,
    pauseScan,
    cancelScan,
    mutateConnection,
    startAutomation() {
      if (scanTimer || disposed) return;
      const config = loadMemmyConfig(configPath).config.agentAccess;
      scheduleAutomation(
        config.autoScanKnownAgents
          ? options.initialScanDelayMs ?? INITIAL_SCAN_DELAY_MS
          : options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
        config.autoScanKnownAgents
      );
    },
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = undefined;
      scanPaused = false;
      scanAbortController?.abort();
      resumePausedScan?.();
      resumePausedScan = undefined;
      scanAbortController = undefined;
    }
  };
}

function sameScanRequest(
  left: ReturnType<typeof normalizeScanInput>,
  right: ReturnType<typeof normalizeScanInput>
): boolean {
  return left.sourceId === right.sourceId && (right.mode === undefined || left.mode === right.mode);
}

export function createBuiltinSourceRegistry(): SourceRegistry {
  return createSourceRegistry([
    createCursorSourceAdapter(),
    createClaudeCodeSourceAdapter(),
    createCodexSourceAdapter(),
    createOpencodeSourceAdapter(),
    createOpenclawSourceAdapter(),
    createHermesSourceAdapter(),
    createDeepseekHarnessSourceAdapter(),
    createWorkbuddySourceAdapter(),
    createPiSourceAdapter(),
    createQwenworkSourceAdapter()
  ]);
}

export function createBuiltinIntegrationRegistry(configPath: string): SkillTargetRegistry {
  return createSkillTargetRegistry([
    createCursorSkillTarget({ memmyConfigPath: configPath }),
    createClaudeCodeSkillTarget({ memmyConfigPath: configPath }),
    createCodexSkillTarget({ memmyConfigPath: configPath }),
    createOpencodeSkillTarget({ memmyConfigPath: configPath }),
    createOpenclawSkillTarget({ memmyConfigPath: configPath }),
    createHermesSkillTarget({ memmyConfigPath: configPath }),
    createDeepseekHarnessSkillTarget({ memmyConfigPath: configPath }),
    createWorkbuddySkillTarget(),
    createPiSkillTarget(),
    createQwenworkSkillTarget()
  ]);
}

function ingestMessages(
  service: MemoryService,
  sourceId: string,
  messages: readonly ConversationMessage[],
  importedRequestIds: Set<string>
): { written: number; messageCount: number; memoryIds: string[]; errors: string[] } {
  const memoryIds: string[] = [];
  const errors: string[] = [];
  let messageCount = 0;
  for (const turn of completeTurns(messages)) {
    const content = turn
      .map((message) => `## ${message.role}\n\n${renderMessageContent(message)}`)
      .join("\n\n");
    const identity = `${sourceId}::${turn[0]!.conversationId}::${turn[0]!.messageId}`;
    const turnHash = createHash("sha256").update(identity).digest("hex");
    const requestId = createHash("sha256")
      .update([identity, turn[0]!.createdAt, content].join("\u0000"))
      .digest("hex");
    if (importedRequestIds.has(requestId)) continue;
    try {
      const added = service.addMemory({
        requestId,
        adapterId: `agent-source:${sourceId}`,
        content,
        layer: "L1",
        title: titleForTurn(sourceId, turn),
        tags: ["agent-source", sourceId],
        source: sourceId,
        turnId: `${sourceId}:${turnHash.slice(0, 24)}`,
        createdAt: turn[0]!.createdAt,
        deferProcessing: true
      });
      importedRequestIds.add(requestId);
      memoryIds.push(added.id);
      messageCount += turn.length;
    } catch (error) {
      errors.push(`${turn[0]!.conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written: memoryIds.length, messageCount, memoryIds, errors };
}

function renderMessageContent(message: ConversationMessage): string {
  if (message.role !== "tool" || /^Tool:\s*/im.test(message.content)) return message.content;
  const toolName = stringMeta(message.rawMeta, "toolName") ?? stringMeta(message.rawMeta, "hermesToolName");
  const callId = stringMeta(message.rawMeta, "toolCallId") ?? stringMeta(message.rawMeta, "hermesToolCallId");
  if (!toolName && !callId) return message.content;
  return [
    toolName ? `Tool: ${toolName}` : undefined,
    callId ? `Call ID: ${callId}` : undefined,
    message.content
  ].filter(Boolean).join("\n\n");
}

function stringMeta(meta: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function ingestAgentSkills(
  service: MemoryService,
  sourceId: string,
  importedRequestIds: Set<string>,
  resolveAgentSkillRoot: (sourceId: string) => string | null = agentRootDirectory
): Promise<{ written: number; memoryIds: string[]; errors: string[] }> {
  const root = resolveAgentSkillRoot(sourceId);
  if (!root) return { written: 0, memoryIds: [], errors: [] };
  const skillsRoot = join(root, "skills");
  const files = await findSkillFiles(skillsRoot);
  const memoryIds: string[] = [];
  const errors: string[] = [];
  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const sourceSkillId = relative(skillsRoot, dirname(filePath)).replaceAll("\\", "/");
    const requestId = `agent-source-skill:${sourceId}:${sourceSkillId}:${contentHash}`;
    if (importedRequestIds.has(requestId)) continue;
    const fileStat = await stat(filePath);
    try {
      const added = service.addMemory({
        requestId,
        adapterId: `agent-source:${sourceId}`,
        content,
        layer: "Skill",
        title: frontmatterValue(content, "name") ?? sourceSkillId,
        tags: ["agent-source", "cross-agent-skill", sourceId],
        source: sourceId,
        turnId: `skill:${sourceSkillId}:${contentHash}`,
        createdAt: fileStat.mtime.toISOString(),
        sourceAgentId: sourceId,
        sourceSkillId,
        sourceSkillPath: filePath,
        sourceSkillVersion: frontmatterValue(content, "version") ?? contentHash,
        sourceContentHash: contentHash,
        deferProcessing: true
      });
      importedRequestIds.add(requestId);
      memoryIds.push(added.id);
    } catch (error) {
      errors.push(`skill ${sourceSkillId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written: memoryIds.length, memoryIds, errors };
}

async function findSkillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, 0);
  return files.sort();

  async function visit(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "memmy-memory" || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") files.push(path);
      else if (depth < 2 && entry.isDirectory()) await visit(path, depth + 1);
    }
  }
}

function agentRootDirectory(sourceId: string): string | null {
  switch (sourceId) {
    case "cursor": return join(homedir(), ".cursor");
    case "claude_code": return resolveClaudeCodeHomeDirectory();
    case "codex": return resolveCodexHomeDirectory();
    case "opencode": return resolveOpencodeConfigDirectory();
    case "openclaw": return resolveOpenclawStateDirectory();
    case "hermes": return resolveHermesHomeDirectory();
    case "deepseek_harness": return resolveDeepseekHarnessHomeDirectory();
    case "workbuddy": return resolveWorkbuddyHomeDirectory();
    case "pi": return resolvePiAgentDirectory();
    case "qwenwork": return resolveQwenworkHomeDirectory();
    default: return null;
  }
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  return content.slice(3, end)
    .match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "im"))?.[1]
    ?.trim();
}

function completeTurns(messages: readonly ConversationMessage[]): ConversationMessage[][] {
  const sorted = [...messages].sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.messageId.localeCompare(right.messageId)
  );
  const turns: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  let conversationId = "";
  for (const message of sorted) {
    if (message.conversationId !== conversationId || (message.role === "user" && current.length > 0)) {
      if (isCompleteTurn(current)) turns.push(current);
      current = [];
      conversationId = message.conversationId;
    }
    current.push(message);
  }
  if (isCompleteTurn(current)) turns.push(current);
  return turns;
}

function isCompleteTurn(messages: readonly ConversationMessage[]): boolean {
  return messages[0]?.role === "user"
    && Boolean(messages[0].content.trim())
    && messages[messages.length - 1]?.role === "assistant"
    && Boolean(messages[messages.length - 1]?.content.trim());
}

function titleForTurn(sourceId: string, messages: readonly ConversationMessage[]): string {
  const firstLine = messages[0]?.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const title = firstLine || `${sourceId} conversation`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function maxCreatedAt(messages: readonly ConversationMessage[]): string | null {
  return messages.reduce<string | null>((latest, message) =>
    !latest || message.createdAt > latest ? message.createdAt : latest, null);
}

function normalizeScanInput(value: unknown): {
  sourceId: string;
  mode?: "initial_subset" | "incremental" | "full";
} {
  const input = record(value);
  const sourceId = typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : "all";
  const mode = input.mode === "initial_subset" || input.mode === "incremental" || input.mode === "full"
    ? input.mode
    : undefined;
  return { sourceId, ...(mode ? { mode } : {}) };
}

function emptyScanState(): AgentSourceScanState {
  return {
    running: false,
    jobId: null,
    sourceId: null,
    mode: null,
    progress: null,
    startedAt: null,
    completedAt: null,
    error: null
  };
}

function emptySourceState(): PersistedSourceState {
  return {
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null,
    latestSeenAt: null,
    importedRequestIds: []
  };
}

async function loadState(path: string): Promise<PersistedState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const value = record(parsed);
    return {
      version: 1,
      sources: record(value.sources) as Record<string, PersistedSourceState>
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, sources: {} };
    throw error;
  }
}

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function connectionStatus(sourceId: string): AgentConnectionStatus {
  return agentConnectionKind(sourceId) === "plugin" ? "plugin_installed" : "skill_installed";
}

function agentConnectionKind(sourceId: string): "plugin" | "skill" {
  return ["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"].includes(sourceId)
    ? "plugin"
    : "skill";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
