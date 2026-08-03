export {
  RuntimeConfigSchema as DesktopRuntimeConfigSchema,
  type RuntimeConfig as DesktopRuntimeConfig
} from "@memmy/local-api-contracts";

export type MicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

export interface DesktopMenuBarIconResult {
  enabled: boolean;
}

export interface DesktopMemoryServiceRestartResult {
  ok: true;
  baseUrl: string;
}

export interface DesktopAppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  updateProvider?: DesktopUpdateProvider;
  updateManifestUrl?: string;
}

export type DesktopUpdateCheckStatus = "not-configured" | "latest" | "available";

export type DesktopUpdateMode = "manual" | "silent" | "force";

export type DesktopUpdateProvider = "legacy-installer" | "microsoft-store";

export interface DesktopUpdateCheckResult {
  status: DesktopUpdateCheckStatus;
  currentVersion: string;
  provider?: DesktopUpdateProvider;
  latestVersion?: string;
  minSupportedVersion?: string;
  updateMode?: DesktopUpdateMode;
  force?: boolean;
  canSilentlyDownload?: boolean;
  storeUpdateCount?: number;
  downloadUrl?: string;
  preparedUpdatePath?: string;
  releaseNotes?: string;
  publishedAt?: string;
}

export interface DesktopUpdateDownloadOptions {
  openInstaller?: boolean;
}

export interface DesktopUpdateDownloadProgress {
  downloadUrl: string;
  filePath: string;
  transferredBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface DesktopUpdateInstallResult {
  filePath: string;
  opened: boolean;
  willQuit?: boolean;
  background?: boolean;
}

export interface DesktopImageActionRequest {
  url: string;
  name?: string;
  mime?: string;
  data?: Uint8Array;
}

export type DesktopImageSaveResult =
  | { canceled: true }
  | { canceled: false; filePath: string; bytes: number };

export type DesktopProjectDirectorySelection =
  | { canceled: true }
  | { canceled: false; path: string };
