import type { ModelConfigInput, ModelConfigView, RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_PRESET_ID_PREFIX, createHttpConfigClient } from "../config-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("config-client canonical model catalog", () => {
  it("GET 返回 revision/catalog，PUT 原样提交 endpoint/preset/capability/assignment", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      return jsonResponse(catalog(init?.method === "PUT" ? "revision-2" : "revision-1"));
    }));
    const client = createHttpConfigClient(config);
    const loaded = await client.getModelConfig();

    expect(loaded.catalog?.configRevision).toBe("revision-1");
    expect(loaded.catalog?.providers[0]?.endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: "chat", protocol: "openai-chat-completions" }),
      expect.objectContaining({ endpointId: "embedding", protocol: "openai-embeddings" })
    ]));
    expect(loaded.catalog?.modelAssignments.byok.agent).toEqual({ candidates: ["byok-agent"], default: "byok-agent" });

    const saved = await client.saveModelCatalog(loaded.catalog!);
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body).toMatchObject({
      configRevision: "revision-1",
      providers: [{
        provider: "openai",
        endpoints: [
          { endpointId: "chat", protocol: "openai-chat-completions" },
          { endpointId: "embedding", protocol: "openai-embeddings" }
        ],
        models: [
          { presetId: "byok-agent", endpointId: "chat", capabilities: ["agent"] },
          { presetId: "byok-embedding", endpointId: "embedding", capabilities: ["embedding"] }
        ]
      }],
      modelAssignments: { byok: { agent: { candidates: ["byok-agent"], default: "byok-agent" } } }
    });
    expect(saved.catalog?.configRevision).toBe("revision-2");
  });

  it("View 回写不会泄露 masked secret，脱敏扩展字段通过省略触发后端保留", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(catalog("revision-2"));
    }));
    const view = catalog("revision-1");
    await createHttpConfigClient(config).saveModelCatalog(view);

    expect(JSON.stringify(body)).not.toContain("sk••••test");
    expect(body.providers[0].apiKey).toBeUndefined();
    expect(body.providers[0].endpoints[0].apiKey).toBeUndefined();
    expect(body.providers[0].extraBody).toBeUndefined();
    expect(body.providers[0].endpoints[0].extraHeaders).toBeUndefined();
  });

  it("View 回写不提交只读账号 Provider，只保留账号 assignment", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(catalog("revision-2"));
    }));
    const view = catalog("revision-1");
    view.providers.push({
      provider: "memmy_account",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "••••",
      apiKey: "",
      ownerAccountId: "owner-a",
      endpoints: [{
        endpointId: "platform",
        apiBase: "https://account.example/v1",
        protocol: "memmy-account",
        hasApiKey: false,
        apiKeyMasked: "",
        apiKey: ""
      }],
      accountManaged: true,
      editable: false,
      models: [{
        presetId: "account-agent",
        provider: "memmy_account",
        endpointId: "platform",
        protocol: "memmy-account",
        model: "agent_chat",
        source: "account",
        ownerAccountId: "owner-a",
        capabilities: ["agent"],
        available: true
      }]
    });
    view.modelAssignments.account.agent = { candidates: ["account-agent", "byok-agent"], default: "byok-agent" };

    await createHttpConfigClient(config).saveModelCatalog(view);

    expect(body.providers.map((provider: any) => provider.provider)).toEqual(["openai"]);
    expect(body.modelAssignments.account.agent).toEqual({ candidates: ["account-agent", "byok-agent"], default: "byok-agent" });
  });

  it("显式 ModelConfigInput 的扩展字段保持原样透传", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(catalog("revision-2"));
    }));
    const input = inputFromCatalog(catalog("revision-1"));
    input.providers[0]!.extraBody = { preserved: true };
    input.providers[0]!.endpoints[0]!.extraHeaders = { "x-extra": "1" };

    await createHttpConfigClient(config).saveModelCatalog(input);

    expect(body.providers[0].extraBody).toEqual({ preserved: true });
    expect(body.providers[0].endpoints[0].extraHeaders).toEqual({ "x-extra": "1" });
  });

  it("新 preset 首次 PUT 不带客户端 ID，第二次 PUT 使用响应 UUID 完成 assignment", async () => {
    const bodies: any[] = [];
    const serverPresetId = "2f9c9d4d-f96a-4e45-bf26-536d762ff2d8";
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const response = catalog(bodies.length === 1 ? "revision-2" : "revision-3");
      response.providers[0]!.models.push({
        presetId: serverPresetId,
        provider: "openai",
        endpointId: "chat",
        protocol: "openai-chat-completions",
        model: "gpt-new",
        source: "byok",
        capabilities: ["agent"],
        available: true
      });
      if (bodies.length > 1) {
        response.modelAssignments.byok.agent = {
          candidates: ["byok-agent", serverPresetId],
          default: serverPresetId
        };
      }
      return jsonResponse(response);
    }));
    const input = inputFromCatalog(catalog("revision-1"));
    const clientPresetId = `${CLIENT_PRESET_ID_PREFIX}test`;
    input.providers[0]!.models.push({
      presetId: clientPresetId,
      endpointId: "chat",
      model: "gpt-new",
      source: "byok",
      capabilities: ["agent"]
    });
    input.modelAssignments.byok.agent = {
      candidates: ["byok-agent", clientPresetId],
      default: clientPresetId
    };

    const saved = await createHttpConfigClient(config).saveModelCatalog(input);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].providers[0].models.find((model: any) => model.model === "gpt-new").presetId).toBeUndefined();
    expect(JSON.stringify(bodies[0].modelAssignments)).not.toContain(CLIENT_PRESET_ID_PREFIX);
    expect(bodies[1].providers[0].models.find((model: any) => model.model === "gpt-new").presetId).toBe(serverPresetId);
    expect(bodies[1].modelAssignments.byok.agent).toEqual({
      candidates: ["byok-agent", serverPresetId],
      default: serverPresetId
    });
    expect(saved.catalog?.modelAssignments.byok.agent.default).toBe(serverPresetId);
  });

  it("首次成功 GET 后只清理旧 workspace cache", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { removeItem } });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(catalog("revision-1"))));

    await createHttpConfigClient(config).getModelConfig();

    expect(removeItem).toHaveBeenCalledWith("memmy-model-workspace-v1");
  });

  it("连接测试仍按 capability 和 secret target 调用真实测试路由", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ ok: true, message: "ok", checkedAt: "2026-08-11T00:00:00.000Z" });
    }));

    const result = await createHttpConfigClient(config).testModelConfig({
      provider: "openai",
      endpointId: "chat",
      protocol: "openai-chat-completions",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-live",
      apiKeyMasked: "",
      configured: true
    }, "chat", "primary");

    expect(body).toEqual({
      provider: "openai_compatible",
      endpointId: "chat",
      protocol: "openai-chat-completions",
      apiBase: "https://api.openai.com/v1",
      modelId: "gpt-4o",
      apiKey: "sk-live",
      capability: "chat",
      secretTarget: "primary"
    });
    expect(result.ok).toBe(true);
  });
});

function catalog(configRevision: string): ModelConfigView {
  const agent = {
    presetId: "byok-agent",
    provider: "openai" as const,
    endpointId: "chat",
    protocol: "openai-chat-completions" as const,
    model: "gpt-4o",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const embedding = {
    presetId: "byok-embedding",
    provider: "openai" as const,
    endpointId: "embedding",
    protocol: "openai-embeddings" as const,
    model: "text-embedding-3-small",
    source: "byok" as const,
    capabilities: ["embedding" as const],
    available: true
  };
  const byok = {
    agent: { candidates: ["byok-agent"], default: "byok-agent" },
    memorySummary: null,
    memoryEvolution: null,
    embedding: "byok-embedding",
    asr: null,
    imageGeneration: null
  };
  return {
    configRevision,
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "sk••••test",
      apiKey: "",
      endpoints: [
        { endpointId: "chat", apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions", hasApiKey: true, apiKeyMasked: "sk••••test", apiKey: "" },
        { endpointId: "embedding", apiBase: "https://api.openai.com/v1", protocol: "openai-embeddings", hasApiKey: true, apiKeyMasked: "sk••••test", apiKey: "" }
      ],
      accountManaged: false,
      editable: true,
      models: [agent, embedding]
    }],
    modelAssignments: { byok, account: { ...structuredClone(byok), ownerAccountId: "owner-a" } },
    effectiveCandidates: { byok: [agent, embedding], account: [agent, embedding] },
    configured: true,
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}

function inputFromCatalog(view: ModelConfigView): ModelConfigInput {
  return {
    configRevision: view.configRevision,
    providers: view.providers.map((provider) => ({
      provider: provider.provider,
      endpoints: provider.endpoints.map((endpoint) => ({
        endpointId: endpoint.endpointId,
        apiBase: endpoint.apiBase,
        protocol: endpoint.protocol
      })),
      models: provider.models.map((model) => ({
        presetId: model.presetId,
        endpointId: model.endpointId,
        model: model.model,
        source: model.source,
        capabilities: [...model.capabilities]
      }))
    })),
    modelAssignments: structuredClone(view.modelAssignments)
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
