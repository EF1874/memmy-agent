/** App config service module. */
import { AvatarOptionSchema, TokenUsageDtoSchema } from "@memmy/local-api-contracts";
import type {
  AppSettingsDto,
  AvatarOption,
  LegacyModelConfigInput,
  ModelConfigInput,
  ModelConfigTestInput,
  ModelConfigTestResult,
  ModelConfigView,
  OnboardingStateDto,
  PatchAppSettingsInput,
  PatchOnboardingInput,
  PatchPrivacyInput,
  PatchScanPreferencesInput,
  PrivacySettingsDto,
  ScanPreferences,
  SetAvatarInput,
  SetImprovementProgramInput,
  SetImprovementProgramResponse,
  SetSkinInput,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { ModelConfigRepository } from "../infrastructure/app-state-store/repositories/model-config-repo.js";
import type { MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import { createHttpModelConfigTester, type ModelConfigTester } from "./model-config-tester.js";

export interface AppConfigService {
  updateSettings(input: PatchAppSettingsInput): Promise<AppSettingsDto>;
  updatePrivacy(input: PatchPrivacyInput): Promise<PrivacySettingsDto>;
  updateScanPreferences(input: PatchScanPreferencesInput): Promise<ScanPreferences>;
  updateOnboarding(input: PatchOnboardingInput): Promise<OnboardingStateDto>;
  setImprovementProgram(input: SetImprovementProgramInput): Promise<SetImprovementProgramResponse>;
  getTokenUsage(): Promise<TokenUsageDto>;
  getModelConfig(): Promise<ModelConfigView>;
  setModelConfig(input: ModelConfigInput): Promise<ModelConfigView>;
  testModelConfig(input: ModelConfigTestInput): Promise<ModelConfigTestResult>;
  listAvatars(): Promise<AvatarOption[]>;
  setAvatar(input: SetAvatarInput): Promise<{ avatarId: string }>;
  setSkin(input: SetSkinInput): Promise<{ skinId: string }>;
}

export interface CreateAppConfigServiceOptions {
  bootstrapRepository: Pick<
    BootstrapRepository,
    | "updateAppSettings"
    | "getAppSettings"
    | "getOnboardingState"
    | "updatePrivacy"
    | "updateScanPreferences"
    | "updateOnboarding"
    | "setAvatarSkin"
    | "getPrivacySettings"
  >;
  modelConfigRepository?: ModelConfigRepository;
  modelConfigTester?: ModelConfigTester;
  cloudClient?: Pick<CloudClient, "getTokenUsage" | "grantImprovementProgramTokens">;
  accountSessionRepository?: Pick<AccountSessionRepository, "get" | "getCloudUuid">;
  memmyConfigWriter?: MemmyConfigWriter;
  memoryClient?: Pick<MemoryClient, "reloadConfig">;
}

const BUILT_IN_AVATARS = AvatarOptionSchema.array().parse([
  {
    id: "memmy-default",
    displayName: "Memmy",
    assetKey: "avatar.memmy.default",
    kind: "image"
  },
  {
    id: "memmy-focus",
    displayName: "Memmy Focus",
    assetKey: "avatar.memmy.focus",
    kind: "image"
  },
  {
    id: "memmy-live",
    displayName: "Memmy Live",
    assetKey: "avatar.memmy.live",
    kind: "video"
  }
]);
const IMPROVEMENT_PROGRAM_TOKEN_EXTRA = 5_000_000;
// Idempotency key sent to the cloud so the improvement-program grant is applied at most once per user,
// even if local data is deleted and the user re-accepts after reinstalling.
const IMPROVEMENT_PROGRAM_GRANT_KEY = "improvement_program";
/** Type definition for normalized model config input. */
/** Type definition for resolved model config test input. */
type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

/** Creates create app config service. */
export function createAppConfigService(options: CreateAppConfigServiceOptions): AppConfigService {
  const modelConfigTester = options.modelConfigTester ?? createHttpModelConfigTester();

  return {
    async updateSettings(input) {
      const previousOnboarding = input.userMode === "byok" ? options.bootstrapRepository.getOnboardingState() : null;
      const settings = options.bootstrapRepository.updateAppSettings(input);
      preserveCompletedGuideWhenSwitchingToByok(previousOnboarding, options);
      return settings;
    },

    async updatePrivacy(input) {
      return options.bootstrapRepository.updatePrivacy(input);
    },

    async updateScanPreferences(input) {
      return options.bootstrapRepository.updateScanPreferences(input);
    },

    async updateOnboarding(input) {
      return options.bootstrapRepository.updateOnboarding(input);
    },

    async setImprovementProgram(input) {
      const onboarding = options.bootstrapRepository.updateOnboarding({
        improvementProgram: input.improvementProgram,
        currentStep: "product_tour_required"
      });

      if (input.improvementProgram !== "accepted") {
        return {
          onboarding,
          privacy: options.bootstrapRepository.getPrivacySettings(),
          tokenUsage: await fetchCloudTokenUsage(options)
        };
      }

      const privacy = options.bootstrapRepository.updatePrivacy({
        allowMemoryImprovementUpload: true
      });
      const cloudClient = getConfiguredCloudClient(options);
      const account = getAuthenticatedCloudAccount(options);
      const grantedTokenUsage = await cloudClient.grantImprovementProgramTokens({
        uuid: account.uuid,
        tokenExtra: IMPROVEMENT_PROGRAM_TOKEN_EXTRA,
        grantKey: IMPROVEMENT_PROGRAM_GRANT_KEY
      });
      const tokenUsage = TokenUsageDtoSchema.parse(grantedTokenUsage);

      return {
        onboarding,
        privacy,
        tokenUsage
      };
    },

    async getTokenUsage() {
      return fetchCloudTokenUsage(options);
    },

    async getModelConfig() {
      if (!options.memmyConfigWriter?.readModelConfig) {
        throw new Error("Memmy config writer is not configured");
      }
      return options.memmyConfigWriter.readModelConfig();
    },

    async setModelConfig(input) {
      if (!options.memmyConfigWriter?.writeModelConfig) {
        throw new Error("Memmy config writer is not configured");
      }
      const config = await options.memmyConfigWriter.writeModelConfig(input);
      const legacyProjection = createLegacyAppStateProjection(input, config);
      if (legacyProjection && options.modelConfigRepository) {
        options.modelConfigRepository.upsert(legacyProjection);
      }
      await options.memoryClient?.reloadConfig({ reason: "model_config_saved" });
      return config;
    },

    async testModelConfig(input) {
      return modelConfigTester.test(resolveModelConfigTestInput(input, options.modelConfigRepository));
    },

    async listAvatars() {
      return BUILT_IN_AVATARS;
    },

    async setAvatar(input) {
      ensureAvatarExists(input.avatarId);
      const settings = options.bootstrapRepository.setAvatarSkin({
        avatarId: input.avatarId
      });
      return { avatarId: settings.avatarId };
    },

    async setSkin(input) {
      const settings = options.bootstrapRepository.setAvatarSkin({
        skinId: input.skinId
      });
      return { skinId: settings.skinId };
    }
  };
}

/** Fetches platform Token usage from Cloud only. */
async function fetchCloudTokenUsage(options: CreateAppConfigServiceOptions): Promise<TokenUsageDto> {
  const cloudClient = getConfiguredCloudClient(options);
  const account = getAuthenticatedCloudAccount(options);
  const usage = await cloudClient.getTokenUsage({
    userId: account.userId,
    uuid: account.uuid
  });
  return TokenUsageDtoSchema.parse(usage);
}

/** Handles preserve completed guide when switching to byok. */
function preserveCompletedGuideWhenSwitchingToByok(
  previousOnboarding: OnboardingStateDto | null,
  options: CreateAppConfigServiceOptions
): void {
  if (!previousOnboarding?.completed) {
    return;
  }

  const byokOnboarding = options.bootstrapRepository.getOnboardingState();
  if (byokOnboarding.completed) {
    return;
  }

  options.bootstrapRepository.updateOnboarding({
    completed: true,
    currentStep: "completed",
    completedAt: previousOnboarding.completedAt ?? new Date().toISOString(),
    hasAcceptedTerms: previousOnboarding.hasAcceptedTerms,
    acceptedTermsVersion: previousOnboarding.acceptedTermsVersion,
    scanPermission: previousOnboarding.scanPermission,
    improvementProgram: previousOnboarding.improvementProgram
  });
}

/** Handles resolve model config test input. */
function resolveModelConfigTestInput(
  input: ModelConfigTestInput,
  repository: ModelConfigRepository | undefined
): ResolvedModelConfigTestInput {
  const directApiKey = input.apiKey?.trim();
  if (directApiKey) {
    return { ...input, apiKey: directApiKey };
  }

  if (!input.secretTarget) {
    throw Object.assign(new Error("Model config test requires an API Key"), { code: "invalid_argument" as const });
  }

  if (!repository?.getTestApiKey) {
    throw Object.assign(new Error("Model config repository is not configured"), { code: "invalid_argument" as const });
  }

  const storedApiKey = repository.getTestApiKey(input.secretTarget);
  if (!storedApiKey) {
    throw Object.assign(new Error("Model config API Key is not configured"), { code: "invalid_argument" as const });
  }

  return { ...input, apiKey: storedApiKey };
}

function createLegacyAppStateProjection(
  input: ModelConfigInput,
  view: ModelConfigView
): LegacyModelConfigInput | null {
  const defaultPreset = view.defaultModelPreset;
  if (!defaultPreset) return null;
  const providerView = view.providers.find((provider) => (
    provider.models.some((model) => model.presetName === defaultPreset)
  ));
  const modelView = providerView?.models.find((model) => model.presetName === defaultPreset);
  const provider = providerView ? legacyProviderName(providerView.provider) : null;
  if (!providerView || !modelView || !provider || !providerView.apiBase) return null;
  const providerInput = input.providers.find((item) => item.provider === providerView.provider);
  const primary = {
    provider,
    baseUrl: providerView.apiBase,
    modelId: modelView.model,
    apiKey: providerInput?.apiKey
  };
  const role = (name: "summary" | "evolution") => {
    const configured = input.memmyMemory?.[name];
    return configured?.mode === "fixed" && configured.fixed
      ? configured.fixed
      : primary;
  };
  const embedding = input.embedding?.mode === "custom"
    ? {
        mode: "custom" as const,
        baseUrl: input.embedding.custom.baseUrl,
        modelId: input.embedding.custom.modelId,
        apiKey: input.embedding.custom.apiKey
      }
    : { mode: "local" as const };
  return {
    ...primary,
    embedding,
    memmyMemory: {
      summary: role("summary"),
      evolution: role("evolution")
    },
    asr: input.asr,
    imageGen: input.imageGen
  };
}

function legacyProviderName(provider: string): LegacyModelConfigInput["provider"] | null {
  switch (provider) {
    case "openai":
      return "openai_compatible";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "google";
    case "deepseek":
    case "zhipu":
    case "minimax":
      return provider;
    case "dashscope":
      return "qwen";
    case "moonshot":
      return "kimi";
    case "qianfan":
      return "baidu";
    case "volcengine":
      return "doubao";
    default:
      return null;
  }
}

/** Reads get authenticated cloud account. */
function getAuthenticatedCloudAccount(options: CreateAppConfigServiceOptions): { userId: string; uuid: string } {
  if (!options.accountSessionRepository) {
    throw Object.assign(new Error("Cloud account dependencies are not configured"), { code: "unauthorized" as const });
  }

  const session = options.accountSessionRepository.get();
  const uuid = options.accountSessionRepository.getCloudUuid();
  if (!session.authenticated || !uuid) {
    throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
  }

  return {
    userId: session.profile.userId,
    uuid
  };
}

/** Reads get configured cloud client. */
function getConfiguredCloudClient(options: CreateAppConfigServiceOptions): Pick<CloudClient, "getTokenUsage" | "grantImprovementProgramTokens"> {
  if (!options.cloudClient) {
    throw Object.assign(new Error("Cloud account dependencies are not configured"), { code: "unauthorized" as const });
  }

  return options.cloudClient;
}

/** Validates ensure avatar exists. */
function ensureAvatarExists(avatarId: string): void {
  if (!BUILT_IN_AVATARS.some((avatar) => avatar.id === avatarId)) {
    throw Object.assign(new Error("Avatar not found"), { code: "not_found" as const });
  }
}
