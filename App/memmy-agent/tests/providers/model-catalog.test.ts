import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readModelCatalog,
  resolveModelSelection,
} from "../../src/providers/model-catalog.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("model catalog", () => {
  it("lists every configured preset and resolves the configured default", () => {
    const configPath = writeConfig(`
providers:
  openai:
    apiBase: https://api.openai.example/v1
    apiKey: sk-openai
  anthropic:
    apiBase: https://api.anthropic.example
    apiKey: sk-anthropic
modelPresets:
  work-gpt:
    provider: openai
    model: gpt-5
  work-claude:
    provider: anthropic
    model: claude-sonnet
agents:
  defaults:
    modelPreset: work-gpt
`);

    expect(readModelCatalog(configPath)).toMatchObject({
      defaultPreset: "work-gpt",
      items: [
        {
          preset: "work-gpt",
          provider: "openai",
          model: "gpt-5",
          isDefault: true,
          available: true,
        },
        {
          preset: "work-claude",
          provider: "anthropic",
          model: "claude-sonnet",
          isDefault: false,
          available: true,
        },
      ],
    });
  });

  it("uses the current default when an explicit requested preset was deleted", () => {
    const configPath = writeConfig(`
providers:
  openai:
    apiBase: https://api.openai.example/v1
    apiKey: sk-openai
  anthropic:
    apiBase: https://api.anthropic.example
    apiKey: sk-anthropic
modelPresets:
  current-default:
    provider: openai
    model: gpt-5
  old-session:
    provider: anthropic
    model: claude-sonnet
agents:
  defaults:
    modelPreset: current-default
`);

    const selected = resolveModelSelection({
      configPath,
      requestedPreset: "deleted-preset",
      sessionPreset: "old-session",
    });

    expect(selected).toMatchObject({
      preset: "current-default",
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("uses a valid Session preset only when no explicit preset was requested", () => {
    const configPath = writeConfig(`
providers:
  openai:
    apiBase: https://api.openai.example/v1
    apiKey: sk-openai
  anthropic:
    apiBase: https://api.anthropic.example
    apiKey: sk-anthropic
modelPresets:
  current-default:
    provider: openai
    model: gpt-5
  session-model:
    provider: anthropic
    model: claude-sonnet
agents:
  defaults:
    modelPreset: current-default
`);

    expect(resolveModelSelection({
      configPath,
      sessionPreset: "session-model",
    })).toMatchObject({
      preset: "session-model",
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });

  it("returns no selection when the catalog has no usable default", () => {
    const configPath = writeConfig(`
providers:
  openai:
    apiBase: https://api.openai.example/v1
modelPresets:
  missing-key:
    provider: openai
    model: gpt-5
agents:
  defaults:
    modelPreset: missing-key
`);

    expect(readModelCatalog(configPath).defaultPreset).toBeNull();
    expect(resolveModelSelection({ configPath })).toBeNull();
  });
});

function writeConfig(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-catalog-"));
  roots.push(root);
  const configPath = path.join(root, "config.yaml");
  fs.writeFileSync(configPath, body.trimStart(), "utf8");
  return configPath;
}
