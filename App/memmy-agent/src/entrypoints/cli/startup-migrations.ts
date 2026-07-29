import { runMigrations } from "@memmy/migrations";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getConfigPath, setConfigPath } from "../../config/loader.js";

export const MIGRATIONS_READY_CONFIG_ENV = "MEMMY_MIGRATIONS_READY_CONFIG";
export const MIGRATIONS_READY_WORKSPACE_ENV = "MEMMY_MIGRATIONS_READY_WORKSPACE";

export interface StartupMigrationTarget {
  runtimeConfigFile: string;
  agentWorkspace: string;
}

export interface StartupMigrationPreparation {
  target: StartupMigrationTarget;
  source: "executed" | "prepared-parent";
}

type StartupMigrationInput = {
  config?: string | null;
  workspace?: string | null;
};

const migrationLogger = {
  info: (event: string, fields?: Record<string, string | number>) =>
    console.info(`[migration] ${event}`, fields ?? {}),
  warn: (event: string, fields?: Record<string, string | number>) =>
    console.warn(`[migration] ${event}`, fields ?? {}),
  error: (event: string, fields?: Record<string, string | number>) =>
    console.error(`[migration] ${event}`, fields ?? {}),
};

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value !== "~" && !value.startsWith("~/")) return value;
  const home = env.HOME;
  return home ? path.join(home, value.slice(2)) : value;
}

function configuredWorkspace(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
    const configured = parsed?.agents?.defaults?.workspace;
    return typeof configured === "string" && configured.trim() ? configured : null;
  } catch {
    // The migration runner reports malformed YAML using its stable error type.
    return null;
  }
}

function normalizeConfigPath(value: string, env: NodeJS.ProcessEnv): string {
  return path.normalize(path.resolve(expandHome(value, env)));
}

function canonicalWorkspacePath(value: string, env: NodeJS.ProcessEnv): string {
  const resolved = path.normalize(path.resolve(expandHome(value, env)));
  fs.mkdirSync(resolved, { recursive: true });
  return fs.realpathSync(resolved);
}

export function resolveStartupMigrationTarget(
  input: StartupMigrationInput = {},
  env: NodeJS.ProcessEnv = process.env,
): StartupMigrationTarget {
  const runtimeConfigFile = normalizeConfigPath(
    input.config ?? env.MEMMY_CONFIG ?? getConfigPath(),
    env,
  );
  if (input.config) setConfigPath(runtimeConfigFile);
  const workspace = input.workspace
    ?? env.MEMMY_AGENT_WORKSPACE
    ?? configuredWorkspace(runtimeConfigFile);
  const agentWorkspace = canonicalWorkspacePath(
    workspace ?? "~/.memmy/workspace",
    env,
  );
  return { runtimeConfigFile, agentWorkspace };
}

function preparedTargetMatches(
  target: StartupMigrationTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  const preparedConfig = env[MIGRATIONS_READY_CONFIG_ENV];
  const preparedWorkspace = env[MIGRATIONS_READY_WORKSPACE_ENV];
  if (!preparedConfig || !preparedWorkspace) return false;
  try {
    return normalizeConfigPath(preparedConfig, env) === target.runtimeConfigFile
      && canonicalWorkspacePath(preparedWorkspace, env) === target.agentWorkspace;
  } catch {
    return false;
  }
}

export async function prepareStartupMigrations(
  input: StartupMigrationInput = {},
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean } = {},
): Promise<StartupMigrationPreparation> {
  const target = resolveStartupMigrationTarget(input, env);
  if (!options.force && preparedTargetMatches(target, env)) {
    return { target, source: "prepared-parent" };
  }
  await runMigrations({ targets: target, logger: migrationLogger });
  return { target, source: "executed" };
}
