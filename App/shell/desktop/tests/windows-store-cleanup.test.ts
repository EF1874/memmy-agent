import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWindowsStoreLegacyInstallation,
  type WindowsStoreCleanupDependencies
} from "../src/main/windows-store-cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Windows Store legacy cleanup", () => {
  it("preserves the native helper launch failure instead of reporting it as unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-store-cleanup-helper-error-"));
    temporaryDirectories.push(root);
    const resourcesPath = join(root, "resources");
    const storeUserDataPath = join(root, "store-user-data");
    const roamingAppDataPath = join(root, "roaming");
    const localAppDataPath = join(root, "local");
    const desktopPath = join(root, "desktop");
    const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");

    await Promise.all([
      mkdir(join(resourcesPath, "native"), { recursive: true }),
      mkdir(storeUserDataPath, { recursive: true }),
      mkdir(desktopPath, { recursive: true })
    ]);
    await writeFile(helperPath, "helper", "utf8");

    await expect(cleanupWindowsStoreLegacyInstallation({
      resourcesPath,
      storeUserDataPath,
      roamingAppDataPath,
      localAppDataPath,
      desktopPath
    }, {
      readStoreIdentity: async () => {
        throw new Error("The code execution cannot proceed because VCRUNTIME140_1.dll was not found");
      }
    })).rejects.toThrow(
      "Store takeover helper failed to read the package identity: " +
      "The code execution cannot proceed because VCRUNTIME140_1.dll was not found"
    );
  });

  it("takes over a reinstalled legacy app even when the completion marker already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-store-cleanup-reinstalled-"));
    temporaryDirectories.push(root);
    const resourcesPath = join(root, "resources");
    const storeUserDataPath = join(root, "store-user-data");
    const roamingAppDataPath = join(root, "roaming");
    const localAppDataPath = join(root, "local");
    const desktopPath = join(root, "desktop");
    const legacyInstallDirectory = join(localAppDataPath, "Programs", "Memmy");
    const migrationMarkerPath = join(
      localAppDataPath,
      "Memmy",
      "launcher",
      "store-migration-in-progress-v1.json"
    );
    const aumid = "Memmy.Development_fvzhnh4ztget6!Memmy";

    await Promise.all([
      mkdir(join(resourcesPath, "native"), { recursive: true }),
      mkdir(legacyInstallDirectory, { recursive: true }),
      mkdir(storeUserDataPath, { recursive: true }),
      mkdir(desktopPath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(legacyInstallDirectory, "Memmy.exe"), "reinstalled legacy app", "utf8"),
      writeFile(
        join(storeUserDataPath, "legacy-cleanup-completed-v1.json"),
        JSON.stringify({ version: 1, aumid }),
        "utf8"
      )
    ]);

    let takeoverAttempts = 0;
    let finalizeAttempts = 0;
    const dependencies = {
      readStoreIdentity: async () => ({ type: "identity" as const, aumid }),
      prepareLegacyTakeover: async (_helperPath: string, legacyDirectory: string) => {
        takeoverAttempts += 1;
        expect(legacyDirectory).toBe(legacyInstallDirectory);
        if (takeoverAttempts === 1) {
          expect(JSON.parse(await readFile(migrationMarkerPath, "utf8"))).toMatchObject({
            version: 1,
            aumid,
            source: "store-startup"
          });
        }
      },
      finalizeLegacyCleanup: async () => {
        finalizeAttempts += 1;
        await rm(legacyInstallDirectory, { recursive: true, force: true });
      }
    };
    const options = {
      resourcesPath,
      storeUserDataPath,
      roamingAppDataPath,
      localAppDataPath,
      desktopPath
    };

    await expect(cleanupWindowsStoreLegacyInstallation(options, dependencies))
      .resolves.toBe("completed");
    expect(takeoverAttempts).toBe(1);
    expect(finalizeAttempts).toBe(1);
    await expect(readFile(migrationMarkerPath, "utf8")).rejects.toThrow();

    await expect(cleanupWindowsStoreLegacyInstallation(options, dependencies))
      .resolves.toBe("already-completed");
    expect(takeoverAttempts).toBe(2);
    expect(finalizeAttempts).toBe(1);
  });

  it("preserves an external migration watcher until it can observe Store readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-store-cleanup-watcher-"));
    temporaryDirectories.push(root);
    const resourcesPath = join(root, "resources");
    const storeUserDataPath = join(root, "store-user-data");
    const roamingAppDataPath = join(root, "roaming");
    const localAppDataPath = join(root, "local");
    const desktopPath = join(root, "desktop");
    const legacyInstallDirectory = join(localAppDataPath, "Programs", "Memmy");
    const launcherDirectory = join(localAppDataPath, "Memmy", "launcher");
    const migrationMarkerPath = join(
      launcherDirectory,
      "store-migration-in-progress-v1.json"
    );
    const launcherPath = join(launcherDirectory, "MemmyLauncher.vbs");
    const activationScriptPath = join(launcherDirectory, "MemmyStoreActivate.ps1");
    const takeoverHelperPath = join(launcherDirectory, "MemmyStoreUpdate.exe");
    const packagedHelperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
    const aumid = "Memmy.Development_fvzhnh4ztget6!Memmy";

    await Promise.all([
      mkdir(join(resourcesPath, "native"), { recursive: true }),
      mkdir(storeUserDataPath, { recursive: true }),
      mkdir(legacyInstallDirectory, { recursive: true }),
      mkdir(launcherDirectory, { recursive: true }),
      mkdir(desktopPath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(legacyInstallDirectory, "Memmy.exe"), "legacy", "utf8"),
      writeFile(launcherPath, "legacy launcher", "utf8"),
      writeFile(activationScriptPath, "migration watcher", "utf8"),
      writeFile(takeoverHelperPath, "native takeover helper", "utf8"),
      writeFile(
        migrationMarkerPath,
        JSON.stringify({
          version: 1,
          aumid,
          source: "legacy-app-watcher"
        }),
        "utf8"
      )
    ]);

    await expect(cleanupWindowsStoreLegacyInstallation({
      resourcesPath,
      storeUserDataPath,
      roamingAppDataPath,
      localAppDataPath,
      desktopPath
    }, {
      readStoreIdentity: async () => ({ type: "identity", aumid }),
      prepareLegacyTakeover: async (helperPath) => {
        expect(helperPath).toBe(takeoverHelperPath);
      },
      finalizeLegacyCleanup: async (helperPath, args) => {
        expect(helperPath).toBe(packagedHelperPath);
        expect(args).toContain("--unpackaged-helper-path");
        expect(args).toContain(takeoverHelperPath);
        await rm(legacyInstallDirectory, { recursive: true, force: true });
      }
    })).resolves.toBe("completed");

    expect(await readFile(launcherPath, "utf8")).toBe("legacy launcher");
    expect(await readFile(activationScriptPath, "utf8")).toBe("migration watcher");
    expect(await readFile(takeoverHelperPath, "utf8")).toBe("native takeover helper");
    expect(JSON.parse(await readFile(migrationMarkerPath, "utf8"))).toMatchObject({
      version: 1,
      aumid,
      source: "legacy-app-watcher"
    });
  });

  it("repairs preserved launch-proxy shortcuts when a completed marker predates the migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-store-cleanup-stale-proxy-"));
    temporaryDirectories.push(root);
    const resourcesPath = join(root, "resources");
    const storeUserDataPath = join(root, "store-user-data");
    const roamingAppDataPath = join(root, "roaming");
    const localAppDataPath = join(root, "local");
    const desktopPath = join(root, "desktop");
    const launcherDirectory = join(localAppDataPath, "Memmy", "launcher");
    const migrationMarkerPath = join(
      launcherDirectory,
      "store-migration-in-progress-v1.json"
    );
    const launcherPath = join(launcherDirectory, "MemmyLauncher.vbs");
    const desktopShortcutPath = join(desktopPath, "Memmy.lnk");
    const startMenuProgramsPath = join(
      roamingAppDataPath,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs"
    );
    const startMenuShortcutPath = join(startMenuProgramsPath, "Memmy.lnk");
    const aumid = "Memmy.Development_fvzhnh4ztget6!Memmy";

    await Promise.all([
      mkdir(join(resourcesPath, "native"), { recursive: true }),
      mkdir(storeUserDataPath, { recursive: true }),
      mkdir(launcherDirectory, { recursive: true }),
      mkdir(desktopPath, { recursive: true }),
      mkdir(startMenuProgramsPath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(storeUserDataPath, "legacy-cleanup-completed-v1.json"),
        JSON.stringify({ version: 1, aumid }),
        "utf8"
      ),
      writeFile(
        migrationMarkerPath,
        JSON.stringify({ version: 1, aumid, source: "legacy-app-watcher" }),
        "utf8"
      ),
      writeFile(launcherPath, "legacy launcher", "utf8"),
      writeFile(desktopShortcutPath, "wscript MemmyLauncher.vbs", "utf8"),
      writeFile(startMenuShortcutPath, "wscript MemmyLauncher.vbs", "utf8")
    ]);

    let finalizeAttempts = 0;
    await expect(cleanupWindowsStoreLegacyInstallation({
      resourcesPath,
      storeUserDataPath,
      roamingAppDataPath,
      localAppDataPath,
      desktopPath
    }, {
      readStoreIdentity: async () => ({ type: "identity", aumid }),
      prepareLegacyTakeover: async () => undefined,
      finalizeLegacyCleanup: async (_helperPath, args) => {
        finalizeAttempts += 1;
        expect(args).toEqual([
          "finalize-legacy-cleanup",
          "--shortcut",
          desktopShortcutPath,
          "--aumid",
          aumid
        ]);
        await writeFile(desktopShortcutPath, "Store AppsFolder shortcut", "utf8");
      }
    })).resolves.toBe("completed");

    expect(finalizeAttempts).toBe(1);
    expect(await readFile(desktopShortcutPath, "utf8")).toBe("Store AppsFolder shortcut");
    await expect(readFile(startMenuShortcutPath, "utf8")).rejects.toThrow();
    expect(await readFile(launcherPath, "utf8")).toBe("legacy launcher");
    expect(JSON.parse(await readFile(migrationMarkerPath, "utf8"))).toMatchObject({
      version: 1,
      aumid,
      source: "legacy-app-watcher"
    });
  });

  it("preserves ~/.memmy and retries desktop shortcut handoff after a helper failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-store-cleanup-"));
    temporaryDirectories.push(root);
    const resourcesPath = join(root, "resources");
    const storeUserDataPath = join(root, "store-user-data");
    const roamingAppDataPath = join(root, "roaming");
    const localAppDataPath = join(root, "local");
    const desktopPath = join(root, "desktop");
    const homePath = join(root, "home");
    const desktopShortcutPath = join(desktopPath, "Memmy.lnk");
    const legacyInstallDirectory = join(localAppDataPath, "Programs", "Memmy");
    const launcherDirectory = join(localAppDataPath, "Memmy", "launcher");
    const launcherPath = join(launcherDirectory, "MemmyLauncher.vbs");
    const activationScriptPath = join(launcherDirectory, "MemmyStoreActivate.ps1");
    const takeoverHelperPath = join(launcherDirectory, "MemmyStoreUpdate.exe");
    const migrationMarkerPath = join(
      launcherDirectory,
      "store-migration-in-progress-v1.json"
    );
    const legacyLocalCachePath = join(localAppDataPath, "Memmy", "cache.bin");
    const legacyRuntimeHomePath = join(homePath, ".memmy");
    const sentinelPath = join(legacyRuntimeHomePath, "must-survive.txt");

    await Promise.all([
      mkdir(join(resourcesPath, "native"), { recursive: true }),
      mkdir(legacyInstallDirectory, { recursive: true }),
      mkdir(join(roamingAppDataPath, "Memmy"), { recursive: true }),
      mkdir(launcherDirectory, { recursive: true }),
      mkdir(desktopPath, { recursive: true }),
      mkdir(legacyRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(legacyInstallDirectory, "Memmy.exe"), "legacy", "utf8"),
      writeFile(desktopShortcutPath, "legacy shortcut", "utf8"),
      writeFile(launcherPath, "legacy launcher", "utf8"),
      writeFile(activationScriptPath, "migration watcher", "utf8"),
      writeFile(takeoverHelperPath, "native takeover helper", "utf8"),
      writeFile(legacyLocalCachePath, "legacy local cache", "utf8"),
      writeFile(sentinelPath, "keep", "utf8")
    ]);

    let finalizeAttempts = 0;
    const dependencies: WindowsStoreCleanupDependencies = {
      readStoreIdentity: async () => ({
        type: "identity",
        aumid: "Memmy.Test_1n2q0jvjmfh7c!Memmy"
      }),
      prepareLegacyTakeover: async (_helperPath, legacyDirectory) => {
        expect(legacyDirectory).toBe(legacyInstallDirectory);
      },
      finalizeLegacyCleanup: async (_helperPath, args) => {
        finalizeAttempts += 1;
        expect(args).toEqual([
          "finalize-legacy-cleanup",
          "--unpackaged-helper-path",
          takeoverHelperPath,
          "--shortcut",
          desktopShortcutPath,
          "--aumid",
          "Memmy.Test_1n2q0jvjmfh7c!Memmy"
        ]);
        await rm(desktopShortcutPath, { force: true });
        if (finalizeAttempts === 1) {
          throw new Error("simulated ShellLink failure");
        }
        await rm(legacyInstallDirectory, { recursive: true, force: true });
        await writeFile(desktopShortcutPath, "Store AppsFolder shortcut", "utf8");
      }
    };
    const options = {
      resourcesPath,
      storeUserDataPath,
      roamingAppDataPath,
      localAppDataPath,
      desktopPath
    };

    await expect(cleanupWindowsStoreLegacyInstallation(options, dependencies))
      .rejects.toThrow("simulated ShellLink failure");
    expect(await readFile(sentinelPath, "utf8")).toBe("keep");
    expect(await readFile(launcherPath, "utf8")).toBe("legacy launcher");
    expect(await readFile(activationScriptPath, "utf8")).toBe("migration watcher");
    expect(await readFile(takeoverHelperPath, "utf8")).toBe("native takeover helper");
    await expect(readFile(migrationMarkerPath, "utf8")).rejects.toThrow();
    await expect(readFile(legacyLocalCachePath, "utf8")).rejects.toThrow();

    await expect(cleanupWindowsStoreLegacyInstallation(options, dependencies))
      .resolves.toBe("completed");
    expect(await readFile(sentinelPath, "utf8")).toBe("keep");
    expect(readFileSync(desktopShortcutPath, "utf8")).toBe("Store AppsFolder shortcut");
    await expect(readFile(launcherDirectory, "utf8")).rejects.toThrow();
    await expect(cleanupWindowsStoreLegacyInstallation(options, dependencies))
      .resolves.toBe("already-completed");
    expect(finalizeAttempts).toBe(2);
  });
});
