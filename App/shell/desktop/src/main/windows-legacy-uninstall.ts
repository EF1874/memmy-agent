import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { isWindowsStoreMigrationComplete } from "./windows-store-migration.js";
import { isLegacyWindowsStoreTransitionCompatible } from "./windows-store-transition-barrier.js";

const execFileAsync = promisify(execFile);
const LEGACY_UNINSTALL_ARGUMENTS = ["/currentuser", "/S", "--updated", "--keep-shortcuts"] as const;
const LEGACY_UNINSTALL_REGISTRY_PATH =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4";

interface LegacyUninstallEntry {
  displayName: string;
  uninstallString: string;
}

interface WindowsLegacyUninstallOptions {
  legacyUserDataPath: string;
  storeUserDataPath: string;
  localAppDataPath: string;
  roamingAppDataPath: string;
  runUninstaller?: (filePath: string, args: readonly string[]) => Promise<void>;
  removeStartMenuLink?: (filePath: string) => void;
  readUninstallEntry?: () => Promise<LegacyUninstallEntry | null>;
  deleteUninstallEntry?: () => Promise<void>;
}

export type WindowsLegacyUninstallResult = "uninstalled" | "missing" | "unprepared";

export async function uninstallLegacyWindowsApp(
  options: WindowsLegacyUninstallOptions
): Promise<WindowsLegacyUninstallResult> {
  const hasLegacyData = existsSync(join(options.legacyUserDataPath, "app.sqlite")) ||
    existsSync(join(options.legacyUserDataPath, "Local Storage"));
  if (!isWindowsStoreMigrationComplete(options.storeUserDataPath) ||
      (hasLegacyData && !isLegacyWindowsStoreTransitionCompatible(options.legacyUserDataPath))) {
    return "unprepared";
  }

  const uninstallerPath = join(options.localAppDataPath, "Programs", "Memmy", "Uninstall Memmy.exe");
  const startMenuLink = join(
    options.roamingAppDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Memmy.lnk"
  );
  const uninstallerExists = existsSync(uninstallerPath);
  const errors: unknown[] = [];
  let mayRemoveUninstallEntry = !uninstallerExists;

  if (uninstallerExists) {
    try {
      await (options.runUninstaller ?? defaultRunUninstaller)(uninstallerPath, LEGACY_UNINSTALL_ARGUMENTS);
      mayRemoveUninstallEntry = true;
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    (options.removeStartMenuLink ?? defaultRemoveStartMenuLink)(startMenuLink);
  } catch (error) {
    errors.push(error);
  }

  if (mayRemoveUninstallEntry) {
    try {
      const entry = await (options.readUninstallEntry ?? readLegacyUninstallEntry)();
      if (entry && isExpectedLegacyUninstallEntry(entry, options.localAppDataPath)) {
        await (options.deleteUninstallEntry ?? deleteLegacyUninstallEntry)();
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(errorMessage).join("; "));
  }
  return uninstallerExists ? "uninstalled" : "missing";
}

export function isExpectedLegacyUninstallEntry(
  entry: LegacyUninstallEntry,
  localAppDataPath: string
): boolean {
  if (!entry.displayName.startsWith("Memmy")) {
    return false;
  }

  const expanded = entry.uninstallString.replace(/%([^%]+)%/g, (match, name: string) => {
    if (name.toLocaleUpperCase("en-US") === "LOCALAPPDATA") {
      return localAppDataPath;
    }
    return process.env[name] ?? process.env[name.toLocaleUpperCase("en-US")] ?? match;
  }).trim();
  const executable = expanded.startsWith('"')
    ? /^"([^"\r\n]+\.exe)"(?:\s.*)?$/i.exec(expanded)?.[1]
    : /^(.+?\.exe)(?:\s.*)?$/i.exec(expanded)?.[1];
  if (!executable || !win32.isAbsolute(executable)) {
    return false;
  }

  const expected = win32.join(localAppDataPath, "Programs", "Memmy", "Uninstall Memmy.exe");
  return win32.normalize(executable).toLocaleLowerCase("en-US") ===
    win32.normalize(expected).toLocaleLowerCase("en-US");
}

async function defaultRunUninstaller(filePath: string, args: readonly string[]): Promise<void> {
  await execFileAsync(filePath, [...args], {
    timeout: 120_000,
    windowsHide: true
  });
}

function defaultRemoveStartMenuLink(filePath: string): void {
  rmSync(filePath, { force: true });
}

async function readLegacyUninstallEntry(): Promise<LegacyUninstallEntry | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("reg.exe", ["query", LEGACY_UNINSTALL_REGISTRY_PATH, "/reg:64"], {
      encoding: "utf8",
      windowsHide: true
    }));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      return null;
    }
    throw error;
  }

  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(DisplayName|UninstallString)\s+REG_\w+\s+(.*)$/.exec(line);
    if (match) {
      const [, name, value] = match;
      if (name && value !== undefined) {
        values.set(name, value.trim());
      }
    }
  }
  return {
    displayName: values.get("DisplayName") ?? "",
    uninstallString: values.get("UninstallString") ?? ""
  };
}

async function deleteLegacyUninstallEntry(): Promise<void> {
  await execFileAsync("reg.exe", ["delete", LEGACY_UNINSTALL_REGISTRY_PATH, "/f", "/reg:64"], {
    windowsHide: true
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
