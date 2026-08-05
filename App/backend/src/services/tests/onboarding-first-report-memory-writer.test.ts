import { describe, expect, it, vi } from "vitest";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createOnboardingFirstReportMemoryWriter } from "../onboarding-first-report-memory-writer.js";

type FirstReportMemoryClient = Pick<
  MemoryClient,
  "addMemory" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "runWorker"
>;

describe("onboarding first-report memory writer", () => {
  it("stores a bilingual cross-Agent memory and waits for summary and index readiness", async () => {
    const addMemory = vi.fn(async () => ({ id: "memory-first-report" }) as Awaited<ReturnType<MemoryClient["addMemory"]>>);
    const enqueueImportSummaries = vi.fn(async () => ({
      enqueued: 1,
      memoryIds: ["memory-first-report"]
    }) as Awaited<ReturnType<MemoryClient["enqueueImportSummaries"]>>);
    const states: Array<"summary_pending" | "embedding_pending" | "ready"> = [
      "summary_pending",
      "embedding_pending",
      "ready"
    ];
    const getMemoryProcessingStatus = vi.fn(async () => ({
      items: [{
        memoryId: "memory-first-report",
        state: states.shift() ?? "ready",
        attemptCount: 0,
        manualRetryCount: 0,
        retryAction: "none",
        updatedAt: "2026-08-05T10:00:00.000Z"
      }]
    }) as Awaited<ReturnType<MemoryClient["getMemoryProcessingStatus"]>>);
    const runWorker = vi.fn(async () => ({
      leased: 1,
      succeeded: 1,
      failed: 0,
      jobs: [],
      embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] }
    }) as Awaited<ReturnType<MemoryClient["runWorker"]>>);
    const memoryClient = {
      addMemory,
      enqueueImportSummaries,
      getMemoryProcessingStatus,
      runWorker
    } satisfies FirstReportMemoryClient;
    const writer = createOnboardingFirstReportMemoryWriter(memoryClient);

    await writer.write({
      locale: "zh-CN",
      reportMarkdown: "## 你的偏好\n- 喜欢中文回答。\n\n## 接下来可以做\n1. 运行测试。",
      projects: ["Memmy"],
      keywords: ["onboarding", "Memory"],
      latestConversation: {
        agentSource: "Codex",
        conversationId: "conversation-123",
        workspacePath: "/Users/jiang/MyProject/memmy-agent-jiang",
        messages: [
          { role: "user", createdAt: "2026-08-05T09:00:00.000Z", text: "修改初见报告。" },
          { role: "assistant", createdAt: "2026-08-05T09:01:00.000Z", text: "已经修改 prompt。" },
          { role: "tool", createdAt: "2026-08-05T09:02:00.000Z", text: "npm test: success" }
        ]
      }
    });

    const added = addMemory.mock.calls[0]?.[0];
    expect(added).toMatchObject({
      adapterId: "agent-source:memmy-onboarding",
      source: "memmy-onboarding",
      layer: "L1",
      deferProcessing: true,
      tags: expect.arrayContaining([
        "agent-source",
        "memmy",
        "初见报告",
        "memmy-first-report",
        "first-encounter-report",
        "onboarding-report",
        "continue-from-first-report",
        "cross-agent-handoff",
        "Memmy",
        "onboarding",
        "Memory"
      ])
    });
    expect(added?.content).toContain("## user\n\nMemmy 初见报告 / Memmy First Encounter Report / Onboarding Report");
    expect(added?.content).toContain("Memmy first report, first encounter report, onboarding report");
    expect(added?.content).toContain("请接着我刚才在 Memmy 里的初见报告继续聊天");
    expect(added?.content).toContain("Please continue from the first report I just had in Memmy");
    expect(added?.content).toContain("【User query / 用户请求");
    expect(added?.content).toContain("【Agent reply / Agent 回复");
    expect(added?.content).toContain("【Tool call or result / 简略工具调用");
    expect(added?.content).toContain("## assistant\n\nMemmy 初见报告 / Memmy First Encounter Report / Onboarding Report");
    expect(added?.content).toContain("## 接下来可以做\n1. 运行测试。");
    expect(enqueueImportSummaries).toHaveBeenCalledWith(["memory-first-report"]);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runWorker).toHaveBeenCalledWith({
      limit: 4,
      targetMemoryIds: ["memory-first-report"],
      priorityCohortOnly: true,
      timeoutMs: 180_000
    });
    expect(addMemory.mock.invocationCallOrder[0]).toBeLessThan(enqueueImportSummaries.mock.invocationCallOrder[0] ?? 0);
    expect(enqueueImportSummaries.mock.invocationCallOrder[0]).toBeLessThan(runWorker.mock.invocationCallOrder[0] ?? 0);
  });
});
