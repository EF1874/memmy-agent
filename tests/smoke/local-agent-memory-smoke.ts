import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryRestClient,
  MemoryService,
  listenMemoryHttpServer,
  type Embedder
} from "../../Memory/src/index.js";
import { createCursorSourceAdapter } from "../../Memory/src/agent-source/adapters/cursor/index.js";
import type { ConversationMessage } from "../../Memory/src/agent-source/adapters/types.js";

const MEMORY_TOKEN = "local-agent-memory-smoke-token";
const CURSOR_SECRET = "smoke-secret-token-12345";

export interface LocalAgentMemorySmokeResult {
  sources: string[];
  scannedMessages: number;
  memoryId: string;
  recallHitCount: number;
  panelItemCount: number;
}

export async function runLocalAgentMemorySmoke(
  sourceIds: readonly string[] = ["cursor"]
): Promise<LocalAgentMemorySmokeResult> {
  assert(
    sourceIds.length === 1 && sourceIds[0] === "cursor",
    "The isolated local-Agent smoke currently supports only --sources=cursor"
  );
  const root = mkdtempSync(join(tmpdir(), "memmy-local-agent-smoke-"));
  const fixture = createCursorFixture(root);
  const cursor = createCursorSourceAdapter({ storageRoot: fixture.storageRoot });
  const messages: ConversationMessage[] = [];
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const namespace = {
    source: "cursor",
    profileId: "default",
    userId: "smoke-user",
    workspacePath: fixture.workspaceRoot
  };
  const service = new MemoryService({
    db,
    mode: "dev",
    config: DEFAULT_MEMMY_CONFIG,
    embedder: createSmokeEmbedder()
  });
  let server: Awaited<ReturnType<typeof listenMemoryHttpServer>> | undefined;

  try {
    assert(await cursor.detect(), "Synthetic Cursor storage must be detected");
    for await (const message of cursor.scan({ maxMessages: 10, maxScanTargets: 1 })) {
      messages.push(message);
    }
    assert(messages.length === 2, "Cursor smoke must emit the synthetic user and assistant turn");
    assert(messages.every((message) => message.sourceId === "cursor"), "Every scanned message must retain Cursor attribution");
    const user = messages.find((message) => message.role === "user");
    const assistant = messages.find((message) => message.role === "assistant");
    assert(user && assistant, "Cursor smoke must emit both sides of the conversation");
    assert(user.content.includes("[REDACTED:authorization_bearer]"), "Cursor scanning must redact the bearer secret");
    assert(!messages.some((message) => message.content.includes(CURSOR_SECRET)), "Cursor scanning must not retain the raw secret");

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
    assert(health.ok, "Memory HTTP health must be ready for the local-Agent smoke");
    const added = await client.addMemory({
      requestId: "cursor-smoke-add",
      adapterId: "agent-source:cursor",
      namespace,
      content: `## user\n\n${user.content}\n\n## assistant\n\n${assistant.content}`,
      layer: "L1",
      title: "cursor smoke release checklist",
      tags: ["agent-source", "cursor", "smoke"],
      source: "cursor",
      turnId: "cursor:cursor-smoke-conversation:0",
      createdAt: user.createdAt,
      deferProcessing: false
    }) as { id: string };

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const worker = await service.runWorkerOnce(20, { namespace });
      assert(worker.failed === 0, "Cursor import processing must not fail");
      if (worker.leased === 0 && worker.embeddingRetries.leased === 0) break;
    }

    const detail = await client.getMemory(added.id);
    const serializedDetail = JSON.stringify(detail);
    assert(serializedDetail.includes("[REDACTED:authorization_bearer]"), "Stored detail must retain only the redacted secret marker");
    assert(!serializedDetail.includes(CURSOR_SECRET), "Stored detail must not expose the raw Cursor secret");
    const recall = await client.search({
      namespace,
      query: "Cursor smoke release checklist",
      layers: ["L1"],
      includeInjectedContext: true,
      verbose: true
    }) as { debug?: { hits?: Array<{ id?: string }> } };
    const hits = recall.debug?.hits ?? [];
    assert(
      hits.some((hit) => hit.id === added.id),
      "Cursor memory must be recalled through the HTTP contract"
    );
    const panel = await client.panelItems({
      layer: "L1",
      sourceAgent: "cursor",
      limit: 20
    }) as { items?: Array<{ id?: string }> };
    const panelItems = panel.items ?? [];
    assert(
      panelItems.some((item) => item.id === added.id),
      "Cursor memory must be visible through the panel contract"
    );

    return {
      sources: ["cursor"],
      scannedMessages: messages.length,
      memoryId: added.id,
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

function createCursorFixture(root: string): { storageRoot: string; workspaceRoot: string } {
  const workspaceRoot = join(root, "workspace");
  const storageRoot = join(root, "cursor", "workspaceStorage");
  const storagePath = join(storageRoot, "smoke-workspace");
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(
    join(storagePath, "workspace.json"),
    `${JSON.stringify({ folder: pathToFileURL(workspaceRoot).href })}\n`,
    "utf8"
  );

  const stateDb = new Database(join(storagePath, "state.vscdb"));
  try {
    stateDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(
      "cursor-smoke-conversation",
      JSON.stringify({
        conversationId: "cursor-smoke-conversation",
        messages: [
          {
            id: "cursor-smoke-user",
            role: "user",
            content: `Cursor smoke release checklist. Authorization: Bearer ${CURSOR_SECRET}`,
            createdAt: "2026-09-01T00:00:00.000Z"
          },
          {
            id: "cursor-smoke-assistant",
            role: "assistant",
            content: "Verify the release contracts and preserve independent Memory metadata.",
            createdAt: "2026-09-01T00:00:01.000Z"
          }
        ]
      })
    );
  } finally {
    stateDb.close();
  }
  return { storageRoot, workspaceRoot };
}

function createSmokeEmbedder(): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "local-agent-smoke-embedding"
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
        model: "local-agent-smoke-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function parseSourceIds(args: readonly string[]): string[] {
  const sourceArg = args.find((arg) => arg.startsWith("--sources="));
  if (!sourceArg) return ["cursor"];
  return sourceArg.slice("--sources=".length).split(",").map((source) => source.trim()).filter(Boolean);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  runLocalAgentMemorySmoke(parseSourceIds(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
