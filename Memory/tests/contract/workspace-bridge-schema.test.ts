import { describe, expect, it } from "vitest";
import {
  MEMORY_WORKSPACE_BRIDGE_FIXTURE,
  PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  ProjectEnvironmentScanPolicySchema,
  ProjectWorkspaceEvidenceSchema,
  WorkspaceBridgeCapabilitiesSchema,
  WorkspaceRelativePathSchema
} from "@memmy/local-api-contracts";

describe("Workspace Bridge contract", () => {
  it("accepts only the fixed scan policy and safe relative paths", () => {
    expect(ProjectEnvironmentScanPolicySchema.parse(PROJECT_ENVIRONMENT_SCAN_POLICY_V1)).toEqual(PROJECT_ENVIRONMENT_SCAN_POLICY_V1);
    expect(ProjectEnvironmentScanPolicySchema.safeParse({ ...PROJECT_ENVIRONMENT_SCAN_POLICY_V1, maxDepth: 21 }).success).toBe(false);
    expect(WorkspaceRelativePathSchema.parse(MEMORY_WORKSPACE_BRIDGE_FIXTURE.relativePath)).toBe("src/index.ts");
    for (const path of MEMORY_WORKSPACE_BRIDGE_FIXTURE.invalidRelativePaths) {
      expect(WorkspaceRelativePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("rejects duplicate or unknown capability declarations", () => {
    expect(WorkspaceBridgeCapabilitiesSchema.safeParse({
      protocolVersion: "1",
      operations: ["inventory", "read_text", "runtime_probe"],
      maxTextBytes: 1048576
    }).success).toBe(true);
    expect(WorkspaceBridgeCapabilitiesSchema.safeParse({
      protocolVersion: "1",
      operations: ["inventory", "inventory"],
      maxTextBytes: 1048576
    }).success).toBe(false);
  });

  it("validates inventory paging and fixed evidence variants", () => {
    const base = {
      operationId: "operation-1",
      kind: "inventory" as const,
      status: "accepted" as const,
      pageIndex: 0,
      isLast: true,
      pageHash: "a".repeat(64),
      entries: [{ relativePath: "src/index.ts", type: "file" as const, size: 12, mtimeMs: 1 }]
    };
    expect(ProjectWorkspaceEvidenceSchema.safeParse({ ...base, omittedCount: 2 }).success).toBe(true);
    expect(ProjectWorkspaceEvidenceSchema.safeParse({ ...base, isLast: false, omittedCount: 2 }).success).toBe(false);
    expect(ProjectWorkspaceEvidenceSchema.safeParse({
      operationId: "operation-2",
      kind: "read_text",
      status: "stale",
      relativePath: "package.json",
      actualSha256: "b".repeat(64)
    }).success).toBe(true);
    expect(ProjectWorkspaceEvidenceSchema.safeParse({
      operationId: "operation-3",
      kind: "runtime_probe",
      status: "unsupported",
      reason: "unsafe_probe"
    }).success).toBe(true);
  });
});
