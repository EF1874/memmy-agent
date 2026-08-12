/** Runtime config sync service module. */
import type { UserMode } from "@memmy/local-api-contracts";
import {
  createAppStateStore,
  type AppStateStore
} from "../infrastructure/app-state-store/index.js";
import {
  readRuntimeMemmyConfigState,
  type RuntimeMemmyConfigState
} from "../infrastructure/memmy-config/index.js";

export interface SyncRuntimeConfigWithAppStateOptions {
  appStateStore: AppStateStore;
  memmyConfigPath: string;
}

export interface SyncRuntimeConfigForStartupOptions {
  databasePath: string;
  memmyConfigPath: string;
}

export interface RuntimeConfigSyncResult {
  source: "runtime_config" | "none";
  mode: UserMode;
  provider?: string;
  model?: string;
  hydratedAppState: boolean;
  wroteConfig: boolean;
  reason: string;
}

type RuntimeConfigSyncErrorState = {
  status: "invalid_yaml" | "conflict" | "no_model_config";
  configPath: string;
  reason: string;
};

/**
 * Hydrate current AppState from config.yaml. Missing runtime config is left untouched:
 * importing SQLite model rows into YAML belongs exclusively to startup migrations.
 */
export async function syncRuntimeConfigWithAppState(
  options: SyncRuntimeConfigWithAppStateOptions
): Promise<RuntimeConfigSyncResult> {
  const state = await readRuntimeMemmyConfigState(options.memmyConfigPath);
  switch (state.status) {
    case "valid_byok":
      return hydrateByokRuntimeConfig(options.appStateStore, state);
    case "valid_account":
      return hydrateAccountRuntimeConfig(options.appStateStore, state);
    case "missing":
    case "empty":
      return {
        source: "none",
        mode: options.appStateStore.repositories.bootstrap.getAppSettings().userMode,
        hydratedAppState: false,
        wroteConfig: false,
        reason: `${state.status}_runtime_config_requires_startup_migration`
      };
    case "no_model_config":
      return {
        source: "none",
        mode: options.appStateStore.repositories.bootstrap.getAppSettings().userMode,
        hydratedAppState: false,
        wroteConfig: false,
        reason: state.reason
      };
    case "invalid_yaml":
    case "conflict":
      throw createRuntimeConfigSyncError(state);
  }
}

/** Handles sync runtime config for startup. */
export async function syncRuntimeConfigForStartup(
  options: SyncRuntimeConfigForStartupOptions
): Promise<RuntimeConfigSyncResult> {
  const appStateStore = createAppStateStore({ databasePath: options.databasePath });
  try {
    return await syncRuntimeConfigWithAppState({
      appStateStore,
      memmyConfigPath: options.memmyConfigPath
    });
  } finally {
    appStateStore.close();
  }
}

function hydrateByokRuntimeConfig(
  appStateStore: AppStateStore,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_byok" }>
): RuntimeConfigSyncResult {
  appStateStore.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
  return {
    source: "runtime_config",
    mode: "byok",
    provider: state.context.provider,
    model: state.context.model,
    hydratedAppState: true,
    wroteConfig: false,
    reason: "hydrated_byok_from_runtime_config"
  };
}

function hydrateAccountRuntimeConfig(
  appStateStore: AppStateStore,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_account" }>
): RuntimeConfigSyncResult {
  const activated = appStateStore.repositories.accountSession.activateByCloudUuid(state.cloudUuid);
  const session = appStateStore.repositories.accountSession.get();
  if (!activated || !session.authenticated || (state.userId && session.profile.userId !== state.userId)) {
    if (activated) appStateStore.repositories.accountSession.activateByCloudUuid("");
    return {
      source: "none",
      mode: appStateStore.repositories.bootstrap.getAppSettings().userMode,
      hydratedAppState: false,
      wroteConfig: false,
      reason: "account_projection_has_no_matching_local_session"
    };
  }
  appStateStore.repositories.bootstrap.updateAppSettings({ userMode: "account" });
  return {
    source: "runtime_config",
    mode: "account",
    provider: "memmy_account",
    model: "agent_chat",
    hydratedAppState: true,
    wroteConfig: false,
    reason: "hydrated_account_from_runtime_config"
  };
}

function createRuntimeConfigSyncError(state: RuntimeConfigSyncErrorState): Error {
  return Object.assign(new Error(`Invalid Memmy runtime config: ${state.reason}`), {
    code: "invalid_runtime_config" as const,
    configPath: state.configPath,
    reason: state.reason,
    status: state.status
  });
}
