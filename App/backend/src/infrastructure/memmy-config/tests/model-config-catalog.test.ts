import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { ModelConfigInput } from "@memmy/local-api-contracts";
import {
  generateDesktopPresetName,
  readModelConfigCatalog,
  writeModelConfigCatalog
} from "../model-config-catalog.js";
import { systemUtcOffset } from "../../../utils/time-zone.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-"));
  temporaryRoots.push(root);
  const configPath = path.join(root, "config.yaml");
  await writeFile(configPath, YAML.stringify({
    providers: {
      openai: {
        apiBase: "https://api.openai.com/v1",
        apiKey: "openai-secret",
        unknownProviderField: "keep"
      }
    },
    modelPresets: {
      "work-gpt": {
        provider: "openai",
        model: "gpt-5",
        maxTokens: 3210,
        contextWindowTokens: 98765,
        temperature: 0.2,
        reasoningEffort: "high",
        unknownPresetField: "keep"
      }
    },
    agents: {
      defaults: {
        modelPreset: "work-gpt",
        fallbackModels: ["work-gpt", "missing-preset"],
        maxToolIterations: 77
      }
    },
    memmyMemory: {
      roleRouting: {
        summary: "follow",
        evolution: "fixed"
      },
      evolution: {
        provider: "openai_compatible",
        vendor: "openai_compatible",
        endpoint: "https://memory.example.test/v1",
        model: "memory-model",
        apiKey: "memory-secret"
      },
      embedding: {
        mode: "local"
      }
    },
    unrelated: {
      value: "keep"
    }
  }), "utf8");
  return configPath;
}

function input(
  configRevision: string,
  overrides: Partial<ModelConfigInput> = {}
): ModelConfigInput {
  const generated = generateDesktopPresetName("openai", "gpt-5-mini");
  return {
    configRevision,
    providers: [
      {
        provider: "openai",
        apiBase: "https://api.openai.com/v1",
        models: [
          { presetName: "work-gpt", model: "gpt-5" },
          { presetName: generated, model: "gpt-5-mini" }
        ]
      },
      {
        provider: "anthropic",
        apiBase: "https://api.anthropic.com",
        apiKey: "anthropic-secret",
        models: [
          {
            presetName: generateDesktopPresetName("anthropic", "claude-sonnet-4"),
            model: "claude-sonnet-4"
          }
        ]
      }
    ],
    defaultModelPreset: generated,
    memmyMemory: {
      summary: { mode: "follow" },
      evolution: {
        mode: "fixed",
        fixed: {
          provider: "openai_compatible",
          baseUrl: "https://memory.example.test/v1",
          modelId: "memory-model"
        }
      }
    },
    embedding: { mode: "local" },
    ...overrides
  };
}

describe("model config catalog", () => {
  it("returns only providers that have at least one configured model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-"));
    temporaryRoots.push(root);
    const configPath = path.join(root, "config.yaml");
    await writeFile(configPath, YAML.stringify({
      providers: {
        openai: { apiKey: "openai-secret" },
        anthropic: {},
        gemini: {},
        deepseek: {},
        zhipu: {},
        qwen: {},
        kimi: {},
        minimax: {},
        baidu: {},
        doubao: {},
      },
      modelPresets: {
        configured: {
          provider: "openai",
          model: "gpt-5",
        },
      },
      agents: {
        defaults: {
          modelPreset: "configured",
        },
      },
    }), "utf8");

    const view = await readModelConfigCatalog(configPath);

    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]).toMatchObject({
      provider: "openai",
      models: [{ presetName: "configured", model: "gpt-5" }],
    });
  });

  it("returns a configured model even when its provider has no API key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-"));
    temporaryRoots.push(root);
    const configPath = path.join(root, "config.yaml");
    await writeFile(configPath, YAML.stringify({
      providers: {
        openai: {},
      },
      modelPresets: {
        configured: {
          provider: "openai",
          model: "gpt-5",
        },
      },
      agents: {
        defaults: {
          modelPreset: "configured",
        },
      },
    }), "utf8");

    const view = await readModelConfigCatalog(configPath);

    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]).toMatchObject({
      provider: "openai",
      configured: false,
      hasApiKey: false,
      models: [{
        presetName: "configured",
        model: "gpt-5",
        available: false,
      }],
    });
  });

  it("round-trips multiple Providers/models and preserves unchanged advanced fields", async () => {
    const configPath = await fixture();
    const before = await readModelConfigCatalog(configPath);
    const saved = await writeModelConfigCatalog(configPath, input(before.configRevision));
    const raw = YAML.parse(await readFile(configPath, "utf8"));
    const generated = generateDesktopPresetName("openai", "gpt-5-mini");

    expect(saved.defaultModelPreset).toBe(generated);
    expect(saved.providers.map((provider) => provider.provider)).toEqual(["openai", "anthropic"]);
    expect(saved.providers[0]?.models.map((model) => model.model)).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(raw.modelPresets["work-gpt"]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      maxTokens: 3210,
      contextWindowTokens: 98765,
      temperature: 0.2,
      reasoningEffort: "high",
      unknownPresetField: "keep"
    });
    expect(raw.modelPresets[generated]).toMatchObject({
      provider: "openai",
      model: "gpt-5-mini"
    });
    expect(raw.providers.openai).toMatchObject({
      apiKey: "openai-secret",
      unknownProviderField: "keep"
    });
    expect(raw.agents.defaults).toMatchObject({
      modelPreset: generated,
      timezone: systemUtcOffset(),
      maxToolIterations: 77,
      fallbackModels: ["work-gpt"]
    });
    expect(raw.unrelated).toEqual({ value: "keep" });
  });

  it("rejects duplicate Provider/model pairs without changing the file", async () => {
    const configPath = await fixture();
    const before = await readModelConfigCatalog(configPath);
    const contentBefore = await readFile(configPath, "utf8");
    const duplicate = input(before.configRevision, {
      providers: [{
        provider: "openai",
        apiBase: "https://api.openai.com/v1",
        models: [
          { presetName: "work-gpt", model: "gpt-5" },
          { model: "gpt-5" }
        ]
      }]
    });

    await expect(writeModelConfigCatalog(configPath, duplicate)).rejects.toMatchObject({
      code: "invalid_argument"
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(contentBefore);
  });

  it("rejects a stale revision and leaves a newer external edit intact", async () => {
    const configPath = await fixture();
    const before = await readModelConfigCatalog(configPath);
    const raw = YAML.parse(await readFile(configPath, "utf8"));
    raw.unrelated.value = "changed elsewhere";
    raw.providers.openai.apiKey = "newer-secret";
    await writeFile(configPath, YAML.stringify(raw), "utf8");

    await expect(writeModelConfigCatalog(configPath, input(before.configRevision))).rejects.toMatchObject({
      code: "model_config_changed"
    });
    const after = YAML.parse(await readFile(configPath, "utf8"));
    expect(after.unrelated.value).toBe("changed elsewhere");
    expect(after.providers.openai.apiKey).toBe("newer-secret");
  });

  it("preserves hidden CLI providers, presets, orphan provider settings, and the hidden default", async () => {
    const configPath = await fixture();
    const raw = YAML.parse(await readFile(configPath, "utf8"));
    raw.providers.openrouter = {
      apiKey: "router-secret",
      apiBase: "https://openrouter.ai/api/v1",
      extraHeaders: { "X-CLI": "keep" },
    };
    raw.providers.groq = {
      apiKey: "orphan-secret",
    };
    raw.modelPresets["cli-router"] = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      maxTokens: 4444,
      unknownPresetField: "keep",
    };
    raw.agents.defaults.modelPreset = "cli-router";
    await writeFile(configPath, YAML.stringify(raw), "utf8");
    const before = await readModelConfigCatalog(configPath);

    await writeModelConfigCatalog(configPath, input(before.configRevision, {
      defaultModelPreset: "cli-router",
    }));

    const saved = YAML.parse(await readFile(configPath, "utf8"));
    expect(saved.providers.openrouter).toEqual(raw.providers.openrouter);
    expect(saved.providers.groq).toEqual(raw.providers.groq);
    expect(saved.modelPresets["cli-router"]).toEqual(raw.modelPresets["cli-router"]);
    expect(saved.agents.defaults.modelPreset).toBe("cli-router");
  });

  it("rejects desktop writes for unsupported providers", async () => {
    const configPath = await fixture();
    const before = await readModelConfigCatalog(configPath);

    await expect(writeModelConfigCatalog(configPath, input(before.configRevision, {
      providers: [{
        provider: "openrouter",
        apiBase: "https://openrouter.ai/api/v1",
        models: [{ model: "openai/gpt-5" }],
      }],
    }))).rejects.toThrow(/not supported by desktop settings/);
  });

  it("rejects a Provider/model pair that duplicates a hidden CLI preset", async () => {
    const configPath = await fixture();
    const raw = YAML.parse(await readFile(configPath, "utf8"));
    raw.providers.openrouter = {
      apiKey: "router-secret",
      apiBase: "https://openrouter.ai/api/v1",
    };
    raw.modelPresets["cli-router"] = {
      provider: "openrouter",
      model: "shared-model",
    };
    await writeFile(configPath, YAML.stringify(raw), "utf8");
    const before = await readModelConfigCatalog(configPath);

    await expect(writeModelConfigCatalog(configPath, input(before.configRevision, {
      providers: [{
        provider: "openrouter",
        apiBase: "https://openrouter.ai/api/v1",
        models: [{ model: "shared-model" }],
      }],
    }))).rejects.toThrow(/not supported by desktop settings/);
  });

  it("uses the agreed deterministic desktop preset name", () => {
    expect(generateDesktopPresetName("OpenAI", "GPT 5 / Mini")).toMatch(
      /^desktop-openai-gpt-5-mini-[a-f0-9]{8}$/
    );
    expect(generateDesktopPresetName("OpenAI", "GPT 5 / Mini")).toBe(
      generateDesktopPresetName("OpenAI", "GPT 5 / Mini")
    );
  });
});
