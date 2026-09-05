import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HELPER_FILE = "MemmyStoreUpdate.exe";

export interface EnsureWindowsStoreLegacyCleanupBrokerOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  resourcesPath: string;
  packageFamilyName: string;
}

export interface EnsureWindowsStoreLegacyCleanupBrokerDependencies {
  runHelper?: (helperPath: string, args: string[]) => Promise<void>;
}

export type EnsureWindowsStoreLegacyCleanupBrokerResult =
  | { status: "not-applicable" }
  | { status: "ready" };

/**
 * Starts the cleanup broker while the caller is still the unpackaged NSIS app.
 * A Store process must never start this broker because its registry context may
 * remain virtualized even after a child loses package identity.
 */
export const ensureWindowsStoreLegacyCleanupBroker = async (
  options: EnsureWindowsStoreLegacyCleanupBrokerOptions,
  dependencies: EnsureWindowsStoreLegacyCleanupBrokerDependencies = {}
): Promise<EnsureWindowsStoreLegacyCleanupBrokerResult> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isWindowsStore) {
    return { status: "not-applicable" };
  }
  if (!options.resourcesPath || options.resourcesPath !== options.resourcesPath.trim()) {
    throw new Error("Windows legacy cleanup broker resources path is unavailable");
  }
  if (!/^[A-Za-z0-9.-]+_[A-Za-z0-9.-]+$/u.test(options.packageFamilyName)) {
    throw new Error("Windows legacy cleanup broker package family is invalid");
  }
  const helperPath = win32.join(options.resourcesPath, "native", HELPER_FILE);
  await (dependencies.runHelper ?? runBrokerHelper)(helperPath, [
    "ensure-legacy-cleanup-broker",
    "--package-family-name",
    options.packageFamilyName
  ]);
  return { status: "ready" };
};

const runBrokerHelper = async (helperPath: string, args: string[]): Promise<void> => {
  await execFileAsync(helperPath, args, {
    timeout: 15_000,
    windowsHide: true
  });
};
