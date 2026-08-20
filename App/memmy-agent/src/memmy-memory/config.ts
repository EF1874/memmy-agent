import type { Config } from "../config/schema.js";
import type { MemmyMemoryResolvedConfig } from "./types.js";

export function resolveMemmyMemoryConfig(config: Config | Record<string, any> | null | undefined): MemmyMemoryResolvedConfig {
  const raw = (config as any)?.memmyMemory ?? {};
  const workspaceBridgeEnabled = raw?.workspaceBridge?.enabled;
  return {
    enabled: Boolean(raw?.enabled ?? raw?.enable ?? true),
    userId: stringOrUndefined(raw?.userId) ?? "local-user",
    workspaceBridgeEnabled: workspaceBridgeEnabled === undefined || workspaceBridgeEnabled === true,
  };
}

function stringOrUndefined(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
