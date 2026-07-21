import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  acquireStoreMigrationBarrier,
  isLegacyWindowsStoreTransitionCompatible
} from "./windows-store-transition-barrier.js";

const JOURNAL_FILE = "store-migration.json";
const JOURNAL_TEMP_FILE = "store-migration.json.migrating";
const SQLITE_HEADER = "SQLite format 3\0";
const MIGRATION_ARTIFACTS = ["app.sqlite", "app.sqlite.migrating", "Local Storage", "Local Storage.migrating"] as const;

interface WindowsStoreMigrationOptions {
  legacyUserDataPath: string;
  targetUserDataPath: string;
  isLegacyApplicationRunning?: () => boolean;
}

interface MigrationResult {
  migratedDatabase: boolean;
  migratedLocalStorage: boolean;
}

type LegacyMigrationPlan = MigrationResult;

interface MigrationJournal extends MigrationResult {
  version: 1;
  state: "started" | "failed" | "completed";
  artifacts: string[];
  error?: string;
}

export function migrateWindowsStoreData(options: WindowsStoreMigrationOptions): MigrationResult {
  const hasLegacyData = existsSync(join(options.legacyUserDataPath, "app.sqlite")) ||
    existsSync(join(options.legacyUserDataPath, "Local Storage"));
  const hasCompatibleLegacyData = hasLegacyData &&
    isLegacyWindowsStoreTransitionCompatible(options.legacyUserDataPath);
  const barrier = acquireStoreMigrationBarrier(
    options.legacyUserDataPath,
    hasCompatibleLegacyData ? options.isLegacyApplicationRunning ?? isLegacyApplicationRunning : () => false
  );
  try {
    const plan: LegacyMigrationPlan = {
      migratedDatabase: hasCompatibleLegacyData && existsSync(join(options.legacyUserDataPath, "app.sqlite")),
      migratedLocalStorage: hasCompatibleLegacyData && existsSync(join(options.legacyUserDataPath, "Local Storage"))
    };
    const result = migrateWindowsStoreDataWithBarrier(options, plan);
    barrier.complete();
    return result;
  } catch (error) {
    barrier.rollback();
    throw error;
  }
}

export function isWindowsStoreMigrationComplete(targetUserDataPath: string): boolean {
  return readJournal(join(targetUserDataPath, JOURNAL_FILE))?.state === "completed";
}

function migrateWindowsStoreDataWithBarrier(
  options: WindowsStoreMigrationOptions,
  plan: LegacyMigrationPlan
): MigrationResult {
  const journalPath = join(options.targetUserDataPath, JOURNAL_FILE);
  const temporaryJournalPath = join(options.targetUserDataPath, JOURNAL_TEMP_FILE);
  const temporaryJournal = readJournal(temporaryJournalPath);
  const previousJournal = temporaryJournal ?? readJournal(journalPath);
  if (previousJournal?.state === "completed") {
    if (temporaryJournal) {
      writeJournal(journalPath, previousJournal);
    }
    return migrationResult(previousJournal);
  }
  mkdirSync(options.targetUserDataPath, { recursive: true });
  if (previousJournal) {
    removeArtifacts(options.targetUserDataPath, previousJournal.artifacts);
  }
  assertNoUnownedArtifacts(options.targetUserDataPath);

  const legacyDatabasePath = join(options.legacyUserDataPath, "app.sqlite");
  const legacyLocalStoragePath = join(options.legacyUserDataPath, "Local Storage");
  const migratedDatabase = plan.migratedDatabase;
  const migratedLocalStorage = plan.migratedLocalStorage;
  const artifacts = [
    ...(migratedDatabase ? ["app.sqlite", "app.sqlite.migrating"] : []),
    ...(migratedLocalStorage ? ["Local Storage", "Local Storage.migrating"] : [])
  ];
  const started: MigrationJournal = {
    version: 1,
    state: "started",
    artifacts,
    migratedDatabase,
    migratedLocalStorage
  };
  writeJournal(journalPath, started);

  try {
    if (migratedDatabase) {
      migrateDatabase(legacyDatabasePath, options.targetUserDataPath);
    }
    if (migratedLocalStorage) {
      migrateLocalStorage(legacyLocalStoragePath, options.targetUserDataPath);
    }

    writeJournal(journalPath, { ...started, state: "completed" });
    return migrationResult(started);
  } catch (error) {
    removeArtifacts(options.targetUserDataPath, artifacts);
    writeJournal(journalPath, {
      ...started,
      state: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function migrateDatabase(sourcePath: string, targetDirectory: string): void {
  assertSqliteFile(sourcePath);
  checkpointDatabase(sourcePath);

  const temporaryPath = join(targetDirectory, "app.sqlite.migrating");
  const targetPath = join(targetDirectory, "app.sqlite");
  copyFileSync(sourcePath, temporaryPath);
  assertSqliteFile(temporaryPath);
  renameSync(temporaryPath, targetPath);
}

function checkpointDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown>;
    const busy = Number(checkpoint.busy ?? Object.values(checkpoint)[0] ?? 0);
    if (busy !== 0) {
      throw new Error("Legacy app.sqlite is busy; close the legacy Memmy application and retry");
    }
  } finally {
    database.close();
  }
}

function assertSqliteFile(filePath: string): void {
  const header = readFileSync(filePath).subarray(0, SQLITE_HEADER.length).toString("utf8");
  if (header !== SQLITE_HEADER) {
    throw new Error(`Invalid SQLite header: ${filePath}`);
  }
}

function migrateLocalStorage(sourcePath: string, targetDirectory: string): void {
  const temporaryPath = join(targetDirectory, "Local Storage.migrating");
  const targetPath = join(targetDirectory, "Local Storage");
  cpSync(sourcePath, temporaryPath, {
    recursive: true,
    filter: (candidate) => basename(candidate).toUpperCase() !== "LOCK"
  });
  renameSync(temporaryPath, targetPath);
}

function readJournal(journalPath: string): MigrationJournal | null {
  if (!existsSync(journalPath)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<MigrationJournal>;
    if (value.version !== 1 || !Array.isArray(value.artifacts)) {
      return null;
    }
    if (value.state !== "started" && value.state !== "failed" && value.state !== "completed") {
      return null;
    }
    return {
      version: 1,
      state: value.state,
      artifacts: value.artifacts.filter((artifact): artifact is string => typeof artifact === "string"),
      migratedDatabase: value.migratedDatabase === true,
      migratedLocalStorage: value.migratedLocalStorage === true,
      ...(typeof value.error === "string" ? { error: value.error } : {})
    };
  } catch {
    return null;
  }
}

function writeJournal(journalPath: string, journal: MigrationJournal): void {
  const temporaryPath = join(dirname(journalPath), JOURNAL_TEMP_FILE);
  writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, journalPath);
}

function removeArtifacts(targetDirectory: string, artifacts: string[]): void {
  for (const artifact of artifacts) {
    if (MIGRATION_ARTIFACTS.includes(artifact as (typeof MIGRATION_ARTIFACTS)[number])) {
      rmSync(join(targetDirectory, artifact), { recursive: true, force: true });
    }
  }
}

function assertNoUnownedArtifacts(targetDirectory: string): void {
  const existing = MIGRATION_ARTIFACTS.filter((artifact) => existsSync(join(targetDirectory, artifact)));
  if (existing.length > 0) {
    throw new Error(`Store migration target already contains unowned data: ${existing.join(", ")}`);
  }
}

function isLegacyApplicationRunning(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'Memmy.exe'\" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress"
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true }
  ).trim();
  if (!output) {
    return false;
  }

  const parsed = JSON.parse(output) as ProcessInfo | ProcessInfo[];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const currentExecutablePath = process.execPath.toLocaleLowerCase("en-US");
  return processes.some((candidate) => {
    if (Number(candidate.ProcessId) === process.pid) {
      return false;
    }
    return typeof candidate.ExecutablePath !== "string" || candidate.ExecutablePath.toLocaleLowerCase("en-US") !== currentExecutablePath;
  });
}

interface ProcessInfo {
  ProcessId?: number;
  ExecutablePath?: string | null;
}

function migrationResult(journal: Pick<MigrationJournal, "migratedDatabase" | "migratedLocalStorage">): MigrationResult {
  return {
    migratedDatabase: journal.migratedDatabase,
    migratedLocalStorage: journal.migratedLocalStorage
  };
}
