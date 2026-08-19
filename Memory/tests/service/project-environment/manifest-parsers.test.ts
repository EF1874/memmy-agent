import { describe, expect, it } from "vitest";
import type { InventoryEntry } from "@memmy/local-api-contracts";
import {
  parseDeterministicProjectFacts
} from "../../../src/service/project-environment/manifest-parsers.js";
import type {
  ProjectEnvironmentOperationRecord
} from "../../../src/storage/repositories.js";

describe("deterministic project manifest parsers", () => {
  it("extracts Node, Python, Rust, Go, JVM and .NET facts without executing configuration", () => {
    const operations = [
      read("package.json", JSON.stringify({
        packageManager: "pnpm@10",
        engines: { node: ">=22" },
        scripts: { build: "tsc", test: "vitest", lint: "eslint ." }
      })),
      read("pyproject.toml", "[project]\nrequires-python='>=3.12'\n[tool.pytest.ini_options]\naddopts='-q'"),
      read("Cargo.toml", "[package]\nname='demo'"),
      read("go.mod", "module example.test/demo\n\ngo 1.24\n"),
      read("pom.xml", "<project><artifactId>demo</artifactId></project>"),
      read("demo.csproj", "<Project Sdk='Microsoft.NET.Sdk'></Project>")
    ];
    const facts = parseDeterministicProjectFacts({ entries: sourceEntries(), operations });
    expect(values(facts.manifestLanguages)).toEqual(expect.arrayContaining([
      "Node.js/JavaScript", "Python", "Rust", "Go", "Java", ".NET/C#"
    ]));
    expect(values(facts.toolchains)).toEqual(expect.arrayContaining([
      "pnpm@10", "pytest", "Cargo", "Go modules", "Maven", ".NET SDK"
    ]));
    expect(values(facts.buildEntries)).toEqual(expect.arrayContaining([
      "npm run build", "cargo build", "go build ./...", "mvn package", "dotnet build"
    ]));
    expect(values(facts.testEntries)).toEqual(expect.arrayContaining([
      "npm run test", "pytest", "cargo test", "go test ./...", "mvn test", "dotnet test"
    ]));
  });

  it("parses static YAML, INI, Docker, Make and static JS while ignoring dynamic JS", () => {
    const operations = [
      read(".github/workflows/ci.yml", "jobs:\n  test:\n    steps:\n      - run: npm run build\n      - run: npm test\n      - run: npm run lint"),
      read("tox.ini", "[tox]\nenvlist=py312\n[testenv]\ncommands=pytest"),
      read("setup.cfg", "[tool:pytest]\naddopts=-q\n[flake8]\nmax-line-length=100"),
      read("Dockerfile", "FROM node:22-alpine\nRUN npm ci"),
      read("Makefile", "build:\n\tgo build ./...\ntest:\n\tgo test ./...\ncheck:\n\tgo vet ./..."),
      read("eslint.config.js", "export default [{ rules: { semi: 'error' } }]")
    ];
    const facts = parseDeterministicProjectFacts({ entries: [], operations });
    expect(values(facts.toolchains)).toEqual(expect.arrayContaining([
      "CI", "tox", "pytest", "Flake8", "Docker", "Make", "ESLint"
    ]));
    expect(values(facts.buildEntries)).toEqual(expect.arrayContaining(["npm run build", "docker build .", "make build"]));
    expect(values(facts.testEntries)).toEqual(expect.arrayContaining(["npm test", "tox", "pytest", "make test"]));
    expect(values(facts.checkEntries)).toEqual(expect.arrayContaining(["npm run lint", "flake8", "make check"]));

    const dynamic = parseDeterministicProjectFacts({
      entries: [],
      operations: [read("eslint.config.js", "export default makeConfig(process.env.SECRET)")]
    });
    expect(values(dynamic.toolchains)).not.toContain("ESLint");
  });

  it("uses only accepted operation evidence and preserves runtime probe facts", () => {
    const unsupported = read("package.json", "{}", "unsupported");
    const probe: ProjectEnvironmentOperationRecord = {
      ...baseOperation("runtime_probe"),
      operation: { operationId: "probe", kind: "runtime_probe", probe: "node_version" },
      evidence: {
        operationId: "probe",
        kind: "runtime_probe",
        status: "accepted",
        probe: "node_version",
        exitCode: 0,
        versionText: "v22.22.2"
      }
    };
    const facts = parseDeterministicProjectFacts({ entries: sourceEntries(), operations: [unsupported, probe] });
    expect(facts.runtimeProbes).toEqual([{ probe: "node_version", value: "v22.22.2" }]);
    expect(values(facts.manifestLanguages)).not.toContain("Node.js/JavaScript");
    expect(facts.languageCounts).toEqual({ ".py": 1, ".ts": 1 });
  });
});

function sourceEntries(): InventoryEntry[] {
  return [file("src/index.ts"), file("tools/main.py")];
}

function file(relativePath: string): Extract<InventoryEntry, { type: "file" }> {
  return { relativePath, type: "file", size: 1, mtimeMs: 1 };
}

function values(facts: Array<{ value: string }>): string[] {
  return facts.map((fact) => fact.value);
}

function read(
  relativePath: string,
  text: string,
  status: ProjectEnvironmentOperationRecord["status"] = "accepted"
): ProjectEnvironmentOperationRecord {
  const operationId = `read-${relativePath}`;
  return {
    ...baseOperation("read_text"),
    operationId,
    status,
    operation: {
      operationId,
      kind: "read_text",
      relativePath,
      expectedSha256: "a".repeat(64),
      maxBytes: 1024
    },
    evidence: status === "accepted"
      ? { operationId, kind: "read_text", status: "accepted", relativePath, sha256: "a".repeat(64), text }
      : { operationId, kind: "read_text", status: "unsupported", reason: "too_large" }
  };
}

function baseOperation(kind: "read_text" | "runtime_probe"): ProjectEnvironmentOperationRecord {
  return {
    syncId: "sync",
    operationId: kind,
    userId: "user",
    projectId: "project",
    adapterId: "adapter",
    operation: kind === "read_text"
      ? {
          operationId: kind,
          kind,
          relativePath: "package.json",
          expectedSha256: "a".repeat(64),
          maxBytes: 1024
        }
      : { operationId: kind, kind, probe: "node_version" },
    status: "accepted",
    evidence: {},
    resultHash: "b".repeat(64),
    nextPageIndex: 0,
    isComplete: true,
    attempts: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
