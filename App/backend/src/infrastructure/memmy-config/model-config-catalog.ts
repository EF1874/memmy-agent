import {
  ASR_PROVIDER,
  QWEN_ASR_MODEL_ID,
  type AgentApiType,
  type EmbeddingConfigInput,
  type EmbeddingConfigView,
  type ImageGenModelConfigInput,
  type ImageGenModelConfigView,
  type MemoryRoleInput,
  type MemoryRoleView,
  type ModelConfigInput,
  type ModelConfigView,
  type ModelProvider,
  type RoleModelConfigInput,
  type RoleModelConfigView,
  type TextModelProviderInput,
  type TextModelProviderView
} from "@memmy/local-api-contracts";
import { withRuntimeConfigWriteLock } from "@memmy/migrations";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import YAML from "yaml";

const ACCOUNT_PROVIDER = "memmy_account";
const ACCOUNT_PRESET = "memmy-account";
const ACCOUNT_MODEL = "agent_chat";
const DESKTOP_TEXT_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "google",
  "deepseek",
  "zhipu",
  "qwen",
  "kimi",
  "minimax",
  "baidu",
  "doubao",
  ACCOUNT_PROVIDER
]);
const API_KEY_OPTIONAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "openai_codex",
  "github_copilot"
]);

type ConfigRecord = Record<string, unknown>;

export class ModelConfigChangedError extends Error {
  readonly code = "model_config_changed";

  constructor() {
    super("Model configuration changed in another entry point");
    this.name = "ModelConfigChangedError";
  }
}

export class InvalidModelConfigError extends Error {
  readonly code = "invalid_argument";

  constructor(message: string) {
    super(message);
    this.name = "InvalidModelConfigError";
  }
}

export async function readModelConfigCatalog(configPath: string): Promise<ModelConfigView> {
  const target = resolve(configPath);
  const { content, config } = await readConfig(target);
  return buildModelConfigView(config, revisionFor(config), await updatedAt(target, content));
}

export async function writeModelConfigCatalog(
  configPath: string,
  input: ModelConfigInput
): Promise<ModelConfigView> {
  const target = resolve(configPath);
  try {
    return await withRuntimeConfigWriteLock(target, async () => {
      const source = await readConfig(target);
      if (input.configRevision !== revisionFor(source.config)) {
        throw new ModelConfigChangedError();
      }

      const next = mergeModelConfig(source.config, input);
      const sourceBeforeCommit = await readContent(target);
      if (sourceBeforeCommit !== source.content) {
        throw new ModelConfigChangedError();
      }
      await writeConfigAtomic(target, next);
      return buildModelConfigView(next, revisionFor(next), new Date().toISOString());
    });
  } catch (error) {
    if (isErrorCode(error, "migration_lock_timeout")) {
      throw Object.assign(new Error("Model configuration is busy; try again"), {
        code: "config_write_busy" as const
      });
    }
    throw error;
  }
}

export function generateDesktopPresetName(provider: string, model: string): string {
  const normalizedProvider = readablePresetPart(provider, null) || "provider";
  const normalizedModel = readablePresetPart(model, 48) || "model";
  const hash = createHash("sha256")
    .update(`${provider.trim()}\0${model.trim()}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `desktop-${normalizedProvider}-${normalizedModel}-${hash}`;
}

function mergeModelConfig(config: ConfigRecord, input: ModelConfigInput): ConfigRecord {
  const existingProviders = record(config.providers);
  const existingPresets = record(config.modelPresets);
  const inputProviders = input.providers.map(normalizeProviderInput);
  validateProviderInputs(inputProviders);
  validateAccountProvider(inputProviders, existingProviders, existingPresets);

  const editableExistingProviders = existingEditableProviderNames(config);
  const nextProviders = Object.fromEntries(
    Object.entries(existingProviders).filter(([provider]) => (
      !DESKTOP_TEXT_PROVIDERS.has(provider) || !editableExistingProviders.has(provider)
    ))
  );
  const nextPresets = Object.fromEntries(
    Object.entries(existingPresets).filter(([, value]) => (
      preserveHiddenPreset(record(value))
    ))
  );
  const generatedNames = new Map<string, string>();
  const retainedNames = new Set(
    Object.entries(nextPresets)
      .filter(([, value]) => presetPair(record(value)) !== null)
      .map(([name]) => name)
  );
  const retainedPairs = new Set(
    Object.values(nextPresets)
      .map((value) => presetPair(record(value)))
      .filter((pair): pair is string => pair !== null)
  );
  const existingDefaults = record(record(config.agents).defaults);

  for (const providerInput of inputProviders) {
    const providerName = providerInput.provider;
    const previousProvider = record(existingProviders[providerName]);
    if (providerName === ACCOUNT_PROVIDER) {
      nextProviders[providerName] = previousProvider;
    } else {
      nextProviders[providerName] = mergeProvider(previousProvider, providerInput);
    }

    for (const item of providerInput.models) {
      const pair = providerModelPair(providerName, item.model);
      if (retainedPairs.has(pair)) {
        throw new InvalidModelConfigError(
          `Duplicate Provider/model: ${providerName} / ${item.model}`
        );
      }
      const previousPresetName = item.presetName?.trim();
      const legacyDefault = (
        previousPresetName === "default"
        && stringValue(existingDefaults.provider) === providerName
        && stringValue(existingDefaults.model) === item.model
      );
      if (legacyDefault) {
        retainedNames.add("default");
        generatedNames.set("default", "default");
        continue;
      }
      const previousPreset = previousPresetName ? record(existingPresets[previousPresetName]) : {};
      const unchanged = Boolean(
        previousPresetName
        && stringValue(previousPreset.provider) === providerName
        && stringValue(previousPreset.model) === item.model
      );
      const presetName = unchanged
        ? previousPresetName!
        : generateDesktopPresetName(providerName, item.model);
      const occupied = nextPresets[presetName] ?? existingPresets[presetName];
      if (
        occupied
        && (!unchanged || stringValue(record(occupied).provider) !== providerName
          || stringValue(record(occupied).model) !== item.model)
      ) {
        throw new InvalidModelConfigError(`Preset name conflict: ${presetName}`);
      }
      if (retainedNames.has(presetName)) {
        throw new InvalidModelConfigError(`Duplicate preset name: ${presetName}`);
      }
      retainedNames.add(presetName);
      retainedPairs.add(pair);
      generatedNames.set(previousPresetName ?? `${providerName}\0${item.model}`, presetName);
      nextPresets[presetName] = unchanged
        ? { ...previousPreset, provider: providerName, model: item.model }
        : createDefaultPreset(providerName, item.model);
    }
  }

  const currentFallbacks = arrayValue(record(record(config.agents).defaults).fallbackModels);
  const agents = { ...record(config.agents) };
  const defaults = { ...record(agents.defaults) };
  const fallbackModels = currentFallbacks.filter((fallback) => (
    typeof fallback !== "string" || retainedNames.has(fallback)
  ));
  if (fallbackModels.length) defaults.fallbackModels = fallbackModels;
  else delete defaults.fallbackModels;

  const defaultPreset = resolveRequestedDefault(input.defaultModelPreset, generatedNames, retainedNames);
  if (!defaultPreset && retainedNames.size > 0) {
    throw new InvalidModelConfigError("A default model is required");
  }
  if (defaultPreset === "default") {
    defaults.modelPreset = null;
  } else if (defaultPreset) {
    defaults.modelPreset = defaultPreset;
  } else {
    defaults.modelPreset = null;
    delete defaults.provider;
    delete defaults.model;
  }
  agents.defaults = defaults;

  const next: ConfigRecord = {
    ...config,
    providers: nextProviders,
    modelPresets: nextPresets,
    agents
  };
  next.memmyMemory = mergeMemoryConfig(record(config.memmyMemory), input);
  next.tools = mergeOptionalToolConfigs(record(config.tools), input);
  return next;
}

function resolveRequestedDefault(
  requested: string | null,
  generatedNames: ReadonlyMap<string, string>,
  retainedNames: ReadonlySet<string>
): string | null {
  if (requested === null) return retainedNames.values().next().value ?? null;
  if (requested === "default") return "default";
  const resolvedName = generatedNames.get(requested) ?? requested;
  if (!retainedNames.has(resolvedName)) {
    throw new InvalidModelConfigError("Default model does not reference a retained preset");
  }
  return resolvedName;
}

function validateProviderInputs(providers: readonly TextModelProviderInput[]): void {
  const providerNames = new Set<string>();
  const combinations = new Set<string>();
  let modelCount = 0;
  for (const provider of providers) {
    const providerName = provider.provider.trim();
    if (!DESKTOP_TEXT_PROVIDERS.has(providerName)) {
      throw new InvalidModelConfigError(`Provider is not supported by desktop settings: ${providerName}`);
    }
    if (providerNames.has(providerName)) {
      throw new InvalidModelConfigError(`Duplicate Provider: ${providerName}`);
    }
    providerNames.add(providerName);
    if (provider.models.length === 0) {
      throw new InvalidModelConfigError(`Provider ${providerName} must contain at least one model`);
    }
    for (const item of provider.models) {
      const key = `${providerName}\0${item.model.trim()}`;
      if (combinations.has(key)) {
        throw new InvalidModelConfigError(`Duplicate Provider/model: ${providerName} / ${item.model.trim()}`);
      }
      combinations.add(key);
      modelCount += 1;
    }
  }
  if (modelCount === 0) {
    throw new InvalidModelConfigError("At least one text model must remain");
  }
}

function existingEditableProviderNames(config: ConfigRecord): Set<string> {
  const names = new Set<string>();
  const defaults = record(record(config.agents).defaults);
  const namedDefault = stringValue(defaults.modelPreset);
  if (!namedDefault || namedDefault === "default") {
    const provider = stringValue(defaults.provider);
    const model = stringValue(defaults.model);
    if (provider && model && DESKTOP_TEXT_PROVIDERS.has(provider)) names.add(provider);
  }
  for (const value of Object.values(record(config.modelPresets))) {
    const preset = record(value);
    const provider = stringValue(preset.provider);
    if (provider && stringValue(preset.model) && DESKTOP_TEXT_PROVIDERS.has(provider)) {
      names.add(provider);
    }
  }
  return names;
}

function preserveHiddenPreset(preset: ConfigRecord): boolean {
  const provider = stringValue(preset.provider);
  const model = stringValue(preset.model);
  return !provider || !model || !DESKTOP_TEXT_PROVIDERS.has(provider);
}

function presetPair(preset: ConfigRecord): string | null {
  const provider = stringValue(preset.provider);
  const model = stringValue(preset.model);
  return provider && model ? providerModelPair(provider, model) : null;
}

function providerModelPair(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function validateAccountProvider(
  inputs: readonly TextModelProviderInput[],
  existingProviders: ConfigRecord,
  existingPresets: ConfigRecord
): void {
  const existingAccountProvider = record(existingProviders[ACCOUNT_PROVIDER]);
  const existingAccountPreset = record(existingPresets[ACCOUNT_PRESET]);
  const hasManagedAccount = (
    stringValue(existingAccountPreset.provider) === ACCOUNT_PROVIDER
    && stringValue(existingAccountPreset.model) === ACCOUNT_MODEL
  );
  const input = inputs.find((provider) => provider.provider === ACCOUNT_PROVIDER);
  if (!hasManagedAccount && !input) return;
  if (!hasManagedAccount || !input) {
    throw new InvalidModelConfigError("The account Provider is managed by account login");
  }
  if (
    input.models.length !== 1
    || input.models[0]?.presetName !== ACCOUNT_PRESET
    || input.models[0]?.model !== ACCOUNT_MODEL
    || (input.apiBase && input.apiBase !== stringValue(existingAccountProvider.apiBase))
    || input.apiKey
  ) {
    throw new InvalidModelConfigError("The account Provider cannot be edited in model settings");
  }
}

function normalizeProviderInput(input: TextModelProviderInput): TextModelProviderInput {
  return {
    ...input,
    provider: input.provider.trim(),
    apiBase: input.apiBase?.trim(),
    apiKey: input.apiKey?.trim(),
    models: input.models.map((item) => ({
      presetName: item.presetName?.trim(),
      model: item.model.trim()
    }))
  };
}

function mergeProvider(
  previous: ConfigRecord,
  input: TextModelProviderInput
): ConfigRecord {
  const next = { ...previous };
  if (input.apiBase !== undefined) next.apiBase = input.apiBase;
  if (input.apiKey) next.apiKey = input.apiKey;
  if (input.provider === "openai") {
    next.apiType = input.apiType ?? stringValue(previous.apiType) ?? "auto";
  }
  return next;
}

function createDefaultPreset(provider: string, model: string): ConfigRecord {
  return {
    model,
    provider,
    maxTokens: 8192,
    contextWindowTokens: 200000,
    temperature: 0.7,
    reasoningEffort: null
  };
}

function mergeMemoryConfig(memory: ConfigRecord, input: ModelConfigInput): ConfigRecord {
  const next = { ...memory };
  const roleRouting = { ...record(next.roleRouting) };
  if (input.memmyMemory) {
    mergeMemoryRole(next, roleRouting, "summary", input.memmyMemory.summary);
    mergeMemoryRole(next, roleRouting, "evolution", input.memmyMemory.evolution);
  }
  next.roleRouting = roleRouting;
  if (input.embedding) {
    next.embedding = mergeEmbedding(record(next.embedding), input.embedding);
  }
  delete next.activeProfile;
  delete next.profiles;
  return next;
}

function mergeMemoryRole(
  memory: ConfigRecord,
  routing: ConfigRecord,
  role: "summary" | "evolution",
  input: MemoryRoleInput
): void {
  routing[role] = input.mode;
  if (!input.fixed) return;
  memory[role] = mergeFixedRole(record(memory[role]), input.fixed);
}

function mergeFixedRole(previous: ConfigRecord, input: RoleModelConfigInput): ConfigRecord {
  return {
    ...previous,
    provider: memoryProviderName(input.provider),
    vendor: input.provider,
    endpoint: input.baseUrl,
    model: input.modelId,
    apiKey: input.apiKey?.trim() || stringValue(previous.apiKey)
  };
}

function mergeEmbedding(previous: ConfigRecord, input: EmbeddingConfigInput): ConfigRecord {
  const next: ConfigRecord = { ...previous, mode: input.mode };
  if (input.mode === "custom") {
    const custom = { ...record(previous.custom) };
    custom.endpoint = input.custom.baseUrl;
    custom.model = input.custom.modelId;
    if (input.custom.apiKey?.trim()) custom.apiKey = input.custom.apiKey.trim();
    next.custom = custom;
  }
  return next;
}

function mergeOptionalToolConfigs(tools: ConfigRecord, input: ModelConfigInput): ConfigRecord {
  const next = { ...tools };
  if (input.imageGen) {
    const imageGeneration = { ...record(next.imageGeneration) };
    const profiles = { ...record(imageGeneration.profiles) };
    profiles.byok = mergeImageProfile(record(profiles.byok), input.imageGen);
    imageGeneration.profiles = profiles;
    if (!imageGeneration.activeProfile) imageGeneration.activeProfile = "byok";
    imageGeneration.enabled = true;
    next.imageGeneration = imageGeneration;
  }
  if (input.asr) {
    const asr = { ...record(next.asr) };
    asr.provider = input.asr.provider;
    asr.apiBase = input.asr.baseUrl;
    asr.model = input.asr.modelId;
    if (input.asr.apiKey?.trim()) asr.apiKey = input.asr.apiKey.trim();
    next.asr = asr;
  }
  return next;
}

function mergeImageProfile(
  previous: ConfigRecord,
  input: ImageGenModelConfigInput
): ConfigRecord {
  const next: ConfigRecord = {
    ...previous,
    provider: imageProviderName(input.provider),
    apiBase: input.baseUrl,
    model: input.modelId
  };
  if (input.apiKey?.trim()) next.apiKey = input.apiKey.trim();
  return next;
}

function buildModelConfigView(
  config: ConfigRecord,
  configRevision: string,
  updatedAtValue: string
): ModelConfigView {
  const providers = record(config.providers);
  const presets = record(config.modelPresets);
  const defaults = record(record(config.agents).defaults);
  const namedDefault = stringValue(defaults.modelPreset);
  const useLegacyDefault = !namedDefault || namedDefault === "default";
  const presetRows: Array<{ name: string; provider: string; model: string }> = [];
  if (useLegacyDefault) {
    const provider = stringValue(defaults.provider);
    const model = stringValue(defaults.model);
    if (provider && model) presetRows.push({ name: "default", provider, model });
  }
  for (const [name, value] of Object.entries(presets)) {
    const preset = record(value);
    const provider = stringValue(preset.provider);
    const model = stringValue(preset.model);
    if (provider && model) presetRows.push({ name, provider, model });
  }

  const providerOrder: string[] = [];
  for (const preset of presetRows) {
    if (!providerOrder.includes(preset.provider)) {
      providerOrder.push(preset.provider);
    }
  }
  const defaultName = useLegacyDefault ? "default" : namedDefault;
  const providerViews = providerOrder.map((provider) => {
    const providerConfig = record(providers[provider]);
    const available = providerAvailable(provider, providerConfig);
    return {
      provider,
      apiBase: stringValue(providerConfig.apiBase) ?? "",
      apiType: providerApiType(providerConfig.apiType),
      configured: available,
      hasApiKey: Boolean(stringValue(providerConfig.apiKey)),
      apiKeyMasked: maskSecret(stringValue(providerConfig.apiKey)),
      apiKey: "",
      accountManaged: provider === ACCOUNT_PROVIDER,
      editable: provider !== ACCOUNT_PROVIDER,
      models: presetRows
        .filter((preset) => preset.provider === provider)
        .map((preset) => ({
          presetName: preset.name,
          model: preset.model,
          isDefault: preset.name === defaultName,
          available
        }))
    } satisfies TextModelProviderView;
  });
  const flattened = providerViews.flatMap((provider) => provider.models);
  const validDefault = flattened.some((model) => model.presetName === defaultName && model.available)
    ? defaultName ?? null
    : null;
  const memory = record(config.memmyMemory);

  return {
    configRevision,
    providers: providerViews,
    defaultModelPreset: validDefault,
    configured: Boolean(validDefault),
    memmyMemory: {
      summary: memoryRoleView(memory, "summary"),
      evolution: memoryRoleView(memory, "evolution")
    },
    embedding: embeddingView(config),
    asr: asrView(config),
    imageGen: imageView(config),
    updatedAt: updatedAtValue
  };
}

function memoryRoleView(
  memory: ConfigRecord,
  role: "summary" | "evolution"
): MemoryRoleView {
  const routing = record(memory.roleRouting);
  const mode = routing[role] === "fixed" ? "fixed" : "follow";
  return {
    mode,
    fixed: roleView(record(memory[role]))
  };
}

function roleView(role: ConfigRecord): RoleModelConfigView | null {
  const provider = modelProviderValue(stringValue(role.vendor) ?? stringValue(role.provider));
  const baseUrl = stringValue(role.endpoint);
  const modelId = stringValue(role.model);
  if (!provider || !baseUrl || !modelId) return null;
  const apiKey = stringValue(role.apiKey);
  return {
    provider,
    baseUrl,
    modelId,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: ""
  };
}

function embeddingView(config: ConfigRecord): EmbeddingConfigView {
  const memory = record(config.memmyMemory);
  const embedding = record(memory.embedding);
  const accountAvailable = accountProjectionValid(config);
  const mode = embedding.mode === "cloud" && accountAvailable
    ? "cloud"
    : embedding.mode === "custom"
      ? "custom"
      : embedding.mode === "local"
        ? "local"
        : accountAvailable
          ? "cloud"
          : "local";
  const custom = embeddingCustomView(record(embedding.custom));
  if (mode === "custom") {
    if (!custom) {
      return { mode: "local", custom: null };
    }
    return { mode, custom };
  }
  return { mode, custom };
}

function embeddingCustomView(custom: ConfigRecord): NonNullable<EmbeddingConfigView["custom"]> | null {
  const baseUrl = stringValue(custom.endpoint);
  const modelId = stringValue(custom.model);
  if (!baseUrl || !modelId) return null;
  const apiKey = stringValue(custom.apiKey);
  return {
    baseUrl,
    modelId,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: ""
  };
}

function asrView(config: ConfigRecord): ModelConfigView["asr"] {
  const asr = record(record(config.tools).asr);
  const baseUrl = stringValue(asr.apiBase);
  const modelId = stringValue(asr.model);
  if (!baseUrl || modelId !== QWEN_ASR_MODEL_ID) return null;
  const apiKey = stringValue(asr.apiKey);
  return {
    provider: ASR_PROVIDER,
    baseUrl,
    modelId: QWEN_ASR_MODEL_ID,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: ""
  };
}

function imageView(config: ConfigRecord): ImageGenModelConfigView | null {
  const imageGeneration = record(record(config.tools).imageGeneration);
  const profiles = record(imageGeneration.profiles);
  const profile = record(profiles.byok);
  const provider = imageProviderValue(stringValue(profile.provider));
  const baseUrl = stringValue(profile.apiBase);
  const modelId = stringValue(profile.model);
  if (!provider || !baseUrl || !modelId) return null;
  const apiKey = stringValue(profile.apiKey);
  return {
    provider,
    baseUrl,
    modelId,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: ""
  };
}

function accountProjectionValid(config: ConfigRecord): boolean {
  const app = record(config.app);
  const provider = record(record(config.providers)[ACCOUNT_PROVIDER]);
  const preset = record(record(config.modelPresets)[ACCOUNT_PRESET]);
  return Boolean(
    stringValue(app.cloudUuid)
    && stringValue(app.userId)
    && stringValue(provider.apiKey)
    && stringValue(preset.provider) === ACCOUNT_PROVIDER
    && stringValue(preset.model) === ACCOUNT_MODEL
  );
}

function providerAvailable(provider: string, config: ConfigRecord): boolean {
  if (provider === ACCOUNT_PROVIDER) return Boolean(stringValue(config.apiKey));
  if (API_KEY_OPTIONAL_PROVIDERS.has(provider)) return true;
  return Boolean(stringValue(config.apiKey));
}

function revisionFor(config: ConfigRecord): string {
  const fragment = {
    providers: config.providers ?? null,
    modelPresets: config.modelPresets ?? null,
    agents: { defaults: record(config.agents).defaults ?? null },
    memmyMemory: {
      roleRouting: record(config.memmyMemory).roleRouting ?? null,
      summary: record(config.memmyMemory).summary ?? null,
      evolution: record(config.memmyMemory).evolution ?? null,
      embedding: record(config.memmyMemory).embedding ?? null
    },
    asr: record(config.tools).asr ?? null,
    imageGeneration: record(config.tools).imageGeneration ?? null
  };
  return createHash("sha256").update(stableJson(fragment)).digest("hex");
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

async function readConfig(configPath: string): Promise<{ content: string | null; config: ConfigRecord }> {
  const content = await readContent(configPath);
  if (!content?.trim()) return { content, config: {} };
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new InvalidModelConfigError(
      `Unable to read model configuration: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new InvalidModelConfigError("Model configuration must be a YAML object");
  }
  return { content, config: parsed };
}

async function readContent(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function updatedAt(configPath: string, content: string | null): Promise<string> {
  if (content === null) return new Date(0).toISOString();
  try {
    return (await stat(configPath)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

async function writeConfigAtomic(configPath: string, config: ConfigRecord): Promise<void> {
  const directory = dirname(configPath);
  const tempPath = `${directory}/.${basename(configPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(YAML.stringify(config), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, configPath);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readablePresetPart(value: string, maxLength: number | null): string {
  let result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (maxLength !== null) result = result.slice(0, maxLength).replace(/-$/g, "");
  return result;
}

function providerApiType(value: unknown): AgentApiType {
  return value === "chatCompletions" || value === "responses" ? value : "auto";
}

function memoryProviderName(provider: ModelProvider): string {
  if (provider === "anthropic") return "anthropic";
  if (provider === "google") return "gemini";
  return "openai_compatible";
}

function modelProviderValue(value: string | undefined): ModelProvider | null {
  switch (value) {
    case "openai":
    case "openai_compatible":
      return "openai_compatible";
    case "anthropic":
      return "anthropic";
    case "gemini":
    case "google":
      return "google";
    case "deepseek":
    case "zhipu":
    case "qwen":
    case "kimi":
    case "minimax":
    case "baidu":
    case "doubao":
      return value;
    default:
      return null;
  }
}

function imageProviderName(provider: ImageGenModelConfigInput["provider"]): string {
  if (provider === "openai_compatible") return "openai";
  if (provider === "google") return "gemini";
  if (provider === "qwen") return "dashscope";
  if (provider === "baidu") return "qianfan";
  if (provider === "doubao") return "volcengine";
  return provider;
}

function imageProviderValue(value: string | undefined): ImageGenModelConfigInput["provider"] | null {
  switch (value) {
    case "openai":
      return "openai_compatible";
    case "gemini":
      return "google";
    case "dashscope":
      return "qwen";
    case "qianfan":
      return "baidu";
    case "volcengine":
      return "doubao";
    case "zhipu":
    case "minimax":
      return value;
    default:
      return null;
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function record(value: unknown): ConfigRecord {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}
