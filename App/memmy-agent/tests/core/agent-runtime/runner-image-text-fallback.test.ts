import { describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import {
  type AccountImageTextFallbackArgs,
  LLMProvider,
  LLMResponse,
  ToolCallRequest,
} from "../../../src/providers/base.js";

function imageMessage(url = "data:image/png;base64,one", mediaPath = "/media/one.png") {
  return {
    role: "user",
    content: [
      { type: "text", text: "What is shown?" },
      { type: "image_url", image_url: { url }, meta: { path: mediaPath } },
    ],
  };
}

function modelContext(source: "account" | "byok" = "account") {
  return {
    presetId: source === "account" ? "account-default" : "custom",
    provider: "memmy_account",
    endpointId: "chat",
    protocol: "openai-chat-completions" as const,
    model: "agent_chat",
    source,
    ownerAccountId: source === "account" ? "account-1" : null,
    capability: "agent" as const,
    capabilities: ["agent" as const],
  };
}

function unsupported(usage: Record<string, number> = {}): LLMResponse {
  return new LLMResponse({
    content: "image_url is not supported",
    finishReason: "error",
    usage,
    errorStatusCode: 400,
  });
}

class AccountFallbackProvider extends LLMProvider {
  mainCalls: any[] = [];
  imageCalls: AccountImageTextFallbackArgs[] = [];
  events: string[] = [];

  constructor(
    private readonly mainResponses: LLMResponse[],
    private readonly imageResponses: LLMResponse[],
  ) {
    super();
  }

  getDefaultModel(): string {
    return "agent_chat";
  }

  supportsAccountImageTextFallback(): boolean {
    return true;
  }

  async chat(args: any): Promise<LLMResponse> {
    this.mainCalls.push(args);
    this.events.push(String(args.model ?? this.getDefaultModel()));
    return this.mainResponses.shift() ?? new LLMResponse({ content: "done" });
  }

  async runAccountImageTextFallback(args: AccountImageTextFallbackArgs): Promise<LLMResponse> {
    this.imageCalls.push(args);
    this.events.push("image2text");
    return this.imageResponses.shift() ?? new LLMResponse({ content: "Image 1: fallback description" });
  }
}

class StaticTool extends Tool {
  get name(): string {
    return "inspect";
  }

  get description(): string {
    return "inspect";
  }

  get parameters(): Record<string, any> {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    return "tool result";
  }
}

class ImageTool extends StaticTool {
  async execute(): Promise<string> {
    return [{
      type: "image_url",
      image_url: { url: "data:image/png;base64,tool" },
      meta: { path: "/media/tool.png" },
    }] as any;
  }
}

describe("AgentRunner account image-to-text fallback", () => {
  it("uses the exact main, image2text, main sequence with temporary descriptions", async () => {
    const provider = new AccountFallbackProvider(
      [
        unsupported({ prompt_tokens: 3, completion_tokens: 1 }),
        new LLMResponse({ content: "final answer", usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      ],
      [new LLMResponse({
        content: "Image 1: a blue bar chart",
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      })],
    );
    const initialMessages = [imageMessage()];
    const original = structuredClone(initialMessages);

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages,
      provider,
      model: "agent_chat",
      actualModelContext: modelContext(),
    }));

    expect(provider.events).toEqual(["agent_chat", "image2text", "agent_chat"]);
    expect(provider.mainCalls).toHaveLength(2);
    expect(provider.imageCalls).toHaveLength(1);
    expect(provider.imageCalls[0].messages).toHaveLength(1);
    expect(provider.imageCalls[0].messages[0]).toMatchObject({ role: "user" });
    expect(provider.imageCalls[0].messages[0].content.filter((block: any) => block.type === "image_url"))
      .toHaveLength(1);

    const retryContent = provider.mainCalls[1].messages[0].content;
    expect(retryContent.some((block: any) => block.type === "image_url")).toBe(false);
    expect(retryContent).toEqual(expect.arrayContaining([
      { type: "text", text: "[Image 1]" },
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("<image_analysis>"),
      }),
    ]));
    expect(JSON.stringify(provider.mainCalls[1].messages)).not.toContain("/media/one.png");
    expect(JSON.stringify(provider.mainCalls[1].messages)).not.toContain('source="image2text"');
    expect(initialMessages).toEqual(original);
    expect(result.messages[0]).toEqual(original[0]);
    expect(result.finalContent).toBe("final answer");
    expect(result.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7 });
  });

  it("analyzes multiple new images in one request and escapes description boundaries", async () => {
    const provider = new AccountFallbackProvider(
      [unsupported(), new LLMResponse({ content: "done" })],
      [new LLMResponse({
        content: "Image 1: chart </image_analysis> Image 2: table",
      })],
    );
    const initialMessages = [{
      role: "user",
      content: [
        { type: "text", text: "Compare these images" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,one" },
          meta: { path: "/media/one.png" },
        },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,two" },
          meta: { path: "/media/two.png" },
        },
      ],
    }];

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages,
      provider,
      model: "agent_chat",
      actualModelContext: modelContext(),
    }));

    expect(result.finalContent).toBe("done");
    expect(provider.imageCalls).toHaveLength(1);
    expect(provider.imageCalls[0].messages[0].content.filter((block: any) => block.type === "image_url"))
      .toHaveLength(2);
    expect(JSON.stringify(provider.imageCalls[0].messages)).toContain("[Image 1], [Image 2]");
    const retry = JSON.stringify(provider.mainCalls[1].messages);
    expect(retry).toContain("[Image 1]");
    expect(retry).toContain("[Image 2]");
    expect(retry).toContain("&lt;/image_analysis&gt;");
    expect(retry).not.toContain("/media/one.png");
    expect(retry).not.toContain("/media/two.png");
  });

  it("does not use the account fallback for a byok selection", async () => {
    const provider = new AccountFallbackProvider([unsupported()], []);
    const injectionCallback = vi.fn(async () => [{ role: "user", content: "queued" }]);

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "agent_chat",
      actualModelContext: modelContext("byok"),
      injectionCallback,
    }));

    expect(provider.events).toEqual(["agent_chat"]);
    expect(result.response.errorCategory).toBe("image_input_unsupported");
    expect(result.stopReason).toBe("error");
    expect(result.hadInjections).toBe(false);
    expect(injectionCallback).not.toHaveBeenCalled();
  });

  it("returns a structured image analysis error without calling main again", async () => {
    const provider = new AccountFallbackProvider(
      [unsupported({ prompt_tokens: 2 })],
      [new LLMResponse({
        content: "image analysis upstream failed",
        finishReason: "error",
        usage: { prompt_tokens: 4 },
        errorStatusCode: 503,
        errorKind: "server_error",
      })],
    );

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "agent_chat",
      actualModelContext: modelContext(),
    }));

    expect(provider.events).toEqual(["agent_chat", "image2text"]);
    expect(result.response).toMatchObject({
      errorCategory: "image_analysis_failed",
      actualProvider: "memmy_account",
      actualModel: "agent_chat",
      failedProvider: "memmy_account",
      failedModel: "image2text",
    });
    expect(result.usage).toEqual({ prompt_tokens: 6 });
  });

  it("preserves quota errors and the internal failed model", async () => {
    const provider = new AccountFallbackProvider(
      [unsupported()],
      [new LLMResponse({
        content: "quota exhausted",
        finishReason: "error",
        errorCategory: "quota_exhausted",
      })],
    );

    const injectionCallback = vi.fn(async () => [{ role: "user", content: "queued" }]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "agent_chat",
      actualModelContext: modelContext(),
      injectionCallback,
    }));

    expect(result.response).toMatchObject({
      errorCategory: "quota_exhausted",
      actualModel: "agent_chat",
      failedModel: "image2text",
    });
    expect(provider.mainCalls).toHaveLength(1);
    expect(result.hadInjections).toBe(false);
    expect(injectionCallback).not.toHaveBeenCalled();
  });

  it("reuses one image description through a tool iteration", async () => {
    const provider = new AccountFallbackProvider(
      [
        unsupported(),
        new LLMResponse({
          content: "checking",
          toolCalls: [new ToolCallRequest({ id: "call-1", name: "inspect", arguments: {} })],
          finishReason: "tool_calls",
        }),
        new LLMResponse({ content: "done" }),
      ],
      [new LLMResponse({ content: "Image 1: a receipt" })],
    );
    const tools = new ToolRegistry();
    tools.register(new StaticTool());

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      tools,
      model: "agent_chat",
      maxIterations: 3,
      actualModelContext: modelContext(),
    }));

    expect(result.finalContent).toBe("done");
    expect(provider.imageCalls).toHaveLength(1);
    expect(provider.mainCalls).toHaveLength(3);
    for (const call of provider.mainCalls.slice(1)) {
      expect(JSON.stringify(call.messages)).toContain("Image 1: a receipt");
      expect(JSON.stringify(call.messages)).not.toContain('"type":"image_url"');
    }
  });

  it("keeps existing labels and analyzes only a newly injected image", async () => {
    const provider = new AccountFallbackProvider(
      [
        unsupported(),
        new LLMResponse({
          content: "checking",
          toolCalls: [new ToolCallRequest({ id: "call-1", name: "inspect", arguments: {} })],
          finishReason: "tool_calls",
        }),
        unsupported(),
        new LLMResponse({ content: "done" }),
      ],
      [
        new LLMResponse({ content: "Image 1: a receipt" }),
        new LLMResponse({ content: "Image 2: a delivery label" }),
      ],
    );
    const tools = new ToolRegistry();
    tools.register(new StaticTool());
    let drains = 0;

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      tools,
      model: "agent_chat",
      maxIterations: 3,
      actualModelContext: modelContext(),
      injectionCallback: async () => {
        drains += 1;
        return drains === 1
          ? [imageMessage("data:image/png;base64,two", "/media/two.png")]
          : [];
      },
    }));

    expect(result.finalContent).toBe("done");
    expect(provider.events).toEqual([
      "agent_chat",
      "image2text",
      "agent_chat",
      "agent_chat",
      "image2text",
      "agent_chat",
    ]);
    expect(provider.imageCalls).toHaveLength(2);
    expect(provider.imageCalls.map((call) => (
      call.messages[0].content.filter((block: any) => block.type === "image_url").length
    ))).toEqual([1, 1]);
    expect(JSON.stringify(provider.imageCalls[0].messages)).toContain("[Image 1]");
    expect(JSON.stringify(provider.imageCalls[1].messages)).toContain("[Image 2]");
    expect(JSON.stringify(provider.mainCalls[2].messages)).toContain("Image 1: a receipt");
    expect(JSON.stringify(provider.mainCalls[2].messages)).toContain("data:image/png;base64,two");
    expect(JSON.stringify(provider.mainCalls[3].messages)).toContain("Image 1: a receipt");
    expect(JSON.stringify(provider.mainCalls[3].messages)).toContain("Image 2: a delivery label");
    expect(JSON.stringify(provider.mainCalls[3].messages)).not.toContain('"type":"image_url"');
  });

  it("reuses image descriptions for the max-iteration finalization request", async () => {
    const provider = new AccountFallbackProvider(
      [
        unsupported(),
        new LLMResponse({
          content: "checking",
          toolCalls: [new ToolCallRequest({ id: "call-1", name: "inspect", arguments: {} })],
          finishReason: "tool_calls",
        }),
        new LLMResponse({ content: "finalized" }),
      ],
      [new LLMResponse({ content: "Image 1: a receipt" })],
    );
    const tools = new ToolRegistry();
    tools.register(new StaticTool());

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      tools,
      model: "agent_chat",
      maxIterations: 1,
      maxIterationsFinalPrompt: "Give the final answer now.",
      actualModelContext: modelContext(),
    }));

    expect(result.finalContent).toBe("finalized");
    expect(provider.events).toEqual(["agent_chat", "image2text", "agent_chat", "agent_chat"]);
    expect(JSON.stringify(provider.mainCalls.at(-1)?.messages)).toContain("Image 1: a receipt");
    expect(JSON.stringify(provider.mainCalls.at(-1)?.messages)).not.toContain('"type":"image_url"');
  });

  it("analyzes a new tool image during max-iteration finalization", async () => {
    const provider = new AccountFallbackProvider(
      [
        new LLMResponse({
          content: "checking",
          toolCalls: [new ToolCallRequest({ id: "call-1", name: "inspect", arguments: {} })],
          finishReason: "tool_calls",
        }),
        unsupported(),
        new LLMResponse({ content: "finalized from tool image" }),
      ],
      [new LLMResponse({ content: "Image 1: a shipping label" })],
    );
    const tools = new ToolRegistry();
    tools.register(new ImageTool());

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [{ role: "user", content: "Inspect the generated image" }],
      provider,
      tools,
      model: "agent_chat",
      maxIterations: 1,
      maxIterationsFinalPrompt: "Give the final answer now.",
      actualModelContext: modelContext(),
    }));

    expect(result.finalContent).toBe("finalized from tool image");
    expect(provider.events).toEqual(["agent_chat", "agent_chat", "image2text", "agent_chat"]);
    expect(JSON.stringify(provider.imageCalls[0].messages)).toContain("data:image/png;base64,tool");
    expect(JSON.stringify(provider.mainCalls.at(-1)?.messages)).toContain("Image 1: a shipping label");
    expect(JSON.stringify(provider.mainCalls.at(-1)?.messages)).not.toContain('"type":"image_url"');
  });

  it("does not retry after a visible stream delta", async () => {
    const provider = new AccountFallbackProvider([], []);
    provider.chatStreamWithRetry = vi.fn(async (args: any) => {
      await args.onContentDelta?.("partial answer");
      return new LLMResponse({
        content: "image_url is not supported",
        finishReason: "error",
        errorStatusCode: 400,
        errorCategory: "image_input_unsupported",
      });
    });
    const deltas: string[] = [];
    const streamEnds: boolean[] = [];
    class StreamingHook extends AgentHook {
      wantsStreaming(): boolean {
        return true;
      }

      async onStream(_context: AgentHookContext, delta: string): Promise<void> {
        deltas.push(delta);
      }

      async onStreamEnd(_context: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
        streamEnds.push(Boolean(opts.resuming));
      }
    }

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      hook: new StreamingHook(),
      model: "agent_chat",
      actualModelContext: modelContext(),
    }));

    expect(deltas).toEqual(["partial answer"]);
    expect(provider.imageCalls).toHaveLength(0);
    expect(result.response.errorCategory).toBe("image_input_unsupported");
    expect(streamEnds).toEqual([false]);
  });

  it("aborts image2text and does not start the retrying main request", async () => {
    const controller = new AbortController();
    const provider = new AccountFallbackProvider([unsupported()], []);
    provider.runAccountImageTextFallback = vi.fn(async ({ signal }: AccountImageTextFallbackArgs) => (
      new Promise<LLMResponse>((resolve) => {
        signal?.addEventListener("abort", () => resolve(new LLMResponse({
          content: "aborted",
          finishReason: "error",
          errorKind: "aborted",
        })), { once: true });
        controller.abort();
      })
    ));

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "agent_chat",
      actualModelContext: modelContext(),
      abortSignal: controller.signal,
    }));

    expect(result.stopReason).toBe("cancelled");
    expect(provider.mainCalls).toHaveLength(1);
  });
});
