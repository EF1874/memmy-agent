import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAccountModelProjectionFromMemmyConfig,
  writeAccountModelProjectionToMemmyConfig
} from "../index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configFile(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-account-catalog-"));
  roots.push(root);
  const file = join(root, "config.yaml");
  await writeFile(file, YAML.stringify(config), "utf8");
  return file;
}

async function readConfig(file: string): Promise<any> {
  return YAML.parse(await readFile(file, "utf8"));
}

function accountId(owner: string, capability: string): string {
  const hash = createHash("sha256").update(owner).digest("hex").slice(0, 12);
  return `memmy-account-${hash}-${capability.replaceAll("_", "-")}`;
}

function currentByokCatalog(): Record<string, unknown> {
  return {
    futureSection: { keepMe: true },
    providers: {
      openai: {
        apiKey: "byok-secret",
        futureProviderField: "keep-provider",
        endpoints: {
          chat: { apiBase: "https://api.example.test/v1", protocol: "openai-chat-completions" }
        }
      }
    },
    modelPresets: {
      byokAgent: {
        provider: "openai", endpoint: "chat", model: "gpt-5", source: "byok", capabilities: ["agent"]
      },
      byokSummary: {
        provider: "openai", endpoint: "chat", model: "gpt-5-mini", source: "byok", capabilities: ["memory_summary"]
      }
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["byokAgent"], default: "byokAgent" },
        memorySummary: "byokSummary",
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      },
      account: {
        ownerAccountId: "previous-owner",
        agent: { candidates: ["byokAgent"], default: "byokAgent" },
        memorySummary: "byokSummary",
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null,
        futureAssignmentField: "keep-assignment"
      }
    },
    agents: { defaults: { modelPreset: "byokAgent", timezone: "+08:00" } }
  };
}

describe("account model projection current catalog", () => {
  it("creates an owner-scoped Provider, endpoint, six presets, and isolated assignment", async () => {
    const file = await configFile(currentByokCatalog());
    const beforeByok = (await readConfig(file)).modelAssignments.byok;

    const result = await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-token",
      userId: "owner-a"
    }, file);

    expect(result).toEqual({ changed: true, memoryConfigAffected: false });
    const saved = await readConfig(file);
    expect(saved.providers.memmy_account).toMatchObject({
      ownerAccountId: "owner-a",
      apiKey: "cloud-token",
      endpoints: {
        platform: {
          apiBase: expect.stringContaining("/api/agentExternal/v1"),
          protocol: "memmy-account"
        }
      }
    });
    expect(saved.providers.memmy_account).not.toHaveProperty("apiBase");
    for (const capability of ["agent", "memory_summary", "memory_evolution", "embedding", "asr", "image_generation"]) {
      expect(saved.modelPresets[accountId("owner-a", capability)]).toMatchObject({
        provider: "memmy_account",
        endpoint: "platform",
        source: "account",
        ownerAccountId: "owner-a",
        capabilities: [capability]
      });
    }
    expect(saved.modelAssignments.byok).toEqual(beforeByok);
    expect(saved.modelAssignments.account).toMatchObject({
      ownerAccountId: "owner-a",
      agent: {
        candidates: ["byokAgent", accountId("owner-a", "agent")],
        default: "byokAgent"
      },
      memorySummary: "byokSummary",
      memoryEvolution: accountId("owner-a", "memory_evolution"),
      futureAssignmentField: "keep-assignment"
    });
    expect(saved.futureSection.keepMe).toBe(true);
    expect(saved.providers.openai.futureProviderField).toBe("keep-provider");
  });

  it("switches owners without reviving the previous owner's platform definitions", async () => {
    const file = await configFile(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const afterA = await readConfig(file);
    const beforeByok = afterA.modelAssignments.byok;

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-b", userId: "owner-b" }, file);
    const afterB = await readConfig(file);
    expect(afterB.modelPresets[accountId("owner-a", "agent")]).toBeUndefined();
    expect(afterB.modelPresets[accountId("owner-b", "agent")]).toBeDefined();
    expect(afterB.providers.memmy_account.ownerAccountId).toBe("owner-b");
    expect(afterB.modelAssignments.account.ownerAccountId).toBe("owner-b");
    expect(afterB.modelAssignments.byok).toEqual(beforeByok);

    await expect(writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-b", userId: "owner-b" }, file))
      .resolves.toEqual({ changed: false, memoryConfigAffected: false });
  });

  it("logout removes account definitions but leaves both assignment namespaces byte-equivalent", async () => {
    const file = await configFile(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const before = await readConfig(file);

    const result = await clearAccountModelProjectionFromMemmyConfig(file);
    const after = await readConfig(file);
    expect(result).toEqual({ changed: true, memoryConfigAffected: false });
    expect(after.providers.memmy_account).toBeUndefined();
    expect(Object.values(after.modelPresets).some((preset: any) => preset.source === "account")).toBe(false);
    expect(after.modelAssignments.account).toEqual(before.modelAssignments.account);
    expect(after.modelAssignments.byok).toEqual(before.modelAssignments.byok);
    expect(after.app?.cloudUuid).toBeUndefined();
    expect(after.app?.userId).toBeUndefined();
  });

  it("does not expose the account identifier in deterministic preset IDs", async () => {
    const file = await configFile({});
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "secret-token", userId: "person@example.test" }, file);
    const ids = Object.keys((await readConfig(file)).modelPresets);
    expect(ids).toHaveLength(6);
    expect(ids.every((id) => !id.includes("person") && !id.includes("example"))).toBe(true);
  });
});
