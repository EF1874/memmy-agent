import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";

const FIRST_REPORT_SOURCE = "memmy-onboarding";
const FIRST_REPORT_PROCESSING_TIMEOUT_MS = 180_000;
const FIRST_REPORT_TAGS = [
  "agent-source",
  "memmy",
  "初见报告",
  "首次登录",
  "memmy-first-report",
  "first-encounter-report",
  "onboarding-report",
  "continue-from-first-report",
  "cross-agent-handoff"
] as const;

export interface OnboardingFirstReportMemoryInput {
  locale: "zh-CN" | "en-US";
  reportMarkdown: string;
  projects: readonly string[];
  keywords: readonly string[];
  latestConversation: {
    agentSource: string;
    conversationId: string;
    workspacePath: string | null;
    messages: ReadonlyArray<{
      role: "user" | "assistant" | "tool";
      createdAt: string;
      text: string;
    }>;
  };
}

export interface OnboardingFirstReportMemoryWriter {
  write(input: OnboardingFirstReportMemoryInput): Promise<void>;
}

export function createOnboardingFirstReportMemoryWriter(
  memoryClient: Pick<
    MemoryClient,
    "addMemory" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "runWorker"
  >,
  now: () => number = Date.now
): OnboardingFirstReportMemoryWriter {
  return {
    async write(input) {
      const stableId = shortHash(`${input.latestConversation.agentSource}:${input.latestConversation.conversationId}`);
      const memory = await memoryClient.addMemory({
        requestId: `first-report:${stableId}`,
        adapterId: `agent-source:${FIRST_REPORT_SOURCE}`,
        content: renderMemoryContent(input),
        layer: "L1",
        title: firstReportTitle(input),
        tags: uniqueStrings([...FIRST_REPORT_TAGS, ...input.projects, ...input.keywords]),
        source: FIRST_REPORT_SOURCE,
        turnId: `first-report:${stableId}`,
        deferProcessing: true
      });

      await memoryClient.enqueueImportSummaries([memory.id]);
      await processFirstReportMemory(memoryClient, memory.id, now);
    }
  };
}

function renderMemoryContent(input: OnboardingFirstReportMemoryInput): string {
  const latestUserQuery = [...input.latestConversation.messages]
    .reverse()
    .find((message) => message.role === "user")?.text ?? "";
  const projects = input.projects.join(", ") || "unknown";
  const keywords = input.keywords.join(", ") || "unknown";
  const transcript = input.latestConversation.messages.map((message) => {
    const label = message.role === "user"
      ? "User query / 用户请求"
      : message.role === "assistant" ? "Agent reply / Agent 回复" : "Tool call or result / 简略工具调用";
    return `【${label} · ${message.createdAt}】\n${message.text}`;
  }).join("\n\n");

  return [
    "## user",
    "Memmy 初见报告 / Memmy First Encounter Report / Onboarding Report 跨 Agent 任务接续记忆",
    `Source Agent: ${input.latestConversation.agentSource}`,
    `Workspace: ${input.latestConversation.workspacePath ?? "unknown"}`,
    `Projects / 项目: ${projects}`,
    `Keywords / 关键词: ${keywords}`,
    "Retrieval aliases / 检索别名: Memmy 初见报告, Memmy first report, first encounter report, onboarding report, 首次登录报告, 最近项目, recent project, 最近任务, latest task, current bug, continue task, cross-agent handoff",
    "Continuation trigger / 中文接续触发词: 请接着我刚才在 Memmy 里的初见报告继续聊天。先告诉我我们已经确定了什么，再给出一个最合适的下一步。",
    "Continuation trigger / English handoff query: Please continue from the first report I just had in Memmy. First tell me what we already decided, then give me the single best next step.",
    `Latest request / 最近请求: ${latestUserQuery}`,
    "The following is the scanned first 2 and latest 12 conversation turns, including compact tool calls. Treat the whole block as the user query for cross-Agent continuation.",
    "以下是扫描到的前 2 轮与最近 12 轮对话及简略工具调用；请把整段作为跨 Agent 接续所需的用户请求上下文。",
    transcript,
    "## assistant",
    "Memmy 初见报告 / Memmy First Encounter Report / Onboarding Report",
    input.reportMarkdown
  ].join("\n\n");
}

async function processFirstReportMemory(
  memoryClient: Pick<MemoryClient, "getMemoryProcessingStatus" | "runWorker">,
  memoryId: string,
  now: () => number
): Promise<void> {
  const deadline = now() + FIRST_REPORT_PROCESSING_TIMEOUT_MS;
  while (now() < deadline) {
    const processing = (await memoryClient.getMemoryProcessingStatus([memoryId])).items[0];
    if (!processing) {
      throw new Error(`First-report memory processing state is missing: ${memoryId}`);
    }
    if (processing.state === "ready") {
      return;
    }
    if (processing.state === "failed" || processing.state === "ready_text_only") {
      throw new Error(`First-report memory was not indexed: ${processing.state}`);
    }

    const run = await memoryClient.runWorker({
      limit: 4,
      targetMemoryIds: [memoryId],
      priorityCohortOnly: true,
      timeoutMs: FIRST_REPORT_PROCESSING_TIMEOUT_MS
    });
    if (run.leased === 0 && run.embeddingRetries.leased === 0) {
      await delay(100);
    }
  }
  throw new Error(`First-report memory indexing timed out: ${memoryId}`);
}

function firstReportTitle(input: OnboardingFirstReportMemoryInput): string {
  const topic = input.projects[0] ?? input.keywords[0];
  return topic
    ? `Memmy 初见报告 / First Encounter Report — ${topic}`
    : "Memmy 初见报告 / First Encounter Report";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
