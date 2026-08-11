import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import type {
  AgentWorkspaceMigrationContext,
  MigrationDefinition,
  MigrationResult,
} from "../../types.js";
import { removeLegacyRuntimeModelFields } from "./0001-normalize-runtime-model-catalog.js";

const MIGRATION_ID = "v1.0.7/0003-remove-legacy-runtime-model-fields";

async function migrate(context: AgentWorkspaceMigrationContext): Promise<MigrationResult> {
  const mutator = (config: RuntimeConfigDocument): void => {
    removeLegacyRuntimeModelFields(config);
  };
  const options = { createIfMissing: false as const };
  const result = context.runtimeConfigLock
    ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, mutator, options)
    : await mutateRuntimeConfig(context.runtimeConfigFile, mutator, options);
  if (!result.sourceExists) return { scanned: 0, changed: 0, ignored: 1 };
  return result.changed
    ? { scanned: 1, changed: 1, ignored: 0 }
    : { scanned: 1, changed: 0, ignored: 1 };
}

export const removeLegacyRuntimeModelFieldsV107: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.7",
  scope: "runtime-config",
  description: "Remove legacy runtime model fields after catalog migration",
  up: migrate,
};
