import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderGit2,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  MemmyAgentClient,
  MemmyAgentUiLanguage,
  WorkspaceEnvironmentDiff,
  WorkspaceEnvironmentFile,
  WorkspaceEnvironmentState,
} from "../api/memmy-agent-client.js";

type AgentEnvironmentPanelProps = {
  client: MemmyAgentClient | null;
  scope: "session" | "project";
  scopeKey: string;
  language: MemmyAgentUiLanguage;
  environment: WorkspaceEnvironmentState | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onClose: () => void;
};

function shortSha(value: string): string {
  return value ? value.slice(0, 7) : "—";
}

function countLabel(value: number | null, prefix: "+" | "-"): string {
  return value == null ? "?" : `${prefix}${value.toLocaleString()}`;
}

export function AgentEnvironmentPanel({
  client,
  scope,
  scopeKey,
  language,
  environment,
  loading,
  error,
  onRefresh,
  onClose,
}: AgentEnvironmentPanelProps) {
  const zh = language === "zh-CN";
  const [diff, setDiff] = useState<WorkspaceEnvironmentDiff | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const diffRequestIdRef = useRef(0);
  const snapshot = environment?.snapshot ?? null;
  const files = environment?.files ?? [];

  useEffect(() => {
    diffRequestIdRef.current += 1;
    setDiff(null);
    setSelectedPath(null);
    return () => {
      diffRequestIdRef.current += 1;
    };
  }, [scope, scopeKey, snapshot?.revision]);

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function selectFile(file: WorkspaceEnvironmentFile) {
    if (!client) return;
    if (selectedPath === file.path) {
      diffRequestIdRef.current += 1;
      setSelectedPath(null);
      setDiff(null);
      return;
    }
    const requestId = ++diffRequestIdRef.current;
    setSelectedPath(file.path);
    setDiff(null);
    try {
      const next = await client.readWorkspaceEnvironmentDiff({ kind: scope, key: scopeKey }, file.path);
      if (requestId === diffRequestIdRef.current) setDiff(next);
    } catch (cause) {
      if (requestId === diffRequestIdRef.current) {
        setDiff({
          path: file.path,
          diff: "",
          truncated: false,
          unavailable_reason: cause instanceof Error ? cause.message : "diff_unavailable",
        });
      }
    }
  }

  async function refresh() {
    diffRequestIdRef.current += 1;
    setDiff(null);
    setSelectedPath(null);
    await onRefresh();
  }

  const statusLabel = snapshot?.status === "not_git"
    ? (zh ? "当前目录不是 Git 仓库" : "Not a Git repository")
    : snapshot?.status === "workspace_unavailable"
      ? (zh ? "工作区不可用" : "Workspace unavailable")
      : snapshot?.status === "error"
        ? (zh ? "读取 Git 状态失败" : "Failed to read Git status")
        : null;

  return (
    <aside className="agent-environment-panel" aria-label={zh ? "环境信息" : "Environment information"}>
      <header className="agent-environment-panel__header">
        <div>
          <p className="agent-environment-panel__eyebrow">{zh ? "环境信息" : "Environment"}</p>
          <h2>{snapshot?.repository?.display_name ?? (zh ? "当前工作区" : "Current workspace")}</h2>
        </div>
        <div className="agent-environment-panel__actions">
          <button type="button" onClick={() => void refresh()} aria-label={zh ? "刷新环境信息" : "Refresh environment"} title={zh ? "刷新" : "Refresh"} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" className={loading ? "agent-environment-panel__spin" : undefined} />
          </button>
          <button type="button" onClick={onClose} aria-label={zh ? "关闭环境信息" : "Close environment"} title={zh ? "关闭" : "Close"}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error ? <p className="agent-environment-panel__notice agent-environment-panel__notice--error" role="status">{error}</p> : null}
      {statusLabel ? <p className="agent-environment-panel__notice" role="status">{statusLabel}</p> : null}

      {snapshot?.status === "ready" && snapshot.repository ? (
        <div className="agent-environment-panel__body">
          <section className="agent-environment-section">
            <div className="agent-environment-row">
              <FolderGit2 size={16} aria-hidden="true" />
              <div className="agent-environment-row__content">
                <span>{zh ? "本地" : "Local"}</span>
                <small title={snapshot.cwd}>{snapshot.cwd}</small>
              </div>
            </div>
            <div className="agent-environment-row">
              <GitBranch size={16} aria-hidden="true" />
              <div className="agent-environment-row__content">
                <span>{snapshot.repository.branch ?? (zh ? "分离 HEAD" : "Detached HEAD")}</span>
                <small>{shortSha(snapshot.repository.head_sha)}{snapshot.repository.upstream ? ` · ${snapshot.repository.upstream}` : ""}</small>
              </div>
              {(snapshot.repository.ahead || snapshot.repository.behind) ? (
                <span className="agent-environment-row__meta">↑{snapshot.repository.ahead} ↓{snapshot.repository.behind}</span>
              ) : null}
            </div>
          </section>

          <section className="agent-environment-section">
            <button type="button" className="agent-environment-section__toggle" onClick={() => setFilesOpen((value) => !value)} aria-expanded={filesOpen}>
              {filesOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              <span>{zh ? "变更" : "Changes"}</span>
              <span className="agent-environment-section__count">{snapshot.changes?.file_count ?? 0}</span>
              <span className="agent-environment-section__lines agent-environment-section__lines--add">{countLabel(snapshot.changes?.additions ?? null, "+")}</span>
              <span className="agent-environment-section__lines agent-environment-section__lines--delete">{countLabel(snapshot.changes?.deletions ?? null, "-")}</span>
            </button>
            {filesOpen ? (
              <div className="agent-environment-files">
                {files.length ? files.map((file) => (
                  <div key={file.path}>
                    <button type="button" className={`agent-environment-file${selectedPath === file.path ? " agent-environment-file--selected" : ""}`} onClick={() => void selectFile(file)} aria-expanded={selectedPath === file.path}>
                      <FileCode2 size={14} aria-hidden="true" />
                      <span className="agent-environment-file__path" title={file.path}>{file.path}</span>
                      <span className={`agent-environment-file__attribution agent-environment-file__attribution--${file.attribution}`}>
                        {file.attribution === "goal" ? (zh ? "目标" : "Goal") : file.attribution === "preexisting" ? (zh ? "原有" : "Existing") : file.attribution === "uncertain" ? (zh ? "待确认" : "Uncertain") : "—"}
                      </span>
                    </button>
                    {selectedPath === file.path ? (
                      <div className="agent-environment-diff">
                        {diff?.diff ? <pre>{diff.diff}</pre> : <p>{diff?.unavailable_reason === "untracked_diff_unavailable" ? (zh ? "未跟踪文件暂不展示 diff" : "Diff is unavailable for untracked files") : (zh ? "暂无可展示的 diff" : "No diff available")}</p>}
                        {diff?.truncated ? <small>{zh ? "Diff 已截断" : "Diff truncated"}</small> : null}
                      </div>
                    ) : null}
                  </div>
                )) : <p className="agent-environment-panel__empty">{zh ? "工作区干净" : "Working tree clean"}</p>}
              </div>
            ) : null}
          </section>

          {snapshot.goal ? (
            <section className="agent-environment-section agent-environment-goal">
              <div className="agent-environment-section__heading">
                <span>{zh ? "Goal 证据" : "Goal evidence"}</span>
                {snapshot.goal.completion_audit === "risk" ? (
                  <AlertTriangle size={15} aria-label={zh ? "存在风险" : "Risk"} />
                ) : snapshot.goal.completion_audit === "satisfied" ? (
                  <CheckCircle2 size={15} aria-label={zh ? "审计通过" : "Audit satisfied"} />
                ) : null}
              </div>
              <dl>
                <div><dt>{zh ? "基线" : "Baseline"}</dt><dd>{snapshot.goal.base_branch ?? "—"} · {snapshot.goal.base_head ? shortSha(snapshot.goal.base_head) : "—"}</dd></div>
                <div><dt>{zh ? "目标新增" : "Goal files"}</dt><dd>{snapshot.goal.goal_files}</dd></div>
                <div><dt>{zh ? "原有变更" : "Pre-existing"}</dt><dd>{snapshot.goal.preexisting_files}</dd></div>
                <div><dt>{zh ? "待确认" : "Uncertain"}</dt><dd>{snapshot.goal.uncertain_files}</dd></div>
                <div><dt>{zh ? "验证" : "Verification"}</dt><dd>{snapshot.goal.verification === "not_run" ? (zh ? "未运行" : "Not run") : snapshot.goal.verification}</dd></div>
              </dl>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
