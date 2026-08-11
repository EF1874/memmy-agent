import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readGoalState } from "./goal-state.js";
import { readWebuiSessionBinding, type Session } from "./manager.js";

export const GOAL_WORKSPACE_BASELINE_KEY = "goalWorkspaceBaselineV1";

export type WorkspaceEnvironmentFile = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  additions: number | null;
  deletions: number | null;
  attribution: "goal" | "preexisting" | "uncertain" | "unattributed";
};

export type WorkspaceEnvironmentSnapshot = {
  session_key: string;
  cwd: string;
  status: "ready" | "not_git" | "workspace_unavailable" | "error";
  revision: string;
  captured_at: string;
  repository: null | {
    display_name: string;
    root: string;
    head_sha: string;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number;
    behind: number;
    worktree: "clean" | "dirty";
  };
  changes: null | {
    file_count: number;
    additions: number | null;
    deletions: number | null;
    conflicts: number;
    staged: number;
    unstaged: number;
    untracked: number;
  };
  goal: null | {
    goal_id: string;
    base_head: string | null;
    base_branch: string | null;
    goal_files: number;
    preexisting_files: number;
    uncertain_files: number;
    verification: "not_run" | "running" | "passed" | "failed" | "stale";
    completion_audit: "pending" | "risk" | "satisfied";
    baseline_status: "captured" | "unavailable";
  };
};

type GitStatusEntry = Omit<WorkspaceEnvironmentFile, "attribution">;
type WorkspaceEnvironmentContext = Pick<Session, "key" | "metadata">;

type GitState = {
  root: string;
  head: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusEntry[];
};

type GoalWorkspaceBaseline = {
  version: 1;
  goalId: string;
  capturedAt: string;
  status: "captured" | "unavailable";
  head: string | null;
  branch: string | null;
  files: Record<string, string | null>;
};

type GitCommandResult = { ok: true; stdout: string } | { ok: false; stderr: string };

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DIFF_OUTPUT_LIMIT = 512 * 1024;

function runGit(cwd: string, args: string[], maxBuffer = GIT_OUTPUT_LIMIT): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stderr: String(result.stderr || result.error?.message || "git command failed").trim(),
    };
  }
  return { ok: true, stdout: String(result.stdout ?? "") };
}

function parseBranchHeader(record: string, state: Pick<GitState, "head" | "branch" | "upstream" | "ahead" | "behind">): void {
  if (record.startsWith("# branch.oid ")) state.head = record.slice(13).trim();
  else if (record.startsWith("# branch.head ")) {
    const branch = record.slice(14).trim();
    state.branch = branch === "(detached)" ? null : branch;
  } else if (record.startsWith("# branch.upstream ")) state.upstream = record.slice(18).trim() || null;
  else if (record.startsWith("# branch.ab ")) {
    const match = record.match(/\+(\d+)\s+-(\d+)/);
    if (match) {
      state.ahead = Number(match[1]);
      state.behind = Number(match[2]);
    }
  }
}

function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    stats.set(filePath, {
      additions: /^\d+$/.test(additionsRaw) ? Number(additionsRaw) : null,
      deletions: /^\d+$/.test(deletionsRaw) ? Number(deletionsRaw) : null,
    });
  }
  return stats;
}

function parseStatus(cwd: string, raw: string): GitState {
  const state: GitState = {
    root: cwd,
    head: "",
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      parseBranchHeader(record, state);
      continue;
    }
    const kind = record[0];
    if (kind === "!" || kind === "#") continue;
    let xy = "??";
    let filePath = "";
    if (kind === "?" ) {
      filePath = record.slice(2);
    } else {
      const fields = record.split(" ");
      xy = fields[1] ?? "??";
      const fixedFields = kind === "1" ? 8 : kind === "2" ? 9 : 10;
      filePath = fields.slice(fixedFields).join(" ");
      if (kind === "2") index += 1;
    }
    if (!filePath) continue;
    const untracked = kind === "?";
    const conflict = kind === "u" || xy.includes("U") || xy === "AA" || xy === "DD";
    state.files.push({
      path: filePath,
      status: untracked ? "??" : xy,
      staged: !untracked && xy[0] !== ".",
      unstaged: !untracked && xy[1] !== ".",
      untracked,
      conflict,
      additions: null,
      deletions: null,
    });
  }
  return state;
}

function readGitState(cwd: string): { status: "ready"; state: GitState } | { status: "not_git" | "error" } {
  const rootResult = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    return { status: /not a git repository/i.test(rootResult.stderr) ? "not_git" : "error" };
  }
  const root = path.resolve(rootResult.stdout.trim());
  const statusResult = runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) return { status: "error" };
  const state = parseStatus(root, statusResult.stdout);
  state.root = root;
  const numstatResult = runGit(root, ["diff", "HEAD", "--numstat", "-z", "--no-renames"]);
  if (numstatResult.ok) {
    const stats = parseNumstat(numstatResult.stdout);
    state.files = state.files.map((file) => ({ ...file, ...(stats.get(file.path) ?? {}) }));
  }
  return { status: "ready", state };
}

function fileFingerprint(root: string, relativePath: string): string | null {
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
  } catch {
    return null;
  }
}

function fileSignature(root: string, file: GitStatusEntry): string {
  const fingerprint = fileFingerprint(root, file.path);
  return `${file.status}:${fingerprint ?? "unavailable"}`;
}

function readBaseline(session: WorkspaceEnvironmentContext, goalId: string): GoalWorkspaceBaseline | null {
  const raw = session.metadata?.[GOAL_WORKSPACE_BASELINE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const baseline = raw as Partial<GoalWorkspaceBaseline>;
  if (baseline.version !== 1 || baseline.goalId !== goalId || !baseline.files || typeof baseline.files !== "object") return null;
  return baseline as GoalWorkspaceBaseline;
}

export function captureGoalWorkspaceBaseline(session: Session, goalId: string): void {
  let cwd: string;
  try {
    cwd = readWebuiSessionBinding(session).cwd;
  } catch {
    return;
  }
  const result = readGitState(cwd);
  const capturedAt = new Date().toISOString();
  if (result.status !== "ready") {
    session.metadata[GOAL_WORKSPACE_BASELINE_KEY] = {
      version: 1,
      goalId,
      capturedAt,
      status: "unavailable",
      head: null,
      branch: null,
      files: {},
    } satisfies GoalWorkspaceBaseline;
    return;
  }
  session.metadata[GOAL_WORKSPACE_BASELINE_KEY] = {
    version: 1,
    goalId,
    capturedAt,
    status: "captured",
    head: result.state.head || null,
    branch: result.state.branch,
    files: Object.fromEntries(result.state.files.map((file) => [file.path, fileSignature(result.state.root, file)])),
  } satisfies GoalWorkspaceBaseline;
}

function attributedFiles(session: WorkspaceEnvironmentContext, state: GitState): WorkspaceEnvironmentFile[] {
  const goal = readGoalState(session.metadata);
  if (!goal) return state.files.map((file) => ({ ...file, attribution: "unattributed" }));
  const baseline = readBaseline(session, goal.goalId);
  if (!baseline || baseline.status !== "captured") {
    return state.files.map((file) => ({ ...file, attribution: "uncertain" }));
  }
  return state.files.map((file) => {
    if (!Object.prototype.hasOwnProperty.call(baseline.files, file.path)) {
      return { ...file, attribution: "goal" };
    }
    const currentSignature = fileSignature(state.root, file);
    const attribution = currentSignature === baseline.files[file.path] ? "preexisting" : "uncertain";
    return { ...file, attribution };
  });
}

function revisionFor(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function readWorkspaceEnvironment(session: WorkspaceEnvironmentContext): {
  snapshot: WorkspaceEnvironmentSnapshot;
  files: WorkspaceEnvironmentFile[];
} {
  let cwd = "";
  try {
    cwd = readWebuiSessionBinding(session).cwd;
  } catch {
    const captured_at = new Date().toISOString();
    const snapshot: WorkspaceEnvironmentSnapshot = {
      session_key: session.key,
      cwd,
      status: "workspace_unavailable",
      revision: revisionFor([session.key, "workspace_unavailable"]),
      captured_at,
      repository: null,
      changes: null,
      goal: null,
    };
    return { snapshot, files: [] };
  }
  const captured_at = new Date().toISOString();
  const result = readGitState(cwd);
  if (result.status !== "ready") {
    const snapshot: WorkspaceEnvironmentSnapshot = {
      session_key: session.key,
      cwd,
      status: result.status,
      revision: revisionFor([session.key, cwd, result.status]),
      captured_at,
      repository: null,
      changes: null,
      goal: null,
    };
    return { snapshot, files: [] };
  }
  const files = attributedFiles(session, result.state);
  const goalState = readGoalState(session.metadata);
  const baseline = goalState ? readBaseline(session, goalState.goalId) : null;
  const hasIncompleteStats = files.some((file) => file.additions == null || file.deletions == null);
  const changes = {
    file_count: files.length,
    additions: hasIncompleteStats ? null : files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: hasIncompleteStats ? null : files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    conflicts: files.filter((file) => file.conflict).length,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged).length,
    untracked: files.filter((file) => file.untracked).length,
  };
  const goal = goalState ? {
    goal_id: goalState.goalId,
    base_head: baseline?.head ?? null,
    base_branch: baseline?.branch ?? null,
    goal_files: files.filter((file) => file.attribution === "goal").length,
    preexisting_files: files.filter((file) => file.attribution === "preexisting").length,
    uncertain_files: files.filter((file) => file.attribution === "uncertain").length,
    verification: "not_run" as const,
    completion_audit: (changes.conflicts > 0
      || files.some((file) => file.attribution === "uncertain")
      || goalState.status === "completed"
      ? "risk"
      : "pending") as "pending" | "risk" | "satisfied",
    baseline_status: baseline?.status ?? "unavailable",
  } : null;
  const repository = {
    display_name: path.basename(result.state.root),
    root: result.state.root,
    head_sha: result.state.head,
    branch: result.state.branch,
    detached: result.state.branch == null,
    upstream: result.state.upstream,
    ahead: result.state.ahead,
    behind: result.state.behind,
    worktree: files.length ? "dirty" as const : "clean" as const,
  };
  const revision = revisionFor({ repository, changes, goal, files });
  return {
    snapshot: {
      session_key: session.key,
      cwd,
      status: "ready",
      revision,
      captured_at,
      repository,
      changes,
      goal,
    },
    files,
  };
}

export function readWorkspaceFileDiff(session: WorkspaceEnvironmentContext, relativePath: string): {
  path: string;
  diff: string;
  truncated: boolean;
  unavailable_reason: string | null;
} | null {
  const environment = readWorkspaceEnvironment(session);
  if (environment.snapshot.status !== "ready" || !environment.snapshot.repository) return null;
  const file = environment.files.find((entry) => entry.path === relativePath);
  if (!file) return null;
  if (file.untracked) {
    return { path: relativePath, diff: "", truncated: false, unavailable_reason: "untracked_diff_unavailable" };
  }
  const result = runGit(environment.snapshot.repository.root, [
    "diff", "--no-ext-diff", "--no-color", "HEAD", "--", relativePath,
  ], DIFF_OUTPUT_LIMIT);
  if (!result.ok) return { path: relativePath, diff: "", truncated: false, unavailable_reason: "diff_unavailable" };
  const truncated = Buffer.byteLength(result.stdout, "utf8") >= DIFF_OUTPUT_LIMIT;
  return { path: relativePath, diff: result.stdout, truncated, unavailable_reason: null };
}
