import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryHttpServer,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder,
  type LlmClient
} from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("local Viewer API", () => {
  it("serves versioned health and protects config writes and secrets", async () => {
    const fixture = await startFixture();
    const health = await fetch(`${fixture.baseUrl}/health`);
    expect(await health.json()).toMatchObject({
      ok: true,
      serviceVersion: "2.1.0",
      protocolVersion: 1,
      viewerUrl: expect.stringContaining("/viewer")
    });

    const config = await viewerFetch(fixture.baseUrl, "/api/v1/config");
    const configText = await config.text();
    expect(configText).not.toContain("hub-secret");
    expect(JSON.parse(configText)).toMatchObject({
      config: {
        algorithm: { lightweightMemory: { enabled: false } },
        logging: { detailedView: false },
        agentAccess: {
          autoScanKnownAgents: true,
          watchFileChanges: true,
          autoInjectSkill: false
        }
      }
    });

    const crossSite = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      headers: { "x-memmy-viewer": "1", origin: "http://evil.example" }
    });
    expect(crossSite.status).toBe(403);

    const missingViewerHeader = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { timeZone: "+08:00" } })
    });
    expect(missingViewerHeader.status).toBe(404);

    const missingJsonContentType = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      method: "PATCH",
      headers: { "x-memmy-viewer": "1" },
      body: JSON.stringify({ config: { timeZone: "+08:00" } })
    });
    expect(missingJsonContentType.status).toBe(400);

    const readOnly = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({ config: { storage: { sqlitePath: "/tmp/other.sqlite" } } })
    });
    expect(readOnly.status).toBe(400);

    const updated = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({ config: { timeZone: "+08:00", hub: { teamToken: "********" } } })
    });
    expect(updated.status).toBe(200);
    expect(readFileSync(fixture.configPath, "utf8")).toContain("+08:00");
    expect(readFileSync(fixture.configPath, "utf8")).toContain("hub-secret");
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("********");
  });

  it("writes Viewer model settings to memmyMemory and keeps the Desktop catalog in sync", async () => {
    const fixture = await startFixture();
    const response = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          roleRouting: { summary: "fixed", evolution: "fixed" },
          summary: {
            provider: "openai_compatible",
            endpoint: "https://summary.example/v1",
            model: "summary-model",
            apiKey: "summary-secret"
          },
          evolution: {
            provider: "anthropic",
            endpoint: "https://evolution.example/v1",
            model: "evolution-model",
            apiKey: "evolution-secret"
          },
          embedding: {
            mode: "custom",
            provider: "openai_compatible",
            endpoint: "https://embedding.example/v1",
            model: "embedding-model",
            apiKey: "embedding-secret"
          },
          telemetry: { enabled: true }
        }
      })
    });
    expect(response.status).toBe(200);

    const raw = YAML.parse(readFileSync(fixture.configPath, "utf8")) as any;
    expect(raw.memmyMemory).toMatchObject({
      roleRouting: { summary: "fixed", evolution: "fixed" },
      summary: {
        endpoint: "https://summary.example/v1",
        model: "summary-model",
        apiKey: "summary-secret"
      },
      evolution: {
        endpoint: "https://evolution.example/v1",
        model: "evolution-model",
        apiKey: "evolution-secret"
      },
      embedding: {
        mode: "custom",
        endpoint: "https://embedding.example/v1",
        model: "embedding-model",
        apiKey: "embedding-secret"
      },
      telemetry: { enabled: true }
    });
    expect(raw.modelAssignments.byok).toMatchObject({
      memorySummary: expect.any(String),
      memoryEvolution: expect.any(String),
      embedding: expect.any(String)
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.memorySummary]).toMatchObject({
      source: "byok",
      model: "summary-model",
      capabilities: ["memory_summary"]
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.memoryEvolution]).toMatchObject({
      source: "byok",
      model: "evolution-model",
      capabilities: ["memory_evolution"]
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.embedding]).toMatchObject({
      source: "byok",
      model: "embedding-model",
      capabilities: ["embedding"]
    });
  });

  it("writes shared cross-Agent scan preferences to memmyMemory", async () => {
    const fixture = await startFixture();
    const response = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          agentAccess: {
            autoScanKnownAgents: false,
            watchFileChanges: true,
            autoInjectSkill: true
          }
        }
      })
    });
    expect(response.status).toBe(200);
    const raw = YAML.parse(readFileSync(fixture.configPath, "utf8")) as any;
    expect(raw.memmyMemory.agentAccess).toEqual({
      autoScanKnownAgents: false,
      watchFileChanges: true,
      autoInjectSkill: true
    });
  });

  it("resumes SSE changes from Last-Event-ID and exposes migrated Hub rows", async () => {
    const fixture = await startFixture();
    fixture.db.db.prepare(
      "INSERT INTO runtime_kv (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("legacy_hub:openclaw:hub_users:user-1", JSON.stringify({ source: "openclaw" }), new Date().toISOString());
    const hub = await viewerFetch(fixture.baseUrl, "/api/v1/hub/items");
    expect(await hub.json()).toMatchObject({ total: 1 });

    const first = fixture.service.addMemory({
      content: "first SSE memory",
      source: "viewer-test",
      layer: "L1",
      title: "first"
    });
    const firstEvent = await readOneEvent(fixture.baseUrl, "0");
    expect(firstEvent).toContain(first.id);
    const firstEventId = eventId(firstEvent);

    const second = fixture.service.addMemory({
      content: "second SSE memory",
      source: "viewer-test",
      layer: "L1",
      title: "second"
    });
    const resumed = await readOneEvent(fixture.baseUrl, firstEventId);
    expect(resumed).toContain(second.id);
    expect(eventId(resumed)).not.toBe(firstEventId);
  });

  it("exports and clears data through the authenticated service boundary", async () => {
    const fixture = await startFixture();
    fixture.service.addMemory({ content: "clear through HTTP", source: "viewer-test", layer: "L1" });

    const exported = await fetch(`${fixture.baseUrl}/api/v1/admin/export`);
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ manifest: { service: "memmy-memory-service" } });

    const cleared = await fetch(`${fixture.baseUrl}/api/v1/admin/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, cleared: { memories: 1 } });
    expect(fixture.db.db.prepare("SELECT COUNT(*) FROM memories").pluck().get()).toBe(0);
    expect(fixture.db.db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBeGreaterThan(0);
  });

  it("performs actual model and embedding probes", async () => {
    const calls: string[] = [];
    const fixture = await startFixture({
      llm: testLlm("summary-test", calls),
      skillLlm: testLlm("evolution-test", calls)
    });

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/models/test", {
      method: "POST",
      body: "{}"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      models: {
        summary: { ok: true, model: "summary-test" },
        evolution: { ok: true, model: "evolution-test" },
        embedding: { ok: true, dimensions: 3 }
      }
    });
    expect(calls).toEqual(expect.arrayContaining([
      "viewer.model-test.summary",
      "viewer.model-test.evolution"
    ]));
  });

  it("supports the copied Viewer auth, telemetry, bulk-delete and archive routes", async () => {
    const fixture = await startFixture();
    const trace = fixture.service.addMemory({ content: "trace", source: "viewer-test", layer: "L1" });
    const skill = fixture.service.addMemory({ content: "skill", source: "viewer-test", layer: "Skill" });
    const worldModel = fixture.service.addMemory({ content: "world", source: "viewer-test", layer: "L3" });

    const auth = await viewerFetch(fixture.baseUrl, "/api/v1/auth/status");
    expect(await auth.json()).toEqual({ enabled: false, needsSetup: false, authenticated: true });

    const telemetry = await viewerFetch(fixture.baseUrl, "/api/v1/telemetry/viewer-opened", {
      method: "POST",
      body: "{}"
    });
    expect(await telemetry.json()).toEqual({ ok: true });

    const deleted = await viewerFetch(fixture.baseUrl, "/api/v1/traces/delete", {
      method: "POST",
      body: JSON.stringify({ ids: [trace.id] })
    });
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(fixture.db.db.prepare("SELECT status FROM memories WHERE id = ?").pluck().get(trace.id)).toBe("deleted");

    await viewerFetch(fixture.baseUrl, "/api/v1/skills/archive", {
      method: "POST",
      body: JSON.stringify({ skillId: skill.id })
    });
    expect(fixture.service.getMemory(skill.id).status).toBe("archived");

    await viewerFetch(fixture.baseUrl, `/api/v1/world-models/${worldModel.id}/archive`, {
      method: "POST",
      body: "{}"
    });
    expect(fixture.service.getMemory(worldModel.id).status).toBe("archived");
  });

  it("lists Memmy user memories for the configured local user", async () => {
    const fixture = await startFixture();
    const session = fixture.service.openSession({
      namespace: { source: "memmy", profileId: "default", userId: "local-user" }
    });
    const completed = fixture.service.completeTurn("turn-viewer-user-memory", {
      sessionId: session.sessionId,
      query: "我喜欢简洁代码，不要写不必要的兜底逻辑",
      answer: "好的，我会记住。"
    });
    expect(completed.userMemoryIds).toHaveLength(1);

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/memories?q=简洁&limit=20&page=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        id: completed.userMemoryIds[0],
        kind: "user_memory",
        memoryLayer: "UserMemory",
        status: "activated"
      })]
    });

    const overview = await viewerFetch(fixture.baseUrl, "/api/v1/overview");
    expect(await overview.json()).toMatchObject({
      summary: { counts: { userMemories: 1 } }
    });

    const maintenance = await viewerFetch(fixture.baseUrl, "/api/v1/embeddings/maintenance");
    const stats = await maintenance.json() as {
      totalSlots: number;
      ready: number;
      missing: number;
      dimMismatch: number;
    };
    expect(stats.totalSlots).toBe(2);
    expect(stats.ready + stats.missing + stats.dimMismatch).toBe(stats.totalSlots);
  });
});

async function startFixture(options: { llm?: LlmClient; skillLlm?: LlmClient } = {}): Promise<{
  baseUrl: string;
  configPath: string;
  db: MemoryDb;
  service: MemoryService;
}> {
  const root = mkdtempSync(join(tmpdir(), "memmy-viewer-api-"));
  const configPath = join(root, "config.yaml");
  const config = {
    ...DEFAULT_MEMMY_CONFIG,
    hub: { enabled: false, teamToken: "hub-secret" }
  } as typeof DEFAULT_MEMMY_CONFIG;
  writeFileSync(configPath, YAML.stringify({ memmyMemory: config }));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    config,
    configPath,
    configLoader: () => ({ config, path: configPath }),
    llm: options.llm,
    skillLlm: options.skillLlm,
    embedder: testEmbedder()
  });
  const server = createMemoryHttpServer({ service, configPath });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    async () => closeServer(server)
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, configPath, db, service };
}

function viewerFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-memmy-viewer": "1",
      ...(init.method && init.method !== "GET" ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

async function readOneEvent(baseUrl: string, cursor: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/events`, { headers: { "last-event-id": cursor } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!text.includes("\n\n")) {
    if (Date.now() > deadline) throw new Error("timed out waiting for SSE event");
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
}

function eventId(event: string): string {
  const match = event.match(/^id: (.+)$/m);
  if (!match?.[1]) throw new Error(`event has no id: ${event}`);
  return match[1].trim();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function testEmbedder(): Embedder {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.embedding, model: "viewer-test" },
    isRemote: () => false,
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    embedOne: async () => [1, 0, 0],
    status: () => ({ provider: "local", model: "viewer-test", configured: true, remote: false })
  };
}

function testLlm(model: string, calls: string[]): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible", model, endpoint: "http://127.0.0.1" },
    isConfigured: () => true,
    complete: async (_messages, options) => {
      calls.push(options.operation);
      return "OK";
    },
    completeJson: async <T extends Record<string, unknown>>() => ({} as T),
    status: () => ({ provider: "test", model, configured: true, remote: true })
  };
}
