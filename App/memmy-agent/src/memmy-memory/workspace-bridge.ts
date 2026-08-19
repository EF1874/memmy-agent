import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import fg from "fast-glob";
import createIgnore from "ignore";
import which from "which";
import {
  PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  ProjectWorkspaceOperationSchema,
  canonicalJson,
  deriveWorkspaceHostId,
  isProjectEnvironmentDeterministicCandidate,
  isProjectEnvironmentSensitivePath,
  sha256Hex,
  validateWorkspaceRelativePath,
  type InventoryEntry,
  type ProjectEnvironmentSyncResponse,
  type ProjectWorkspaceEvidence,
  type ProjectWorkspaceOperation,
  type RuntimeProbe,
  type WorkspaceHostId,
  type WorkspaceUri
} from "@memmy/local-api-contracts";
import type { MemmyMemoryClient } from "./client.js";
import type { L3WorldModelRequestEnvelope } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_READ_TEXT_BYTES = 1024 * 1024;

const FIXED_EXCLUDES = [
  ".git", ".git/**", "node_modules/**", "vendor/**", ".venv/**", "venv/**", "env/**",
  "dist/**", "build/**", "out/**", "coverage/**", ".cache/**", ".next/**",
  ".nuxt/**", "target/**", "__pycache__/**", ".pytest_cache/**", ".mypy_cache/**"
];

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".exe",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".o", ".obj", ".pdf", ".png", ".so", ".tar", ".tgz", ".wav", ".webm",
  ".webp", ".woff", ".woff2", ".xz", ".zip"
]);

const PROBE_SPEC: Record<RuntimeProbe, {
  executable: string;
  args: string[];
  pattern: RegExp;
}> = {
  node_version: { executable: "node", args: ["--version"], pattern: /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u },
  python_version: { executable: "python3", args: ["--version"], pattern: /^Python \d+\.\d+\.\d+(?:[\w.+-]*)$/u },
  go_version: { executable: "go", args: ["version"], pattern: /^go version go\d+\.\d+(?:\.\d+)?\b.*$/u },
  rust_version: { executable: "rustc", args: ["--version"], pattern: /^rustc \d+\.\d+\.\d+\b.*$/u },
  java_version: { executable: "java", args: ["-version"], pattern: /^(?:openjdk|java) version "[^"\r\n]+".*$/u }
};

export interface WorkspaceBridgeDriverInput {
  client: MemmyMemoryClient;
  projectId: string;
  sessionId: string;
  trigger: "session_start" | "token_compaction";
  envelope: L3WorldModelRequestEnvelope;
  root: string;
}

export class MemmyWorkspaceBridge {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<MemmyWorkspaceBridge | null> {
    const normalized = await normalizeWorkspaceRoot(root);
    return normalized ? new MemmyWorkspaceBridge(normalized) : null;
  }

  async execute(operationInput: ProjectWorkspaceOperation): Promise<ProjectWorkspaceEvidence[]> {
    const operation = ProjectWorkspaceOperationSchema.parse(operationInput);
    switch (operation.kind) {
      case "inventory":
        return this.inventory(operation);
      case "read_text":
        return [await this.readText(operation)];
      case "runtime_probe":
        return [await this.runtimeProbe(operation)];
    }
  }

  private async inventory(
    operation: Extract<ProjectWorkspaceOperation, { kind: "inventory" }>
  ): Promise<ProjectWorkspaceEvidence[]> {
    if (canonicalJson(operation.policy) !== canonicalJson(PROJECT_ENVIRONMENT_SCAN_POLICY_V1)) {
      return [unsupported(operation, "unsupported_operation")];
    }
    let first = await this.scanOnce(operation);
    const second = await this.scanOnce(operation);
    if (inventorySnapshot(first) !== inventorySnapshot(second)) {
      first = await this.scanOnce(operation);
      const retry = await this.scanOnce(operation);
      if (inventorySnapshot(first) !== inventorySnapshot(retry)) {
        return [unsupported(operation, "unstable_workspace")];
      }
      first = retry;
    }
    const pages: ProjectWorkspaceEvidence[] = [];
    const chunks = chunkInventory(first.entries, operation.policy.maxPageEntries);
    for (const [pageIndex, entries] of chunks.entries()) {
      const isLast = pageIndex === chunks.length - 1;
      const hashInput = {
        operationId: operation.operationId,
        pageIndex,
        isLast,
        omittedCount: isLast && first.omittedCount > 0 ? first.omittedCount : null,
        entries
      };
      pages.push({
        operationId: operation.operationId,
        kind: "inventory",
        status: "accepted",
        pageIndex,
        isLast,
        ...(isLast && first.omittedCount > 0 ? { omittedCount: first.omittedCount } : {}),
        pageHash: sha256Hex(canonicalJson(hashInput)),
        entries
      });
    }
    return pages;
  }

  private async scanOnce(
    operation: Extract<ProjectWorkspaceOperation, { kind: "inventory" }>
  ): Promise<{ entries: InventoryEntry[]; omittedCount: number }> {
    const gitignore = createIgnore();
    try {
      gitignore.add(await readFile(resolve(this.root, ".gitignore"), "utf8"));
    } catch {
      // A missing or unreadable .gitignore simply contributes no project rules.
    }
    const scanned = await fg("**/*", {
      cwd: this.root,
      dot: true,
      onlyFiles: false,
      markDirectories: false,
      stats: true,
      followSymbolicLinks: false,
      deep: operation.policy.maxDepth,
      ignore: FIXED_EXCLUDES,
      suppressErrors: true
    });
    const collected: InventoryEntry[] = [];
    for (const entry of scanned) {
      const path = normalizeRelativePath(entry.path);
      if (
        !path || validateWorkspaceRelativePath(path) || gitignore.ignores(path) ||
        (entry.dirent.isDirectory() && gitignore.ignores(`${path}/`)) || excludedByType(path)
      ) continue;
      if (entry.dirent.isSymbolicLink()) continue;
      const stat = entry.stats;
      if (!stat || (!stat.isDirectory() && !stat.isFile())) continue;
      if (stat.isDirectory()) {
        collected.push({ relativePath: path, type: "directory", mtimeMs: floorTime(stat.mtimeMs) });
      } else {
        const base: Extract<InventoryEntry, { type: "file" }> = {
          relativePath: path,
          type: "file",
          size: stat.size,
          mtimeMs: floorTime(stat.mtimeMs)
        };
        if (isProjectEnvironmentDeterministicCandidate(path)) {
          const hash = await this.hashStableCandidate(path, base);
          if (hash) base.sha256 = hash;
        }
        collected.push(base);
      }
    }
    if (await rootHasGitEntry(this.root)) {
      collected.push({ relativePath: ".git", type: "directory", mtimeMs: 0 });
    }
    collected.sort((left, right) => compare(left.relativePath, right.relativePath));
    const omittedCount = Math.max(0, collected.length - operation.policy.maxEntries);
    return { entries: collected.slice(0, operation.policy.maxEntries), omittedCount };
  }

  private async hashStableCandidate(
    relativePath: string,
    observed: Extract<InventoryEntry, { type: "file" }>
  ): Promise<string | null> {
    const absolute = await this.safeExistingPath(relativePath);
    if (!absolute) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await lstat(absolute);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_READ_TEXT_BYTES) return null;
      const content = await readFile(absolute);
      const after = await lstat(absolute);
      if (sameFileObservation(before, after) && (attempt > 0 || sameInventoryObservation(observed, before))) {
        return createHash("sha256").update(content).digest("hex");
      }
    }
    return null;
  }

  private async readText(
    operation: Extract<ProjectWorkspaceOperation, { kind: "read_text" }>
  ): Promise<ProjectWorkspaceEvidence> {
    if (!isProjectEnvironmentDeterministicCandidate(operation.relativePath)) {
      return unsupported(operation, isProjectEnvironmentSensitivePath(operation.relativePath) ? "permission_denied" : "unsafe_path");
    }
    const absolute = await this.safeExistingPath(operation.relativePath);
    if (!absolute) return unsupported(operation, "unsafe_path");
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) return unsupported(operation, "unsafe_path");
    if (before.size > Math.min(operation.maxBytes, MAX_READ_TEXT_BYTES)) return unsupported(operation, "too_large");
    const content = await readFile(absolute);
    const after = await lstat(absolute);
    if (!sameFileObservation(before, after)) {
      return {
        operationId: operation.operationId,
        kind: "read_text",
        status: "stale",
        relativePath: operation.relativePath,
        actualSha256: createHash("sha256").update(content).digest("hex")
      };
    }
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (actualSha256 !== operation.expectedSha256) {
      return {
        operationId: operation.operationId,
        kind: "read_text",
        status: "stale",
        relativePath: operation.relativePath,
        actualSha256
      };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return unsupported(operation, "unsupported_operation");
    }
    const evidence: ProjectWorkspaceEvidence = {
      operationId: operation.operationId,
      kind: "read_text",
      status: "accepted",
      relativePath: operation.relativePath,
      sha256: actualSha256,
      text
    };
    if (Buffer.byteLength(JSON.stringify({ evidence }), "utf8") >= MAX_JSON_BODY_BYTES) {
      return unsupported(operation, "body_limit");
    }
    return evidence;
  }

  private async runtimeProbe(
    operation: Extract<ProjectWorkspaceOperation, { kind: "runtime_probe" }>
  ): Promise<ProjectWorkspaceEvidence> {
    const spec = PROBE_SPEC[operation.probe];
    try {
      const executable = await which(spec.executable);
      const canonical = await realpath(executable);
      if (isInside(this.root, canonical)) return unsupported(operation, "unsafe_probe");
      const stat = await lstat(canonical);
      if (!stat.isFile()) return unsupported(operation, "unsafe_probe");
      const environment = minimalProbeEnvironment();
      const result = await execFileAsync(canonical, spec.args, {
        cwd: tmpdir(),
        env: environment,
        timeout: 2_000,
        maxBuffer: 4_096,
        windowsHide: true,
        shell: false
      });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 256);
      return {
        operationId: operation.operationId,
        kind: "runtime_probe",
        status: "accepted",
        probe: operation.probe,
        exitCode: 0,
        versionText: spec.pattern.test(combined) ? combined : null
      };
    } catch (error) {
      const exitCode = isRecord(error) && typeof error.code === "number" ? error.code : 1;
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
        return unsupported(operation, "unavailable_runtime");
      }
      return {
        operationId: operation.operationId,
        kind: "runtime_probe",
        status: "accepted",
        probe: operation.probe,
        exitCode,
        versionText: null
      };
    }
  }

  private async safeExistingPath(relativePath: string): Promise<string | null> {
    if (validateWorkspaceRelativePath(relativePath)) return null;
    const candidate = resolve(this.root, ...relativePath.split("/"));
    if (!isInside(this.root, candidate)) return null;
    try {
      const observed = await lstat(candidate);
      if (observed.isSymbolicLink()) return null;
      const canonical = await realpath(candidate);
      return isInside(this.root, canonical) ? canonical : null;
    } catch {
      return null;
    }
  }
}

export async function driveWorkspaceBridge(input: WorkspaceBridgeDriverInput): Promise<ProjectEnvironmentSyncResponse> {
  const bridge = await MemmyWorkspaceBridge.create(input.root);
  if (!bridge) throw new Error("workspace_bridge_root_unavailable");
  let response = await input.client.projectEnvironmentSyncStart(input.projectId, {
    ...input.envelope,
    sessionId: input.sessionId,
    trigger: input.trigger,
    capabilities: {
      protocolVersion: "1",
      operations: ["inventory", "read_text", "runtime_probe"],
      maxTextBytes: MAX_READ_TEXT_BYTES
    }
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (response.status === "clean" || response.status === "failed" || response.operations.length === 0) return response;
    for (const operation of response.operations) {
      const evidence = await bridge.execute(operation);
      for (const item of evidence) {
        response = await input.client.projectEnvironmentSyncEvidence(input.projectId, response.syncId, {
          ...input.envelope,
          requestId: randomUUID(),
          sessionId: input.sessionId,
          evidence: item
        });
      }
    }
    response = await input.client.projectEnvironmentSyncStatus(
      input.projectId,
      response.syncId,
      input.sessionId,
      { ...input.envelope, requestId: randomUUID() }
    );
  }
  return response;
}

export async function normalizeWorkspaceRoot(value: string): Promise<string | null> {
  if (!value || !isAbsolute(value)) return null;
  try {
    const canonical = await realpath(value);
    const stat = await lstat(canonical);
    if (!stat.isDirectory()) return null;
    const parsed = parse(canonical);
    if (canonical === parsed.root || canonical === await realpath(homedir())) return null;
    return canonical;
  } catch {
    return null;
  }
}

export function workspaceUriFromRoot(root: string): WorkspaceUri {
  return pathToFileURL(root).href as WorkspaceUri;
}

export function workspaceHostIdFromInstallationId(installationId: string): WorkspaceHostId {
  return deriveWorkspaceHostId(installationId);
}

function unsupported(
  operation: ProjectWorkspaceOperation,
  reason: Extract<ProjectWorkspaceEvidence, { status: "unsupported" }>["reason"]
): Extract<ProjectWorkspaceEvidence, { status: "unsupported" }> {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    status: "unsupported",
    reason
  };
}

function chunkInventory(entries: InventoryEntry[], maxEntries: number): InventoryEntry[][] {
  if (entries.length === 0) return [[]];
  const chunks: InventoryEntry[][] = [];
  let current: InventoryEntry[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (current.length > 0 && (
      candidate.length > maxEntries ||
      Buffer.byteLength(JSON.stringify({ evidence: { entries: candidate } }), "utf8") >= MAX_JSON_BODY_BYTES
    )) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  chunks.push(current);
  return chunks;
}

function inventorySnapshot(value: { entries: InventoryEntry[]; omittedCount: number }): string {
  return canonicalJson({
    entries: value.entries.map((entry) => ({
      relativePath: entry.relativePath,
      type: entry.type,
      ...(entry.type === "file" ? { size: entry.size } : {}),
      mtimeMs: entry.mtimeMs,
      ...(entry.type === "file" && entry.sha256 ? { sha256: entry.sha256 } : {})
    })),
    omittedCount: value.omittedCount
  });
}

function excludedByType(relativePath: string): boolean {
  if (isProjectEnvironmentSensitivePath(relativePath)) return true;
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(extension);
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//u, "");
}

function floorTime(value: number | bigint): number {
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  return Math.max(0, Math.floor(Number.isFinite(numericValue) ? numericValue : 0));
}

function sameInventoryObservation(entry: Extract<InventoryEntry, { type: "file" }>, stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return entry.size === stat.size && entry.mtimeMs === floorTime(stat.mtimeMs);
}

function sameFileObservation(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return left.isFile() && right.isFile() && left.size === right.size &&
    floorTime(left.mtimeMs) === floorTime(right.mtimeMs);
}

async function rootHasGitEntry(root: string): Promise<boolean> {
  try {
    const stat = await lstat(resolve(root, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function minimalProbeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
