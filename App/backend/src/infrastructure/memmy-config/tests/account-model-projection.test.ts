import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  clearAccountModelProjectionFromMemmyConfig,
  writeAccountModelProjectionToMemmyConfig
} from "../index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

async function configFile(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "memmy-account-model-"));
  temporaryRoots.push(root);
  const file = path.join(root, "config.yaml");
  await writeFile(file, YAML.stringify(config), "utf8");
  return file;
}

async function readConfig(file: string): Promise<any> {
  return YAML.parse(await readFile(file, "utf8"));
}

describe("account model projection", () => {
  it("adds the account Provider without replacing a valid BYOK default", async () => {
    const file = await configFile({
      providers: {
        openai: {
          apiBase: "https://api.openai.com/v1",
          apiKey: "byok-secret"
        }
      },
      modelPresets: {
        "work-gpt": {
          provider: "openai",
          model: "gpt-5"
        }
      },
      agents: {
        defaults: {
          modelPreset: "work-gpt"
        }
      },
      memmyMemory: {
        userId: "local-user",
        roleRouting: {
          summary: "fixed",
          evolution: "follow"
        },
        summary: {
          provider: "openai_compatible",
          endpoint: "https://memory.example.test/v1",
          model: "memory-model",
          apiKey: "memory-secret"
        },
        embedding: {
          mode: "local"
        }
      }
    });

    await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-uuid",
      userId: "account-user"
    }, file);
    const loggedIn = await readConfig(file);

    expect(loggedIn.agents.defaults.modelPreset).toBe("work-gpt");
    expect(loggedIn.providers.openai.apiKey).toBe("byok-secret");
    expect(loggedIn.providers.memmy_account.apiKey).toBe("cloud-uuid");
    expect(loggedIn.modelPresets["memmy-account"]).toEqual({
      provider: "memmy_account",
      model: "agent_chat"
    });
    expect(loggedIn.app).toMatchObject({
      cloudUuid: "cloud-uuid",
      userId: "account-user"
    });
    expect(loggedIn.memmyMemory).toMatchObject({
      userId: "local-user",
      roleRouting: {
        summary: "fixed",
        evolution: "follow"
      },
      embedding: {
        mode: "local"
      }
    });

    await clearAccountModelProjectionFromMemmyConfig(file);
    const loggedOut = await readConfig(file);
    expect(loggedOut.providers.openai.apiKey).toBe("byok-secret");
    expect(loggedOut.providers.memmy_account).toBeUndefined();
    expect(loggedOut.modelPresets["memmy-account"]).toBeUndefined();
    expect(loggedOut.agents.defaults.modelPreset).toBe("work-gpt");
    expect(loggedOut.app?.cloudUuid).toBeUndefined();
    expect(loggedOut.app?.userId).toBeUndefined();
    expect(loggedOut.memmyMemory.userId).toBe("local-user");
    expect(loggedOut.memmyMemory.summary.model).toBe("memory-model");
  });

  it("uses the account model only when no valid default exists and clears it on logout", async () => {
    const file = await configFile({
      memmyMemory: {
        roleRouting: {
          summary: "follow",
          evolution: "follow"
        },
        embedding: {
          mode: "cloud",
          custom: {
            endpoint: "https://embedding.example.test/v1",
            model: "embedding-model",
            apiKey: "embedding-secret"
          }
        }
      }
    });

    await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-uuid",
      userId: "account-user"
    }, file);
    expect((await readConfig(file)).agents.defaults.modelPreset).toBe("memmy-account");

    await clearAccountModelProjectionFromMemmyConfig(file);
    const loggedOut = await readConfig(file);
    expect(loggedOut.agents.defaults.modelPreset).toBeNull();
    expect(loggedOut.memmyMemory.embedding.mode).toBe("custom");
    expect(loggedOut.memmyMemory.roleRouting).toEqual({
      summary: "follow",
      evolution: "follow"
    });
  });

  it("rejects an occupied memmy-account preset without modifying the file", async () => {
    const file = await configFile({
      providers: {
        openai: {
          apiKey: "byok-secret"
        }
      },
      modelPresets: {
        "memmy-account": {
          provider: "openai",
          model: "gpt-5"
        }
      }
    });
    const before = await readFile(file, "utf8");

    await expect(writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-uuid",
      userId: "account-user"
    }, file)).rejects.toMatchObject({
      code: "account_model_preset_conflict"
    });
    await expect(readFile(file, "utf8")).resolves.toBe(before);
  });
});
