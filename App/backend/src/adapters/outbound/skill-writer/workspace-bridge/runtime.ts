import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import createIgnore from "ignore";
import YAML from "yaml";
import {
  PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  canonicalJson,
  isProjectEnvironmentDeterministicCandidate,
  isProjectEnvironmentSensitivePath,
  normalizeWorkspaceUri,
  renderL3WorldModelContext,
  sha256Hex,
  validateWorkspaceRelativePath,
  type InventoryEntry,
  type L3WorldModelRequestEnvelope,
  type ProjectEnvironmentSyncResponse,
  type ProjectWorkspaceEvidence,
  type ProjectWorkspaceOperation,
  type RuntimeProbe,
} from "@memmy/local-api-contracts";

const execFileAsync = promisify(execFile);
const DEFAULT_ENDPOINT = "http://127.0.0.1:18960";
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const FIXED_EXCLUDES = new Set([
  ".git", "node_modules", "vendor", ".venv", "venv", "env", "dist", "build",
  "out", "coverage", ".cache", ".next", ".nuxt", "target", "__pycache__",
  ".pytest_cache", ".mypy_cache",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".exe",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".o", ".obj", ".pdf", ".png", ".so", ".tar", ".tgz", ".wav", ".webm",
  ".webp", ".woff", ".woff2", ".xz", ".zip",
]);

const PROBES: Record<RuntimeProbe, { executable: string; args: string[]; pattern: RegExp }> = {
  node_version: { executable: "node", args: ["--version"], pattern: /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u },
  python_version: { executable: "python3", args: ["--version"], pattern: /^Python \d+\.\d+\.\d+(?:[\w.+-]*)$/u },
  go_version: { executable: "go", args: ["version"], pattern: /^go version go\d+\.\d+(?:\.\d+)?\b.*$/u },
  rust_version: { executable: "rustc", args: ["--version"], pattern: /^rustc \d+\.\d+\.\d+\b.*$/u },
  java_version: { executable: "java", args: ["-version"], pattern: /^(?:openjdk|java) version "[^"\r\n]+".*$/u },
};

export interface RuntimeConfig {
  endpoint: string;
  token: string;
  userId: string;
  workspaceHostId: string;
  workspaceBridgeEnabled: boolean;
}

export interface RuntimeSession {
  protocol: "legacy" | "v2";
  workspaceBridgeSupported: boolean;
  sessionId: string;
  projectId: string | null;
  sessionKey: string;
  source: string;
  adapterId: string;
  profileId: string;
  workspaceRoot: string | null;
  config: RuntimeConfig;
}

export interface OpenRuntimeSessionInput {
  configUrl: URL;
  source: string;
  sessionKey: string;
  workspaceRoot?: string | null;
  transition: "allow_legacy_rollover" | "resume_only";
  pinnedOwner?: boolean;
  adapterId?: string;
  profileId?: string;
}

export interface LoadedRuntimeSession extends RuntimeSession {
  additionalContext: string;
  renderedContext: string;
  memoryVersion: number | null;
}

export async function readRuntimeConfig(configUrl: URL, pinnedOwner = false): Promise<RuntimeConfig> {
  const snapshot = objectValue(await readJson(configUrl));
  const configPath = text(snapshot.memmy_config_path) || resolve(homedir(), ".memmy", "config.yaml");
  const yaml = objectValue(YAML.parse(await readFile(configPath, "utf8").catch(() => "{}")));
  const memory = objectValue(yaml.memmyMemory);
  const storage = objectValue(memory.storage);
  const legacyStorage = objectValue(yaml.storage);
  const app = objectValue(yaml.app);
  const workspaceBridge = objectValue(memory.workspaceBridge);
  const hasWorkspaceBridgeSetting = Object.prototype.hasOwnProperty.call(workspaceBridge, "enabled");
  return {
    endpoint: text(storage.endpoint) || text(memory.endpoint) || text(legacyStorage.endpoint) || text(snapshot.endpoint) || DEFAULT_ENDPOINT,
    token: text(storage.token) || text(memory.token) || text(legacyStorage.token) || text(snapshot.token),
    userId: pinnedOwner
      ? text(snapshot.userId) || "local-user"
      : text(app.userId) || text(memory.userId) || text(snapshot.userId) || "local-user",
    workspaceHostId: text(snapshot.workspaceHostId),
    workspaceBridgeEnabled: hasWorkspaceBridgeSetting
      ? workspaceBridge.enabled === true
      : true,
  };
}

export async function openRuntimeSession(input: OpenRuntimeSessionInput): Promise<RuntimeSession | null> {
  const config = await readRuntimeConfig(input.configUrl, input.pinnedOwner === true);
  const client = new RuntimeHttpClient(config);
  const health = await client.get("/api/v1/health").catch(() => null);
  if (!health && input.pinnedOwner === true) return null;
  const features = objectValue(objectValue(health).features);
  const supportsV2 = numberArray(features.l3WorldModelProtocolVersions).includes(2);
  const supportsWorkspaceBridge = stringArray(features.workspaceBridgeProtocolVersions).includes("1");
  const adapterId = input.adapterId || `memmy-${input.source}-adapter`;
  const profileId = input.profileId || "default";
  if (!supportsV2) {
    return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
  }
  const resolvedWorkspaceRoot = input.workspaceRoot ? await canonicalWorkspaceRoot(input.workspaceRoot) : null;
  const workspaceRoot = resolvedWorkspaceRoot && config.workspaceHostId ? resolvedWorkspaceRoot : null;
  const envelope = runtimeEnvelope(input.source, input.sessionKey, config.userId, null, adapterId, profileId);
  const workspaceUri = workspaceRoot ? normalizeWorkspaceUri(pathToFileURL(workspaceRoot).href) : null;
  let opened: Record<string, any>;
  try {
    opened = objectValue(await client.post("/api/v1/sessions/open", compact({
      ...envelope,
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: input.transition,
      workspaceUri: workspaceUri || undefined,
      workspaceHostId: workspaceUri ? config.workspaceHostId : undefined,
    })));
  } catch (error) {
    if (input.transition !== "resume_only" || !isV2ResumeConflict(error)) throw error;
    return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
  }
  const sessionId = text(opened.sessionId);
  if (!sessionId) return null;
  return {
    protocol: "v2",
    workspaceBridgeSupported: supportsWorkspaceBridge,
    sessionId,
    projectId: text(opened.projectId) || null,
    sessionKey: input.sessionKey,
    source: input.source,
    adapterId,
    profileId,
    workspaceRoot,
    config,
  };
}

async function openLegacyRuntimeSession(
  client: RuntimeHttpClient,
  config: RuntimeConfig,
  input: OpenRuntimeSessionInput,
  adapterId: string,
  profileId: string,
): Promise<RuntimeSession> {
  const externalSessionId = input.sessionKey;
  const opened = objectValue(await client.post("/api/v1/sessions/open", {
    sessionId: externalSessionId,
    source: input.source,
    profileId: profileId !== "default" ? profileId : undefined,
    workspacePath: input.workspaceRoot || undefined,
  }));
  return {
    protocol: "legacy",
    workspaceBridgeSupported: false,
    sessionId: text(opened.sessionId) || externalSessionId,
    projectId: null,
    sessionKey: input.sessionKey,
    source: input.source,
    adapterId,
    profileId,
    workspaceRoot: null,
    config,
  };
}

export async function loadRuntimeL3(session: RuntimeSession): Promise<LoadedRuntimeSession> {
  if (session.protocol !== "v2") return { ...session, additionalContext: "", renderedContext: "", memoryVersion: null };
  const client = new RuntimeHttpClient(session.config);
  const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
  const result = objectValue(await client.get(
    `/api/v1/l3-world-model/sessions/${encodeURIComponent(session.sessionId)}/context`,
    envelopeGetTransport(envelope),
  ));
  const renderedContext = text(result.renderedContext);
  return {
    ...session,
    additionalContext: renderedContext ? renderL3WorldModelContext(renderedContext) : "",
    renderedContext,
    memoryVersion: typeof result.memoryVersion === "number" ? result.memoryVersion : null,
  };
}

export async function notifyRuntimeBoundary(
  session: RuntimeSession,
  trigger: "token_compaction" | "token_compaction_attempt",
): Promise<boolean> {
  if (session.protocol !== "v2") return false;
  const client = new RuntimeHttpClient(session.config);
  const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
  const head = objectValue(await client.get(
    `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-trace-head`,
    envelopeGetTransport(envelope),
  ));
  const throughL1MemoryId = text(head.throughL1MemoryId);
  if (!throughL1MemoryId) return false;
  await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-boundary`, {
    ...envelope,
    trigger,
    throughL1MemoryId,
  });
  return true;
}

export async function closeRuntimeSession(session: RuntimeSession): Promise<void> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId)
    : { source: session.source };
  await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, body);
}

export async function startRuntimeTurn(
  session: RuntimeSession,
  turnId: string,
  query: string,
): Promise<Record<string, unknown>> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? { ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId), sessionId: session.sessionId, turnId, query }
    : { source: session.source, adapterId: session.adapterId, requestId: `${session.source}-start:${turnId}`, sessionId: session.sessionId, turnId, query };
  return objectValue(await client.post("/api/v1/turns/start", body));
}

export async function completeRuntimeTurn(
  session: RuntimeSession,
  input: {
    turnId: string;
    episodeId?: string;
    query: string;
    answer: string;
    status: "succeeded" | "failed";
    sourceMemoryIds?: string[];
    reasoningSummary?: string;
    toolCalls?: unknown[];
    toolResults?: unknown[];
  },
): Promise<void> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? {
        ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId),
        sessionId: session.sessionId,
        episodeId: input.episodeId,
        query: input.query,
        answer: input.answer,
        status: input.status,
        sourceMemoryIds: input.sourceMemoryIds,
        reasoningSummary: input.reasoningSummary,
        toolCalls: input.toolCalls,
        toolResults: input.toolResults,
      }
    : {
        source: session.source,
        adapterId: session.adapterId,
        requestId: `${session.source}-complete:${input.turnId}:${hashText([input.status, input.query, input.answer].join("\u0000"))}`,
        sessionId: session.sessionId,
        ...input,
      };
  await client.post(`/api/v1/turns/${encodeURIComponent(input.turnId)}/complete`, compact(body));
}

export async function syncRuntimeEnvironment(
  session: RuntimeSession,
  trigger: "session_start" | "token_compaction",
): Promise<ProjectEnvironmentSyncResponse | null> {
  if (
    session.protocol !== "v2" || !session.workspaceBridgeSupported || !session.projectId || !session.workspaceRoot ||
    !session.config.workspaceBridgeEnabled
  ) return null;
  const client = new RuntimeHttpClient(session.config);
  const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
  let response = objectValue(await client.post(
    `/api/v1/l3-world-model/projects/${encodeURIComponent(session.projectId)}/environment-sync/start`,
    {
      ...envelope,
      sessionId: session.sessionId,
      trigger,
      capabilities: {
        protocolVersion: "1",
        operations: ["inventory", "read_text", "runtime_probe"],
        maxTextBytes: MAX_TEXT_BYTES,
      },
    },
  )) as unknown as ProjectEnvironmentSyncResponse;
  const bridge = new RuntimeWorkspaceBridge(session.workspaceRoot);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (response.status === "clean" || response.status === "failed" || response.operations.length === 0) return response;
    for (const operation of response.operations) {
      for (const evidence of await bridge.execute(operation)) {
        response = objectValue(await client.post(
          `/api/v1/l3-world-model/projects/${encodeURIComponent(session.projectId)}/environment-sync/${encodeURIComponent(response.syncId)}/evidence`,
          { ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId), sessionId: session.sessionId, evidence },
        )) as unknown as ProjectEnvironmentSyncResponse;
      }
    }
    response = objectValue(await client.get(
      `/api/v1/l3-world-model/projects/${encodeURIComponent(session.projectId)}/environment-sync/${encodeURIComponent(response.syncId)}`,
      envelopeGetTransport(runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId), session.sessionId),
    )) as unknown as ProjectEnvironmentSyncResponse;
  }
  return response;
}

/** Runs a short-hook workspace sync after the host process has returned. */
export function syncRuntimeEnvironmentDetached(
  session: RuntimeSession,
  trigger: "session_start" | "token_compaction",
): boolean {
  if (
    session.protocol !== "v2" || !session.workspaceBridgeSupported || !session.projectId ||
    !session.workspaceRoot || !session.config.workspaceBridgeEnabled
  ) return false;
  const script = [
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "const payload = JSON.parse(input);",
    "const runtime = await import(payload.assetUrl);",
    "await runtime.syncRuntimeEnvironment(payload.session, payload.trigger);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.once("error", () => undefined);
  child.stdin?.once("error", () => undefined);
  child.stdin?.end(JSON.stringify({ assetUrl: import.meta.url, session, trigger }));
  child.unref();
  return true;
}

export class RuntimeWorkspaceBridge {
  constructor(private readonly root: string) {}

  async execute(operation: ProjectWorkspaceOperation): Promise<ProjectWorkspaceEvidence[]> {
    if (operation.kind === "inventory") return this.inventory(operation);
    if (operation.kind === "read_text") return [await this.readText(operation)];
    return [await this.runtimeProbe(operation)];
  }

  private async inventory(
    operation: Extract<ProjectWorkspaceOperation, { kind: "inventory" }>,
  ): Promise<ProjectWorkspaceEvidence[]> {
    if (canonicalJson(operation.policy) !== canonicalJson(PROJECT_ENVIRONMENT_SCAN_POLICY_V1)) {
      return [unsupported(operation, "unsupported_operation")];
    }
    let first = await this.scan(operation);
    const second = await this.scan(operation);
    if (canonicalJson(first) !== canonicalJson(second)) {
      first = await this.scan(operation);
      if (canonicalJson(first) !== canonicalJson(await this.scan(operation))) {
        return [unsupported(operation, "unstable_workspace")];
      }
    }
    const pages = chunkEntries(first.entries, operation.policy.maxPageEntries);
    return pages.map((entries, pageIndex) => {
      const isLast = pageIndex === pages.length - 1;
      return {
        operationId: operation.operationId,
        kind: "inventory" as const,
        status: "accepted" as const,
        pageIndex,
        isLast,
        ...(isLast && first.omittedCount ? { omittedCount: first.omittedCount } : {}),
        pageHash: sha256Hex(canonicalJson({
          operationId: operation.operationId,
          pageIndex,
          isLast,
          omittedCount: isLast && first.omittedCount ? first.omittedCount : null,
          entries,
        })),
        entries,
      };
    });
  }

  private async scan(
    operation: Extract<ProjectWorkspaceOperation, { kind: "inventory" }>,
  ): Promise<{ entries: InventoryEntry[]; omittedCount: number }> {
    const rules = createIgnore();
    rules.add(await readFile(resolve(this.root, ".gitignore"), "utf8").catch(() => ""));
    const entries: InventoryEntry[] = [];
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > operation.policy.maxDepth) return;
      const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
      children.sort((left, right) => compare(left.name, right.name));
      for (const child of children) {
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
        if (
          Buffer.byteLength(relativePath, "utf8") > operation.policy.maxRelativePathUtf8Bytes ||
          validateWorkspaceRelativePath(relativePath) || FIXED_EXCLUDES.has(child.name) ||
          rules.ignores(relativePath) || (child.isDirectory() && rules.ignores(`${relativePath}/`)) ||
          isProjectEnvironmentSensitivePath(relativePath)
        ) continue;
        if (child.isSymbolicLink()) continue;
        const absolute = resolve(directory, child.name);
        const details = await stat(absolute).catch(() => null);
        if (!details) continue;
        if (child.isDirectory()) {
          entries.push({ relativePath, type: "directory", mtimeMs: floorTime(details.mtimeMs) });
          await walk(absolute, relativePath, depth + 1);
        } else if (child.isFile() && !isBinaryPath(relativePath)) {
          const entry: Extract<InventoryEntry, { type: "file" }> = {
            relativePath,
            type: "file",
            size: details.size,
            mtimeMs: floorTime(details.mtimeMs),
          };
          if (isProjectEnvironmentDeterministicCandidate(relativePath) && details.size <= MAX_TEXT_BYTES) {
            const sha256 = await this.hashStableCandidate(absolute, entry);
            if (sha256) entry.sha256 = sha256;
          }
          entries.push(entry);
        }
      }
    };
    await walk(this.root, "", 0);
    if (await rootHasGitEntry(this.root)) {
      entries.push({ relativePath: ".git", type: "directory", mtimeMs: 0 });
    }
    entries.sort((left, right) => compare(left.relativePath, right.relativePath));
    const omittedCount = Math.max(0, entries.length - operation.policy.maxEntries);
    return { entries: entries.slice(0, operation.policy.maxEntries), omittedCount };
  }

  private async hashStableCandidate(
    absolute: string,
    observed: Extract<InventoryEntry, { type: "file" }>,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await lstat(absolute).catch(() => null);
      if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_TEXT_BYTES) return null;
      const content = await readFile(absolute).catch(() => null);
      if (!content) return null;
      const after = await lstat(absolute).catch(() => null);
      if (after && sameFileObservation(before, after) &&
          (attempt > 0 || sameInventoryObservation(observed, before))) {
        return createHash("sha256").update(content).digest("hex");
      }
    }
    return null;
  }

  private async readText(
    operation: Extract<ProjectWorkspaceOperation, { kind: "read_text" }>,
  ): Promise<ProjectWorkspaceEvidence> {
    if (!isProjectEnvironmentDeterministicCandidate(operation.relativePath)) {
      return unsupported(operation, "unsafe_path");
    }
    const absolute = await safePath(this.root, operation.relativePath);
    if (!absolute) return unsupported(operation, "unsafe_path");
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size > Math.min(operation.maxBytes, MAX_TEXT_BYTES)) {
      return unsupported(operation, "too_large");
    }
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!sameFileObservation(before, after) || sha256 !== operation.expectedSha256) {
      return { operationId: operation.operationId, kind: "read_text", status: "stale", relativePath: operation.relativePath, actualSha256: sha256 };
    }
    let textValue: string;
    try {
      textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return unsupported(operation, "unsupported_operation");
    }
    const accepted: ProjectWorkspaceEvidence = {
      operationId: operation.operationId,
      kind: "read_text",
      status: "accepted",
      relativePath: operation.relativePath,
      sha256,
      text: textValue,
    };
    if (Buffer.byteLength(JSON.stringify({ evidence: accepted }), "utf8") >= JSON_BODY_LIMIT) {
      return unsupported(operation, "body_limit");
    }
    return accepted;
  }

  private async runtimeProbe(
    operation: Extract<ProjectWorkspaceOperation, { kind: "runtime_probe" }>,
  ): Promise<ProjectWorkspaceEvidence> {
    const spec = PROBES[operation.probe];
    try {
      const resolvedExecutable = await findExecutable(spec.executable);
      if (!resolvedExecutable) return unsupported(operation, "unavailable_runtime");
      const executable = await realpath(resolvedExecutable);
      if (inside(this.root, executable)) return unsupported(operation, "unsafe_probe");
      const result = await execFileAsync(executable, spec.args, {
        cwd: tmpdir(), env: probeEnvironment(), timeout: 2_000, maxBuffer: 4_096, shell: false, windowsHide: true,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(0, 256);
      return { operationId: operation.operationId, kind: "runtime_probe", status: "accepted", probe: operation.probe, exitCode: 0, versionText: spec.pattern.test(output) ? output : null };
    } catch (error) {
      const code = objectValue(error).code;
      if (code === "ENOENT" || code === "EACCES") return unsupported(operation, "unavailable_runtime");
      return { operationId: operation.operationId, kind: "runtime_probe", status: "accepted", probe: operation.probe, exitCode: typeof code === "number" ? code : 1, versionText: null };
    }
  }
}

class RuntimeHttpClient {
  constructor(private readonly config: RuntimeConfig) {}

  async get(path: string, transport: { query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<unknown> {
    const url = new URL(path, this.config.endpoint.replace(/\/+$/u, "") + "/");
    for (const [key, value] of Object.entries(transport.query || {})) url.searchParams.set(key, value);
    return this.request(url, { method: "GET", headers: transport.headers });
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, this.config.endpoint.replace(/\/+$/u, "") + "/");
    return this.request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(45_000) });
    const textValue = await response.text();
    const parsed = textValue.trim() ? JSON.parse(textValue) : null;
    if (!response.ok) {
      const body = objectValue(parsed);
      const nested = objectValue(body.error);
      throw new RuntimeHttpError(
        response.status,
        text(body.code) || text(nested.code),
        text(body.message) || text(nested.message) || `Memory request failed: ${response.status}`,
      );
    }
    return parsed;
  }
}

class RuntimeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeHttpError";
  }
}

function isV2ResumeConflict(error: unknown): boolean {
  return error instanceof RuntimeHttpError && error.status === 409 &&
    (error.code === "l3_world_model_v2_session_not_open" || error.message === "l3_world_model_v2_session_not_open");
}

function runtimeEnvelope(
  source: string,
  sessionKey: string,
  userId: string,
  projectId: string | null,
  adapterId: string,
  profileId: string,
): L3WorldModelRequestEnvelope {
  return {
    requestId: randomUUID(),
    adapterId,
    source,
    namespace: compact({ source, profileId, userId, sessionKey, projectId: projectId || undefined }),
  };
}

function envelopeGetTransport(envelope: L3WorldModelRequestEnvelope, sessionId?: string): { query: Record<string, string>; headers: Record<string, string> } {
  const query = { adapterId: envelope.adapterId, source: envelope.namespace.source, ...(sessionId ? { sessionId } : {}) };
  const headers: Record<string, string> = { "x-request-id": envelope.requestId };
  const pairs: Array<[string, string | undefined]> = [
    ["x-memmy-user-id", envelope.namespace.userId], ["x-memmy-project-id", envelope.namespace.projectId],
    ["x-memmy-profile-id", envelope.namespace.profileId], ["x-memmy-session-key", envelope.namespace.sessionKey],
  ];
  for (const [key, value] of pairs) if (value) headers[key] = value;
  return { query, headers };
}

async function canonicalWorkspaceRoot(value: string): Promise<string | null> {
  if (!value || !isAbsolute(value)) return null;
  const canonical = await realpath(value).catch(() => "");
  if (!canonical) return null;
  const details = await stat(canonical).catch(() => null);
  if (!details?.isDirectory() || canonical === parse(canonical).root || canonical === await realpath(homedir())) return null;
  return canonical;
}

async function safePath(root: string, relativePath: string): Promise<string | null> {
  if (validateWorkspaceRelativePath(relativePath)) return null;
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!inside(root, candidate)) return null;
  const observed = await lstat(candidate).catch(() => null);
  if (!observed || observed.isSymbolicLink()) return null;
  const canonical = await realpath(candidate).catch(() => "");
  return canonical && inside(root, canonical) ? canonical : null;
}

function unsupported(
  operation: ProjectWorkspaceOperation,
  reason: Extract<ProjectWorkspaceEvidence, { status: "unsupported" }>["reason"],
): Extract<ProjectWorkspaceEvidence, { status: "unsupported" }> {
  return { operationId: operation.operationId, kind: operation.kind, status: "unsupported", reason };
}

function chunkEntries(entries: InventoryEntry[], maxEntries: number): InventoryEntry[][] {
  if (!entries.length) return [[]];
  const pages: InventoryEntry[][] = [];
  let current: InventoryEntry[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (current.length && (
      candidate.length > maxEntries ||
      Buffer.byteLength(JSON.stringify({ evidence: { entries: candidate } }), "utf8") >= JSON_BODY_LIMIT
    )) {
      pages.push(current);
      current = [entry];
    } else current = candidate;
  }
  pages.push(current);
  return pages;
}

function sameInventoryObservation(
  entry: Extract<InventoryEntry, { type: "file" }>,
  details: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return entry.size === details.size && entry.mtimeMs === floorTime(details.mtimeMs);
}

function sameFileObservation(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.isFile() && right.isFile() && left.size === right.size &&
    floorTime(left.mtimeMs) === floorTime(right.mtimeMs);
}

async function rootHasGitEntry(root: string): Promise<boolean> {
  const details = await lstat(resolve(root, ".git")).catch(() => null);
  return Boolean(details && (details.isDirectory() || details.isFile()));
}

function isBinaryPath(value: string): boolean {
  const name = value.split("/").at(-1) || value;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(extension);
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function probeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}

async function findExecutable(name: string): Promise<string | null> {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${name}${extension}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")) as T;
}

function objectValue(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function floorTime(value: number | bigint): number {
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  return Math.max(0, Math.floor(Number.isFinite(numericValue) ? numericValue : 0));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readJson(url: URL): Promise<unknown> {
  const content = await readFile(url, "utf8").catch(() => "{}");
  try { return JSON.parse(content); } catch { return {}; }
}
