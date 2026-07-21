import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWindowsStoreMigrationComplete, migrateWindowsStoreData } from "../src/main/windows-store-migration.js";
import { markLegacyWindowsStoreTransitionCompatible } from "../src/main/windows-store-transition-barrier.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Store data migration", () => {
  it("reports completion only for a valid completed journal", () => {
    const { target } = createPaths();
    expect(isWindowsStoreMigrationComplete(target)).toBe(false);
    mkdirSync(target, { recursive: true });
    for (const state of ["started", "failed", "completed"] as const) {
      writeFileSync(join(target, "store-migration.json"), JSON.stringify({
        version: 1,
        state,
        artifacts: [],
        migratedDatabase: false,
        migratedLocalStorage: false
      }));
      expect(isWindowsStoreMigrationComplete(target)).toBe(state === "completed");
    }
    writeFileSync(join(target, "store-migration.json"), "not json");
    expect(isWindowsStoreMigrationComplete(target)).toBe(false);
  });

  it("migrates SQLite and Local Storage once", () => {
    const { legacy, target } = createPaths();
    createLegacyDatabase(join(legacy, "app.sqlite"), "kept");
    const levelDb = join(legacy, "Local Storage", "leveldb");
    mkdirSync(levelDb, { recursive: true });
    writeFileSync(join(levelDb, "CURRENT"), "MANIFEST-000001\n");
    writeFileSync(join(levelDb, "LOCK"), "");

    expect(runMigration(legacy, target)).toEqual({
      migratedDatabase: true,
      migratedLocalStorage: true
    });
    expect(readDatabaseValue(join(target, "app.sqlite"))).toBe("kept");
    expect(readFileSync(join(target, "Local Storage", "leveldb", "CURRENT"), "utf8")).toBe("MANIFEST-000001\n");
    expect(existsSync(join(target, "Local Storage", "leveldb", "LOCK"))).toBe(false);

    expect(runMigration(legacy, target)).toEqual({
      migratedDatabase: true,
      migratedLocalStorage: true
    });
  });

  it("replaces only journal-owned artifacts after an interrupted attempt", () => {
    const { legacy, target } = createPaths();
    createLegacyDatabase(join(legacy, "app.sqlite"), "recovered");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "app.sqlite"), "partial");
    writeFileSync(join(target, "keep.txt"), "unrelated");
    writeFileSync(join(target, "store-migration.json"), JSON.stringify({
      version: 1,
      state: "started",
      artifacts: ["app.sqlite", "app.sqlite.migrating"]
    }));

    runMigration(legacy, target);

    expect(readDatabaseValue(join(target, "app.sqlite"))).toBe("recovered");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("unrelated");
  });

  it("rolls back target artifacts when the legacy database is invalid", () => {
    const { legacy, target } = createPaths();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "app.sqlite"), "not sqlite");

    expect(() => runMigration(legacy, target)).toThrow("SQLite header");
    expect(existsSync(join(target, "app.sqlite"))).toBe(false);
    expect(readFileSync(join(legacy, "app.sqlite"), "utf8")).toBe("not sqlite");
    expect(JSON.parse(readFileSync(join(target, "store-migration.json"), "utf8"))).toMatchObject({ state: "failed" });
  });

  it("treats missing legacy data as a successful fresh install", () => {
    const { legacy, target } = createPaths();

    expect(runMigration(legacy, target)).toEqual({
      migratedDatabase: false,
      migratedLocalStorage: false
    });
    expect(JSON.parse(readFileSync(join(target, "store-migration.json"), "utf8"))).toMatchObject({ state: "completed" });
  });

  it("allows a legacy database without Local Storage", () => {
    const { legacy, target } = createPaths();
    createLegacyDatabase(join(legacy, "app.sqlite"), "database-only");

    expect(runMigration(legacy, target)).toEqual({
      migratedDatabase: true,
      migratedLocalStorage: false
    });
    expect(readDatabaseValue(join(target, "app.sqlite"))).toBe("database-only");
  });

  it("refuses to copy a busy legacy database", () => {
    const { legacy, target } = createPaths();
    const databasePath = join(legacy, "app.sqlite");
    createLegacyDatabase(databasePath, "busy");
    const writer = new DatabaseSync(databasePath);
    writer.exec("BEGIN IMMEDIATE; INSERT INTO settings (value) VALUES ('pending')");

    try {
      expect(() => runMigration(legacy, target)).toThrow("is busy");
      expect(existsSync(join(target, "app.sqlite"))).toBe(false);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("preserves existing Store data when the ownership journal is corrupt", () => {
    const { legacy, target } = createPaths();
    createLegacyDatabase(join(legacy, "app.sqlite"), "legacy");
    mkdirSync(target, { recursive: true });
    createLegacyDatabase(join(target, "app.sqlite"), "store");
    writeFileSync(join(target, "store-migration.json"), "not json");

    expect(() => runMigration(legacy, target)).toThrow("unowned data");
    expect(readDatabaseValue(join(target, "app.sqlite"))).toBe("store");
    expect(readDatabaseValue(join(legacy, "app.sqlite"))).toBe("legacy");
  });

  it("starts fresh when legacy data never ran the Store-compatible NSIS version", () => {
    const { legacy, target } = createPaths();
    createLegacyDatabase(join(legacy, "app.sqlite"), "unprepared");

    expect(migrateWindowsStoreData({
      legacyUserDataPath: legacy,
      targetUserDataPath: target,
      isLegacyApplicationRunning: () => false
    })).toEqual({ migratedDatabase: false, migratedLocalStorage: false });
    expect(readDatabaseValue(join(legacy, "app.sqlite"))).toBe("unprepared");
    expect(JSON.parse(readFileSync(join(target, "store-migration.json"), "utf8"))).toMatchObject({
      state: "completed",
      migratedDatabase: false,
      migratedLocalStorage: false
    });
  });

  it("recovers an atomically written completed journal", () => {
    const { legacy, target } = createPaths();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "store-migration.json"), "incomplete");
    writeFileSync(join(target, "store-migration.json.migrating"), JSON.stringify({
      version: 1,
      state: "completed",
      artifacts: [],
      migratedDatabase: false,
      migratedLocalStorage: false
    }));

    expect(runMigration(legacy, target)).toEqual({ migratedDatabase: false, migratedLocalStorage: false });
    expect(JSON.parse(readFileSync(join(target, "store-migration.json"), "utf8"))).toMatchObject({ state: "completed" });
    expect(existsSync(join(target, "store-migration.json.migrating"))).toBe(false);
  });

  it("refuses a Local Storage-only migration while legacy Memmy is running", () => {
    const { legacy, target } = createPaths();
    mkdirSync(join(legacy, "Local Storage", "leveldb"), { recursive: true });
    writeFileSync(join(legacy, "Local Storage", "leveldb", "CURRENT"), "MANIFEST-000001\n");
    markLegacyWindowsStoreTransitionCompatible(legacy);

    expect(() => migrateWindowsStoreData({
      legacyUserDataPath: legacy,
      targetUserDataPath: target,
      isLegacyApplicationRunning: () => true
    })).toThrow("still running");
    expect(existsSync(join(target, "Local Storage"))).toBe(false);
    expect(existsSync(join(target, "store-migration.json"))).toBe(false);
  });
});

function createPaths(): { legacy: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "memmy-store-migration-"));
  temporaryDirectories.push(root);
  return { legacy: join(root, "legacy"), target: join(root, "target") };
}

function createLegacyDatabase(databasePath: string, value: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE settings (value TEXT NOT NULL)");
  database.prepare("INSERT INTO settings (value) VALUES (?)").run(value);
  database.close();
}

function readDatabaseValue(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return String((database.prepare("SELECT value FROM settings").get() as { value: unknown }).value);
  } finally {
    database.close();
  }
}

function runMigration(legacyUserDataPath: string, targetUserDataPath: string) {
  if (existsSync(join(legacyUserDataPath, "app.sqlite")) || existsSync(join(legacyUserDataPath, "Local Storage"))) {
    markLegacyWindowsStoreTransitionCompatible(legacyUserDataPath);
  }
  return migrateWindowsStoreData({
    legacyUserDataPath,
    targetUserDataPath,
    isLegacyApplicationRunning: () => false
  });
}
