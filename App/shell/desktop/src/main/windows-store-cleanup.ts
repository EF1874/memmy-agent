import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLEANUP_COMPLETION_FILE = "legacy-cleanup-completed-v1.json";
const CLEANUP_LOG_FILE = "legacy-cleanup.log";
const DESKTOP_SHORTCUT_HANDOFF_FILE = "legacy-desktop-shortcut-handoff-v1.json";
const STORE_MIGRATION_IN_PROGRESS_FILE = "store-migration-in-progress-v1.json";

export interface WindowsStoreCleanupOptions {
  resourcesPath: string;
  storeUserDataPath: string;
  roamingAppDataPath: string;
  localAppDataPath: string;
  desktopPath: string;
}

export type WindowsStoreCleanupResult = "already-completed" | "not-available" | "completed";

interface StoreIdentityResult {
  type: "identity";
  aumid: string;
}

export interface WindowsStoreCleanupDependencies {
  readStoreIdentity?: (helperPath: string) => Promise<StoreIdentityResult>;
  prepareLegacyTakeover?: (helperPath: string, legacyInstallDirectory: string) => Promise<void>;
  finalizeLegacyCleanup?: (helperPath: string, args: string[]) => Promise<void>;
}

export async function cleanupWindowsStoreLegacyInstallation(
  options: WindowsStoreCleanupOptions,
  dependencies: WindowsStoreCleanupDependencies = {}
): Promise<WindowsStoreCleanupResult> {
  const completionMarkerPath = join(options.storeUserDataPath, CLEANUP_COMPLETION_FILE);
  const helperPath = join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  const legacyInstallDirectory = join(options.localAppDataPath, "Programs", "Memmy");
  assertExactCleanupTarget(
    legacyInstallDirectory,
    join(options.localAppDataPath, "Programs", "Memmy"),
    "install"
  );
  let identity: StoreIdentityResult;
  try {
    identity = await (dependencies.readStoreIdentity ?? readStoreIdentity)(helperPath);
  } catch (error) {
    if (!existsSync(helperPath)) {
      return "not-available";
    }
    throw new Error(
      `Store takeover helper failed to read the package identity: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const legacyLocalDataDirectory = join(options.localAppDataPath, "Memmy");
  const launcherDirectory = join(legacyLocalDataDirectory, "launcher");
  const legacyTakeoverHelperPath = join(launcherDirectory, "MemmyStoreUpdate.exe");
  const takeoverHelperPath = existsSync(legacyTakeoverHelperPath)
    ? legacyTakeoverHelperPath
    : helperPath;
  const migrationMarkerPath = join(launcherDirectory, STORE_MIGRATION_IN_PROGRESS_FILE);
  const legacyRoamingDataDirectory = join(options.roamingAppDataPath, "Memmy");
  const desktopShortcutPath = join(options.desktopPath, "Memmy.lnk");
  const startMenuShortcutPath = join(
    options.roamingAppDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Memmy.lnk"
  );
  const desktopShortcutHandoffPath = join(
    options.storeUserDataPath,
    DESKTOP_SHORTCUT_HANDOFF_FILE
  );
  assertExactCleanupTarget(legacyRoamingDataDirectory, join(options.roamingAppDataPath, "Memmy"), "roaming data");
  assertExactCleanupTarget(legacyLocalDataDirectory, join(options.localAppDataPath, "Memmy"), "local data");
  assertExactCleanupTarget(desktopShortcutPath, join(options.desktopPath, "Memmy.lnk"), "desktop shortcut");
  assertExactCleanupTarget(
    startMenuShortcutPath,
    join(options.roamingAppDataPath, "Microsoft", "Windows", "Start Menu", "Programs", "Memmy.lnk"),
    "Start menu shortcut"
  );
  let ownsMigrationMarker = false;
  if (existsSync(legacyInstallDirectory) && !existsSync(migrationMarkerPath)) {
    await mkdir(launcherDirectory, { recursive: true });
    await writeFile(migrationMarkerPath, JSON.stringify({
      version: 1,
      startedAt: new Date().toISOString(),
      aumid: identity.aumid,
      source: "store-startup"
    }), "utf8");
    ownsMigrationMarker = true;
  }

  try {
    await (dependencies.prepareLegacyTakeover ?? prepareLegacyTakeover)(
      takeoverHelperPath,
      legacyInstallDirectory
    );
    if (
      await hasCompletedCleanup(completionMarkerPath, identity.aumid) &&
      !existsSync(legacyInstallDirectory) &&
      !existsSync(migrationMarkerPath) &&
      !existsSync(startMenuShortcutPath) &&
      !(await hasDesktopShortcutHandoff(desktopShortcutHandoffPath))
    ) {
      if (ownsMigrationMarker) {
        await rm(launcherDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      return "already-completed";
    }

    const logPath = join(options.storeUserDataPath, CLEANUP_LOG_FILE);
    await mkdir(options.storeUserDataPath, { recursive: true });
    await writeCleanupLog(logPath, "Legacy cleanup started");

    const errors: unknown[] = [];
    const hadDesktopShortcut = existsSync(desktopShortcutPath);
    const hasPendingDesktopShortcutHandoff = await hasDesktopShortcutHandoff(
      desktopShortcutHandoffPath
    );
    const shouldCreateDesktopShortcut = hadDesktopShortcut || hasPendingDesktopShortcutHandoff;
    if (hadDesktopShortcut && !hasPendingDesktopShortcutHandoff) {
      await writeFile(desktopShortcutHandoffPath, JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        aumid: identity.aumid
      }), "utf8");
    }
    await writeCleanupLog(logPath, "Removing validated legacy files and data");
    for (const path of [
      legacyRoamingDataDirectory,
      startMenuShortcutPath
    ]) {
      try {
        await rm(path, {
          recursive: true,
          force: true,
          maxRetries: 6,
          retryDelay: 500
        });
      } catch (error) {
        errors.push(new Error(`Failed to remove '${path}': ${errorMessage(error)}`));
      }
    }
    try {
      // The NSIS launch proxy, migration watcher, native takeover helper, and in-progress marker
      // live here. Keep that recovery surface intact until native finalization and shortcut
      // handoff have both succeeded.
      await removeLegacyLocalDataExceptLauncher(legacyLocalDataDirectory, launcherDirectory);
    } catch (error) {
      errors.push(new Error(
        `Failed to remove legacy local data outside '${launcherDirectory}': ${errorMessage(error)}`
      ));
    }

    try {
      // Delete the legacy application directory from the native helper. Node's recursive Windows
      // removal can leave a pending kernel file operation on a large app.asar and block this Store
      // process indefinitely. The separate helper uses bounded Win32 retries instead.
      const args = ["finalize-legacy-cleanup"] as string[];
      if (existsSync(legacyTakeoverHelperPath)) {
        args.push("--unpackaged-helper-path", legacyTakeoverHelperPath);
      }
      if (shouldCreateDesktopShortcut) {
        args.push("--shortcut", desktopShortcutPath, "--aumid", identity.aumid);
      }
      // Always finalize with the helper shipped in the currently running Store package. An older
      // NSIS launcher helper may not know how to break registry cleanup out of MSIX virtualization.
      await (dependencies.finalizeLegacyCleanup ?? finalizeLegacyCleanup)(helperPath, args);
      await rm(desktopShortcutHandoffPath, { force: true });
    } catch (error) {
      errors.push(new Error(`Failed to finalize Windows shell cleanup: ${errorMessage(error)}`));
    }

    if (errors.length > 0) {
      for (const error of errors) {
        await writeCleanupLog(logPath, `ERROR ${errorMessage(error)}`);
      }
      throw new AggregateError(errors, errors.map(errorMessage).join("; "));
    }

    await writeFile(completionMarkerPath, JSON.stringify({
      version: 1,
      completedAt: new Date().toISOString(),
      aumid: identity.aumid
    }), "utf8");
    await writeCleanupLog(logPath, "Legacy cleanup completed");
    if (ownsMigrationMarker) {
      await rm(launcherDirectory, { recursive: true, force: true }).catch(async (error) => {
        await writeCleanupLog(
          logPath,
          `WARNING Failed to remove completed legacy launcher: ${errorMessage(error)}`
        );
      });
    }
    return "completed";
  } finally {
    if (ownsMigrationMarker) {
      await rm(migrationMarkerPath, { force: true }).catch(() => undefined);
    }
  }
}

async function removeLegacyLocalDataExceptLauncher(
  legacyLocalDataDirectory: string,
  launcherDirectory: string
): Promise<void> {
  let childNames: string[];
  try {
    childNames = await readdir(legacyLocalDataDirectory);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  const expectedLauncherDirectory = resolve(legacyLocalDataDirectory, "launcher");
  assertExactCleanupTarget(launcherDirectory, expectedLauncherDirectory, "launcher");
  for (const childName of childNames) {
    const childPath = join(legacyLocalDataDirectory, childName);
    if (resolve(childPath) === resolve(launcherDirectory)) {
      continue;
    }
    await rm(childPath, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 500
    });
  }
}

async function readStoreIdentity(helperPath: string): Promise<StoreIdentityResult> {
  const { stdout } = await execFileAsync(helperPath, ["identity"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  const value = line ? JSON.parse(line) as Partial<StoreIdentityResult> : null;
  if (value?.type !== "identity" || typeof value.aumid !== "string" || !isValidAumid(value.aumid)) {
    throw new Error("Store update helper returned an invalid application identity");
  }
  return { type: "identity", aumid: value.aumid };
}

async function finalizeLegacyCleanup(helperPath: string, args: string[]): Promise<void> {
  await execFileAsync(helperPath, args, {
    timeout: 30_000,
    windowsHide: true
  });
}

async function prepareLegacyTakeover(
  helperPath: string,
  legacyInstallDirectory: string
): Promise<void> {
  await execFileAsync(
    helperPath,
    ["prepare-legacy-takeover", "--legacy-install-directory", legacyInstallDirectory],
    {
      timeout: 30_000,
      windowsHide: true
    }
  );
}

async function hasCompletedCleanup(markerPath: string, aumid: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(markerPath, "utf8")) as {
      version?: unknown;
      aumid?: unknown;
    };
    return value.version === 1 && value.aumid === aumid;
  } catch {
    return false;
  }
}

async function hasDesktopShortcutHandoff(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return value.version === 1;
  } catch {
    return false;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}

function assertExactCleanupTarget(actual: string, expected: string, label: string): void {
  if (normalizePath(actual) !== normalizePath(expected)) {
    throw new Error(`Refusing to clean unexpected ${label} path '${actual}'`);
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US");
}

async function writeCleanupLog(logPath: string, message: string): Promise<void> {
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function isValidAumid(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
