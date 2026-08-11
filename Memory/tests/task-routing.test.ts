import { describe, expect, it } from "vitest";
import { MemoryModelTaskRouter, type MemoryModelTaskContext } from "../src/model/task-routing.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../src/model/types.js";

function client(name: string): LlmClient {
  return {
    config: {
      provider: "openai_compatible",
      endpoint: "https://example.test/v1",
      model: name,
      apiKey: "test-key",
      sourceProvider: name,
      enableThinking: false,
      temperature: 0.7,
      timeoutMs: 1_000,
      maxRetries: 0,
      malformedRetries: 0
    },
    isConfigured: () => true,
    complete: async (_messages: LlmMessage[], _options: LlmCompletionOptions) => name,
    completeJson: async <T extends Record<string, unknown>>() => ({ name }) as unknown as T,
    status: () => ({
      provider: "openai_compatible",
      model: name,
      configured: true,
      remote: true,
      routing: null
    })
  };
}

function context(name: string): MemoryModelTaskContext {
  return {
    config: { marker: name } as unknown as MemoryModelTaskContext["config"],
    summary: client(`${name}-summary`),
    evolution: client(`${name}-evolution`)
  };
}

describe("MemoryModelTaskRouter", () => {
  it("keeps one immutable model snapshot across all LLM calls in a task", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");

    const result = await router.run(async () => {
      const first = await summary.complete([], { operation: "test.summary" });
      await Promise.resolve();
      const second = await evolution.complete([], { operation: "test.evolution" });
      return [first, second];
    });

    expect(result).toEqual(["task-1-summary", "task-1-evolution"]);
    expect(resolutions).toBe(1);
  });

  it("isolates concurrent tasks even when their asynchronous work interleaves", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.first" });
      await firstPaused;
      const after = await evolution.complete([], { operation: "test.evolution.first" });
      return [before, after];
    });
    const second = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.second" });
      const after = await evolution.complete([], { operation: "test.evolution.second" });
      releaseFirst();
      return [before, after];
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      ["task-1-summary", "task-1-evolution"],
      ["task-2-summary", "task-2-evolution"]
    ]);
    expect(resolutions).toBe(2);
  });
});
