import {
  WorkspaceBridgeCapabilitiesSchema,
  canonicalJson,
  sha256Hex,
  type JsonValue,
  type ProjectEnvironmentSyncEvidenceRequest,
  type ProjectEnvironmentSyncResponse,
  type ProjectEnvironmentSyncStartRequest,
  type ProjectWorkspaceOperation,
  type WorkspaceBridgeCapabilities
} from "@memmy/local-api-contracts";
import type { LlmClient } from "../../model/types.js";
import {
  ProjectEnvironmentIdempotencyConflictError,
  type ProjectEnvironmentDerivedEvidence,
  type EvolutionJobRecord,
  type Repositories,
  type SessionRecord
} from "../../storage/repositories.js";
import { MemoryServiceError } from "../../utils/error.js";
import { newId } from "../../utils/id.js";
import {
  parseDeterministicProjectFacts
} from "./manifest-parsers.js";
import { renderDeterministicCodeProfile } from "./profile-renderer.js";
import {
  buildCompactFileTree,
  deterministicReadCandidates,
  projectFingerprint,
  requiredRuntimeProbes
} from "./scan-policy.js";
import { classifyProjectInventory } from "./project-classifier.js";
import { ProjectEnvironmentProfilePipeline } from "./profile-pipeline.js";

interface ProjectEnvironmentServiceDeps {
  repos: Repositories;
  readonly llm: LlmClient;
}

export class ProjectEnvironmentService {
  private readonly profilePipeline: ProjectEnvironmentProfilePipeline;

  constructor(private readonly deps: ProjectEnvironmentServiceDeps) {
    this.profilePipeline = new ProjectEnvironmentProfilePipeline(deps);
  }

  start(
    session: SessionRecord,
    projectId: string,
    request: ProjectEnvironmentSyncStartRequest
  ): ProjectEnvironmentSyncResponse {
    try {
      return this.deps.repos.projectEnvironments.startIdempotent({
        userId: session.userId,
        projectId,
        adapterId: request.adapterId,
        capabilities: request.capabilities,
        idempotencyKey: `project-environment.start:${request.adapterId}:${request.requestId}`,
        requestHash: sha256Hex(canonicalJson({
          operation: "project-environment.start",
          projectId,
          request
        } as JsonValue))
      });
    } catch (error) {
      if (error instanceof ProjectEnvironmentIdempotencyConflictError) {
        throw new MemoryServiceError("conflict", "idempotency key reused with different project environment start request");
      }
      throw error;
    }
  }

  evidence(
    session: SessionRecord,
    projectId: string,
    syncId: string,
    request: ProjectEnvironmentSyncEvidenceRequest
  ): ProjectEnvironmentSyncResponse {
    const accepted = this.deps.repos.projectEnvironments.acceptEvidence({
      userId: session.userId,
      projectId,
      adapterId: request.adapterId,
      syncId,
      evidence: request.evidence
    });
    if (accepted.stale) {
      return this.deps.repos.projectEnvironments.replaceAfterStale({
        userId: session.userId,
        projectId,
        adapterId: request.adapterId,
        syncId
      });
    }
    if (!accepted.progressed) return accepted.response;

    if (accepted.inventoryComplete) {
      const operations = this.deps.repos.projectEnvironments.listActiveOperations(syncId);
      const inventory = operations.find((operation) => operation.operation.kind === "inventory");
      const hasPlannedDeterministicOperations = operations.some((operation) => operation.operation.kind !== "inventory");
      if (!inventory) throw new Error("project_environment_inventory_missing");
      if (inventory.status === "unsupported") {
        return this.deps.repos.projectEnvironments.failCurrentSync({
          userId: session.userId,
          projectId,
          adapterId: request.adapterId,
          syncId
        });
      }
      const { entries } = this.deps.repos.projectEnvironments.inventoryEntries(syncId);
      const classification = classifyProjectInventory(entries);
      if (classification.kind === "code" && !hasPlannedDeterministicOperations) {
        const capabilities = WorkspaceBridgeCapabilitiesSchema.parse(inventory.evidence.capabilities);
        const planned = planDeterministicOperations(entries, capabilities);
        if (planned.length > 0) {
          return this.deps.repos.projectEnvironments.planDeterministicOperations({
            userId: session.userId,
            projectId,
            adapterId: request.adapterId,
            syncId,
            operations: planned
          });
        }
      }
      const latest = this.deps.repos.projectEnvironments.listActiveOperations(syncId);
      if (classification.kind === "folder" || latest.every((operation) => operation.isComplete)) {
        return this.finalizeDeterministic(session, projectId, request.adapterId, syncId);
      }
    }
    return this.deps.repos.projectEnvironments.response(session.userId, projectId, request.adapterId);
  }

  status(session: SessionRecord, projectId: string, syncId: string, adapterId: string): ProjectEnvironmentSyncResponse {
    const state = this.deps.repos.projectEnvironments.getState(session.userId, projectId);
    if (!state || state.currentSyncId !== syncId) throw new Error("project_environment_sync_conflict");
    return this.deps.repos.projectEnvironments.response(session.userId, projectId, adapterId);
  }

  async processSummaryJob(job: EvolutionJobRecord): Promise<void> {
    await this.profilePipeline.process(job);
  }

  private finalizeDeterministic(
    session: SessionRecord,
    projectId: string,
    adapterId: string,
    syncId: string
  ): ProjectEnvironmentSyncResponse {
    const { entries, omittedCount } = this.deps.repos.projectEnvironments.inventoryEntries(syncId);
    const classification = classifyProjectInventory(entries);
    const operations = this.deps.repos.projectEnvironments.deterministicEvidence(syncId);
    const facts = parseDeterministicProjectFacts({ entries, operations });
    const derived: ProjectEnvironmentDerivedEvidence = {
      projectKind: classification.kind,
      compactFileTree: buildCompactFileTree(entries),
      omittedCount,
      deterministicProfile: classification.kind === "code"
        ? renderDeterministicCodeProfile(facts, omittedCount)
        : null,
      fingerprint: projectFingerprint({
        kind: classification.kind,
        entries,
        omittedCount,
        deterministicFacts: facts
      })
    };
    return this.deps.repos.projectEnvironments.commitDeterministic({
      userId: session.userId,
      projectId,
      adapterId,
      syncId,
      derived,
      sessionId: session.id
    });
  }
}

function planDeterministicOperations(
  entries: Parameters<typeof deterministicReadCandidates>[0],
  capabilities: WorkspaceBridgeCapabilities
): ProjectWorkspaceOperation[] {
  const readOperations: ProjectWorkspaceOperation[] = deterministicReadCandidates(entries, capabilities).map((candidate) => ({
    operationId: newId("l3wm_op"),
    kind: "read_text",
    relativePath: candidate.relativePath,
    expectedSha256: candidate.sha256,
    maxBytes: candidate.maxBytes
  }));
  const probeOperations: ProjectWorkspaceOperation[] = requiredRuntimeProbes(entries, capabilities).map((probe) => ({
    operationId: newId("l3wm_op"),
    kind: "runtime_probe",
    probe
  }));
  return [...readOperations, ...probeOperations];
}
