import { useEffect, useRef, useState } from "react";
import { GitBranch, Laptop } from "lucide-react";
import type {
  MemmyAgentClient,
  MemmyAgentUiLanguage,
  WorkspaceEnvironmentSnapshot,
} from "../api/memmy-agent-client.js";

export type AgentWorkspaceContextProps = {
  client: MemmyAgentClient | null;
  projectId: string | null;
  language: MemmyAgentUiLanguage;
};

function displayedRevision(snapshot: WorkspaceEnvironmentSnapshot): string | null {
  const repository = snapshot.repository;
  if (!repository) return null;
  if (repository.branch) return repository.branch;
  return repository.head_sha ? `HEAD ${repository.head_sha.slice(0, 7)}` : "Detached HEAD";
}

export function AgentWorkspaceContext({ client, projectId, language }: AgentWorkspaceContextProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceEnvironmentSnapshot | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function refresh() {
      const requestId = ++requestIdRef.current;
      if (!client || !projectId) {
        if (active) setSnapshot(null);
        return;
      }
      try {
        const next = await client.readProjectWorkspaceEnvironment(projectId);
        if (active && requestId === requestIdRef.current) setSnapshot(next);
      } catch {
        if (active && requestId === requestIdRef.current) setSnapshot(null);
      }
    }

    setSnapshot(null);
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [client, projectId]);

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
