export const GET_APP_APPEARANCE_MODE_CHANNEL = "app:get-appearance-mode";
export const SET_APP_APPEARANCE_MODE_CHANNEL = "app:set-appearance-mode";
export const GET_SYSTEM_APPEARANCE_CHANNEL = "app:get-system-appearance";

function reportBestEffortError(error, context, reporter) {
  try {
    reporter(error, context);
  } catch (reportingError) {
    console.error("App appearance error reporter failed.", reportingError);
  }
}

function notifyAppearanceChanged(mode, sender, callback, reporter) {
  try {
    const result = callback(mode, sender);
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch((error) =>
        reportBestEffortError(
          error,
          { operation: "appearance-changed", mode },
          reporter,
        ),
      );
    }
  } catch (error) {
    reportBestEffortError(
      error,
      { operation: "appearance-changed", mode },
      reporter,
    );
  }
}

export function syncWindowBackgroundColors({
  windows,
  backgroundColor,
  onWindowError = (error) =>
    console.error("Could not update a window background.", error),
} = {}) {
  for (const window of windows) {
    try {
      if (!window.isDestroyed()) {
        window.setBackgroundColor(backgroundColor);
      }
    } catch (error) {
      reportBestEffortError(
        error,
        { operation: "window-background", window, backgroundColor },
        onWindowError,
      );
    }
  }
}

export function registerAppAppearanceIpc({
  ipcMain,
  preferencesStore,
  nativeTheme,
  isTrustedSender,
  getSystemAppearance,
  assertMutationAvailable = () => {},
  onAppearanceChanged = () => {},
  onAppearanceChangeError = (error) =>
    console.error("Could not refresh the app appearance.", error),
} = {}) {
  if (
    !ipcMain ||
    typeof ipcMain.on !== "function" ||
    typeof ipcMain.handle !== "function"
  ) {
    throw new TypeError("Electron IPC is required for app appearance.");
  }
  if (
    !preferencesStore ||
    typeof preferencesStore.getAppAppearanceMode !== "function" ||
    typeof preferencesStore.setAppAppearanceMode !== "function"
  ) {
    throw new TypeError("An app appearance preferences store is required.");
  }
  if (!nativeTheme || !("themeSource" in nativeTheme)) {
    throw new TypeError("Electron nativeTheme is required for app appearance.");
  }
  if (typeof isTrustedSender !== "function") {
    throw new TypeError("A trusted IPC sender predicate is required.");
  }
  if (typeof getSystemAppearance !== "function") {
    throw new TypeError("A desktop appearance reader is required.");
  }

  const getAppearanceMode = (event) => {
    event.returnValue = isTrustedSender(event)
      ? preferencesStore.getAppAppearanceMode()
      : "system";
  };
  const getDesktopAppearance = (event) => {
    event.returnValue = isTrustedSender(event) ? getSystemAppearance() : null;
  };
  const setAppearanceMode = (event, mode) => {
    if (!isTrustedSender(event)) {
      throw new Error("App appearance IPC is unavailable to this page.");
    }
    assertMutationAvailable();

    const previousPersistedMode = preferencesStore.getAppAppearanceMode();
    const previousNativeMode = nativeTheme.themeSource;
    const canonicalMode = preferencesStore.setAppAppearanceMode(mode);
    try {
      nativeTheme.themeSource = canonicalMode;
    } catch (assignmentError) {
      const rollbackErrors = [];
      try {
        nativeTheme.themeSource = previousNativeMode;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        preferencesStore.setAppAppearanceMode(previousPersistedMode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }

      if (rollbackErrors.length) {
        const error = new AggregateError(
          [assignmentError, ...rollbackErrors],
          "The app appearance could not be applied or fully restored.",
          { cause: assignmentError },
        );
        error.code = "APP_APPEARANCE_ROLLBACK_FAILED";
        error.rollbackErrors = rollbackErrors;
        throw error;
      }
      throw assignmentError;
    }

    notifyAppearanceChanged(
      canonicalMode,
      event.sender,
      onAppearanceChanged,
      onAppearanceChangeError,
    );
    return canonicalMode;
  };

  ipcMain.on(GET_APP_APPEARANCE_MODE_CHANNEL, getAppearanceMode);
  ipcMain.on(GET_SYSTEM_APPEARANCE_CHANNEL, getDesktopAppearance);
  ipcMain.handle(SET_APP_APPEARANCE_MODE_CHANNEL, setAppearanceMode);

  return () => {
    ipcMain.removeListener?.(
      GET_APP_APPEARANCE_MODE_CHANNEL,
      getAppearanceMode,
    );
    ipcMain.removeHandler?.(SET_APP_APPEARANCE_MODE_CHANNEL);
    ipcMain.removeListener?.(
      GET_SYSTEM_APPEARANCE_CHANNEL,
      getDesktopAppearance,
    );
  };
}
