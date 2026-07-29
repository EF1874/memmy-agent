import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../src/core/runtime-messages/queue.js";
import {
  buildHelpText,
  builtinCommandPalette,
  cmdGoal,
  cmdModel,
  registerBuiltinCommands,
} from "../../src/command/builtin.js";
import { CommandContext, CommandRouter } from "../../src/command/router.js";
import { Config, ModelPresetConfig } from "../../src/config/schema.js";

function provider(defaultModel: string, maxTokens = 123): any {
  return {
    getDefaultModel: () => defaultModel,
    spec: { name: "openai" },
    generation: { max_tokens: maxTokens, maxTokens, temperature: 0.1, reasoning_effort: null, reasoningEffort: null },
  };
}

const temporaryRoots: string[] = [];

afterEach(() => {
  delete process.env.MEMMY_CONFIG;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeLoop(): AgentLoop {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-command-"));
  temporaryRoots.push(root);
  const configPath = path.join(root, "config.yaml");
  fs.writeFileSync(configPath, [
    "providers:",
    "  openai:",
    "    apiBase: https://api.openai.com/v1",
    "    apiKey: test-key",
    "modelPresets:",
    "  fast:",
    "    provider: openai",
    "    model: openai/gpt-4.1",
    "    maxTokens: 4096",
    "    contextWindowTokens: 32768",
    "agents:",
    "  defaults:",
    "    provider: openai",
    "    model: base-model",
    "",
  ].join("\n"));
  process.env.MEMMY_CONFIG = configPath;
  const config = new Config({
    providers: {
      openai: {
        apiBase: "https://api.openai.com/v1",
        apiKey: "test-key",
      },
    },
    agents: {
      defaults: {
        provider: "openai",
        model: "base-model",
      },
    },
    fileMemory: { enabled: true },
  });
  return new AgentLoop({
    config,
    bus: new MessageBus(),
    provider: provider("base-model", 123),
    workspace: root,
    model: "base-model",
    contextWindowTokens: 1000,
    modelPresets: {
      fast: new ModelPresetConfig({
        provider: "openai",
        model: "openai/gpt-4.1",
        maxTokens: 4096,
        contextWindowTokens: 32_768,
      }),
    },
  });
}

function ctx(loop: AgentLoop, raw: string, args = "", sessionInput: any = null): CommandContext {
  const msg = new InboundMessage({ channel: "cli", senderId: "user", chatId: "direct", content: raw });
  const session = sessionInput === true
    ? loop.sessions.getOrCreate(msg.sessionKey)
    : sessionInput;
  return new CommandContext({ msg, session, key: msg.sessionKey, raw, args, loop });
}

describe("model command", () => {
  it("lists current and available presets", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model"));
    expect(out.content).toContain("Current model: `openai / base-model`");
    expect(out.content).toContain("Current preset: `default`");
    expect(out.content).toContain("Available presets: `default`, `fast`");
    expect(out.metadata).toEqual({ renderAs: "text" });
  });

  it("lists preset to Provider/model mappings", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model list", "list"));
    expect(out.content).toContain("`default` -> `openai / base-model`");
    expect(out.content).toContain("`fast` -> `openai / openai/gpt-4.1`");
  });

  it("switches only the current Session and not the process-wide model", async () => {
    const loop = makeLoop();
    const mirrorUpdated = vi.fn();
    loop.guiTranscriptMirror = { sessionUpdated: mirrorUpdated } as any;
    const context = ctx(loop, "/model fast", "fast", true);
    const other = loop.sessions.getOrCreate("cli:other");

    const out = await cmdModel(context);

    expect(out.content).toContain("Switched this Session to `fast`.");
    expect(out.content).toContain("Model: `openai / openai/gpt-4.1`");
    expect(context.session?.metadata.modelPreset).toBe("fast");
    expect(loop.sessions.reload(context.key)?.metadata.modelPreset).toBe("fast");
    expect(other.metadata.modelPreset).toBeUndefined();
    expect(loop.modelPreset).toBeNull();
    expect(loop.model).toBe("base-model");
    expect(loop.contextWindowTokens).toBe(1000);
    expect(mirrorUpdated).toHaveBeenCalledWith(context.key);
  });

  it("keeps old state for unknown preset", async () => {
    const loop = makeLoop();
    const context = ctx(loop, "/model missing", "missing", true);
    const out = await cmdModel(context);
    expect(out.content).toContain("Could not switch model preset");
    expect(out.content).not.toContain('"modelPreset');
    expect(out.content).toContain("Available presets: `default`, `fast`");
    expect(context.session?.metadata.modelPreset).toBeUndefined();
    expect(loop.modelPreset).toBeNull();
    expect(loop.model).toBe("base-model");
  });

  it("is registered as exact and prefix and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const out = await router.dispatch(ctx(loop, "/model fast", "", true));
    expect(out?.content).toContain("Switched this Session");
    expect(loop.modelPreset).toBeNull();
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[list|preset]" })]));
    expect(buildHelpText()).toContain("/model [list|preset]");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[list|preset]" })]));
    expect(buildHelpText()).toContain("/model [list|preset]");
  });
});

describe("goal command", () => {
  it("shows usage without args and rejects mid-turn without session", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal")))?.content).toContain("Usage: /goal");
    expect((await cmdGoal(ctx(loop, "/goal do work", "do work")))?.content).toContain("/stop");
  });

  it("shows usage without args", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal")))?.content).toContain("Usage: /goal");
  });

  it("rejects mid-turn starts when no session is available", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal do work", "do work")))?.content).toContain("/stop");
  });

  it("rewrites to an agent prompt when a session is available", async () => {
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal audit the repo", "audit the repo", {});
    const out = await cmdGoal(commandCtx);
    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("audit the repo");
    expect(commandCtx.msg.content).toContain("long_task");
    expect(commandCtx.msg.metadata.originalCommand).toBe("/goal");
    expect(commandCtx.msg.metadata.originalContent).toBe("/goal audit the repo");
    expect(typeof commandCtx.msg.metadata.goalStartedAt).toBe("number");
  });

  it("is registered and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", {});
    const out = await router.dispatch(commandCtx);
    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("ship it");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/goal", arg_hint: "<goal>" })]));
    expect(buildHelpText()).toContain("/goal <goal>");
  });

  it("dispatches through the command router", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", {});

    const out = await router.dispatch(commandCtx);

    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("ship it");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/goal", arg_hint: "<goal>" })]));
    expect(buildHelpText()).toContain("/goal <goal>");
  });
});
