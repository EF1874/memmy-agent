import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_TRANSITION_MARKER = ".store-transition-active";
const STORE_TRANSITION_COMPATIBILITY_MARKER = ".store-transition-compatible-v1";
const LEGACY_CLAIMS_DIRECTORY = ".legacy-instance-claims";

interface LegacyInstanceClaim {
  blocked: boolean;
  release: () => void;
}

interface StoreMigrationBarrier {
  complete: () => void;
  rollback: () => void;
}

export function claimLegacyWindowsInstance(legacyUserDataPath: string, pid = process.pid): LegacyInstanceClaim {
  const claimsDirectory = join(legacyUserDataPath, LEGACY_CLAIMS_DIRECTORY);
  const claimPath = join(claimsDirectory, String(pid));
  mkdirSync(claimsDirectory, { recursive: true });
  rmSync(claimPath, { recursive: true, force: true });
  mkdirSync(claimPath);
  markLegacyWindowsStoreTransitionCompatible(legacyUserDataPath);

  const release = (): void => {
    rmSync(claimPath, { recursive: true, force: true });
  };
  if (existsSync(join(legacyUserDataPath, STORE_TRANSITION_MARKER))) {
    release();
    return { blocked: true, release };
  }

  process.once("exit", release);
  return { blocked: false, release };
}

export function acquireStoreMigrationBarrier(
  legacyUserDataPath: string,
  isLegacyApplicationRunning: () => boolean,
  isProcessRunning: (pid: number) => boolean = defaultIsProcessRunning
): StoreMigrationBarrier {
  mkdirSync(legacyUserDataPath, { recursive: true });
  const markerPath = join(legacyUserDataPath, STORE_TRANSITION_MARKER);
  writeFileSync(markerPath, "Store migration owns this legacy profile.\n", "utf8");

  try {
    if (isLegacyApplicationRunning() || hasLiveLegacyClaim(legacyUserDataPath, isProcessRunning)) {
      throw new Error("Legacy Memmy application is still running; close it and retry migration");
    }
  } catch (error) {
    rmSync(markerPath, { force: true });
    throw error;
  }

  return {
    complete: () => undefined,
    rollback: () => rmSync(markerPath, { force: true })
  };
}

export function markLegacyWindowsStoreTransitionCompatible(legacyUserDataPath: string): void {
  mkdirSync(legacyUserDataPath, { recursive: true });
  writeFileSync(
    join(legacyUserDataPath, STORE_TRANSITION_COMPATIBILITY_MARKER),
    "This profile has run a Store-transition-compatible Memmy version.\n",
    "utf8"
  );
}

export function isLegacyWindowsStoreTransitionCompatible(legacyUserDataPath: string): boolean {
  return existsSync(join(legacyUserDataPath, STORE_TRANSITION_COMPATIBILITY_MARKER));
}

function hasLiveLegacyClaim(legacyUserDataPath: string, isProcessRunning: (pid: number) => boolean): boolean {
  const claimsDirectory = join(legacyUserDataPath, LEGACY_CLAIMS_DIRECTORY);
  if (!existsSync(claimsDirectory)) {
    return false;
  }

  for (const entry of readdirSync(claimsDirectory, { withFileTypes: true })) {
    const pid = Number(entry.name);
    const claimPath = join(claimsDirectory, entry.name);
    if (!entry.isDirectory() || !Number.isSafeInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
      rmSync(claimPath, { recursive: true, force: true });
      continue;
    }
    return true;
  }
  return false;
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}
