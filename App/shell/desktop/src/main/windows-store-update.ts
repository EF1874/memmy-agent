import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type WindowsStoreUpdateCommand =
  | "check"
  | "download-silent"
  | "download-user"
  | "install-silent"
  | "install-user";

export type WindowsStoreUpdateState =
  | "pending"
  | "downloading"
  | "deploying"
  | "completed"
  | "canceled"
  | "error-low-battery"
  | "error-wifi-recommended"
  | "error-wifi-required"
  | "not-allowed"
  | "other-error";

export interface WindowsStoreUpdateCheckResult {
  type: "check";
  available: boolean;
  updateCount: number;
  canSilentlyDownload: boolean;
  mandatory: boolean;
  latestVersion?: string;
}

export interface WindowsStoreUpdateProgress {
  type: "progress";
  state: WindowsStoreUpdateState;
  transferredBytes: number;
  totalBytes: number;
  percent: number;
}

export interface WindowsStoreUpdateActionResult {
  type: "result";
  state: WindowsStoreUpdateState;
  packages: Array<{
    family: string;
    state: WindowsStoreUpdateState;
    transferredBytes: number;
    totalBytes: number;
  }>;
}

export interface RunWindowsStoreUpdateOptions {
  resourcesPath: string;
  command: WindowsStoreUpdateCommand;
  ownerWindowHandle?: string;
  onProgress?: (progress: WindowsStoreUpdateProgress) => void;
}

type WindowsStoreHelperMessage =
  | WindowsStoreUpdateCheckResult
  | WindowsStoreUpdateProgress
  | WindowsStoreUpdateActionResult
  | { type: "error"; hresult: number; message: string };

export async function runWindowsStoreUpdate(
  options: RunWindowsStoreUpdateOptions
): Promise<WindowsStoreUpdateCheckResult | WindowsStoreUpdateActionResult> {
  const helperPath = join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  const args: string[] = [options.command];
  if (options.ownerWindowHandle) {
    args.push("--hwnd", options.ownerWindowHandle);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr: string[] = [];
    let result: WindowsStoreUpdateCheckResult | WindowsStoreUpdateActionResult | null = null;
    let helperError: Error | null = null;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const message = parseWindowsStoreHelperMessage(line);
        if (message.type === "progress") {
          options.onProgress?.(message);
          return;
        }
        if (message.type === "error") {
          helperError = new Error(`Microsoft Store update failed (${formatHresult(message.hresult)}): ${message.message}`);
          return;
        }
        result = message;
      } catch (error) {
        helperError = error instanceof Error ? error : new Error(String(error));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (helperError) {
        reject(helperError);
        return;
      }
      if (code !== 0 || !result) {
        reject(new Error(
          `Microsoft Store update helper exited with code ${code ?? "unknown"}${stderr.length > 0 ? `: ${stderr.join("").trim()}` : ""}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

export function nativeWindowHandleToDecimal(handle: Buffer): string {
  if (handle.length >= 8) {
    return handle.readBigUInt64LE(0).toString(10);
  }
  if (handle.length >= 4) {
    return String(handle.readUInt32LE(0));
  }
  throw new Error("Electron returned an invalid native window handle");
}

function parseWindowsStoreHelperMessage(line: string): WindowsStoreHelperMessage {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.type === "check") {
    if (typeof value.available !== "boolean" ||
        typeof value.updateCount !== "number" ||
        typeof value.canSilentlyDownload !== "boolean" ||
        typeof value.mandatory !== "boolean") {
      throw new Error("Microsoft Store update helper returned an invalid check result");
    }
    return {
      type: "check",
      available: value.available,
      updateCount: value.updateCount,
      canSilentlyDownload: value.canSilentlyDownload,
      mandatory: value.mandatory,
      ...(typeof value.latestVersion === "string" ? { latestVersion: value.latestVersion } : {})
    };
  }
  if (value.type === "progress") {
    if (!isWindowsStoreUpdateState(value.state) ||
        typeof value.transferredBytes !== "number" ||
        typeof value.totalBytes !== "number" ||
        typeof value.percent !== "number") {
      throw new Error("Microsoft Store update helper returned invalid progress");
    }
    return {
      type: "progress",
      state: value.state,
      transferredBytes: value.transferredBytes,
      totalBytes: value.totalBytes,
      percent: value.percent
    };
  }
  if (value.type === "result") {
    if (!isWindowsStoreUpdateState(value.state) || !Array.isArray(value.packages)) {
      throw new Error("Microsoft Store update helper returned an invalid operation result");
    }
    return {
      type: "result",
      state: value.state,
      packages: value.packages.flatMap((candidate) => {
        if (!isRecord(candidate) ||
            typeof candidate.family !== "string" ||
            !isWindowsStoreUpdateState(candidate.state) ||
            typeof candidate.transferredBytes !== "number" ||
            typeof candidate.totalBytes !== "number") {
          return [];
        }
        return [{
          family: candidate.family,
          state: candidate.state,
          transferredBytes: candidate.transferredBytes,
          totalBytes: candidate.totalBytes
        }];
      })
    };
  }
  if (value.type === "error" && typeof value.hresult === "number" && typeof value.message === "string") {
    return { type: "error", hresult: value.hresult, message: value.message };
  }
  throw new Error("Microsoft Store update helper returned an unknown message");
}

function isWindowsStoreUpdateState(value: unknown): value is WindowsStoreUpdateState {
  return value === "pending" ||
    value === "downloading" ||
    value === "deploying" ||
    value === "completed" ||
    value === "canceled" ||
    value === "error-low-battery" ||
    value === "error-wifi-recommended" ||
    value === "error-wifi-required" ||
    value === "not-allowed" ||
    value === "other-error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatHresult(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
