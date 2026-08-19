import type { DeterministicProjectFacts } from "./manifest-parsers.js";

export function renderDeterministicCodeProfile(
  facts: DeterministicProjectFacts,
  omittedCount: number
): string {
  const manifestLanguages = values(facts.manifestLanguages);
  const extensionLanguages = Object.entries(facts.languageCounts)
    .sort(([left], [right]) => compare(left, right))
    .map(([extension, count]) => `${languageName(extension)}(${extension})=${count}`);
  const lines = [
    `语言：${[...manifestLanguages, ...extensionLanguages].join("、") || "未识别"}`,
    `运行时声明：${values(facts.runtimeDeclarations).join("、") || "未识别"}`,
    `运行时探测：${facts.runtimeProbes.map((fact) => `${fact.probe}=${fact.value}`).join("、") || "未识别"}`,
    `工具链：${values(facts.toolchains).join("、") || "未识别"}`,
    `构建入口：${values(facts.buildEntries).join("；") || "未识别"}`,
    `测试入口：${values(facts.testEntries).join("；") || "未识别"}`,
    `检查入口：${values(facts.checkEntries).join("；") || "未识别"}`
  ];
  if (omittedCount > 0) {
    lines.push(`证据范围：文件清单已省略 ${omittedCount} 个路径，画像仅基于已登记部分`);
  }
  return lines.join("\n");
}

export function renderProjectEnvironmentProfile(input: {
  projectKind: "code" | "folder";
  deterministicProfile: string | null;
  summary: string | null;
  omittedCount: number;
}): string | null {
  if (input.projectKind === "code") {
    const parts = [
      input.deterministicProfile?.trim() || null,
      input.summary?.trim() ? `代码摘要：${input.summary.trim()}` : null
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (!input.summary?.trim()) return null;
  const parts = [`项目摘要：${input.summary.trim()}`];
  if (input.omittedCount > 0) {
    parts.push(`证据范围：文件清单已省略 ${input.omittedCount} 个路径，摘要仅基于已登记部分`);
  }
  return parts.join("\n");
}

function values(facts: Array<{ value: string }>): string[] {
  return facts.map((fact) => fact.value);
}

function languageName(extension: string): string {
  return ({
    ".c": "C", ".cc": "C++", ".cpp": "C++", ".cs": "C#", ".go": "Go", ".h": "C/C++",
    ".hpp": "C++", ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript/JSX", ".kt": "Kotlin",
    ".kts": "Kotlin", ".mjs": "JavaScript", ".cjs": "JavaScript", ".php": "PHP", ".py": "Python",
    ".rb": "Ruby", ".rs": "Rust", ".scala": "Scala", ".swift": "Swift", ".ts": "TypeScript",
    ".tsx": "TypeScript/TSX"
  } as Record<string, string>)[extension] ?? extension;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
