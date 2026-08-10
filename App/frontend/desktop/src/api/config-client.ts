import type {
  AppSettingsDto,
  EmbeddingMode as ModelEmbeddingMode,
  ModelConfigInput,
  ModelConfigTestCapability,
  ModelConfigTestResult,
  ModelConfigTestSecretTarget,
  ModelConfigView,
  ModelProvider,
  AgentApiType,
  OnboardingStateDto,
  PrivacySettingsDto,
  RuntimeConfig,
  ScanPreferences,
  ScanPermission,
  SetImprovementProgramResponse,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import {
  AppSettingsDtoSchema,
  ModelConfigInputSchema,
  ModelConfigTestInputSchema,
  ModelConfigTestResultSchema,
  ModelConfigViewSchema,
  OnboardingStateDtoSchema,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  PatchScanPreferencesInputSchema,
  PrivacySettingsDtoSchema,
  ScanPreferencesSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  TokenUsageDtoSchema
} from "@memmy/local-api-contracts";
import type { PreferredMode } from "../app/routes.js";
import { requestJson } from "./http.js";

export interface ModelProviderConfig {
  configRevision?: string;
  providers?: TextModelProviderConfig[];
  defaultModelPreset?: string | null;
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  embedding?: EmbeddingProviderConfig | null;
  memmyMemory?: MemmyMemoryProviderConfig | null;
  asr?: AsrProviderConfig | null;
  imageGen?: ImageGenProviderConfig | null;
}

export interface TextModelConfig {
  presetName?: string;
  draftId?: string;
  model: string;
  isDefault: boolean;
  available: boolean;
}

export interface TextModelProviderConfig {
  provider: string;
  endpoint: string;
  apiType: AgentApiType;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  accountManaged: boolean;
  editable: boolean;
  models: TextModelConfig[];
}

export interface RoleModelProviderConfig {
  mode?: "follow" | "fixed";
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface MemmyMemoryProviderConfig {
  summary: RoleModelProviderConfig;
  evolution: RoleModelProviderConfig;
}

export interface EmbeddingProviderConfig {
  mode: ModelEmbeddingMode;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface AsrProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ImageGenProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ConfigClient {
  updateSettings(settings: Partial<AppSettingsDto>): Promise<Partial<AppSettingsDto>>;
  updatePrivacy(privacy: Partial<PrivacySettingsDto>): Promise<Partial<PrivacySettingsDto>>;
  updateOnboarding(onboarding: Partial<OnboardingStateDto>): Promise<Partial<OnboardingStateDto>>;
  setImprovementProgram(accepted: boolean): Promise<SetImprovementProgramResponse>;
  getTokenUsage(): Promise<TokenUsageDto>;
  updateScanPermission(permission: ScanPermission): Promise<Partial<OnboardingStateDto>>;
  updateScanPreferences(preferences: Partial<ScanPreferences>): Promise<ScanPreferences>;
  getModelConfig(): Promise<ModelProviderConfig>;
  saveModelConfig(config: ModelProviderConfig): Promise<ModelProviderConfig>;
  testModelConfig(config: ModelProviderConfig, capability?: ModelConfigTestCapability, secretTarget?: ModelConfigTestSecretTarget): Promise<ModelConfigTestResult>;
  updatePreferredMode(mode: PreferredMode): Promise<PreferredMode>;
}

export function createHttpConfigClient(config: RuntimeConfig): ConfigClient {
  return {
    async updateSettings(settings) {
      return requestJson({
        config,
        path: "/api/app/settings",
        schema: AppSettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchAppSettingsInputSchema.parse(settings)
      });
    },

    async updatePrivacy(privacy) {
      return requestJson({
        config,
        path: "/api/app/privacy",
        schema: PrivacySettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchPrivacyInputSchema.parse(privacy)
      });
    },

    async updateOnboarding(onboarding) {
      return requestJson({
        config,
        path: "/api/app/onboarding",
        schema: OnboardingStateDtoSchema,
        init: { method: "PATCH" },
        body: PatchOnboardingInputSchema.parse(onboarding)
      });
    },

    async setImprovementProgram(accepted) {
      return requestJson({
        config,
        path: "/api/app/improvement-program",
        schema: SetImprovementProgramResponseSchema,
        init: { method: "PATCH" },
        body: SetImprovementProgramInputSchema.parse({
          improvementProgram: accepted ? "accepted" : "declined"
        })
      });
    },

    async getTokenUsage() {
      return requestJson({
        config,
        path: "/api/app/token-usage",
        schema: TokenUsageDtoSchema
      });
    },

    async updateScanPermission(permission) {
      return this.updateOnboarding({
        scanPermission: permission
      });
    },

    async updateScanPreferences(preferences) {
      return requestJson({
        config,
        path: "/api/app/scan-preferences",
        schema: ScanPreferencesSchema,
        init: { method: "PATCH" },
        body: PatchScanPreferencesInputSchema.parse(preferences)
      });
    },

    async getModelConfig() {
      const response = await requestJson({
        config,
        path: "/api/app/model-config",
        schema: ModelConfigViewSchema
      });

      return fromModelConfigView(response);
    },

    async saveModelConfig(modelConfig) {
      const response = await requestJson({
        config,
        path: "/api/app/model-config",
        schema: ModelConfigViewSchema,
        init: { method: "PUT" },
        body: await toModelConfigInput(modelConfig)
      });

      return fromModelConfigView(response);
    },

    async testModelConfig(modelConfig, capability = "chat", secretTarget) {
      return requestJson({
        config,
        path: "/api/app/model-config/test",
        schema: ModelConfigTestResultSchema,
        body: ModelConfigTestInputSchema.parse({
          provider: toModelProvider(modelConfig.provider),
          baseUrl: modelConfig.endpoint,
          modelId: modelConfig.model,
          apiKey: modelConfig.apiKey || undefined,
          capability,
          secretTarget
        })
      });
    },

    async updatePreferredMode(mode) {
      await this.updateSettings({ defaultLaunchMode: mode });
      return mode;
    }
  };
}

async function toModelConfigInput(config: ModelProviderConfig): Promise<ModelConfigInput> {
  const providers = config.providers?.length
    ? config.providers
    : [{
        provider: config.provider,
        endpoint: config.endpoint,
        apiType: "auto" as const,
        apiKey: config.apiKey,
        apiKeyMasked: config.apiKeyMasked,
        configured: config.configured,
        accountManaged: false,
        editable: true,
        models: [{
          model: config.model,
          isDefault: true,
          available: config.configured
        }]
      }];
  const preparedProviders = await Promise.all(providers.map(async (provider) => ({
    provider,
    models: await Promise.all(provider.models.map(async (model) => ({
      ...model,
      resolvedPresetName: model.presetName
        ?? await desktopPresetName(provider.provider, model.model)
    })))
  })));
  const selectedPreset = preparedProviders
    .flatMap(({ models }) => models)
    .find((model) => (
      model.presetName === config.defaultModelPreset
      || model.draftId === config.defaultModelPreset
    ))?.resolvedPresetName
    ?? config.defaultModelPreset
    ?? null;
  return ModelConfigInputSchema.parse({
    configRevision: config.configRevision ?? "unknown",
    providers: preparedProviders.map(({ provider, models }) => ({
      provider: provider.provider,
      apiBase: provider.endpoint || undefined,
      apiType: provider.apiType,
      apiKey: provider.apiKey || undefined,
      models: models.map((model) => ({
        presetName: model.resolvedPresetName,
        model: model.model
      }))
    })),
    defaultModelPreset: selectedPreset,
    embedding: toEmbeddingConfigInput(config.embedding),
    memmyMemory: toMemmyMemoryConfigInput(config),
    asr: toAsrConfigInput(config.asr),
    imageGen: toImageGenConfigInput(config.imageGen)
  });
}

async function desktopPresetName(provider: string, model: string): Promise<string> {
  const normalizedProvider = readablePresetPart(provider, "provider");
  const normalizedModel = readablePresetPart(model, "model").slice(0, 48).replace(/-+$/g, "");
  const bytes = new TextEncoder().encode(`${provider.trim()}\0${model.trim()}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const shortHash = [...digest.slice(0, 4)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `desktop-${normalizedProvider}-${normalizedModel || "model"}-${shortHash}`;
}

function readablePresetPart(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function toImageGenConfigInput(config: ModelProviderConfig["imageGen"]): ModelConfigInput["imageGen"] {
  if (!config || !config.endpoint.trim() || !config.model.trim()) {
    return undefined;
  }
  return {
    provider: toModelProvider(config.provider) as NonNullable<ModelConfigInput["imageGen"]>["provider"],
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined
  };
}

function toEmbeddingConfigInput(config: ModelProviderConfig["embedding"]): ModelConfigInput["embedding"] {
  if (!config) return undefined;
  if (config.mode === "local") {
    return { mode: "local" };
  }
  if (config.mode === "cloud") {
    return { mode: "cloud" };
  }
  // Exclude incomplete custom embedding placeholders before validating the write schema.
  if (!config.endpoint.trim() || !config.model.trim()) {
    return undefined;
  }
  return {
    mode: "custom",
    custom: {
      baseUrl: config.endpoint,
      modelId: config.model,
      apiKey: config.apiKey || undefined
    }
  };
}

// Match normalizeMemmyMemoryInput defaults: missing memory roles fall back to the primary model.
// Omit the section when both roles are absent so empty endpoint or model values never reach RoleModelConfigInputSchema.
function toMemmyMemoryConfigInput(config: ModelProviderConfig): ModelConfigInput["memmyMemory"] {
  const memmyMemory = config.memmyMemory;
  if (!memmyMemory) return undefined;

  const summaryConfigured = hasRoleModelValues(memmyMemory.summary);
  const evolutionConfigured = hasRoleModelValues(memmyMemory.evolution);
  if (!summaryConfigured && !evolutionConfigured) {
    return undefined;
  }

  return {
    summary: toMemoryRoleInput(memmyMemory.summary, summaryConfigured),
    evolution: toMemoryRoleInput(memmyMemory.evolution, evolutionConfigured)
  };
}

function hasRoleModelValues(config: RoleModelProviderConfig): boolean {
  return Boolean(config.endpoint.trim() && config.model.trim());
}

function toRoleModelConfigInput(config: Pick<ModelProviderConfig, "provider" | "endpoint" | "model" | "apiKey">) {
  return {
    provider: toModelProvider(config.provider),
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined
  };
}

function toMemoryRoleInput(
  config: RoleModelProviderConfig,
  configured: boolean
): NonNullable<ModelConfigInput["memmyMemory"]>["summary"] {
  if (config.mode === "follow" || !configured) {
    return { mode: "follow" };
  }
  return {
    mode: "fixed",
    fixed: toRoleModelConfigInput(config)
  };
}

function toAsrConfigInput(config: ModelProviderConfig["asr"]): ModelConfigInput["asr"] {
  if (!config || !config.endpoint.trim()) return undefined;
  return {
    provider: "aliyun",
    baseUrl: config.endpoint,
    modelId: "qwen3-asr-flash",
    apiKey: config.apiKey || undefined
  };
}

function fromModelConfigView(view: ModelConfigView): ModelProviderConfig {
  const selected = findSelectedTextModel(view);
  const embeddingCustom = view.embedding?.custom ?? null;
  return {
    configRevision: view.configRevision,
    providers: view.providers.map((provider) => ({
      provider: provider.provider,
      endpoint: provider.apiBase,
      apiType: provider.apiType,
      apiKey: provider.apiKey,
      apiKeyMasked: provider.apiKeyMasked,
      configured: provider.configured,
      accountManaged: provider.accountManaged,
      editable: provider.editable,
      models: provider.models.map((model) => ({
        presetName: model.presetName,
        model: model.model,
        isDefault: model.isDefault,
        available: model.available
      }))
    })),
    defaultModelPreset: view.defaultModelPreset,
    provider: selected?.provider.provider ?? "openai",
    endpoint: selected?.provider.apiBase ?? "",
    model: selected?.model.model ?? "",
    apiKey: selected?.provider.apiKey ?? "",
    apiKeyMasked: selected?.provider.apiKeyMasked ?? "",
    configured: view.configured,
    embedding: view.embedding ? {
      mode: view.embedding.mode,
      endpoint: embeddingCustom?.baseUrl ?? "",
      model: embeddingCustom?.modelId ?? "",
      apiKey: embeddingCustom?.apiKey ?? "",
      apiKeyMasked: embeddingCustom?.apiKeyMasked ?? "",
      configured: embeddingCustom?.hasApiKey ?? view.embedding.mode !== "custom"
    } : null,
    memmyMemory: {
      summary: fromRoleModelConfigView(view.memmyMemory.summary),
      evolution: fromRoleModelConfigView(view.memmyMemory.evolution)
    },
    asr: view.asr ? {
      provider: view.asr.provider,
      endpoint: view.asr.baseUrl,
      model: view.asr.modelId,
      apiKey: view.asr.apiKey,
      apiKeyMasked: view.asr.apiKeyMasked,
      configured: view.asr.hasApiKey
    } : null,
    imageGen: view.imageGen ? {
      provider: fromModelProvider(view.imageGen.provider),
      endpoint: view.imageGen.baseUrl,
      model: view.imageGen.modelId,
      apiKey: view.imageGen.apiKey,
      apiKeyMasked: view.imageGen.apiKeyMasked,
      configured: view.imageGen.hasApiKey
    } : null
  };
}

function fromRoleModelConfigView(view: ModelConfigView["memmyMemory"]["summary"]): RoleModelProviderConfig {
  const fixed = view.fixed;
  return {
    mode: view.mode,
    provider: fixed ? fromModelProvider(fixed.provider) : "openai",
    endpoint: fixed?.baseUrl ?? "",
    model: fixed?.modelId ?? "",
    apiKey: fixed?.apiKey ?? "",
    apiKeyMasked: fixed?.apiKeyMasked ?? "",
    configured: fixed?.hasApiKey ?? false
  };
}

function findSelectedTextModel(view: ModelConfigView): {
  provider: ModelConfigView["providers"][number];
  model: ModelConfigView["providers"][number]["models"][number];
} | null {
  for (const provider of view.providers) {
    const model = provider.models.find(
      (candidate) => candidate.presetName === view.defaultModelPreset
    );
    if (model) return { provider, model };
  }
  const provider = view.providers[0];
  const model = provider?.models[0];
  return provider && model ? { provider, model } : null;
}

function toModelProvider(provider: string): ModelProvider {
  if (provider === "openai") {
    return "openai_compatible";
  }

  return provider === "gemini" ? "google" : (provider as ModelProvider);
}

function fromModelProvider(provider: ModelProvider): string {
  if (provider === "openai_compatible") {
    return "openai";
  }

  return provider === "google" ? "gemini" : provider;
}
