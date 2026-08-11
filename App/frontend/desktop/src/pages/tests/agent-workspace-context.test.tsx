// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEnvironmentSnapshot } from "../../api/memmy-agent-client.js";
import { AgentWorkspaceContext } from "../agent-workspace-context.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function environment(branch: string | null = "zy_git_v1.0.7"): WorkspaceEnvironmentSnapshot {
  return {
    scope_kind: "project",
    scope_key: "project-1",
    cwd: "/workspace/memmy-agent",
    status: "ready",
    revision: `revision-${branch ?? "detached"}`,
    captured_at: "2026-08-11T08:00:00.000Z",
    repository: {
      display_name: "memmy-agent",
      root: "/workspace/memmy-agent",
      head_sha: "84d10f8f00",
      branch,
      detached: branch == null,
      upstream: null,
      ahead: 0,
      behind: 0,
      worktree: "clean",
    },
    changes: { file_count: 0, additions: 0, deletions: 0, conflicts: 0, staged: 0, unstaged: 0, untracked: 0 },
    goal: null,
  };
}

describe("AgentWorkspaceContext", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the local mode and current branch from the shared snapshot", () => {
    act(() => {
      root.render(<AgentWorkspaceContext snapshot={environment()} language="zh-CN" />);
    });

    expect(container.textContent).toContain("本地");
    expect(container.textContent).toContain("zy_git_v1.0.7");
  });

  it("renders nothing when the shared snapshot is not a Git repository", () => {
    act(() => {
      root.render(<AgentWorkspaceContext snapshot={{
        ...environment(),
        status: "not_git",
        repository: null,
        changes: null,
      }} language="zh-CN" />);
    });

    expect(container.innerHTML).toBe("");
  });
});
