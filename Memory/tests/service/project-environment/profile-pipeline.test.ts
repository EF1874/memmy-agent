import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import {
  CODE_PROFILE_PROMPT,
  FOLDER_PROFILE_PROMPT,
  ProjectEnvironmentProfilePipeline,
  validateProjectEnvironmentProfileOutput
} from "../../../src/service/project-environment/profile-pipeline.js";
import type { EvolutionJobRecord, Repositories } from "../../../src/storage/repositories.js";

describe("project environment profile pipeline", () => {
  it("generates one complete code profile from structured evidence and the compact tree", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      op: "create",
      profile: "## Project overview\nTypeScript service."
    }));
    const { applyProfile, pipeline, renewProfileEvidence } = fixture({ complete, projectKind: "code" });

    await pipeline.process(job("code"));

    expect(renewProfileEvidence).toHaveBeenCalledWith("sync-1");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]?.[0]).toEqual({ role: "system", content: CODE_PROFILE_PROMPT });
    const input = JSON.parse(complete.mock.calls[0]![0][1]!.content) as Record<string, unknown>;
    expect(input).toEqual({
      compact_file_tree: "package.json\nsrc/\n  index.ts",
      project_kind: "code",
      scan_evidence: {
        build_candidates: [{ source_relative_path: "package.json", value: "npm run build" }],
        check_candidates: [{ source_relative_path: "package.json", value: "npm run typecheck" }],
        language_counts: { TypeScript: 1 },
        manifest_languages: [{ source_relative_path: "package.json", value: "Node.js/JavaScript" }],
        omitted_count: 2,
        runtime_declarations: [{ source_relative_path: "package.json", value: "node >=22" }],
        runtime_probes: [{ probe: "node_version", value: "v22.23.1" }],
        test_candidates: [{ source_relative_path: "package.json", value: "npm test" }],
        toolchains: [{ source_relative_path: "package.json", value: "pnpm@10" }]
      }
    });
    expect(complete.mock.calls[0]?.[0][1]?.content).not.toContain("sourceSha256");
    expect(complete.mock.calls[0]?.[0][1]?.content).not.toContain("workspace_uri");
    expect(complete.mock.calls[0]?.[1]).toEqual({
      operation: "project_environment_code_profile",
      temperature: 0,
      maxTokens: 65_536,
      jsonMode: true
    });
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentProfile: null,
      operation: "create",
      profile: "## Project overview\nTypeScript service."
    }));
  });

  it("passes the current complete profile and advances a folder noop without repeating it", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","profile":""}');
    const { applyProfile, pipeline } = fixture({
      complete,
      projectKind: "folder",
      currentProfile: "已有项目画像"
    });

    await pipeline.process(job("folder"));

    expect(complete.mock.calls[0]?.[0]?.[0]).toEqual({ role: "system", content: FOLDER_PROFILE_PROMPT });
    expect(JSON.parse(complete.mock.calls[0]![0][1]!.content)).toEqual({
      compact_file_tree: "package.json\nsrc/\n  index.ts",
      current_profile: "已有项目画像",
      project_kind: "folder",
      scan_evidence: { omitted_count: 2 }
    });
    expect(complete.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      operation: "project_environment_folder_profile",
      maxTokens: 65_536
    }));
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentProfile: "已有项目画像",
      operation: "noop",
      profile: ""
    }));
  });

  it.each([
    ["update", "新的完整画像"],
    ["update", ""]
  ] as const)("applies %s as a complete replacement, including clear", async (operation, profile) => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ op: operation, profile }));
    const { applyProfile, pipeline } = fixture({
      complete,
      projectKind: "code",
      currentProfile: "旧画像"
    });

    await pipeline.process(job("code"));

    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentProfile: "旧画像",
      operation,
      profile
    }));
  });

  it("drops a late scan before loading evidence or calling the model", async () => {
    const complete = vi.fn();
    const { pipeline, renewProfileEvidence } = fixture({
      complete,
      projectKind: "code",
      currentSyncId: "sync-new"
    });

    await pipeline.process(job("code"));

    expect(complete).not.toHaveBeenCalled();
    expect(renewProfileEvidence).not.toHaveBeenCalled();
  });

  it("repairs an invalid response once with the same output limit", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce('{"op":"create","profile":"Recovered profile"}');
    const { pipeline } = fixture({ complete, projectKind: "code" });

    await pipeline.process(job("code"));

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      operation: "project_environment_code_profile.repair",
      maxTokens: 65_536
    }));
  });

  it("rejects unknown output fields after the one strict repair", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","profile":"profile","extra":true}');
    const { pipeline } = fixture({ complete, projectKind: "code" });

    await expect(pipeline.process(job("code"))).rejects.toThrow("profile output must contain exactly op and profile");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("treats a stale apply as a successfully superseded job", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","profile":"profile"}');
    const { pipeline } = fixture({ complete, projectKind: "code", staleApply: true });

    await expect(pipeline.process(job("code"))).resolves.toBeUndefined();
  });

  it("does not retry a failed model call after a newer sync supersedes the job", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { pipeline } = fixture({
      complete,
      projectKind: "code",
      latestCurrentSyncId: "sync-new"
    });

    await expect(pipeline.process(job("code"))).resolves.toBeUndefined();
  });

  it("does not call the model again after the same scan was atomically applied", async () => {
    const complete = vi.fn();
    const { pipeline, renewProfileEvidence } = fixture({
      complete,
      projectKind: "code",
      status: "clean",
      profileScanId: "scan-1"
    });

    await pipeline.process(job("code"));

    expect(complete).not.toHaveBeenCalled();
    expect(renewProfileEvidence).not.toHaveBeenCalled();
  });

  it("strictly validates noop, create, update and clear operations", () => {
    expect(validateProjectEnvironmentProfileOutput({ op: "noop", profile: "" }, null)).toEqual({
      op: "noop", profile: ""
    });
    expect(validateProjectEnvironmentProfileOutput({ op: "create", profile: "new" }, null)).toEqual({
      op: "create", profile: "new"
    });
    expect(validateProjectEnvironmentProfileOutput({ op: "update", profile: "" }, "old")).toEqual({
      op: "update", profile: ""
    });
    expect(() => validateProjectEnvironmentProfileOutput({ op: "noop", profile: "old" }, "old")).toThrow();
    expect(() => validateProjectEnvironmentProfileOutput({ op: "update", profile: "   " }, "old")).toThrow();
    expect(() => validateProjectEnvironmentProfileOutput({ op: "create", profile: "new", extra: true }, null)).toThrow();
    expect(() => validateProjectEnvironmentProfileOutput({ op: "update", profile: "old" }, "old")).toThrow();
  });
});

function fixture(input: {
  complete: LlmClient["complete"];
  projectKind: "code" | "folder";
  currentProfile?: string;
  currentSyncId?: string;
  latestCurrentSyncId?: string;
  status?: "summarizing" | "clean";
  profileScanId?: string;
  staleApply?: boolean;
}) {
  const renewProfileEvidence = vi.fn();
  const applyProfile = vi.fn().mockReturnValue({ stale: input.staleApply ?? false });
  const currentState = {
    currentSyncId: input.currentSyncId ?? "sync-1",
    currentScanId: "scan-1",
    status: input.status ?? "summarizing",
    profileScanId: input.profileScanId
  };
  const getState = vi.fn().mockReturnValue(currentState);
  if (input.latestCurrentSyncId) {
    getState
      .mockReturnValueOnce(currentState)
      .mockReturnValue({ ...currentState, currentSyncId: input.latestCurrentSyncId });
  }
  const projectEnvironments = {
    getState,
    renewProfileEvidence,
    derivedEvidence: vi.fn().mockReturnValue({
      projectKind: input.projectKind,
      fingerprint: "fingerprint-1",
      compactFileTree: "package.json\nsrc/\n  index.ts",
      omittedCount: 2,
      deterministicFacts: {
        languageCounts: { TypeScript: 1 },
        manifestLanguages: [sourcedFact("Node.js/JavaScript")],
        runtimeDeclarations: [sourcedFact("node >=22")],
        runtimeProbes: [{ probe: "node_version", value: "v22.23.1" }],
        toolchains: [sourcedFact("pnpm@10")],
        buildEntries: [sourcedFact("npm run build")],
        testEntries: [sourcedFact("npm test")],
        checkEntries: [sourcedFact("npm run typecheck")]
      }
    }),
    applyProfile
  };
  const l3WorldModels = {
    fields: vi.fn().mockReturnValue({
      generalRulesAndSafetyConstraints: null,
      projectEnvironmentProfile: input.currentProfile ?? null,
      projectContract: null,
      domainKnowledge: null
    })
  };
  const repos = { projectEnvironments, l3WorldModels } as unknown as Repositories;
  const llm: LlmClient = {
    config: {} as LlmClient["config"],
    isConfigured: () => true,
    complete: input.complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "test", configured: true, remote: false })
  };
  return {
    applyProfile,
    renewProfileEvidence,
    pipeline: new ProjectEnvironmentProfilePipeline({ repos, llm })
  };
}

function sourcedFact(value: string) {
  return {
    value,
    sourceRelativePath: "package.json",
    sourceSha256: "sha256-do-not-send"
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
