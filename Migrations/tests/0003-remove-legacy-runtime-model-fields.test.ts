import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeLegacyRuntimeModelFieldsV107 } from "../src/migrations/v1.0.7/0003-remove-legacy-runtime-model-fields.js";
import type { AgentWorkspaceMigrationContext } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("v1.0.7/0003-remove-legacy-runtime-model-fields", () => {
  it("removes the invalid BYOK account projection without disturbing valid BYOK assignments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-remove-legacy-model-fields-"));
    roots.push(root);
    const configPath = path.join(root, "config.yaml");
    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        memmy_account: {
          ownerAccountId: "owner-a",
          endpoints: { platform: { apiBase: "https://account.example/v1", protocol: "memmy-account" } },
        },
        openai: {
          apiKey: "sk-valid",
          endpoints: { chat: { apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions" } },
        },
      },
      modelPresets: {
        invalidAccountCopy: {
          provider: "memmy_account",
          endpoint: "platform",
          model: "agent_chat",
          source: "byok",
          capabilities: ["agent"],
        },
        validMemory: {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-4.1-mini",
          source: "byok",
          capabilities: ["memory_summary", "memory_evolution"],
        },
      },
      modelAssignments: {
        byok: {
          agent: { candidates: ["invalidAccountCopy"], default: "invalidAccountCopy" },
          memorySummary: "validMemory",
          memoryEvolution: "validMemory",
          embedding: null,
          asr: null,
          imageGeneration: null,
        },
      },
    }), "utf8");
    const context: AgentWorkspaceMigrationContext = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await removeLegacyRuntimeModelFieldsV107.up(context);

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.modelPresets.invalidAccountCopy).toBeUndefined();
    expect(config.modelAssignments.byok.agent).toEqual({ candidates: [], default: null });
    expect(config.modelAssignments.byok.memorySummary).toBe("validMemory");
    expect(config.modelAssignments.byok.memoryEvolution).toBe("validMemory");
  });
});
