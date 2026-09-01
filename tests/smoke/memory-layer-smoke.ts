import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryRestClient,
  MemoryService,
  listenMemoryHttpServer,
  type Embedder
} from "../../Memory/src/index.js";

const MEMORY_TOKEN = "memory-layer-smoke-token";

export interface MemoryLayerSmokeResult {
  healthRouteCount: number;
  memoryId: string;
  recallHitCount: number;
  panelItemCount: number;
}

export async function runMemoryLayerSmoke(): Promise<MemoryLayerSmokeResult> {
  const root = mkdtempSync(join(tmpdir(), "memmy-memory-layer-smoke-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const namespace = {
    source: "smoke-runner",
    profileId: "default",
    userId: "smoke-user"
  };
  const service = new MemoryService({
    db,
    mode: "dev",
    config: DEFAULT_MEMMY_CONFIG,
    embedder: createSmokeEmbedder()
  });
  let server: Awaited<ReturnType<typeof listenMemoryHttpServer>> | undefined;

  try {
    server = await listenMemoryHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      apiKey: MEMORY_TOKEN,
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000,
      startAgentSourceAutomation: false
    });
    const client = new MemoryRestClient({ endpoint: server.url, token: MEMORY_TOKEN });
    const health = await client.health();
    assert(health.ok, "Memory health must be ready");
    assert(
      health.capabilities.routes.length === API_ROUTES.length,
      "Memory health must expose the complete public route contract"
    );

    const opened = await client.openSession({
      requestId: "memory-smoke-open",
      adapterId: "memory-smoke",
      namespace,
      sessionId: "memory-smoke-session"
    }) as { sessionId: string };
    const turnId = "memory-smoke-turn";
    await client.startTurn({
      requestId: "memory-smoke-start",
      adapterId: "memory-smoke",
      namespace,
      sessionId: opened.sessionId,
      turnId,
      query: "Verify the Memmy v1.1.2 release attachment contract",
      layers: ["L1"]
    });
    const completed = await client.completeTurn(turnId, {
      requestId: "memory-smoke-complete",
      adapterId: "memory-smoke",
      namespace,
      sessionId: opened.sessionId,
      query: "Verify the Memmy v1.1.2 release attachment contract",
      answer: "Run every release check and publish only after every attachment is verified.",
      status: "succeeded"
    }) as { l1MemoryId: string };

    await service.runWorkerOnce(20, { namespace });
    await service.runWorkerOnce(20, { namespace });

    const detail = await client.getMemory(completed.l1MemoryId) as { id?: string };
    assert(detail.id === completed.l1MemoryId, "Memory detail must return the completed turn");
    const recall = await client.search({
      namespace,
      sessionId: opened.sessionId,
      turnId,
      query: "v1.1.2 release attachments",
      layers: ["L1"],
      includeInjectedContext: true,
      verbose: true
    }) as { debug?: { hits?: Array<{ id?: string }> } };
    const hits = recall.debug?.hits ?? [];
    assert(
      hits.some((hit) => hit.id === completed.l1MemoryId),
      "Memory search must recall the completed release turn"
    );
    const panel = await client.panelItems({ layer: "L1", limit: 20 }) as {
      items?: Array<{ id?: string }>;
    };
    const panelItems = panel.items ?? [];
    assert(
      panelItems.some((item) => item.id === completed.l1MemoryId),
      "Memory panel must expose the completed release turn"
    );
    await client.closeSession(opened.sessionId, {
      requestId: "memory-smoke-close",
      adapterId: "memory-smoke",
      namespace
    });

    return {
      healthRouteCount: health.capabilities.routes.length,
      memoryId: completed.l1MemoryId,
      recallHitCount: hits.length,
      panelItemCount: panelItems.length
    };
  } finally {
    if (server) {
      await new Promise<void>((resolveClose) => server?.server.close(() => resolveClose()));
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function createSmokeEmbedder(): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "memory-layer-smoke-embedding"
    },
    isRemote: () => false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "memory-layer-smoke-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  runMemoryLayerSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
