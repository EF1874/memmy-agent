import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWindowsStoreAumid,
  resolveWindowsStoreUserDataPath
} from "../src/main/windows-store-paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Store paths", () => {
  it("does nothing outside a Windows Store process", () => {
    expect(resolveWindowsStoreUserDataPath({
      isWindowsStore: false,
      resourcesPath: "",
      localAppDataPath: ""
    })).toBeNull();
    expect(resolveWindowsStoreAumid({
      isWindowsStore: false,
      resourcesPath: "",
      localAppDataPath: ""
    })).toBeNull();
  });

  it("resolves LocalState from the installed package identity", () => {
    const root = createTemporaryDirectory();
    const packageRoot = join(root, "Memmy.Development_0.0.2.0_x64__abc123");
    const resourcesPath = join(packageRoot, "app", "resources");
    const localAppDataPath = join(root, "LocalAppData");
    mkdirSync(resourcesPath, { recursive: true });
    writeFileSync(
      join(packageRoot, "AppxManifest.xml"),
      '<Package><Identity Publisher="CN=Memmy Development" Name="Memmy.Development" Version="0.0.2.0" /><Applications><Application Id="Memmy" /></Applications></Package>',
      "utf8"
    );

    expect(resolveWindowsStoreUserDataPath({
      isWindowsStore: true,
      resourcesPath,
      localAppDataPath
    })).toBe(join(localAppDataPath, "Packages", "Memmy.Development_abc123", "LocalState", "Memmy"));
    expect(resolveWindowsStoreAumid({
      isWindowsStore: true,
      resourcesPath,
      localAppDataPath
    })).toBe("Memmy.Development_abc123!Memmy");
  });

  it("rejects an installed package without an Identity name", () => {
    const root = createTemporaryDirectory();
    const packageRoot = join(root, "Memmy.Development_0.0.2.0_x64__abc123");
    const resourcesPath = join(packageRoot, "app", "resources");
    mkdirSync(resourcesPath, { recursive: true });
    writeFileSync(join(packageRoot, "AppxManifest.xml"), "<Package />", "utf8");

    expect(() => resolveWindowsStoreUserDataPath({
      isWindowsStore: true,
      resourcesPath,
      localAppDataPath: join(root, "LocalAppData")
    })).toThrow("Identity Name");
  });
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-store-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}
