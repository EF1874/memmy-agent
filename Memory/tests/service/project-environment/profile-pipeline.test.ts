import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import {
  CODE_SUMMARY_PROMPT,
  FOLDER_SUMMARY_PROMPT,
  ProjectEnvironmentProfilePipeline,
  validateProjectEnvironmentSummaryOutput
} from "../../../src/service/project-environment/profile-pipeline.js";
import { L3_WORLD_MODEL_MAX_TOKENS } from "../../../src/service/l3-world-model/strict-json-completion.js";
import type { EvolutionJobRecord,Repositories } from "../../../src/storage/repositories.js";

describe("project environment profile pipeline", () => {
  it("generates a code summary from only the canonical file-tree input", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","summary":"Source lives in src."}');
    const { applySummary, pipeline, renewSummaryEvidence } = fixture({ complete, projectKind: "code" });
    await pipeline.process(job("code"));

    expect(renewSummaryEvidence).toHaveBeenCalledWith("sync-1");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toEqual([
      { role: "system", content: CODE_SUMMARY_PROMPT },
      { role: "user", content: '{"compact_file_tree":"src/\\n  index.ts"}' }
    ]);
    expect(complete.mock.calls[0]?.[1]).toEqual({
      operation: "project_profile_code_summary",
      temperature: 0,
      maxTokens: L3_WORLD_MODEL_MAX_TOKENS,
      jsonMode: true
    });
    expect(applySummary).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentSummary: null,
      operation: "create",
      summary: "Source lives in src."
    }));
  });

  it("includes the complete current folder summary and advances a noop without repeating it", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","summary":""}');
    const { applySummary, pipeline } = fixture({
      complete,
      projectKind: "folder",
      currentSummary: "已有项目摘要"
    });
    await pipeline.process(job("folder"));
    expect(complete.mock.calls[0]?.[0]).toEqual([
      { role: "system", content: FOLDER_SUMMARY_PROMPT },
      {
        role: "user",
        content: '{"compact_file_tree":"src/\\n  index.ts","current_summary":"已有项目摘要"}'
      }
    ]);
    expect(applySummary).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentSummary: "已有项目摘要",
      operation: "noop",
      summary: ""
    }));
  });

  it("uses the folder prompt and creates the complete first summary", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","summary":"客户材料按月份组织。"}');
    const { applySummary, pipeline } = fixture({ complete, projectKind: "folder" });

    await pipeline.process(job("folder"));

    expect(complete.mock.calls[0]?.[0]).toEqual([
      { role: "system", content: FOLDER_SUMMARY_PROMPT },
      { role: "user", content: '{"compact_file_tree":"src/\\n  index.ts"}' }
    ]);
    expect(complete.mock.calls[0]?.[1]).toEqual({
      operation: "project_profile_folder_summary",
      temperature: 0,
      maxTokens: L3_WORLD_MODEL_MAX_TOKENS,
      jsonMode: true
    });
    expect(applySummary).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentSummary: null,
      operation: "create",
      summary: "客户材料按月份组织。"
    }));
  });

  it.each([
    ["update", "新的完整摘要"],
    ["update", ""]
  ] as const)("applies %s as a complete replacement, including clear", async (operation, summary) => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ op: operation, summary }));
    const { applySummary, pipeline } = fixture({
      complete,
      projectKind: "code",
      currentSummary: "旧摘要"
    });

    await pipeline.process(job("code"));

    expect(applySummary).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentSummary: "旧摘要",
      operation,
      summary
    }));
  });

  it("drops a late scan before loading evidence or calling the model", async () => {
    const complete = vi.fn();
    const { pipeline, renewSummaryEvidence } = fixture({
      complete,
      projectKind: "code",
      currentSyncId: "sync-new"
    });

    await pipeline.process(job("code"));

    expect(complete).not.toHaveBeenCalled();
    expect(renewSummaryEvidence).not.toHaveBeenCalled();
  });

  it("rejects unknown output fields after the one strict repair", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","summary":"摘要","extra":true}');
    const { pipeline } = fixture({ complete, projectKind: "code" });

    await expect(pipeline.process(job("code"))).rejects.toThrow("summary output must contain exactly op and summary");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      operation: "project_profile_code_summary.repair",
      maxTokens: L3_WORLD_MODEL_MAX_TOKENS
    }));
  });

  it("uses one strict repair and rejects a stale apply base", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce('{"op":"create","summary":"Recovered"}');
    const { pipeline } = fixture({ complete, projectKind: "code", staleApply: true });
    await expect(pipeline.process(job("code"))).rejects.toThrow("stale_project_environment_summary_base");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      operation: "project_profile_code_summary.repair",
      maxTokens: L3_WORLD_MODEL_MAX_TOKENS
    }));
  });

  it("does not call the model again after the same scan was atomically applied", async () => {
    const complete = vi.fn();
    const { pipeline, renewSummaryEvidence } = fixture({
      complete,
      projectKind: "code",
      status: "clean",
      summaryScanId: "scan-1"
    });
    await pipeline.process(job("code"));
    expect(complete).not.toHaveBeenCalled();
    expect(renewSummaryEvidence).not.toHaveBeenCalled();
  });

  it("strictly validates noop, create, update and clear operations", () => {
    expect(validateProjectEnvironmentSummaryOutput({ op: "noop", summary: "" }, null)).toEqual({
      op: "noop", summary: ""
    });
    expect(validateProjectEnvironmentSummaryOutput({ op: "create", summary: "new" }, null)).toEqual({
      op: "create", summary: "new"
    });
    expect(validateProjectEnvironmentSummaryOutput({ op: "update", summary: "" }, "old")).toEqual({
      op: "update", summary: ""
    });
    expect(() => validateProjectEnvironmentSummaryOutput({ op: "noop", summary: "old" }, "old")).toThrow();
    expect(() => validateProjectEnvironmentSummaryOutput({ op: "create", summary: "new", extra: true }, null)).toThrow();
    expect(() => validateProjectEnvironmentSummaryOutput({ op: "update", summary: "old" }, "old")).toThrow();
  });
});

function fixture(input: {
  complete: LlmClient["complete"];
  projectKind: "code" | "folder";
  currentSummary?: string;
  currentSyncId?: string;
  status?: "summarizing" | "clean";
  summaryScanId?: string;
  staleApply?: boolean;
}) {
  const renewSummaryEvidence = vi.fn();
  const applySummary = vi.fn().mockReturnValue({ stale: input.staleApply ?? false });
  const projectEnvironments = {
    getState: vi.fn().mockReturnValue({
      currentSyncId: input.currentSyncId ?? "sync-1",
      currentScanId: "scan-1",
      status: input.status ?? "summarizing",
      summaryScanId: input.summaryScanId,
      summaryText: input.currentSummary
    }),
    renewSummaryEvidence,
    derivedEvidence: vi.fn().mockReturnValue({
      projectKind: input.projectKind,
      compactFileTree: "src/\n  index.ts"
    }),
    applySummary
  };
  const repos = { projectEnvironments } as unknown as Repositories;
  const llm: LlmClient = {
    config: {} as LlmClient["config"],
    isConfigured: () => true,
    complete: input.complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "test", configured: true, remote: false })
  };
  return {
    applySummary,
    renewSummaryEvidence,
    pipeline: new ProjectEnvironmentProfilePipeline({ repos, llm })
  };
}

function job(projectKind: "code" | "folder"): EvolutionJobRecord {
  return {
    id: "job-1",
    jobType: "project_environment_profile",
    status: "leased",
    userId: "user-1",
    payload: {
      userId: "user-1",
      projectId: "project-1",
      syncId: "sync-1",
      scanId: "scan-1",
      projectKind
    },
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
