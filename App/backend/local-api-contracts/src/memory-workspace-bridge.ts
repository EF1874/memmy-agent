/** Shared Workspace Bridge v1 wire contract. */
import { z } from "zod";
import { L3WorldModelRequestEnvelopeSchema } from "./memory-l3-world-model.js";

const NonEmptyStringSchema = z.string().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ProjectEnvironmentSyncTriggerSchema = z.enum(["session_start", "token_compaction"]);
export type ProjectEnvironmentSyncTrigger = z.infer<typeof ProjectEnvironmentSyncTriggerSchema>;

export const ProjectEnvironmentSyncStatusSchema = z.enum([
  "uninitialized",
  "dirty",
  "collecting_inventory",
  "deterministic_ready",
  "summarizing",
  "clean",
  "failed"
]);
export type ProjectEnvironmentSyncStatus = z.infer<typeof ProjectEnvironmentSyncStatusSchema>;

export const ProjectEnvironmentScanPolicySchema = z.object({
  policyVersion: z.literal("project_environment.v1"),
  maxDepth: z.literal(20),
  maxEntries: z.literal(20000),
  maxPageEntries: z.literal(500),
  maxRelativePathUtf8Bytes: z.literal(4096),
  followSymbolicLinks: z.literal(false),
  respectGitignore: z.literal(true)
}).strict();
export type ProjectEnvironmentScanPolicy = z.infer<typeof ProjectEnvironmentScanPolicySchema>;

export const PROJECT_ENVIRONMENT_SCAN_POLICY_V1: ProjectEnvironmentScanPolicy = {
  policyVersion: "project_environment.v1",
  maxDepth: 20,
  maxEntries: 20000,
  maxPageEntries: 500,
  maxRelativePathUtf8Bytes: 4096,
  followSymbolicLinks: false,
  respectGitignore: true
};

export const WorkspaceBridgeOperationKindSchema = z.enum(["inventory", "read_text", "runtime_probe"]);
export type WorkspaceBridgeOperationKind = z.infer<typeof WorkspaceBridgeOperationKindSchema>;

export const WorkspaceBridgeCapabilitiesSchema = z.object({
  protocolVersion: z.literal("1"),
  operations: z.array(WorkspaceBridgeOperationKindSchema).min(1),
  maxTextBytes: z.number().int().positive()
}).strict().superRefine((value, context) => {
  if (new Set(value.operations).size !== value.operations.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "operations must be unique" });
  }
});
export type WorkspaceBridgeCapabilities = z.infer<typeof WorkspaceBridgeCapabilitiesSchema>;

export const WorkspaceRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  const message = validateWorkspaceRelativePath(value);
  if (message) context.addIssue({ code: "custom", message });
});
export type WorkspaceRelativePath = z.infer<typeof WorkspaceRelativePathSchema>;

export const RuntimeProbeSchema = z.enum([
  "node_version",
  "python_version",
  "go_version",
  "rust_version",
  "java_version"
]);
export type RuntimeProbe = z.infer<typeof RuntimeProbeSchema>;

export const ProjectWorkspaceOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("inventory"),
    policy: ProjectEnvironmentScanPolicySchema,
    mode: z.literal("full")
  }).strict(),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("read_text"),
    relativePath: WorkspaceRelativePathSchema,
    expectedSha256: Sha256Schema,
    maxBytes: z.number().int().positive().max(1024 * 1024)
  }).strict(),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("runtime_probe"),
    probe: RuntimeProbeSchema
  }).strict()
]);
export type ProjectWorkspaceOperation = z.infer<typeof ProjectWorkspaceOperationSchema>;

export const InventoryEntrySchema = z.discriminatedUnion("type", [
  z.object({
    relativePath: WorkspaceRelativePathSchema,
    type: z.literal("directory"),
    mtimeMs: z.number().int().nonnegative().safe()
  }).strict(),
  z.object({
    relativePath: WorkspaceRelativePathSchema,
    type: z.literal("file"),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
    sha256: Sha256Schema.optional()
  }).strict()
]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

export const ProjectWorkspaceUnsupportedReasonSchema = z.enum([
  "permission_denied",
  "unsafe_path",
  "unsafe_probe",
  "unsupported_operation",
  "too_large",
  "body_limit",
  "unavailable_runtime",
  "unstable_workspace"
]);
export type ProjectWorkspaceUnsupportedReason = z.infer<typeof ProjectWorkspaceUnsupportedReasonSchema>;

export const ProjectWorkspaceEvidenceSchema = z.union([
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("inventory"),
    status: z.literal("accepted"),
    pageIndex: z.number().int().nonnegative(),
    isLast: z.boolean(),
    omittedCount: z.number().int().nonnegative().safe().optional(),
    pageHash: Sha256Schema,
    entries: z.array(InventoryEntrySchema).max(500)
  }).strict().superRefine((value, context) => {
    if (!value.isLast && value.omittedCount !== undefined) {
      context.addIssue({ code: "custom", path: ["omittedCount"], message: "omittedCount is only valid on the last page" });
    }
  }),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("read_text"),
    status: z.literal("accepted"),
    relativePath: WorkspaceRelativePathSchema,
    sha256: Sha256Schema,
    text: z.string()
  }).strict(),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("read_text"),
    status: z.literal("stale"),
    relativePath: WorkspaceRelativePathSchema,
    actualSha256: Sha256Schema
  }).strict(),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: z.literal("runtime_probe"),
    status: z.literal("accepted"),
    probe: RuntimeProbeSchema,
    exitCode: z.number().int(),
    versionText: z.string().max(256).nullable()
  }).strict(),
  z.object({
    operationId: NonEmptyStringSchema,
    kind: WorkspaceBridgeOperationKindSchema,
    status: z.literal("unsupported"),
    reason: ProjectWorkspaceUnsupportedReasonSchema
  }).strict()
]);
export type ProjectWorkspaceEvidence = z.infer<typeof ProjectWorkspaceEvidenceSchema>;

export const ProjectEnvironmentSyncStartRequestSchema = L3WorldModelRequestEnvelopeSchema.safeExtend({
  sessionId: NonEmptyStringSchema,
  trigger: ProjectEnvironmentSyncTriggerSchema,
  capabilities: WorkspaceBridgeCapabilitiesSchema
}).strict();
export type ProjectEnvironmentSyncStartRequest = z.infer<typeof ProjectEnvironmentSyncStartRequestSchema>;

export const ProjectEnvironmentSyncEvidenceRequestSchema = L3WorldModelRequestEnvelopeSchema.safeExtend({
  sessionId: NonEmptyStringSchema,
  evidence: ProjectWorkspaceEvidenceSchema
}).strict();
export type ProjectEnvironmentSyncEvidenceRequest = z.infer<typeof ProjectEnvironmentSyncEvidenceRequestSchema>;

export const ProjectEnvironmentSyncStatusQuerySchema = z.object({
  sessionId: NonEmptyStringSchema,
  adapterId: NonEmptyStringSchema,
  source: NonEmptyStringSchema
}).strict();
export type ProjectEnvironmentSyncStatusQuery = z.infer<typeof ProjectEnvironmentSyncStatusQuerySchema>;

export const ProjectEnvironmentSyncResponseSchema = z.object({
  syncId: NonEmptyStringSchema,
  scanId: NonEmptyStringSchema.nullable(),
  status: ProjectEnvironmentSyncStatusSchema,
  operations: z.array(ProjectWorkspaceOperationSchema)
}).strict();
export type ProjectEnvironmentSyncResponse = z.infer<typeof ProjectEnvironmentSyncResponseSchema>;

export const MEMORY_WORKSPACE_BRIDGE_FIXTURE = {
  policy: PROJECT_ENVIRONMENT_SCAN_POLICY_V1,
  relativePath: "src/index.ts",
  invalidRelativePaths: ["../secret", "/absolute", "C:/absolute", "dir\\file", "./file"]
} as const;

export const PROJECT_ENVIRONMENT_SOURCE_EXTENSIONS = [
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".kts", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".scala",
  ".swift", ".ts", ".tsx"
] as const;

/** The only files Workspace Bridge v1 may hash and return through read_text. */
export function isProjectEnvironmentDeterministicCandidate(relativePath: string): boolean {
  if (validateWorkspaceRelativePath(relativePath) || isProjectEnvironmentSensitivePath(relativePath)) return false;
  const segments = relativePath.split("/");
  const basename = segments.at(-1)!;
  const lower = basename.toLowerCase();
  const depth = segments.length - 1;
  if (segments.length === 3 && segments[0] === ".github" && segments[1] === "workflows" && /\.(ya?ml)$/i.test(basename)) return true;
  if (depth <= 2 && /\.(sln|csproj)$/i.test(basename)) return true;
  if (depth !== 0) return false;
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|makefile)$/i.test(basename)) return true;
  if (/^(package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lock)$/i.test(basename)) return true;
  if (/^(tsconfig|jsconfig).*\.json$/i.test(basename)) return true;
  if (/^(eslint\.config\.(js|cjs|mjs|ts)|\.eslintrc(\.(json|ya?ml|js|cjs))?)$/i.test(basename)) return true;
  if (/^(jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|mjs|ts))$/i.test(basename)) return true;
  if (/^(poetry\.lock|uv\.lock|requirements.*\.txt|\.python-version|tox\.ini|pytest\.ini|setup\.cfg)$/i.test(basename)) return true;
  if (/^(cargo\.lock|rust-toolchain(\.toml)?|go\.sum|go\.work(\.sum)?)$/i.test(basename)) return true;
  if (/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/i.test(basename)) return true;
  if (/^(dockerfile(\..*)?|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(basename)) return true;
  if (/^(\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile)$/i.test(basename)) return true;
  return /^(\.nvmrc|\.node-version|\.tool-versions|\.java-version|\.ruby-version)$/i.test(basename);
}

export function isProjectEnvironmentSensitivePath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return basename.startsWith(".env") || basename.includes("credentials") || basename.includes("secret") ||
    /\.(pem|key|p12|pfx|crt|cer)$/i.test(basename) || basename === ".npmrc" ||
    basename === ".pypirc" || basename === "settings.xml" || lower.startsWith(".ssh/");
}

export function validateWorkspaceRelativePath(value: string): string | null {
  if (new TextEncoder().encode(value).byteLength > 4096) return "relative path exceeds 4096 UTF-8 bytes";
  if (value.includes("\0")) return "relative path must not contain NUL";
  if (value.includes("\\")) return "relative path must use forward slashes";
  if (value.startsWith("/") || value.startsWith("//")) return "relative path must not be absolute";
  if (/^[A-Za-z]:/.test(value)) return "relative path must not include a Windows drive prefix";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "relative path contains an empty, dot, or parent segment";
  }
  return null;
}
