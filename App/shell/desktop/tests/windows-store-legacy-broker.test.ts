import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ensureWindowsStoreLegacyCleanupBroker } from "../src/main/windows-store-legacy-broker.js";

describe("Windows Store legacy cleanup broker", () => {
  const baseOptions = {
    platform: "win32" as const,
    isPackaged: true,
    isWindowsStore: false,
    resourcesPath: "D:\\memmy\\resources",
    packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
  };

  it("starts the fixed helper before the NSIS app enters any Store context", async () => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker(baseOptions, { runHelper }))
      .resolves.toEqual({ status: "ready" });
    expect(runHelper).toHaveBeenCalledWith(
      "D:\\memmy\\resources\\native\\MemmyStoreUpdate.exe",
      [
        "ensure-legacy-cleanup-broker",
        "--package-family-name",
        "Memtensor.MemmyAgent_eyack96k521x2"
      ]
    );
  });

  it.each([
    { platform: "linux" as const },
    { isPackaged: false },
    { isWindowsStore: true }
  ])("does not start a broker outside the unpackaged Windows app", async (override) => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker({ ...baseOptions, ...override }, { runHelper }))
      .resolves.toEqual({ status: "not-applicable" });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("rejects an invalid package family before invoking native code", async () => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker({
      ...baseOptions,
      packageFamilyName: "../wrong"
    }, { runHelper })).rejects.toThrow("package family is invalid");
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("fails closed at the irreversible Store acquisition handoff", async () => {
    const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const start = mainSource.indexOf("async function openWindowsStoreMigration(");
    const end = mainSource.indexOf("function createCurrentWindowsStoreTransitionBinding(", start);
    const openMigrationSource = mainSource.slice(start, end);

    const brokerIndex = openMigrationSource.indexOf(
      "await requireCurrentWindowsStoreLegacyCleanupBroker();"
    );
    const journalWriteIndex = openMigrationSource.indexOf(
      "await writeWindowsStoreTransitionState(statePath, state);"
    );
    const externalOpenIndex = openMigrationSource.indexOf(
      "await shell.openExternal(activeOffer.policy.acquisitionUri);"
    );
    expect(brokerIndex).toBeGreaterThan(-1);
    expect(journalWriteIndex).toBeGreaterThan(brokerIndex);
    expect(externalOpenIndex).toBeGreaterThan(journalWriteIndex);
  });
});
