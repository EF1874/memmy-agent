import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  type InventoryEntry,
  type ProjectWorkspaceEvidence,
  type ProjectWorkspaceOperation,
  type WorkspaceBridgeCapabilities
} from "@memmy/local-api-contracts";
import type { LlmClient } from "../../../src/model/types.js";
import type { MemoryService } from "../../../src/service/memory-service.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("project environment profile pipeline", () => {
  it("keeps the first profile empty until the model publishes one complete code profile", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      op: "create",
      profile: "## 项目概览\nNode.js/TypeScript 项目。\n\n## 主要入口\n主构建入口为 npm run build，测试入口为 npm run test，检查入口为 npm run typecheck。\n\n## 代码组织\n源码集中在 src，测试位于 tests。"
    }));
    const { db, service } = createTestService({ skillLlm: fakeLlm(complete) });
    const opened = openProject(service, "code-profile-session");
    const envelope = projectEnvelope(opened.projectId!, "code-profile-session");
    const started = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: {
        protocolVersion: "1",
        operations: ["inventory", "read_text", "runtime_probe"],
        maxTextBytes: 1024 * 1024
      }
    });
    expect(started).toMatchObject({ status: "collecting_inventory", scanId: null });
    const inventory = onlyOperation(started.operations, "inventory");
    const packageText = JSON.stringify({
      packageManager: "npm@10.9.8",
      engines: { node: ">=22" },
      scripts: { build: "tsc", test: "vitest run", typecheck: "tsc --noEmit" }
    });
    const packageHash = sha256Hex(packageText);
    const entries: InventoryEntry[] = [
      { relativePath: ".git", type: "directory", mtimeMs: 1 },
      { relativePath: "src", type: "directory", mtimeMs: 1 },
      { relativePath: "src/index.ts", type: "file", size: 20, mtimeMs: 1 },
      { relativePath: "tests", type: "directory", mtimeMs: 1 },
      { relativePath: "tests/index.test.ts", type: "file", size: 20, mtimeMs: 1 },
      { relativePath: "package.json", type: "file", size: packageText.length, mtimeMs: 1, sha256: packageHash }
    ];
    const afterInventory = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "dce64d5c-b61e-426e-afbf-c14b1f79e069",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(inventory.operationId, entries)
    });
    expect(afterInventory.operations.map((operation) => operation.kind).sort()).toEqual(["read_text", "runtime_probe"]);

    let latest = afterInventory;
    for (const operation of afterInventory.operations) {
      let evidence: ProjectWorkspaceEvidence;
      if (operation.kind === "read_text") {
        evidence = {
            operationId: operation.operationId,
            kind: "read_text",
            status: "accepted",
            relativePath: operation.relativePath,
            sha256: operation.expectedSha256,
            text: packageText
          };
      } else if (operation.kind === "runtime_probe") {
        evidence = {
            operationId: operation.operationId,
            kind: "runtime_probe",
            status: "accepted",
            probe: operation.probe,
            exitCode: 0,
            versionText: "v22.22.2"
          };
      } else {
        throw new Error("unexpected second inventory operation");
      }
      latest = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
        ...envelope,
        requestId: operation.kind === "read_text"
          ? "64ad1f17-eb89-4497-b570-664220de0d40"
          : "0b7efe61-1bf1-432c-a89c-4608b04b941e",
        sessionId: opened.sessionId,
        evidence
      });
    }
    expect(latest.status).toBe("summarizing");
    expect(latest.scanId).toMatch(/^l3wm_scan_/u);
    expect(service.l3WorldModelContext(opened.sessionId, envelope).projectEnvironmentProfile).toBeNull();

    await service.runWorkerOnce(10);

    const afterSummary = service.l3WorldModelContext(opened.sessionId, {
      ...envelope,
      requestId: "8bf0318f-4514-4eb1-8cb1-2a440c867620"
    });
    expect(afterSummary.projectEnvironmentProfile).toContain("## 项目概览");
    expect(afterSummary.projectEnvironmentProfile).toContain("主构建入口为 npm run build");
    expect(afterSummary.projectEnvironmentProfile).toContain("源码集中在 src");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(complete.mock.calls[0]![0][1]!.content)).toEqual(expect.objectContaining({
      compact_file_tree: ".git/\npackage.json\nsrc/\n  index.ts\ntests/\n  index.test.ts",
      project_kind: "code",
      scan_evidence: expect.objectContaining({
        build_candidates: [{ source_relative_path: "package.json", value: "npm run build" }],
        test_candidates: [{ source_relative_path: "package.json", value: "npm run test" }],
        check_candidates: [{ source_relative_path: "package.json", value: "npm run typecheck" }]
      })
    }));
    expect(db.db.prepare(
      `SELECT status, applied_scan_id, profile_scan_id
       FROM l3_world_model_project_environment_sync_state`
    ).get()).toMatchObject({ status: "clean", applied_scan_id: latest.scanId, profile_scan_id: latest.scanId });
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM l3_world_model_project_environment_operations`
    ).get()).toEqual({ count: 0 });

    const unchanged = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      requestId: "5d66accf-4bca-4317-b15d-300700bec83c",
      sessionId: opened.sessionId,
      trigger: "token_compaction",
      capabilities: {
        protocolVersion: "1",
        operations: ["inventory", "read_text", "runtime_probe"],
        maxTextBytes: 1024 * 1024
      }
    });
    let unchangedResult = service.projectEnvironmentSyncEvidence(opened.projectId!, unchanged.syncId, {
      ...envelope,
      requestId: "879e859a-82dc-4192-82d5-4155502fb617",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(onlyOperation(unchanged.operations, "inventory").operationId, entries)
    });
    for (const [index, operation] of unchangedResult.operations.entries()) {
      const evidence: ProjectWorkspaceEvidence = operation.kind === "read_text"
        ? {
            operationId: operation.operationId,
            kind: "read_text",
            status: "accepted",
            relativePath: operation.relativePath,
            sha256: operation.expectedSha256,
            text: packageText
          }
        : operation.kind === "runtime_probe"
          ? {
              operationId: operation.operationId,
              kind: "runtime_probe",
              status: "accepted",
              probe: operation.probe,
              exitCode: 0,
              versionText: "v22.22.2"
            }
          : (() => { throw new Error("unexpected inventory operation"); })();
      unchangedResult = service.projectEnvironmentSyncEvidence(opened.projectId!, unchanged.syncId, {
        ...envelope,
        requestId: `8b8a208f-7f55-4ff8-8ea3-84dfdf6b7c${index}`,
        sessionId: opened.sessionId,
        evidence
      });
    }
    expect(unchangedResult).toMatchObject({ status: "clean", scanId: latest.scanId });
    await service.runWorkerOnce(10);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("classifies an ordinary folder without requesting file contents or probes", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","profile":"包含需求与排期材料。"}');
    const { service } = createTestService({ skillLlm: fakeLlm(complete) });
    const opened = openProject(service, "folder-profile-session");
    const envelope = projectEnvelope(opened.projectId!, "folder-profile-session");
    const started = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: {
        protocolVersion: "1",
        operations: ["inventory", "read_text", "runtime_probe"],
        maxTextBytes: 1024 * 1024
      }
    });
    const inventory = onlyOperation(started.operations, "inventory");
    const response = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "32acf76a-8ca4-4768-931a-187321d0159c",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(inventory.operationId, [
        { relativePath: "需求", type: "directory", mtimeMs: 1 },
        { relativePath: "需求/评审稿.docx", type: "file", size: 10, mtimeMs: 1 },
        { relativePath: "排期", type: "directory", mtimeMs: 1 },
        { relativePath: "排期/里程碑.xlsx", type: "file", size: 10, mtimeMs: 1 }
      ])
    });
    expect(response.status).toBe("summarizing");
    expect(response.operations).toEqual([]);
    expect(service.l3WorldModelContext(opened.sessionId, envelope).projectEnvironmentProfile).toBeNull();
    await service.runWorkerOnce(10);
    expect(service.l3WorldModelContext(opened.sessionId, {
      ...envelope,
      requestId: "ac0063b0-d22c-40ea-ad9b-f1bf6c6fd07e"
    }).projectEnvironmentProfile).toBe("包含需求与排期材料。");
  });

  it("keeps the previous same-kind profile until a noop atomically advances both scan records", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"op":"create","profile":"Initial folder profile."}')
      .mockResolvedValueOnce('{"op":"noop","profile":""}');
    const { db, service } = createTestService({ skillLlm: fakeLlm(complete) });
    const opened = openProject(service, "same-kind-noop-session");
    const envelope = projectEnvelope(opened.projectId!, "same-kind-noop-session");
    const first = completeFolderScan(service, opened, envelope, {
      startRequestId: "fcd966cf-ff2e-46e6-9646-326778547f8a",
      evidenceRequestId: "2bf311f2-e122-411b-87b9-40561ea1e302",
      entries: [fileEntry("需求.docx")]
    });
    await service.runWorkerOnce(10);
    const repos = new Repositories(db.db);
    const before = repos.l3WorldModels.getMemory("project-profile-user", opened.projectId)!;
    expect(repos.l3WorldModels.fields("project-profile-user", opened.projectId).projectEnvironmentProfile)
      .toBe("Initial folder profile.");

    const second = completeFolderScan(service, opened, envelope, {
      startRequestId: "a49bb6ef-278a-4739-abf0-43a62efb57d0",
      evidenceRequestId: "68f7513c-8916-49bf-9200-8f58a03c8ef4",
      entries: [fileEntry("需求.docx"), fileEntry("排期.xlsx")]
    });
    expect(second.status).toBe("summarizing");
    expect(second.scanId).not.toBe(first.scanId);
    expect(repos.l3WorldModels.fields("project-profile-user", opened.projectId).projectEnvironmentProfile)
      .toBe("Initial folder profile.");

    await service.runWorkerOnce(10);

    const after = repos.l3WorldModels.getMemory("project-profile-user", opened.projectId)!;
    expect(after.memoryValue).toBe(before.memoryValue);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.info.project_environment_applied_scan_id).toBe(second.scanId);
    expect(db.db.prepare(
      `SELECT status, applied_scan_id, profile_scan_id
       FROM l3_world_model_project_environment_sync_state`
    ).get()).toEqual({
      status: "clean",
      applied_scan_id: second.scanId,
      profile_scan_id: second.scanId
    });
    expect(JSON.parse(complete.mock.calls[1]![0][1]!.content)).toMatchObject({
      current_profile: "Initial folder profile."
    });
  });

  it("advances an empty-profile noop without creating an empty L3 memory", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","profile":""}');
    const { db, service } = createTestService({ skillLlm: fakeLlm(complete) });
    const existingProject = openProject(service, "empty-noop-existing-session");
    const repos = new Repositories(db.db);
    const contract = repos.l3WorldModels.upsertField({
      userId: "project-profile-user",
      projectId: existingProject.projectId,
      targetField: "project_contract",
      value: "Keep the contract."
    })!;
    const existingResult = completeFolderScan(
      service,
      existingProject,
      projectEnvelope(existingProject.projectId!, "empty-noop-existing-session"),
      {
        startRequestId: "65232aec-1eb6-4acd-abee-0c49c3344471",
        evidenceRequestId: "4681dbf1-ad40-49b4-a3ae-5133bfdba312",
        entries: []
      }
    );
    await service.runWorkerOnce(10);
    const existingMemory = repos.l3WorldModels.getMemory("project-profile-user", existingProject.projectId)!;
    expect(existingMemory.id).toBe(contract.id);
    expect(existingMemory.info.project_environment_applied_scan_id).toBe(existingResult.scanId);
    expect(repos.l3WorldModels.fields("project-profile-user", existingProject.projectId)).toMatchObject({
      projectEnvironmentProfile: null,
      projectContract: "Keep the contract."
    });

    const emptyProject = openProject(service, "empty-noop-no-memory-session");
    const emptyResult = completeFolderScan(
      service,
      emptyProject,
      projectEnvelope(emptyProject.projectId!, "empty-noop-no-memory-session"),
      {
        startRequestId: "e6e1ce90-b0fd-4eb6-a1ab-a1ca84df0155",
        evidenceRequestId: "80949af3-8409-4218-9da2-d751817e4dbc",
        entries: []
      }
    );
    await service.runWorkerOnce(10);
    expect(repos.l3WorldModels.getScope("project-profile-user", emptyProject.projectId)?.memoryId).toBeUndefined();
    expect(repos.projectEnvironments.getState("project-profile-user", emptyProject.projectId!)).toMatchObject({
      status: "clean",
      appliedScanId: emptyResult.scanId,
      profileScanId: emptyResult.scanId
    });
  });

  it("clears an incompatible summary when the same project changes type", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"op":"create","profile":"TypeScript service code."}')
      .mockResolvedValueOnce('{"op":"create","profile":"Planning documents and schedules."}');
    const { db, service } = createTestService({ skillLlm: fakeLlm(complete) });
    const opened = openProject(service, "type-change-session");
    const envelope = projectEnvelope(opened.projectId!, "type-change-session");
    const inventoryOnlyCapabilities: WorkspaceBridgeCapabilities = {
      protocolVersion: "1",
      operations: ["inventory"],
      maxTextBytes: 1024 * 1024
    };

    const codeStart = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: inventoryOnlyCapabilities
    });
    const codeResponse = service.projectEnvironmentSyncEvidence(opened.projectId!, codeStart.syncId, {
      ...envelope,
      requestId: "f4022a4a-5fcb-4d24-b151-9b560f734b10",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(onlyOperation(codeStart.operations, "inventory").operationId, [
        fileEntry("src/a.ts"),
        fileEntry("src/b.ts"),
        fileEntry("src/c.ts"),
        fileEntry("src/d.ts"),
        fileEntry("src/e.ts")
      ])
    });
    expect(codeResponse.status).toBe("summarizing");
    await service.runWorkerOnce(10);
    expect(service.l3WorldModelContext(opened.sessionId, {
      ...envelope,
      requestId: "a129c40a-0f87-441b-8377-6bea64e8b990"
    }).projectEnvironmentProfile).toContain("TypeScript service code");

    const folderStart = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      requestId: "f1f081b6-f0d6-47dc-b099-362f44819e21",
      sessionId: opened.sessionId,
      trigger: "token_compaction",
      capabilities: inventoryOnlyCapabilities
    });
    const folderResponse = service.projectEnvironmentSyncEvidence(opened.projectId!, folderStart.syncId, {
      ...envelope,
      requestId: "04d10b88-b241-4c96-8d67-f33929aa6aec",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(onlyOperation(folderStart.operations, "inventory").operationId, [
        fileEntry("需求.docx"),
        fileEntry("排期.xlsx")
      ])
    });
    expect(folderResponse.status).toBe("summarizing");
    expect(service.l3WorldModelContext(opened.sessionId, {
      ...envelope,
      requestId: "774dff70-b23b-476a-9ed0-aa393fc77b34"
    }).projectEnvironmentProfile).toBeNull();
    expect(db.db.prepare(
      `SELECT project_kind, profile_scan_id
       FROM l3_world_model_project_environment_sync_state`
    ).get()).toEqual({ project_kind: "folder", profile_scan_id: null });

    await service.runWorkerOnce(10);
    expect(service.l3WorldModelContext(opened.sessionId, {
      ...envelope,
      requestId: "44886a60-c96d-438f-9a34-8ef297085ec4"
    }).projectEnvironmentProfile).toBe("Planning documents and schedules.");
    expect(JSON.parse(complete.mock.calls[1]![0][1]!.content)).toEqual({
      compact_file_tree: "排期.xlsx\n需求.docx",
      project_kind: "folder",
      scan_evidence: { omitted_count: 0 }
    });

    db.close();
  });

  it("creates the sync and exact idempotency response atomically", () => {
    const { db, service } = createTestService();
    const opened = openProject(service, "idempotent-sync-session");
    const envelope = projectEnvelope(opened.projectId!, "idempotent-sync-session");
    const request = {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start" as const,
      capabilities: inventoryCapabilities()
    };
    const first = service.projectEnvironmentSyncStart(opened.projectId!, request);
    const duplicate = service.projectEnvironmentSyncStart(opened.projectId!, request);
    expect(duplicate).toEqual(first);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM l3_world_model_project_environment_operations`
    ).get()).toEqual({ count: 1 });
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM idempotency_keys
       WHERE key = ?`
    ).get(`project-environment.start:${request.adapterId}:${request.requestId}`)).toEqual({ count: 1 });

    expect(() => service.projectEnvironmentSyncStart(opened.projectId!, {
      ...request,
      trigger: "token_compaction"
    })).toThrow(/idempotency key reused/u);
  });

  it("fails safely when inventory is not in the negotiated capability set", () => {
    const { service } = createTestService();
    const opened = openProject(service, "missing-inventory-session");
    const envelope = projectEnvelope(opened.projectId!, "missing-inventory-session");
    const response = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: {
        protocolVersion: "1",
        operations: ["read_text"],
        maxTextBytes: 1024
      }
    });
    expect(response).toMatchObject({ status: "failed", scanId: null, operations: [] });
  });

  it("rejects out-of-order pages and re-collects the whole inventory after stale text", () => {
    const { db, service } = createTestService();
    const opened = openProject(service, "stale-inventory-session");
    const envelope = projectEnvelope(opened.projectId!, "stale-inventory-session");
    const started = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: inventoryCapabilities()
    });
    const inventory = onlyOperation(started.operations, "inventory");
    const badPage = inventoryEvidence(inventory.operationId, []);
    expect(() => service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "57999c83-b8cb-43ad-8308-eb70746775ee",
      sessionId: opened.sessionId,
      evidence: { ...badPage, pageIndex: 1 }
    })).toThrow(/page_hash_mismatch|page_sequence_conflict/u);

    const packageHash = "a".repeat(64);
    const entries: InventoryEntry[] = [
      { relativePath: "package.json", type: "file", size: 2, mtimeMs: 1, sha256: packageHash },
      { relativePath: "src/index.ts", type: "file", size: 1, mtimeMs: 1 }
    ];
    const planned = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "abcae851-74b1-4f13-b1c9-211096a01b4e",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(inventory.operationId, entries)
    });
    const read = onlyOperation(planned.operations, "read_text");
    const replacement = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "95c6343e-613c-4786-ae9f-a089009c6d5f",
      sessionId: opened.sessionId,
      evidence: {
        operationId: read.operationId,
        kind: "read_text",
        status: "stale",
        relativePath: read.relativePath,
        actualSha256: "b".repeat(64)
      }
    });
    expect(replacement.status).toBe("collecting_inventory");
    expect(replacement.operations).toHaveLength(1);
    expect(replacement.operations[0]?.kind).toBe("inventory");
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM l3_world_model_project_environment_operations
       WHERE sync_id = ? AND status = 'expired'`
    ).get(started.syncId)).toEqual({ count: planned.operations.length + 1 });

    const replanned = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "fbcbd66d-da83-4c04-8062-f23bdca13887",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(onlyOperation(replacement.operations, "inventory").operationId, entries)
    });
    expect(replanned.operations.some((operation) => operation.kind === "read_text")).toBe(true);
  });

  it("binds operations to the owner and renews the ten-minute lease only on progress", () => {
    const { db, service } = createTestService();
    const opened = openProject(service, "lease-session");
    const envelope = projectEnvelope(opened.projectId!, "lease-session");
    const started = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: inventoryCapabilities()
    });
    db.db.prepare(
      `UPDATE l3_world_model_project_environment_sync_state
       SET sync_lease_expires_at = '2099-01-01T00:00:00.000Z'`
    ).run();
    const resumed = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      requestId: "af5a9ff1-9d60-4221-a97d-e4c00177247d",
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: inventoryCapabilities()
    });
    expect(resumed.syncId).toBe(started.syncId);
    expect(db.db.prepare(
      `SELECT sync_lease_expires_at FROM l3_world_model_project_environment_sync_state`
    ).get()).toEqual({ sync_lease_expires_at: "2099-01-01T00:00:00.000Z" });

    const operation = onlyOperation(started.operations, "inventory");
    const page = inventoryPage(operation.operationId, 0, false, [fileEntry("src/index.ts")]);
    service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "9850437e-ce2c-4ba2-ad8f-23613846b283",
      sessionId: opened.sessionId,
      evidence: page
    });
    expect(db.db.prepare(
      `SELECT sync_lease_expires_at FROM l3_world_model_project_environment_sync_state`
    ).get()).not.toEqual({ sync_lease_expires_at: "2099-01-01T00:00:00.000Z" });

    expect(() => service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      adapterId: "other-adapter",
      requestId: "f32f6d95-bf3c-4e0f-a346-a43d881e37fe",
      sessionId: opened.sessionId,
      evidence: inventoryPage(operation.operationId, 1, true, [])
    })).toThrow(/sync_conflict/u);

    db.db.prepare(
      `UPDATE l3_world_model_project_environment_sync_state
       SET sync_lease_expires_at = '2000-01-01T00:00:00.000Z'`
    ).run();
    expect(() => service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "569db8c9-e98f-40e5-bf9f-d846aeb1ba29",
      sessionId: opened.sessionId,
      evidence: inventoryPage(operation.operationId, 1, true, [])
    })).toThrow(/lease_expired/u);
  });

  it("extends temporary evidence during retries, cleans it at dead letter, and allows a new sync", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const { db, service } = createTestService({ skillLlm: fakeLlm(complete) });
    const opened = openProject(service, "dead-letter-session");
    const envelope = projectEnvelope(opened.projectId!, "dead-letter-session");
    const started = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      sessionId: opened.sessionId,
      trigger: "session_start",
      capabilities: inventoryCapabilities()
    });
    const summarizing = service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
      ...envelope,
      requestId: "ff67d752-114f-44ef-9735-8914346e58c1",
      sessionId: opened.sessionId,
      evidence: inventoryEvidence(onlyOperation(started.operations, "inventory").operationId, [
        fileEntry("需求.docx")
      ])
    });
    expect(summarizing.status).toBe("summarizing");
    db.db.prepare(
      `UPDATE l3_world_model_project_environment_operations
       SET expires_at = '2000-01-01T00:00:00.000Z'`
    ).run();

    await service.runWorkerOnce(1);
    const renewed = db.db.prepare(
      `SELECT expires_at FROM l3_world_model_project_environment_operations WHERE sync_id = ?`
    ).get(started.syncId) as { expires_at: string };
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.now());

    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    expect(db.db.prepare(
      `SELECT status FROM l3_world_model_project_environment_sync_state`
    ).get()).toEqual({ status: "failed" });
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM l3_world_model_project_environment_operations`
    ).get()).toEqual({ count: 0 });

    const recovered = service.projectEnvironmentSyncStart(opened.projectId!, {
      ...envelope,
      requestId: "bedf3473-d541-4ee6-a837-9d32510e57dc",
      sessionId: opened.sessionId,
      trigger: "token_compaction",
      capabilities: inventoryCapabilities()
    });
    expect(recovered).toMatchObject({ status: "collecting_inventory", scanId: summarizing.scanId });
    expect(recovered.syncId).not.toBe(started.syncId);
  });
});

function openProject(service: MemoryService, sessionKey: string) {
  return service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    workspaceUri: `file:///tmp/${sessionKey}`,
    workspaceHostId: "b".repeat(64),
    namespace: {
      source: "codex",
      profileId: "default",
      sessionKey,
      userId: "project-profile-user"
    }
  });
}

function projectEnvelope(projectId: string, sessionKey: string) {
  return {
    requestId: "d8773f59-0b3f-4d16-b730-a80155711430",
    adapterId: "codex-memory",
    source: "codex",
    namespace: {
      source: "codex",
      profileId: "default",
      sessionKey,
      userId: "project-profile-user",
      projectId
    }
  } as const;
}

function onlyOperation<K extends ProjectWorkspaceOperation["kind"]>(
  operations: ProjectWorkspaceOperation[],
  kind: K
): Extract<ProjectWorkspaceOperation, { kind: K }> {
  const operation = operations.find((candidate) => candidate.kind === kind);
  if (!operation || operation.kind !== kind) throw new Error(`missing ${kind} operation`);
  return operation as Extract<ProjectWorkspaceOperation, { kind: K }>;
}

function inventoryEvidence(
  operationId: string,
  entries: InventoryEntry[]
): Extract<ProjectWorkspaceEvidence, { kind: "inventory" }> {
  const value = {
    operationId,
    pageIndex: 0,
    isLast: true,
    omittedCount: null,
    entries
  };
  return {
    operationId,
    kind: "inventory",
    status: "accepted",
    pageIndex: 0,
    isLast: true,
    pageHash: sha256Hex(canonicalJson(value)),
    entries
  };
}

function inventoryPage(
  operationId: string,
  pageIndex: number,
  isLast: boolean,
  entries: InventoryEntry[]
): Extract<ProjectWorkspaceEvidence, { kind: "inventory" }> {
  const value = { operationId, pageIndex, isLast, omittedCount: null, entries };
  return {
    operationId,
    kind: "inventory",
    status: "accepted",
    pageIndex,
    isLast,
    pageHash: sha256Hex(canonicalJson(value)),
    entries
  };
}

function fileEntry(relativePath: string): Extract<InventoryEntry, { type: "file" }> {
  return { relativePath, type: "file", size: 1, mtimeMs: 1 };
}

function inventoryCapabilities(): WorkspaceBridgeCapabilities {
  return {
    protocolVersion: "1",
    operations: ["inventory", "read_text", "runtime_probe"],
    maxTextBytes: 1024 * 1024
  };
}

function completeFolderScan(
  service: MemoryService,
  opened: ReturnType<typeof openProject>,
  envelope: ReturnType<typeof projectEnvelope>,
  input: {
    startRequestId: string;
    evidenceRequestId: string;
    entries: InventoryEntry[];
  }
) {
  const started = service.projectEnvironmentSyncStart(opened.projectId!, {
    ...envelope,
    requestId: input.startRequestId,
    sessionId: opened.sessionId,
    trigger: "token_compaction",
    capabilities: {
      protocolVersion: "1",
      operations: ["inventory"],
      maxTextBytes: 1024
    }
  });
  return service.projectEnvironmentSyncEvidence(opened.projectId!, started.syncId, {
    ...envelope,
    requestId: input.evidenceRequestId,
    sessionId: opened.sessionId,
    evidence: inventoryEvidence(onlyOperation(started.operations, "inventory").operationId, input.entries)
  });
}

function fakeLlm(complete: LlmClient["complete"]): LlmClient {
  return {
    config: {} as LlmClient["config"],
    isConfigured: () => true,
    complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}
