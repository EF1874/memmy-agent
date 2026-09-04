import { describe, expect, it, vi } from "vitest";
import {
  executeWindowsStoreTransitionPreReady,
  runWindowsStoreTransitionPreReadyWorker,
  type WindowsStoreTransitionPreReadyInput
} from "../src/main/windows-store-transition-pre-ready.js";

const input: WindowsStoreTransitionPreReadyInput = {
  legacy: {
    platform: "win32",
    isPackaged: true,
    isWindowsStore: true,
    resourcesPath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\resources",
    localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
    roamingAppDataPath: "C:\\Users\\lee\\AppData\\Roaming",
    homeDirectory: "C:\\Users\\lee",
    desktopPath: "E:\\Users\\lee\\Desktop",
    identity: {
      edition: "intl",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
      aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
    }
  },
  coordinator: {
    localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
    identity: {
      edition: "intl",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
      aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
    },
    layout: {
      userDataPath: "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy",
      runtimeHomePath: "C:\\Users\\lee\\.memmy",
      pointerPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy\\data-root.txt"
    }
  }
};

describe("Windows Store pre-ready transition", () => {
  it("runs legacy takeover before transactional data preparation", async () => {
    const actions: string[] = [];
    const prepareLegacy = vi.fn(async () => {
      actions.push("legacy");
      return { status: "prepared" as const, source: "manual-install" as const, transactionId: "tx" };
    });
    const prepareTransition = vi.fn(async () => {
      actions.push("transition");
      return { status: "prepared" as const, transactionId: "tx", phase: "awaiting-app-verification" as const };
    });

    await expect(executeWindowsStoreTransitionPreReady(input, { prepareLegacy, prepareTransition }))
      .resolves.toEqual({
        legacy: { status: "prepared", source: "manual-install", transactionId: "tx" },
        transition: { status: "prepared", transactionId: "tx", phase: "awaiting-app-verification" }
      });
    expect(actions).toEqual(["legacy", "transition"]);
  });

  it("starts the packaged executable as a synchronous plain-Node worker", () => {
    const execWorker = vi.fn();
    runWindowsStoreTransitionPreReadyWorker({
      executablePath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\Memmy.exe",
      workerPath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\resources\\app.asar\\dist\\main\\windows-store-transition-pre-ready-worker.js",
      input
    }, { execWorker });

    expect(execWorker).toHaveBeenCalledOnce();
    const [executablePath, args, options] = execWorker.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(executablePath).toBe("E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\Memmy.exe");
    expect(args[0]).toContain("windows-store-transition-pre-ready-worker.js");
    expect(JSON.parse(Buffer.from(args[1], "base64url").toString("utf8"))).toEqual(input);
    expect(options).toMatchObject({ windowsHide: true, timeout: 600_000 });
    expect(options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("rejects ambiguous executable and worker paths before spawning", () => {
    expect(() => runWindowsStoreTransitionPreReadyWorker({
      executablePath: "Memmy.exe",
      workerPath: "C:\\worker.js",
      input
    })).toThrow("executable path is invalid");
    expect(() => runWindowsStoreTransitionPreReadyWorker({
      executablePath: "C:\\Memmy.exe",
      workerPath: "worker.js",
      input
    })).toThrow("worker script path is invalid");
  });
});
