import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";

const roots: string[] = [];

function makeLoop(): AgentLoop {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-turn-admission-"));
  roots.push(workspace);
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider: {
      generation: { maxTokens: 256 },
      getDefaultModel: () => "test-model",
    },
    workspace,
    model: "test-model",
  });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  return loop;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop Turn admission", () => {
  it("creates one FIFO Turn Slot for every default message, including the same route", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "A") await firstGate;
      return null;
    }) as any;

    const running = loop.run();
    for (const content of ["A", "B", "C"]) {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "telegram",
        chatId: "same-chat",
        senderId: "user",
        content,
      }));
      if (content === "A") await waitUntil(() => started.length === 1);
    }

    await waitUntil(() => (loop.turnSlots.get("telegram:same-chat")?.length ?? 0) === 3);
    const slots = loop.turnSlots.get("telegram:same-chat") as any[];
    expect(slots.map((slot) => slot.root.content)).toEqual(["A", "B", "C"]);
    expect(slots.map((slot) => slot.pendingSteer.size)).toEqual([0, 0, 0]);
    expect(new Set(slots.map((slot) => slot.turnId)).size).toBe(3);

    releaseFirst();
    await waitUntil(() => started.length === 3);
    await waitUntil(() => !loop.isSessionBusy("telegram:same-chat"));
    expect(started).toEqual(["A", "B", "C"]);
    loop.stop();
    await running;
  });

  it("steers only the active accepting Slot instead of the last queued Slot", async () => {
    const loop = makeLoop();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "cli",
      chatId: "turns",
      senderId: "user",
      content: "active",
      sessionKeyOverride: "cli:turns",
    }));
    await waitUntil(() => (loop.turnSlots.get("cli:turns") as any[])?.[0]?.acceptingSteer === true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "cli",
      chatId: "turns",
      senderId: "user",
      content: "queued",
      sessionKeyOverride: "cli:turns",
    }));
    await waitUntil(() => (loop.turnSlots.get("cli:turns")?.length ?? 0) === 2);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "cli",
      chatId: "turns",
      senderId: "user",
      content: "correction",
      sessionKeyOverride: "cli:turns",
      turnAdmission: "steer",
    }));

    await waitUntil(() => ((loop.turnSlots.get("cli:turns") as any[])?.[0]?.pendingSteer.size ?? 0) === 1);
    const slots = loop.turnSlots.get("cli:turns") as any[];
    expect(slots[0].pendingSteer.getNowait().content).toBe("correction");
    expect(slots[1].pendingSteer.size).toBe(0);
    slots[0].pendingSteer.put(new InboundMessage({
      channel: "cli",
      chatId: "turns",
      senderId: "user",
      content: "correction",
      sessionKeyOverride: "cli:turns",
      turnAdmission: "steer",
    }));

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy("cli:turns"));
    loop.stop();
    await running;
  });

  it("degrades steer to queue when route or active state does not match", async () => {
    const loop = makeLoop();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;
    loop.unifiedSession = true;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "route-a",
      senderId: "user",
      content: "active",
    }));
    await waitUntil(() => (loop.turnSlots.get(UNIFIED_SESSION_KEY) as any[])?.[0]?.acceptingSteer === true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "route-b",
      senderId: "user",
      content: "wrong route",
      turnAdmission: "steer",
    }));

    await waitUntil(() => (loop.turnSlots.get(UNIFIED_SESSION_KEY)?.length ?? 0) === 2);
    const queued = (loop.turnSlots.get(UNIFIED_SESSION_KEY) as any[])[1];
    expect(queued.root.content).toBe("wrong route");
    expect(queued.root.turnAdmission).toBe("queue");
    expect(queued.pendingSteer.size).toBe(0);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(UNIFIED_SESSION_KEY));
    loop.stop();
    await running;
  });

  it("emits message_queued before a busy WebUI root is accepted", async () => {
    const loop = makeLoop();
    loop.unifiedSession = true;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "first") await firstGate;
      if (message.content === "second") {
        await loop.publishWebuiMessageAccepted(message, options.slot);
      }
      return null;
    }) as any;

    const running = loop.run();
    const requestSessionKey = "websocket:queued-ui";
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queued-ui",
      senderId: "user",
      content: "first",
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queued-ui",
      senderId: "user",
      content: "second",
      metadata: {
        webui: true,
        client_request_id: "11111111-1111-4111-8111-111111111111",
      },
    }));

    await waitUntil(() => loop.bus.outboundSize === 1);
    const queued = await loop.bus.consumeOutbound();
    expect(queued.metadata).toMatchObject({
      webuiMessageQueued: true,
      webuiRequestSessionKey: requestSessionKey,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
    });

    releaseFirst();
    await waitUntil(() => loop.bus.outboundSize >= 2);
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    const acceptedIndex = outbound.findIndex((message) => message.metadata?.webuiMessageAccepted);
    const runningIndex = outbound.findIndex((message) => message.metadata?.runStatus === "running");
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(runningIndex);
    await waitUntil(() => !loop.isSessionBusy(UNIFIED_SESSION_KEY));
    loop.stop();
    await running;
  });

  it("projects visible composer slots, removes only the selected queued Turn, and dequeues on start", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      started.push(message.content);
      if (message.content === "running") await firstGate;
      if (message.metadata?.client_request_id) {
        await loop.publishWebuiMessageAccepted(message, options.slot);
      }
      return null;
    }) as any;
    const cancelAll = vi.spyOn(loop, "cancelActiveTasks");
    const sessionKey = "websocket:visible-queue";
    const requests = [
      ["11111111-1111-4111-8111-111111111111", "first queued", "2026-08-09T12:00:01.000Z"],
      ["22222222-2222-4222-8222-222222222222", "remove queued", "2026-08-09T12:00:02.000Z"],
      ["33333333-3333-4333-8333-333333333333", "last queued", "2026-08-09T12:00:03.000Z"],
    ] as const;
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "visible-queue",
      senderId: "user",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    for (const [clientRequestId, content, timestamp] of requests) {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "visible-queue",
        senderId: "user",
        content,
        timestamp: new Date(timestamp),
        metadata: {
          webui: true,
          client_request_id: clientRequestId,
          webui_queue_surface: "chat_composer",
        },
      }));
    }
    await waitUntil(() => loop.getWebuiQueueSnapshot(sessionKey).items.length === 3);
    expect(loop.getWebuiQueueSnapshot(sessionKey).items.map((item) => item.clientRequestId))
      .toEqual(requests.map(([id]) => id));
    await expect(loop.removeQueuedWebuiMessage(sessionKey, requests[1][0])).resolves.toBe("removed");
    expect(cancelAll).not.toHaveBeenCalled();
    expect(loop.getWebuiQueueSnapshot(sessionKey).items.map((item) => item.clientRequestId))
      .toEqual([requests[0][0], requests[2][0]]);

    releaseFirst();
    await waitUntil(() => started.length === 3);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(started).toEqual(["running", "first queued", "last queued"]);
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiQueueItem && message.metadata?.webuiMessageQueued))
      .toHaveLength(3);
    expect(outbound.filter((message) => message.metadata?.webuiMessageDequeued)
      .map((message) => message.metadata?.clientRequestId))
      .toEqual([requests[0][0], requests[2][0]]);
    expect(loop.getWebuiQueueSnapshot(sessionKey)).toEqual({ items: [], startedItems: [] });
    loop.stop();
    await running;
  });

  it("cancels a visible queued Turn while its queue announcement is still publishing", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseRunning!: () => void;
    let releaseAnnouncement!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const announcementGate = new Promise<void>((resolve) => {
      releaseAnnouncement = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "running") await runningGate;
      return null;
    }) as any;
    const originalPublishOutbound = loop.bus.publishOutbound.bind(loop.bus);
    let announcementEntered = false;
    loop.bus.publishOutbound = vi.fn(async (message) => {
      if (message.metadata?.webuiMessageQueued && message.metadata?.webuiQueueItem) {
        announcementEntered = true;
        await announcementGate;
      }
      await originalPublishOutbound(message);
    });
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-gate",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-gate",
      content: "queued",
      metadata: {
        webui: true,
        client_request_id: "44444444-4444-4444-8444-444444444444",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(() => announcementEntered);
    releaseRunning();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["running"]);

    await expect(loop.removeQueuedWebuiMessage(
      "websocket:announcement-gate",
      "44444444-4444-4444-8444-444444444444",
    )).resolves.toBe("removed");

    releaseAnnouncement();
    await waitUntil(() => !loop.isSessionBusy("websocket:announcement-gate"));
    expect(started).toEqual(["running"]);
    expect(loop.getWebuiQueueSnapshot("websocket:announcement-gate"))
      .toEqual({ items: [], startedItems: [] });
    loop.stop();
    await running;
  });

  it("drops a visible queued Turn when its queue announcement fails", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "running") await runningGate;
      return null;
    }) as any;
    const originalPublishOutbound = loop.bus.publishOutbound.bind(loop.bus);
    loop.bus.publishOutbound = vi.fn(async (message) => {
      if (message.metadata?.webuiMessageQueued && message.metadata?.webuiQueueItem) {
        throw new Error("queue announcement failed");
      }
      await originalPublishOutbound(message);
    });
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-failure",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-failure",
      content: "must not start",
      metadata: {
        webui: true,
        client_request_id: "55555555-5555-4555-8555-555555555555",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(() => loop.bus.outboundSize > 0);
    const rejected = await loop.bus.consumeOutbound();
    expect(rejected.metadata).toMatchObject({
      webuiMessageRejected: true,
      clientRequestId: "55555555-5555-4555-8555-555555555555",
      reason: "turn_start_failed",
    });
    expect(loop.getWebuiQueueSnapshot("websocket:announcement-failure"))
      .toEqual({ items: [], startedItems: [] });

    releaseRunning();
    await waitUntil(() => !loop.isSessionBusy("websocket:announcement-failure"));
    expect(started).toEqual(["running"]);
    loop.stop();
    await running;
  });

  it("publishes Goal inbox queued, accepted, and dequeued events at their distinct lifecycle boundaries", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:goal-queue";
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "keep working",
      tokenBudget: 1_000,
      route: { channel: "websocket", chatId: "goal-queue" },
      turnId: "turn-create",
    });
    while (loop.bus.outboundSize) await loop.bus.consumeOutbound();
    let releaseInboxTurn!: () => void;
    const inboxTurnGate = new Promise<void>((resolve) => {
      releaseInboxTurn = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      if (message.metadata?.client_request_id === clientRequestId) await inboxTurnGate;
      return null;
    }) as any;
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "goal-queue",
      content: "persisted inbox question",
      timestamp: new Date("2026-08-09T12:00:00.000Z"),
      metadata: {
        webui: true,
        client_request_id: clientRequestId,
        webui_request_digest: "goal-queue-digest",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(() => loop.getWebuiQueueSnapshot(sessionKey).items.length === 1);
    const beforeStart = [];
    while (loop.bus.outboundSize) beforeStart.push(await loop.bus.consumeOutbound());
    expect(beforeStart.filter((message) => (
      message.metadata?.webuiMessageQueued || message.metadata?.webuiMessageAccepted
    )).map((message) => (
      message.metadata?.webuiMessageQueued ? "queued" : "accepted"
    ))).toEqual(["queued", "accepted"]);

    loop.goalRuntime.releaseTurn(sessionKey, "turn-create");
    await (loop as any).dispatchNextGoalWork(sessionKey);
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    expect(loop.getWebuiQueueSnapshot(sessionKey)).toMatchObject({
      items: [],
      startedItems: [expect.objectContaining({ clientRequestId })],
    });
    const afterStart = [];
    while (loop.bus.outboundSize) afterStart.push(await loop.bus.consumeOutbound());
    expect(afterStart.some((message) => (
      message.metadata?.webuiMessageDequeued
      && message.metadata?.clientRequestId === clientRequestId
    ))).toBe(true);

    releaseInboxTurn();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(loop.goalRuntime.get(sessionKey)).toMatchObject({ goalId: goal.goalId, status: "active" });
    loop.stop();
    await running;
  });

  it("converts deletion-barrier input to queue and emits one queued acknowledgement", async () => {
    const loop = makeLoop();
    loop.processMessageInternal = vi.fn(async () => null) as any;
    const sessionKey = "websocket:deletion";
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = loop.withSessionDeletionBarrier(
      sessionKey,
      () => deletionGate,
      async () => undefined,
    );
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "deletion",
      senderId: "user",
      content: "survive deletion",
      metadata: {
        webui: true,
        client_request_id: "22222222-2222-4222-8222-222222222222",
      },
      turnAdmission: "steer",
    }));

    await waitUntil(() => (loop.sessionDeletionQueues.get(sessionKey)?.length ?? 0) === 1);
    expect(loop.sessionDeletionQueues.get(sessionKey)?.[0]?.turnAdmission).toBe("queue");
    const queued = await loop.bus.consumeOutbound();
    expect(queued.metadata?.webuiMessageQueued).toBe(true);

    releaseDeletion();
    await deletion;
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    expect((loop.processMessageInternal as any).mock.calls[0][0].turnAdmission).toBe("queue");
    expect((loop.processMessageInternal as any).mock.calls).toHaveLength(1);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("rejects a queued WebUI root exactly once when Stop cancels it before acceptance", async () => {
    const loop = makeLoop();
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content !== "running") return null;
      await new Promise<void>((resolve) => {
        if (options.abortSignal.aborted) {
          resolve();
          return;
        }
        options.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    }) as any;
    const sessionKey = "websocket:cancel-queue";
    const clientRequestId = "33333333-3333-4333-8333-333333333333";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "cancel-queue",
      senderId: "user",
      content: "running",
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "cancel-queue",
      senderId: "user",
      content: "queued",
      metadata: { webui: true, client_request_id: clientRequestId },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey)?.length ?? 0) === 2);
    await loop.cancelActiveTasks(sessionKey);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));

    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    const rejections = outbound.filter((message) => message.metadata?.webuiMessageRejected);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].metadata).toMatchObject({
      clientRequestId,
      reason: "turn_queue_cancelled",
    });
    expect((loop.processMessageInternal as any).mock.calls).toHaveLength(1);
    loop.stop();
    await running;
  });

  it("keeps direct, Slot-backed, and deletion-barrier Sessions out of auto-compaction", () => {
    const loop = makeLoop();
    loop.pendingQueues.set("cli:direct", {} as any);
    loop.turnSlots.set("telegram:chat", [{} as any]);
    loop.sessionDeletionQueues.set("websocket:deleting", []);

    expect(new Set((loop as any).busySessionKeysForAutoCompact())).toEqual(new Set([
      "cli:direct",
      "telegram:chat",
      "websocket:deleting",
    ]));
  });
});
