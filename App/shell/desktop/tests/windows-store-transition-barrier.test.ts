import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStoreMigrationBarrier,
  claimLegacyWindowsInstance
} from "../src/main/windows-store-transition-barrier.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Store transition barrier", () => {
  it("rejects migration when the compatibility version already owns a live claim", () => {
    const legacy = createLegacyPath();
    const claim = claimLegacyWindowsInstance(legacy, 42);

    expect(() => acquireStoreMigrationBarrier(legacy, () => false, (pid) => pid === 42)).toThrow("still running");
    claim.release();
  });

  it("blocks a compatibility version that races after the Store barrier", () => {
    const legacy = createLegacyPath();
    const barrier = acquireStoreMigrationBarrier(legacy, () => false, () => false);

    expect(claimLegacyWindowsInstance(legacy, 43).blocked).toBe(true);
    barrier.complete();
    expect(claimLegacyWindowsInstance(legacy, 44).blocked).toBe(true);
  });

  it("allows the compatibility version again when migration rolls back", () => {
    const legacy = createLegacyPath();
    const barrier = acquireStoreMigrationBarrier(legacy, () => false, () => false);
    barrier.rollback();

    const claim = claimLegacyWindowsInstance(legacy, 45);
    expect(claim.blocked).toBe(false);
    claim.release();
  });
});

function createLegacyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-store-transition-"));
  temporaryDirectories.push(directory);
  return directory;
}
