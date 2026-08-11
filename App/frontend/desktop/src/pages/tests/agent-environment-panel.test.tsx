// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient, WorkspaceEnvironmentSnapshot } from "../../api/memmy-agent-client.js";
import { AgentEnvironmentPanel } from "../agent-environment-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: WorkspaceEnvironmentSnapshot = {
  session_key: "websocket:chat-1",
  cwd: "/workspace/memmy-agent",
  status: "ready",
  revision: "rev-1",
  captured_at: "2026-08-11T08:00:00.000Z",
  repository: {
    display_name: "memmy-agent",
    root: "/workspace/memmy-agent",
    head_sha: "84d10f8f00",
    branch: "zy_git_v1.0.7",
    detached: false,
    upstream: "origin/zy_git_v1.0.7",
    ahead: 1,
    behind: 0,
    worktree: "dirty",
  },
  changes: { file_count: 1, additions: 8, deletions: 1, conflicts: 0, staged: 0, unstaged: 1, untracked: 0 },
  goal: {
    goal_id: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
    base_head: "1111111111",
    base_branch: "main",
    goal_files: 1,
    preexisting_files: 0,
    uncertain_files: 0,
    verification: "not_run",
    completion_audit: "pending",
    baseline_status: "captured",
  },
};

describe("AgentEnvironmentPanel", () => {
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
    vi.restoreAllMocks();
  });

  it("renders repository and Goal evidence and loads a selected diff", async () => {
    const onClose = vi.fn();
    const client = {
      readWorkspaceEnvironment: vi.fn(async () => snapshot),
      listWorkspaceEnvironmentFiles: vi.fn(async () => ({
        session_key: "websocket:chat-1",
        revision: "rev-1",
        files: [{
          path: "src/panel.tsx",
          status: ".M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflict: false,
          additions: 8,
          deletions: 1,
          attribution: "goal" as const,
        }],
      })),
      readWorkspaceEnvironmentDiff: vi.fn(async () => ({
        path: "src/panel.tsx",
        diff: "+export function Panel() {}",
        truncated: false,
        unavailable_reason: null,
      })),
    } as unknown as MemmyAgentClient;

    await act(async () => {
      root.render(
        <AgentEnvironmentPanel
          client={client}
          sessionKey="websocket:chat-1"
          language="zh-CN"
          running={false}
          onClose={onClose}
        />
      );
    });

    expect(container.textContent).toContain("zy_git_v1.0.7");
    expect(container.textContent).toContain("Goal 证据");
    expect(container.textContent).toContain("src/panel.tsx");

    const fileButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("src/panel.tsx"));
    expect(fileButton).toBeTruthy();
    await act(async () => fileButton!.click());

    expect(client.readWorkspaceEnvironmentDiff).toHaveBeenCalledWith("websocket:chat-1", "src/panel.tsx");
    expect(container.textContent).toContain("+export function Panel() {}");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
