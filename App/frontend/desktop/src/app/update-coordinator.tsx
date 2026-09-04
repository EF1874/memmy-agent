/** App-level desktop update coordination. */
import type {
  DesktopPreparedUpdateHandle,
  DesktopUpdateCheckResult,
  DesktopUpdateDownloadProgress,
  DesktopUpdateInstallResult
} from "@memmy/desktop-interface";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useAppState } from "../state/app-state.js";
import { decideUpdateNotification } from "../state/update-notification.js";
import { checkForUpdatesInBrowser, openUpdateUrlInBrowser } from "./browser-update.js";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "latest"
  | "not-configured"
  | "available"
  | "downloading"
  | "prepared"
  | "installing"
  | "error";

export interface UpdateFeedback {
  key: MessageKey;
  values?: MessageValues;
}

export interface UpdateCoordinatorValue {
  appVersion: string;
  phase: UpdatePhase;
  preparedUpdatePath: string | null;
  downloadProgress: DesktopUpdateDownloadProgress | null;
  feedback: UpdateFeedback | null;
  requestInlineAction(): Promise<void>;
  requestPrimaryAction(): Promise<void>;
}

type UpdateDialogKind = "download-confirm" | "install-confirm" | null;

interface DownloadUpdateOptions {
  showInstallDialog?: boolean;
}

interface UpdateCoordinatorState {
  phase: UpdatePhase;
  result: DesktopUpdateCheckResult | null;
  preparedUpdate: DesktopPreparedUpdateHandle | null;
  downloadProgress: DesktopUpdateDownloadProgress | null;
  feedback: UpdateFeedback | null;
  dialog: UpdateDialogKind;
}

interface UpdateCoordinatorContextValue extends UpdateCoordinatorValue {
  result: DesktopUpdateCheckResult | null;
  dialog: UpdateDialogKind;
  dismissDialog(): void;
  confirmDialog(): Promise<void>;
}

const UPDATE_NOTIFICATION_FIRST_CHECK_DELAY_MS = 5_000;
const UPDATE_NOTIFICATION_INTERVAL_MS = 60 * 60 * 1000;

const INITIAL_UPDATE_STATE: UpdateCoordinatorState = {
  phase: "idle",
  result: null,
  preparedUpdate: null,
  downloadProgress: null,
  feedback: null,
  dialog: null
};

const UpdateCoordinatorContext = createContext<UpdateCoordinatorContextValue | null>(null);

/** Keeps update work alive while route pages mount and unmount. */
export function UpdateCoordinatorProvider(props: { children: ReactNode }) {
  const { state: appState } = useAppState();
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("0.0.0");
  const [appPlatform, setAppPlatform] = useState<string | null>(() => {
    return typeof window === "undefined" ? null : window.memmy?.platform ?? null;
  });
  const [updateState, setUpdateState] = useState<UpdateCoordinatorState>(INITIAL_UPDATE_STATE);
  const updateStateRef = useRef(updateState);
  const mountedRef = useRef(true);
  const checkInFlightRef = useRef<Promise<DesktopUpdateCheckResult> | null>(null);
  const downloadInFlightRef = useRef<Promise<DesktopUpdateInstallResult> | null>(null);
  const installInFlightRef = useRef<Promise<DesktopUpdateInstallResult> | null>(null);
  const lastNotifiedUpdateKeyRef = useRef<string | null>(null);
  const notificationContextRef = useRef({
    enabled: true,
    soundEnabled: true,
    translate: t
  });
  notificationContextRef.current = {
    enabled: appState.bootstrap?.app.autoUpdateEnabled ?? true,
    soundEnabled: appState.bootstrap?.app.notificationSoundEnabled ?? true,
    translate: t
  };

  const commitUpdateState = useCallback((resolveNext: (current: UpdateCoordinatorState) => UpdateCoordinatorState) => {
    setUpdateState((current) => {
      const next = resolveNext(current);
      updateStateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.getAppInfo) {
      return;
    }

    let disposed = false;
    void bridge.getAppInfo().then((appInfo) => {
      if (disposed) {
        return;
      }
      if (appInfo.version) {
        setAppVersion(appInfo.version);
      }
      if (appInfo.platform) {
        setAppPlatform(appInfo.platform);
      }
    }).catch((error: unknown) => {
      console.warn("load desktop app info failed", error);
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.onUpdateDownloadProgress) {
      return;
    }

    return bridge.onUpdateDownloadProgress((progress) => {
      commitUpdateState((current) => {
        if (current.phase !== "downloading") {
          return current;
        }
        return {
          ...current,
          downloadProgress: progress
        };
      });
    });
  }, [commitUpdateState]);

  const requestUpdateResult = useCallback((): Promise<DesktopUpdateCheckResult> => {
    const existingRequest = checkInFlightRef.current;
    if (existingRequest) {
      return existingRequest;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    const rawRequest = bridge?.checkForUpdates
      ? bridge.checkForUpdates()
      : checkForUpdatesInBrowser(appVersion);
    const request = rawRequest.finally(() => {
      if (checkInFlightRef.current === request) {
        checkInFlightRef.current = null;
      }
    });
    checkInFlightRef.current = request;
    return request;
  }, [appVersion]);

  const downloadUpdate = useCallback(async (update: DesktopUpdateCheckResult, options: DownloadUpdateOptions = {}): Promise<void> => {
    if (downloadInFlightRef.current) {
      await downloadInFlightRef.current;
      return;
    }

    const version = update.latestVersion;
    if (!canDownloadUpdate(update)) {
      commitUpdateState((current) => ({
        ...current,
        phase: "available",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateAvailableNoLink", values: { version: version ?? update.currentVersion } }
      }));
      return;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.downloadUpdate) {
      if (update.downloadUrl) {
        openUpdateUrlInBrowser(update.downloadUrl);
      }
      commitUpdateState((current) => ({
        ...current,
        phase: "available",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.openingUpdate", values: { version: version ?? update.currentVersion } }
      }));
      return;
    }

    commitUpdateState((current) => ({
      ...current,
      phase: "downloading",
      preparedUpdate: null,
      downloadProgress: null,
      dialog: null,
      feedback: resolveDownloadingUpdateFeedback(update)
    }));

    const offerToken = update.offerToken;
    if (!offerToken) {
      commitUpdateState((current) => ({
        ...current,
        phase: "available",
        preparedUpdate: null,
        downloadProgress: null,
        dialog: null,
        feedback: { key: "settings.about.updateAvailableNoLink", values: { version: version ?? update.currentVersion } }
      }));
      return;
    }

    const request = bridge.downloadUpdate(offerToken, { openInstaller: false });
    downloadInFlightRef.current = request;
    try {
      const installResult = await request;
      if (!mountedRef.current) {
        return;
      }
      const preparedUpdate = validatePreparedUpdateHandle(installResult.preparedUpdate);
      const preparedResult = { ...update, preparedUpdate };
      commitUpdateState(() => ({
        phase: "prepared",
        result: preparedResult,
        preparedUpdate,
        downloadProgress: null,
        feedback: resolvePreparedUpdateFeedback(update),
        dialog: options.showInstallDialog === false ? null : "install-confirm"
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("download app update failed", error);
      commitUpdateState((current) => ({
        ...current,
        phase: "error",
        preparedUpdate: null,
        downloadProgress: null,
        dialog: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
    } finally {
      if (downloadInFlightRef.current === request) {
        downloadInFlightRef.current = null;
      }
    }
  }, [commitUpdateState]);

  const installPreparedUpdate = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    const preparedUpdate = current.preparedUpdate;
    if (!preparedUpdate || installInFlightRef.current) {
      if (installInFlightRef.current) {
        await installInFlightRef.current;
      }
      return;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.openUpdateInstaller) {
      commitUpdateState((state) => ({
        ...state,
        phase: "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
      return;
    }

    commitUpdateState((state) => ({
      ...state,
      phase: "installing",
      dialog: null,
      downloadProgress: null,
      feedback: { key: resolveUpdateInstallStartedMessageKey(preparedUpdate, appPlatform) }
    }));

    try {
      await waitForUpdateInstallMessagePaint(appPlatform);
      const request = bridge.openUpdateInstaller(preparedUpdate);
      installInFlightRef.current = request;
      const installResult = await request;
      if (!mountedRef.current) {
        return;
      }

      commitUpdateState((state) => ({
        ...state,
        phase: installResult.willQuit ? "installing" : "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: resolveUpdateInstallResultMessageKey(installResult, appPlatform) }
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("install app update failed", error);
      if (preparedUpdate.kind === "store-migration") {
        commitUpdateState(() => ({
          phase: "error",
          result: null,
          preparedUpdate: null,
          dialog: null,
          downloadProgress: null,
          feedback: { key: "settings.about.updateInstallFailed" }
        }));
        return;
      }
      commitUpdateState((state) => ({
        ...state,
        phase: "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
    } finally {
      installInFlightRef.current = null;
    }
  }, [appPlatform, commitUpdateState]);

  const checkManually = useCallback(async (): Promise<void> => {
    if (isUpdateBusy(updateStateRef.current.phase)) {
      return;
    }

    commitUpdateState(() => ({
      phase: "checking",
      result: null,
      preparedUpdate: null,
      downloadProgress: null,
      feedback: null,
      dialog: null
    }));
    try {
      const result = await requestUpdateResult();
      if (!mountedRef.current) {
        return;
      }

      if (result.status === "not-configured") {
        commitUpdateState(() => ({
          phase: "not-configured",
          result,
          preparedUpdate: null,
          downloadProgress: null,
          feedback: { key: "settings.about.updateNotConfigured" },
          dialog: null
        }));
        return;
      }

      if (result.status === "latest") {
        commitUpdateState(() => ({
          phase: "latest",
          result,
          preparedUpdate: null,
          downloadProgress: null,
          feedback: { key: "settings.about.upToDate", values: { version: result.currentVersion } },
          dialog: null
        }));
        return;
      }

      if (result.preparedUpdate) {
        const preparedUpdate = validatePreparedUpdateHandle(result.preparedUpdate);
        commitUpdateState(() => ({
          phase: "prepared",
          result,
          preparedUpdate,
          downloadProgress: null,
          feedback: resolvePreparedUpdateFeedback(result),
          dialog: "install-confirm"
        }));
        return;
      }

      commitUpdateState(() => ({
        phase: "available",
        result,
        preparedUpdate: null,
        downloadProgress: null,
        feedback: canDownloadUpdate(result)
          ? resolveAvailableUpdateFeedback(result)
          : { key: "settings.about.updateAvailableNoLink", values: { version: result.latestVersion ?? result.currentVersion } },
        dialog: canDownloadUpdate(result) ? "download-confirm" : null
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("check for app updates failed", error);
      commitUpdateState(() => ({
        phase: "error",
        result: null,
        preparedUpdate: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateCheckFailed" },
        dialog: null
      }));
    }
  }, [commitUpdateState, requestUpdateResult]);

  const requestPrimaryAction = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    if (isUpdateBusy(current.phase)) {
      return;
    }
    if (current.phase === "prepared" && current.result && current.preparedUpdate) {
      commitUpdateState((state) => ({ ...state, dialog: "install-confirm" }));
      return;
    }
    if (current.phase === "available" && current.result && canDownloadUpdate(current.result)) {
      commitUpdateState((state) => ({ ...state, dialog: "download-confirm" }));
      return;
    }

    await checkManually();
  }, [checkManually, commitUpdateState]);

  const requestInlineAction = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    if (isUpdateBusy(current.phase)) {
      return;
    }
    if (current.phase === "prepared" && current.result && current.preparedUpdate) {
      await installPreparedUpdate();
      return;
    }
    if (current.phase === "available" && current.result && canDownloadUpdate(current.result)) {
      await downloadUpdate(current.result, { showInstallDialog: false });
      return;
    }

    await checkManually();
  }, [checkManually, downloadUpdate, installPreparedUpdate]);

  const dismissDialog = useCallback(() => {
    commitUpdateState((state) => ({ ...state, dialog: null }));
  }, [commitUpdateState]);

  const confirmDialog = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    if (current.dialog === "install-confirm") {
      await installPreparedUpdate();
      return;
    }
    if (current.dialog === "download-confirm" && current.result) {
      await downloadUpdate(current.result);
    }
  }, [downloadUpdate, installPreparedUpdate]);

  const commitPassiveAvailableUpdate = useCallback((result: DesktopUpdateCheckResult): void => {
    commitUpdateState((current) => {
      if (isForegroundUpdateFlow(current)) {
        return current;
      }
      if (result.preparedUpdate) {
        return {
          phase: "prepared",
          result,
          preparedUpdate: validatePreparedUpdateHandle(result.preparedUpdate),
          downloadProgress: null,
          feedback: resolvePreparedUpdateFeedback(result),
          dialog: null
        };
      }
      return {
        phase: "available",
        result,
        preparedUpdate: null,
        downloadProgress: null,
        feedback: canDownloadUpdate(result)
          ? resolveAvailableUpdateFeedback(result)
          : { key: "settings.about.updateAvailableNoLink", values: { version: result.latestVersion ?? result.currentVersion } },
        dialog: null
      };
    });
  }, [commitUpdateState]);

  const startupReady = appState.startup.status === "ready";
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!startupReady || !bridge?.checkForUpdates) {
      return;
    }

    let disposed = false;
    const runScheduledUpdateCheck = async () => {
      if (isForegroundUpdateFlow(updateStateRef.current)) {
        return;
      }

      try {
        const result = await requestUpdateResult();
        if (disposed) {
          return;
        }
        if (result.status === "available") {
          commitPassiveAvailableUpdate(result);
        }
        const notificationContext = notificationContextRef.current;
        const plan = decideUpdateNotification({
          enabled: notificationContext.enabled,
          soundEnabled: notificationContext.soundEnabled,
          status: result.status,
          latestVersion: result.latestVersion,
          notificationKey: resolveUpdateNotificationKey(result),
          alreadyNotifiedKey: lastNotifiedUpdateKeyRef.current
        });
        if (!plan) {
          return;
        }

        if (!bridge.notifyUpdateAvailable) {
          return;
        }
        lastNotifiedUpdateKeyRef.current = plan.key;
        void bridge.notifyUpdateAvailable({
          title: notificationContext.translate("notification.update.title"),
          body: plan.version
            ? notificationContext.translate("notification.update.body", { version: plan.version })
            : result.provider === "store-migration"
            ? notificationContext.translate("notification.update.storeMigrationBody")
            : notificationContext.translate("notification.update.storeBody"),
          silent: plan.silent
        }).catch(() => undefined);
      } catch {
        // The next scheduled check retries transient update failures.
      }
    };

    const firstCheckTimer = setTimeout(() => {
      void runScheduledUpdateCheck();
    }, UPDATE_NOTIFICATION_FIRST_CHECK_DELAY_MS);
    const intervalTimer = setInterval(() => {
      void runScheduledUpdateCheck();
    }, UPDATE_NOTIFICATION_INTERVAL_MS);

    return () => {
      disposed = true;
      clearTimeout(firstCheckTimer);
      clearInterval(intervalTimer);
    };
  }, [commitPassiveAvailableUpdate, requestUpdateResult, startupReady]);

  const value = useMemo<UpdateCoordinatorContextValue>(() => ({
    appVersion,
    phase: updateState.phase,
    preparedUpdatePath: updateState.preparedUpdate?.kind === "installer-file"
      ? updateState.preparedUpdate.filePath
      : null,
    downloadProgress: updateState.downloadProgress,
    feedback: updateState.feedback,
    result: updateState.result,
    dialog: updateState.dialog,
    requestInlineAction,
    requestPrimaryAction,
    dismissDialog,
    confirmDialog
  }), [appVersion, confirmDialog, dismissDialog, requestInlineAction, requestPrimaryAction, updateState]);

  return (
    <UpdateCoordinatorContext.Provider value={value}>
      {props.children}
    </UpdateCoordinatorContext.Provider>
  );
}

/** Reads the stable app-level update state. */
export function useUpdateCoordinator(): UpdateCoordinatorValue {
  return useUpdateCoordinatorContext();
}

/** Reads the app-level update state when a provider is present. */
export function useOptionalUpdateCoordinator(): UpdateCoordinatorValue | null {
  return useContext(UpdateCoordinatorContext);
}

/** Renders the update dialog above route-specific pages. */
export function GlobalUpdateDialog(props: { suspended?: boolean }) {
  const update = useUpdateCoordinatorContext();
  const { t } = useTranslation();
  if (props.suspended || !update.dialog || !update.result) {
    return null;
  }

  const installReady = update.dialog === "install-confirm";
  const forced = isForceUpdate(update.result);
  const version = update.result.latestVersion;
  const versionlessStoreUpdate = isVersionlessMicrosoftStoreUpdate(update.result);
  const storeMigration = isWindowsStoreMigration(update.result);
  const titleKey: MessageKey = storeMigration
    ? "settings.about.storeMigrationConfirmTitle"
    : versionlessStoreUpdate
    ? "settings.about.storeUpdateConfirmTitle"
    : "settings.about.updateConfirmTitle";
  return (
    <ConfirmDialog
      open
      title={t(titleKey, version ? { version } : undefined)}
      message={(
        <div className="space-y-2 text-left">
          <p>
            {storeMigration
              ? t("settings.about.storeMigrationConfirmDesc", { currentVersion: update.result.currentVersion })
              : installReady
              ? t(versionlessStoreUpdate
                ? "settings.about.storePreparedUpdateConfirmDesc"
                : "settings.about.preparedUpdateConfirmDesc", { currentVersion: update.result.currentVersion })
              : forced
              ? t(versionlessStoreUpdate
                ? "settings.about.storeForceUpdateConfirmDesc"
                : "settings.about.forceUpdateConfirmDesc", { currentVersion: update.result.currentVersion })
              : t(versionlessStoreUpdate
                ? "settings.about.storeUpdateConfirmDesc"
                : "settings.about.updateConfirmDesc", { currentVersion: update.result.currentVersion })}
          </p>
          {update.result.releaseNotes && (
            <p className="whitespace-pre-wrap text-text-ink/55">{update.result.releaseNotes}</p>
          )}
        </div>
      )}
      cancelLabel={t("settings.about.updateConfirmCancel")}
      closeLabel={t("common.close")}
      confirmLabel={storeMigration
        ? t("settings.about.storeMigrationConfirmOk")
        : installReady
        ? t("settings.about.preparedUpdateConfirmOk")
        : t("settings.about.updateConfirmOk")}
      ariaLabel={t(titleKey, version ? { version } : undefined)}
      iconPose="think"
      width={420}
      buttonMinWidth={96}
      onCancel={update.dismissDialog}
      onConfirm={() => void update.confirmDialog()}
    />
  );
}

function useUpdateCoordinatorContext(): UpdateCoordinatorContextValue {
  const value = useContext(UpdateCoordinatorContext);
  if (!value) {
    throw new Error("useUpdateCoordinator must be used within UpdateCoordinatorProvider");
  }
  return value;
}

function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

function isForegroundUpdateFlow(state: UpdateCoordinatorState): boolean {
  return state.phase === "checking"
    || state.phase === "available"
    || state.phase === "downloading"
    || state.phase === "prepared"
    || state.phase === "installing"
    || state.dialog !== null;
}

function resolveUpdateInstallStartedMessageKey(
  preparedUpdate: DesktopPreparedUpdateHandle,
  platform: string | null
): MessageKey {
  if (preparedUpdate.kind === "store-migration") {
    return "settings.about.storeMigrationOpening";
  }
  return platform === "win32"
    ? "settings.about.windowsBackgroundInstallStarted"
    : "settings.about.backgroundInstallStarted";
}

async function waitForUpdateInstallMessagePaint(platform: string | null): Promise<void> {
  if (platform !== "win32" || typeof window === "undefined") {
    return;
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function resolveUpdateInstallResultMessageKey(
  result: DesktopUpdateInstallResult,
  platform: string | null
): MessageKey {
  if (result.preparedUpdate.kind === "store-migration") {
    return "settings.about.storeMigrationOpened";
  }
  if (result.background) {
    return resolveUpdateInstallStartedMessageKey(result.preparedUpdate, platform);
  }
  return result.willQuit ? "settings.about.installerOpenedQuit" : "settings.about.installerOpened";
}

function isForceUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.force === true || update.updateMode === "force";
}

function canDownloadUpdate(update: DesktopUpdateCheckResult): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.memmy;
  return bridge?.downloadUpdate ? Boolean(update.offerToken) : Boolean(update.downloadUrl);
}

function isVersionlessMicrosoftStoreUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.provider === "microsoft-store" && !update.latestVersion;
}

function isWindowsStoreMigration(update: DesktopUpdateCheckResult): boolean {
  return update.provider === "store-migration";
}

function resolveAvailableUpdateFeedback(update: DesktopUpdateCheckResult): UpdateFeedback {
  if (isVersionlessMicrosoftStoreUpdate(update)) {
    return {
      key: isForceUpdate(update)
        ? "settings.about.storeForceUpdateReady"
        : "settings.about.storeUpdateReady"
    };
  }
  const version = update.latestVersion ?? update.currentVersion;
  return {
    key: isForceUpdate(update) ? "settings.about.forceUpdateReady" : "settings.about.updateReady",
    values: { version }
  };
}

function resolveDownloadingUpdateFeedback(update: DesktopUpdateCheckResult): UpdateFeedback {
  if (isVersionlessMicrosoftStoreUpdate(update)) {
    return { key: "settings.about.storeUpdateDownloading" };
  }
  return {
    key: "settings.about.downloadingUpdate",
    values: { version: update.latestVersion ?? update.currentVersion }
  };
}

function resolvePreparedUpdateFeedback(update: DesktopUpdateCheckResult): UpdateFeedback {
  if (isWindowsStoreMigration(update)) {
    return { key: "settings.about.storeMigrationReady" };
  }
  if (isVersionlessMicrosoftStoreUpdate(update)) {
    return { key: "settings.about.storeUpdatePrepared" };
  }
  return {
    key: "settings.about.silentReady",
    values: { version: update.latestVersion ?? update.currentVersion }
  };
}

function validatePreparedUpdateHandle(value: DesktopPreparedUpdateHandle): DesktopPreparedUpdateHandle {
  if (value.kind === "installer-file") {
    if (!value.filePath.trim()) {
      throw new Error("downloaded update path is empty");
    }
    return value;
  }
  if (value.kind === "microsoft-store") {
    if (!value.baselinePackageVersion.trim() || !value.baselinePackageFullName.trim()) {
      throw new Error("Microsoft Store prepared update identity is incomplete");
    }
    return value;
  }
  if (value.kind === "store-migration") {
    if (!value.offerToken.trim()) {
      throw new Error("Microsoft Store migration handle is incomplete");
    }
    return value;
  }
  throw new Error("unknown prepared update provider");
}

function resolveUpdateNotificationKey(update: DesktopUpdateCheckResult): string | undefined {
  if (update.latestVersion) {
    return update.latestVersion;
  }
  if (update.provider !== "microsoft-store") {
    return update.provider === "store-migration" && update.preparedUpdate?.kind === "store-migration"
      ? `store-migration:${update.currentVersion}`
      : undefined;
  }
  return update.windowsStore?.baselinePackageFullName || `microsoft-store:${update.currentVersion}`;
}
