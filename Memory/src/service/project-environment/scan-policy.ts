import {
  canonicalJson,
  isProjectEnvironmentDeterministicCandidate,
  PROJECT_ENVIRONMENT_SOURCE_EXTENSIONS,
  sha256Hex,
  type InventoryEntry,
  type RuntimeProbe,
  type WorkspaceBridgeCapabilities
} from "@memmy/local-api-contracts";

export const PROJECT_SOURCE_EXTENSIONS = PROJECT_ENVIRONMENT_SOURCE_EXTENSIONS;

export function isDeterministicCandidate(relativePath: string): boolean {
  return isProjectEnvironmentDeterministicCandidate(relativePath);
}

export function buildCompactFileTree(entries: InventoryEntry[]): string {
  const paths = entries.map((entry) => ({ path: entry.relativePath, directory: entry.type === "directory" }));
  const children = new Map<string, Map<string, boolean>>();
  for (const item of paths) {
    const segments = item.path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      const name = segments[index]!;
      const isDirectory = index < segments.length - 1 || item.directory;
      const siblings = children.get(parent) ?? new Map<string, boolean>();
      siblings.set(name, (siblings.get(name) ?? false) || isDirectory);
      children.set(parent, siblings);
    }
  }
  const lines: string[] = [];
  const visit = (parent: string, depth: number): void => {
    const siblings = children.get(parent);
    if (!siblings) return;
    for (const [name, isDirectory] of [...siblings.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
      lines.push(`${"  ".repeat(depth)}${name}${isDirectory ? "/" : ""}`);
      if (isDirectory) visit(parent ? `${parent}/${name}` : name, depth + 1);
    }
  };
  visit("", 0);
  return lines.join("\n");
}

export function projectFingerprint(input: {
  kind: "code" | "folder";
  entries: InventoryEntry[];
  omittedCount: number;
  deterministicFacts: unknown;
}): string {
  const sortedTypeAndPath = input.entries
    .map((entry) => `${entry.type}:${entry.relativePath}`)
    .sort(compareCodePoints);
  const sortedCandidatePathAndHash = input.entries
    .filter((entry): entry is Extract<InventoryEntry, { type: "file" }> & { sha256: string } =>
      entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
    .map((entry) => `${entry.relativePath}:${entry.sha256}`)
    .sort(compareCodePoints);
  return sha256Hex(canonicalJson({
    kind: input.kind,
    sortedTypeAndPath,
    sortedCandidatePathAndHash,
    omittedCount: input.omittedCount,
    deterministicFacts: JSON.parse(JSON.stringify(input.deterministicFacts))
  }));
}

export function requiredRuntimeProbes(
  entries: InventoryEntry[],
  capabilities: WorkspaceBridgeCapabilities
): RuntimeProbe[] {
  if (!capabilities.operations.includes("runtime_probe")) return [];
  const paths = new Set(entries.map((entry) => entry.relativePath.toLowerCase()));
  const extensions = new Set(entries.map((entry) => extensionOf(entry.relativePath.toLowerCase())));
  const probes: RuntimeProbe[] = [];
  if (paths.has("package.json") || extensions.has(".js") || extensions.has(".ts") || extensions.has(".tsx")) probes.push("node_version");
  if (paths.has("pyproject.toml") || extensions.has(".py")) probes.push("python_version");
  if (paths.has("go.mod") || extensions.has(".go")) probes.push("go_version");
  if (paths.has("cargo.toml") || extensions.has(".rs")) probes.push("rust_version");
  if (paths.has("pom.xml") || paths.has("build.gradle") || extensions.has(".java") || extensions.has(".kt")) probes.push("java_version");
  return probes;
}

export function deterministicReadCandidates(
  entries: InventoryEntry[],
  capabilities: WorkspaceBridgeCapabilities
): Array<{ relativePath: string; sha256: string; maxBytes: number }> {
  if (!capabilities.operations.includes("read_text")) return [];
  const maxBytes = Math.min(capabilities.maxTextBytes, 1024 * 1024);
  return entries
    .filter((entry): entry is Extract<InventoryEntry, { type: "file" }> & { sha256: string } =>
      entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
    .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
    .map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256, maxBytes }));
}

export function extensionOf(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const index = basename.lastIndexOf(".");
  return index <= 0 ? "" : basename.slice(index).toLowerCase();
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
