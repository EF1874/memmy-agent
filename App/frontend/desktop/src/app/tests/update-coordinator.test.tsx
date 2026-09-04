// @vitest-environment happy-dom

/** App-level update coordinator tests. */
import type {
  DesktopStoreMigrationToken,
  DesktopUpdateDownloadProgress,
  DesktopUpdateInstallResult,
  DesktopUpdateOfferToken
} from "@memmy/desktop-interface";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../state/app-state.js";
import {
  GlobalUpdateDialog,
  UpdateCoordinatorProvider,
  useUpdateCoordinator
} from "../update-coordinator.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OFFER_TOKEN = "a".repeat(43) as DesktopUpdateOfferToken;
const STORE_MIGRATION_TOKEN = "m".repeat(43) as DesktopStoreMigrationToken;
const SECOND_STORE_MIGRATION_TOKEN = "n".repeat(43) as DesktopStoreMigrationToken;

describe("UpdateCoordinatorProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps downloading across route content changes and reopens the prepared installer dialog", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      offerToken: OFFER_TOKEN,
      downloadUrl: "https://updates.example.com/Memmy.dmg"
    }));
    const downloadUpdate = vi.fn(() => downloadPromise);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(getButtonByText("下载更新")).not.toBeNull();

    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");

    act(() => getButtonByLabel("toggle-route").click());
    expect(container.querySelector('[aria-label="update-action"]')).toBeNull();

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("/tmp/Memmy-2.2.0.dmg");
    expect(getButtonByText("重启安装")).not.toBeNull();

    act(() => getButtonByText("稍后再说").click());
    expect(readOutput("phase")).toBe("prepared");
    expect(container.textContent).not.toContain("安装包已准备好，是否重启并安装更新？");

    act(() => getButtonByLabel("toggle-route").click());
    expect(getButtonByLabel("update-action").textContent).toBe("prepared");
    await act(async () => {
      getButtonByLabel("update-action").click();
    });

    expect(getButtonByText("重启安装")).not.toBeNull();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledWith(OFFER_TOKEN, { openInstaller: false });
  });

  it("downloads from the inline account action without opening the installer dialog", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      offerToken: OFFER_TOKEN,
      downloadUrl: "https://updates.example.com/Memmy.dmg"
    }));
    const downloadUpdate = vi.fn(() => downloadPromise);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    act(() => getButtonByText("稍后再说").click());
    expect(readOutput("phase")).toBe("available");

    await act(async () => {
      getButtonByLabel("inline-update-action").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");
    expect(downloadUpdate).toHaveBeenCalledWith(
      OFFER_TOKEN,
      { openInstaller: false }
    );

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(container.textContent).not.toContain("安装包已准备好，是否重启并安装更新？");
  });

  it("keeps the prepared installer path when launching the installer fails", async () => {
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      downloadUrl: "https://updates.example.com/Memmy.dmg",
      preparedUpdate: { kind: "installer-file" as const, filePath: "/tmp/Memmy-2.2.0.dmg" }
    }));
    const openUpdateInstaller = vi.fn(async () => {
      throw new Error("installer unavailable");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(getButtonByText("重启安装")).not.toBeNull();

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("/tmp/Memmy-2.2.0.dmg");
    expect(readOutput("feedback-key")).toBe("settings.about.updateInstallFailed");

    await act(async () => {
      getButtonByLabel("update-action").click();
    });
    expect(getButtonByText("重启安装")).not.toBeNull();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(openUpdateInstaller).toHaveBeenCalledTimes(1);
  });

  it("tracks desktop download progress until the installer is prepared", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    let progressCallback!: (progress: DesktopUpdateDownloadProgress) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const unsubscribeProgress = vi.fn();
    const onUpdateDownloadProgress = vi.fn((callback: (progress: DesktopUpdateDownloadProgress) => void) => {
      progressCallback = callback;
      return unsubscribeProgress;
    });
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        currentVersion: "2.1.0",
        latestVersion: "2.2.0",
        offerToken: OFFER_TOKEN,
        downloadUrl: "https://updates.example.com/Memmy.dmg"
      })),
      downloadUpdate: vi.fn(() => downloadPromise),
      onUpdateDownloadProgress
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    expect(onUpdateDownloadProgress).toHaveBeenCalledTimes(1);

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");

    act(() => {
      progressCallback({
        kind: "installer-file",
        downloadUrl: "https://updates.example.com/Memmy.dmg",
        filePath: "/tmp/Memmy-2.2.0.dmg",
        transferredBytes: 512,
        totalBytes: 1024,
        percent: 50
      });
    });
    expect(readOutput("download-progress")).toBe("50");

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("download-progress")).toBe("");
  });

  it("does not send renderer-controlled provider or URL metadata without an opaque desktop offer token", async () => {
    const downloadUpdate = vi.fn(async () => {
      throw new Error("must not be called");
    });
    setDesktopBridge({
      platform: "win32",
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        currentVersion: "1.1.2",
        latestVersion: "9.9.9",
        provider: "legacy-installer" as const,
        force: true,
        downloadUrl: "https://attacker.example/forged.exe"
      })),
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });

    expect(readOutput("phase")).toBe("available");
    expect(container.textContent).not.toContain("下载更新");
    expect(readOutput("feedback-key")).toBe("settings.about.updateAvailableNoLink");
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("keeps the browser fallback on the manifest download URL when no preload bridge exists", async () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://updates.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          version: "2.2.0",
          downloads: { fallback: "https://updates.example.com/Memmy.dmg" }
        }
      })
    })));
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });

    expect(open).toHaveBeenCalledWith(
      "https://updates.example.com/Memmy.dmg",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("keeps a versionless Microsoft Store handle out of installer file paths", async () => {
    const preparedUpdate = {
      kind: "microsoft-store" as const,
      baselinePackageVersion: "1.1.1.0",
      baselinePackageFullName: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2"
    };
    const downloadUpdate = vi.fn(async () => ({ preparedUpdate, opened: false }));
    const openUpdateInstaller = vi.fn(async () => ({
      preparedUpdate,
      opened: true,
      willQuit: true,
      background: true
    }));
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: true
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        provider: "microsoft-store" as const,
        currentVersion: "1.1.1",
        offerToken: OFFER_TOKEN,
        updateMode: "manual" as const,
        windowsStore: {
          baselinePackageVersion: preparedUpdate.baselinePackageVersion,
          baselinePackageFullName: preparedUpdate.baselinePackageFullName,
          canSilentlyDownload: false
        }
      })),
      downloadUpdate,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Microsoft Store 更新可用");

    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(downloadUpdate).toHaveBeenCalledWith(OFFER_TOKEN, { openInstaller: false });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(container.textContent).toContain("Microsoft Store 更新已下载");

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenCalledWith(preparedUpdate);
  });

  it("offers an installer-to-Store migration without treating the Store URI as a package path", async () => {
    const preparedUpdate = {
      kind: "store-migration" as const,
      offerToken: STORE_MIGRATION_TOKEN
    };
    const openUpdateInstaller = vi.fn(async () => ({
      preparedUpdate,
      opened: true
    }));
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate
      })),
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });

    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(container.textContent).toContain("迁移到 Microsoft Store");
    expect(container.textContent).toContain("首次启动商店版本时会迁移现有数据");

    await act(async () => {
      getButtonByText("打开 Microsoft Store").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenCalledWith(preparedUpdate);
    expect(readOutput("feedback-key")).toBe("settings.about.storeMigrationOpened");
  });

  it("drops an expired Store migration handle so the next action can recheck", async () => {
    const firstPreparedUpdate = {
      kind: "store-migration" as const,
      offerToken: STORE_MIGRATION_TOKEN
    };
    const refreshedPreparedUpdate = {
      kind: "store-migration" as const,
      offerToken: SECOND_STORE_MIGRATION_TOKEN
    };
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate: firstPreparedUpdate
      })
      .mockResolvedValueOnce({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate: refreshedPreparedUpdate
      });
    const openUpdateInstaller = vi.fn()
      .mockRejectedValueOnce(new Error("Microsoft Store migration offer is missing, expired, or unavailable"))
      .mockResolvedValueOnce({
        preparedUpdate: refreshedPreparedUpdate,
        opened: true,
        willQuit: true
      });
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("打开 Microsoft Store").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("error");
    expect(readOutput("feedback-key")).toBe("settings.about.updateInstallFailed");

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(readOutput("phase")).toBe("prepared");

    await act(async () => {
      getButtonByText("打开 Microsoft Store").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenNthCalledWith(1, firstPreparedUpdate);
    expect(openUpdateInstaller).toHaveBeenNthCalledWith(2, refreshedPreparedUpdate);
  });
});

function UpdateHarness() {
  const update = useUpdateCoordinator();
  const [routeContentVisible, setRouteContentVisible] = useState(true);
  return (
    <>
      <button
        type="button"
        aria-label="toggle-route"
        onClick={() => setRouteContentVisible((visible) => !visible)}
      >
        Toggle route
      </button>
      {routeContentVisible && (
        <>
          <button
            type="button"
            aria-label="update-action"
            onClick={() => void update.requestPrimaryAction()}
          >
            {update.phase}
          </button>
          <button
            type="button"
            aria-label="inline-update-action"
            onClick={() => void update.requestInlineAction()}
          >
            {update.phase}
          </button>
        </>
      )}
      <output aria-label="phase">{update.phase}</output>
      <output aria-label="prepared-path">{update.preparedUpdatePath ?? ""}</output>
      <output aria-label="download-progress">{update.downloadProgress?.percent ?? ""}</output>
      <output aria-label="feedback-key">{update.feedback?.key ?? ""}</output>
      <GlobalUpdateDialog />
    </>
  );
}

function setDesktopBridge(bridge: Partial<NonNullable<Window["memmy"]>>): void {
  Object.defineProperty(window, "memmy", {
    configurable: true,
    writable: true,
    value: bridge
  });
}

function getButtonByLabel(label: string): HTMLButtonElement {
  const button = containerQuery<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === text);
  expect(button).not.toBeNull();
  return button!;
}

function readOutput(label: string): string {
  return containerQuery<HTMLOutputElement>(`output[aria-label="${label}"]`)?.textContent ?? "";
}

function containerQuery<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
