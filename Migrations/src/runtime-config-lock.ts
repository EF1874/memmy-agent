import fs from "node:fs/promises";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { MigrationError } from "./types.js";

type RuntimeConfigLockOptions = {
  stale: number;
  update: number;
  retries: number;
  retryDelay: number;
};

const DEFAULT_LOCK_OPTIONS: RuntimeConfigLockOptions = {
  stale: 120_000,
  update: 10_000,
  retries: 50,
  retryDelay: 100,
};

function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ELOCKED"
  );
}

function lockTimeoutError(configPath: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration_lock_timeout",
    `Timed out waiting for the runtime config lock: ${configPath}`,
    { scope: "runtime-config", cause },
  );
}

function lockIoError(configPath: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration_io_failed",
    `Runtime config lock failed for ${configPath}`,
    { scope: "runtime-config", cause },
  );
}

async function withRuntimeConfigWriteLockInternal<T>(
  configPath: string,
  operation: () => Promise<T>,
  options: RuntimeConfigLockOptions,
): Promise<T> {
  const normalizedPath = path.normalize(path.resolve(configPath));
  try {
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
  } catch (error) {
    throw lockIoError(normalizedPath, error);
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(normalizedPath, {
      realpath: false,
      stale: options.stale,
      update: options.update,
      retries: {
        retries: options.retries,
        factor: 1,
        minTimeout: options.retryDelay,
        maxTimeout: options.retryDelay,
        randomize: false,
      },
    });
  } catch (error) {
    if (isLockContention(error)) throw lockTimeoutError(normalizedPath, error);
    throw lockIoError(normalizedPath, error);
  }

  let operationError: unknown = null;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (operationError === null) throw lockIoError(normalizedPath, error);
    }
  }
}

export function withRuntimeConfigWriteLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withRuntimeConfigWriteLockInternal(configPath, operation, DEFAULT_LOCK_OPTIONS);
}

export function withRuntimeConfigWriteLockForTest<T>(
  configPath: string,
  operation: () => Promise<T>,
  options: Partial<RuntimeConfigLockOptions>,
): Promise<T> {
  return withRuntimeConfigWriteLockInternal(configPath, operation, {
    ...DEFAULT_LOCK_OPTIONS,
    ...options,
  });
}
