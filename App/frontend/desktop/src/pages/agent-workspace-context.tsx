import { GitBranch, Laptop } from "lucide-react";
import type {
  MemmyAgentUiLanguage,
  WorkspaceEnvironmentSnapshot,
} from "../api/memmy-agent-client.js";

export type AgentWorkspaceContextProps = {
  snapshot: WorkspaceEnvironmentSnapshot | null;
  language: MemmyAgentUiLanguage;
};

function displayedRevision(snapshot: WorkspaceEnvironmentSnapshot): string | null {
  const repository = snapshot.repository;
  if (!repository) return null;
  if (repository.branch) return repository.branch;
  return repository.head_sha ? `HEAD ${repository.head_sha.slice(0, 7)}` : "Detached HEAD";
}

export function AgentWorkspaceContext({ snapshot, language }: AgentWorkspaceContextProps) {
  const revision = snapshot?.status === "ready" ? displayedRevision(snapshot) : null;
  if (!revision) return null;

  const localLabel = language === "zh-CN" ? "本地" : "Local";
  const branchLabel = snapshot?.repository?.branch
    ? (language === "zh-CN" ? `分支 ${revision}` : `Branch ${revision}`)
    : revision;

  return (
    <div className="home-workspace-context" aria-label={language === "zh-CN" ? "Git 工作区信息" : "Git workspace information"}>
      <span className="home-workspace-context__mode" title={language === "zh-CN" ? "工作模式：本地" : "Work mode: Local"}>
        <Laptop size={14} aria-hidden="true" />
        <span>{localLabel}</span>
      </span>
      <span className="home-workspace-context__branch" title={branchLabel}>
        <GitBranch size={14} aria-hidden="true" />
        <span>{revision}</span>
      </span>
    </div>
  );
}
