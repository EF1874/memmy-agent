import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import {
  prepareWindowsStoreLegacyTransitionBeforeLock,
  type WindowsStoreLegacyTransitionOptions,
  type WindowsStoreLegacyTransitionPrepareResult
} from "./windows-store-legacy-transition.js";
import {
  prepareWindowsStoreTransitionForBoot,
  type WindowsStoreTransitionCoordinatorOptions,
  type WindowsStoreTransitionPrepareResult
} from "./windows-store-transition-coordinator.js";

const PRE_READY_WORKER_TIMEOUT_MS = 10 * 60 * 1_000;

export interface WindowsStoreTransitionPreReadyInput {
  legacy: WindowsStoreLegacyTransitionOptions;
  coordinator: WindowsStoreTransitionCoordinatorOptions;
}

export interface WindowsStoreTransitionPreReadyResult {
  legacy: WindowsStoreLegacyTransitionPrepareResult;
  transition: WindowsStoreTransitionPrepareResult;
}

export interface RunWindowsStoreTransitionPreReadyWorkerOptions {
  executablePath: string;
  workerPath: string;
  input: WindowsStoreTransitionPreReadyInput;
}

export interface RunWindowsStoreTransitionPreReadyWorkerDependencies {
  execWorker?: typeof execFileSync;
}

export interface ExecuteWindowsStoreTransitionPreReadyDependencies {
  prepareLegacy?: typeof prepareWindowsStoreLegacyTransitionBeforeLock;
  prepareTransition?: typeof prepareWindowsStoreTransitionForBoot;
}

/** Runs the existing transactional takeover and data preparation inside the pre-ready worker. */
export const executeWindowsStoreTransitionPreReady = async (
  input: WindowsStoreTransitionPreReadyInput,
  dependencies: ExecuteWindowsStoreTransitionPreReadyDependencies = {}
): Promise<WindowsStoreTransitionPreReadyResult> => {
  const legacy = await (dependencies.prepareLegacy ?? prepareWindowsStoreLegacyTransitionBeforeLock)(input.legacy);
  const transition = await (dependencies.prepareTransition ?? prepareWindowsStoreTransitionForBoot)(input.coordinator);
  return { legacy, transition };
};

/**
 * Blocks the Electron main thread on a short-lived Node child while the destination profile is
 * still unlocked. The child reuses the normal transactional migration implementation instead of
 * maintaining a second synchronous copy algorithm.
 */
export const runWindowsStoreTransitionPreReadyWorker = (
  options: RunWindowsStoreTransitionPreReadyWorkerOptions,
  dependencies: RunWindowsStoreTransitionPreReadyWorkerDependencies = {}
): void => {
  const executablePath = normalizeExecutablePath(options.executablePath);
  const workerPath = normalizeWorkerPath(options.workerPath);
  const payload = Buffer.from(JSON.stringify(options.input), "utf8").toString("base64url");
  (dependencies.execWorker ?? execFileSync)(executablePath, [workerPath, payload], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PRE_READY_WORKER_TIMEOUT_MS,
    windowsHide: true
  });
};

const normalizeExecutablePath = (value: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value) || win32.extname(value).toLowerCase() !== ".exe") {
    throw new Error("Windows Store pre-ready worker executable path is invalid");
  }
  return win32.normalize(value);
};

const normalizeWorkerPath = (value: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value) || win32.extname(value).toLowerCase() !== ".js") {
    throw new Error("Windows Store pre-ready worker script path is invalid");
  }
  return win32.normalize(value);
};
