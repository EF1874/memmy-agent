import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getConfigPath, loadConfig, resolveConfigEnvVars } from "../config/loader.js";
import type { Config, ModelPresetConfig } from "../config/schema.js";
import { buildProviderSnapshot, type ProviderSnapshot } from "./factory.js";
import { findByName } from "./registry.js";

export type ModelCatalogItem = {
  preset: string;
  provider: string;
  model: string;
  isDefault: boolean;
  available: boolean;
};

export type ModelCatalog = {
  items: ModelCatalogItem[];
  defaultPreset: string | null;
  fingerprint: string;
};

export type ResolvedModelSelection = {
  preset: string;
  provider: string;
  model: string;
  snapshot: ProviderSnapshot;
};

export function readModelCatalog(configPath: string | null = null): ModelCatalog {
  const config = resolveConfigEnvVars(loadConfig(configPath));
  const defaults = config.agents.defaults;
  const activeName = defaults.modelPreset;
  const useLegacyDefault = !activeName || activeName === "default";
  const candidates: Array<{ preset: string; value: ModelPresetConfig }> = [];
  if (useLegacyDefault) {
    try {
      candidates.push({ preset: "default", value: config.resolvePreset("default") });
    } catch {
      // An incomplete legacy default is represented as no compatibility item.
    }
  }
  for (const [preset, value] of Object.entries(config.modelPresets)) {
    candidates.push({ preset, value });
  }

  const seen = new Set<string>();
  const items: ModelCatalogItem[] = [];
  for (const candidate of candidates) {
    const provider = resolvedProviderName(config, candidate.value);
    const model = candidate.value.model.trim();
    if (!provider || !model) continue;
    const pair = `${provider}\0${model}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    items.push({
      preset: candidate.preset,
      provider,
      model,
      isDefault: candidate.preset === (useLegacyDefault ? "default" : activeName),
      available: canBuildPreset(config, candidate.preset),
    });
  }
  const defaultCandidate = useLegacyDefault ? "default" : activeName;
  const defaultPreset = (
    defaultCandidate
    && items.some((item) => item.preset === defaultCandidate && item.available)
  ) ? defaultCandidate : null;
  return {
    items,
    defaultPreset,
    fingerprint: modelCatalogFingerprint(configPath),
  };
}

export function resolveModelSelection(input: {
  configPath?: string | null;
  requestedPreset?: string | null;
  sessionPreset?: string | null;
}): ResolvedModelSelection | null {
  const configPath = input.configPath ?? null;
  const config = resolveConfigEnvVars(loadConfig(configPath));
  const catalog = readModelCatalog(configPath);
  const available = new Set(
    catalog.items.filter((item) => item.available).map((item) => item.preset),
  );
  let selected: string | null;
  if (input.requestedPreset !== undefined) {
    selected = input.requestedPreset && available.has(input.requestedPreset)
      ? input.requestedPreset
      : catalog.defaultPreset;
  } else if (input.sessionPreset && available.has(input.sessionPreset)) {
    selected = input.sessionPreset;
  } else {
    selected = catalog.defaultPreset;
  }
  if (!selected) return null;
  const item = catalog.items.find((candidate) => candidate.preset === selected);
  if (!item) return null;
  try {
    return {
      preset: selected,
      provider: item.provider,
      model: item.model,
      snapshot: buildProviderSnapshot(config, { presetName: selected }),
    };
  } catch {
    return null;
  }
}

export function modelCatalogFingerprint(configPath: string | null = null): string {
  const target = path.resolve(configPath ?? getConfigPath());
  let parsed: unknown = {};
  try {
    const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    parsed = content.trim() ? YAML.parse(content) : {};
  } catch {
    return "invalid";
  }
  const config = record(parsed);
  const fragment = {
    providers: config.providers ?? null,
    modelPresets: config.modelPresets ?? null,
    agents: { defaults: record(config.agents).defaults ?? null },
  };
  return createHash("sha256").update(stableJson(fragment)).digest("hex");
}

function canBuildPreset(config: Config, preset: string): boolean {
  try {
    buildProviderSnapshot(config, { presetName: preset });
    return true;
  } catch {
    return false;
  }
}

function resolvedProviderName(config: Config, preset: ModelPresetConfig): string | null {
  const configured = config.getProviderName(preset.model, { preset });
  if (configured) return configured;
  if (preset.provider !== "auto") return preset.provider;
  const prefix = preset.model.split("/", 1)[0]?.trim();
  return prefix && findByName(prefix) ? prefix : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
