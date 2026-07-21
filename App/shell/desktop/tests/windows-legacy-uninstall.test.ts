import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markLegacyWindowsStoreTransitionCompatible } from "../src/main/windows-store-transition-barrier.js";
import {
  isExpectedLegacyUninstallEntry,
  uninstallLegacyWindowsApp
} from "../src/main/windows-legacy-uninstall.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows legacy uninstall handoff", () => {
  it("silently removes the compatible NSIS app while preserving the redirected desktop shortcut", async () => {
    const paths = createPaths();
    for (const filePath of [paths.uninstaller, paths.desktopLink, paths.startMenuLink, join(paths.legacy, "app.sqlite")]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "test");
    }
    markLegacyWindowsStoreTransitionCompatible(paths.legacy);
    writeCompletedMigrationJournal(paths.store);
    const runUninstaller = vi.fn(async () => undefined);
    const readUninstallEntry = vi.fn(async () => null);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      runUninstaller,
      readUninstallEntry
    })).resolves.toBe("uninstalled");

    expect(runUninstaller).toHaveBeenCalledWith(paths.uninstaller, [
      "/currentuser",
      "/S",
      "--updated",
      "--keep-shortcuts"
    ]);
    expect(existsSync(paths.desktopLink)).toBe(true);
    expect(existsSync(paths.startMenuLink)).toBe(false);
    expect(readUninstallEntry).toHaveBeenCalledOnce();
  });

  it("does not touch a completed migration whose persistent legacy data lacks the compatibility marker", async () => {
    const paths = createPaths();
    for (const filePath of [paths.uninstaller, paths.desktopLink, paths.startMenuLink, join(paths.legacy, "app.sqlite")]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "test");
    }
    writeCompletedMigrationJournal(paths.store);
    const runUninstaller = vi.fn(async () => undefined);
    const removeStartMenuLink = vi.fn();
    const readUninstallEntry = vi.fn(async () => null);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      runUninstaller,
      removeStartMenuLink,
      readUninstallEntry
    })).resolves.toBe("unprepared");
    expect(runUninstaller).not.toHaveBeenCalled();
    expect(removeStartMenuLink).not.toHaveBeenCalled();
    expect(readUninstallEntry).not.toHaveBeenCalled();
    expect(existsSync(paths.desktopLink)).toBe(true);
    expect(existsSync(paths.startMenuLink)).toBe(true);
  });

  it("does not clean anything before migration completes", async () => {
    const paths = createPaths();
    const runUninstaller = vi.fn(async () => undefined);
    const removeStartMenuLink = vi.fn();
    const readUninstallEntry = vi.fn(async () => null);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      runUninstaller,
      removeStartMenuLink,
      readUninstallEntry
    })).resolves.toBe("unprepared");
    expect(runUninstaller).not.toHaveBeenCalled();
    expect(removeStartMenuLink).not.toHaveBeenCalled();
    expect(readUninstallEntry).not.toHaveBeenCalled();
  });

  it("removes stale Start Menu and matching ARP entries after the NSIS app is already gone", async () => {
    const paths = createPaths();
    mkdirSync(dirname(paths.startMenuLink), { recursive: true });
    writeFileSync(paths.startMenuLink, "test");
    writeCompletedMigrationJournal(paths.store);
    const deleteUninstallEntry = vi.fn(async () => undefined);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      readUninstallEntry: async () => ({
        displayName: "Memmy 0.0.9",
        uninstallString: `\"${paths.uninstaller}\" /currentuser`
      }),
      deleteUninstallEntry
    })).resolves.toBe("missing");
    expect(existsSync(paths.startMenuLink)).toBe(false);
    expect(deleteUninstallEntry).toHaveBeenCalledOnce();
  });

  it("keeps ARP visible when uninstall fails but still removes the stale Start Menu link", async () => {
    const paths = createPaths();
    for (const filePath of [paths.uninstaller, paths.startMenuLink]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "test");
    }
    writeCompletedMigrationJournal(paths.store);
    const readUninstallEntry = vi.fn(async () => ({
      displayName: "Memmy 0.0.9",
      uninstallString: `\"${paths.uninstaller}\" /currentuser`
    }));
    const deleteUninstallEntry = vi.fn(async () => undefined);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      runUninstaller: async () => { throw new Error("uninstall failed"); },
      readUninstallEntry,
      deleteUninstallEntry
    })).rejects.toThrow("uninstall failed");
    expect(existsSync(paths.startMenuLink)).toBe(false);
    expect(readUninstallEntry).not.toHaveBeenCalled();
    expect(deleteUninstallEntry).not.toHaveBeenCalled();
  });

  it("continues safe cleanup when deleting the Start Menu link fails", async () => {
    const paths = createPaths();
    writeCompletedMigrationJournal(paths.store);
    const deleteUninstallEntry = vi.fn(async () => undefined);

    await expect(uninstallLegacyWindowsApp({
      legacyUserDataPath: paths.legacy,
      storeUserDataPath: paths.store,
      localAppDataPath: paths.local,
      roamingAppDataPath: paths.roaming,
      removeStartMenuLink: () => { throw new Error("link failed"); },
      readUninstallEntry: async () => ({
        displayName: "Memmy 0.0.9",
        uninstallString: `\"${paths.uninstaller}\"`
      }),
      deleteUninstallEntry
    })).rejects.toThrow("link failed");
    expect(deleteUninstallEntry).toHaveBeenCalledOnce();
  });

  it("deletes only the exact legacy uninstall registration", () => {
    const localAppDataPath = "C:\\Users\\test\\AppData\\Local";
    expect(isExpectedLegacyUninstallEntry({
      displayName: "Memmy 0.0.9",
      uninstallString: '"%LOCALAPPDATA%\\Programs\\Memmy\\Uninstall Memmy.exe" /currentuser'
    }, localAppDataPath)).toBe(true);
    expect(isExpectedLegacyUninstallEntry({
      displayName: "Other App",
      uninstallString: '"%LOCALAPPDATA%\\Programs\\Memmy\\Uninstall Memmy.exe"'
    }, localAppDataPath)).toBe(false);
    expect(isExpectedLegacyUninstallEntry({
      displayName: "Memmy 0.0.9",
      uninstallString: '"%LOCALAPPDATA%\\Programs\\Other\\Uninstall Memmy.exe"'
    }, localAppDataPath)).toBe(false);
  });
});

function createPaths(): {
  root: string;
  local: string;
  roaming: string;
  legacy: string;
  store: string;
  uninstaller: string;
  desktopLink: string;
  startMenuLink: string;
} {
  const root = mkdtempSync(join(tmpdir(), "memmy-legacy-uninstall-"));
  temporaryDirectories.push(root);
  const local = join(root, "Local");
  const roaming = join(root, "Roaming");
  return {
    root,
    local,
    roaming,
    legacy: join(roaming, "Memmy"),
    store: join(local, "Packages", "Memmy", "LocalState"),
    uninstaller: join(local, "Programs", "Memmy", "Uninstall Memmy.exe"),
    desktopLink: join(root, "Desktop", "Memmy.lnk"),
    startMenuLink: join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Memmy.lnk")
  };
}

function writeCompletedMigrationJournal(storeUserDataPath: string): void {
  mkdirSync(storeUserDataPath, { recursive: true });
  writeFileSync(join(storeUserDataPath, "store-migration.json"), JSON.stringify({
    version: 1,
    state: "completed",
    artifacts: [],
    migratedDatabase: false,
    migratedLocalStorage: false
  }));
}
