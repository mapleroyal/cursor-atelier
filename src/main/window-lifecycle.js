export function shouldRegisterMainAppLoginItem(preferences) {
  if (preferences?.startup?.runInBackground !== true) {
    return false;
  }
  const automaticRandomizationEnabled =
    preferences?.randomization?.automaticEnabled === true;
  return (
    preferences?.menuBar?.visible === true ||
    preferences?.appearance?.automaticSwitching === true ||
    (automaticRandomizationEnabled &&
      ["launch", "interval", "daily", "times"].includes(
        preferences?.randomization?.schedule?.mode,
      ))
  );
}

export function shouldMainAppStayRunning(preferences) {
  const automaticRandomizationEnabled =
    preferences?.randomization?.automaticEnabled === true;
  return (
    preferences?.menuBar?.visible === true ||
    preferences?.appearance?.automaticSwitching === true ||
    (automaticRandomizationEnabled &&
      ["interval", "daily", "times"].includes(
        preferences?.randomization?.schedule?.mode,
      ))
  );
}

export function createWindowLifecycle({
  isMacOS = process.platform === "darwin",
  setActivationPolicy,
  quit,
  getMenuBarVisible,
  getShouldStayRunning,
  hasVisibleWindows,
  hideWindow,
  onError = () => {},
} = {}) {
  if (isMacOS && typeof setActivationPolicy !== "function") {
    throw new TypeError("A macOS activation-policy setter is required.");
  }
  for (const [name, callback] of [
    ["quit", quit],
    ["getMenuBarVisible", getMenuBarVisible],
    ["getShouldStayRunning", getShouldStayRunning],
    ["hasVisibleWindows", hasVisibleWindows],
    ["hideWindow", hideWindow],
    ["onError", onError],
  ]) {
    if (typeof callback !== "function") {
      throw new TypeError(`A window lifecycle ${name} callback is required.`);
    }
  }

  let activationPolicy = null;
  let quitting = false;
  let quitRequested = false;

  const isStopping = () => quitting || quitRequested;

  const setPolicy = (policy) => {
    if (!isMacOS || isStopping() || activationPolicy === policy) {
      return;
    }
    try {
      setActivationPolicy(policy);
      activationPolicy = policy;
    } catch (error) {
      onError(error, { policy });
    }
  };

  const requestQuit = () => {
    if (isStopping()) {
      return false;
    }
    quitRequested = true;
    quit();
    return true;
  };

  return {
    prepareToShowWindow() {
      if (isStopping()) {
        return false;
      }
      setPolicy("regular");
      return true;
    },
    enterBackground() {
      if (isStopping()) {
        return false;
      }
      setPolicy("accessory");
      return true;
    },
    handleWindowClose(event, window) {
      if (isStopping() || hasVisibleWindows(window)) {
        return "close";
      }

      if (getMenuBarVisible() === true) {
        event.preventDefault();
        hideWindow(window);
        setPolicy("accessory");
        return "hide";
      }

      if (getShouldStayRunning() === true) {
        setPolicy("accessory");
        return "close-background";
      }

      return "close";
    },
    handleBackgroundPreferenceChanged(shouldStayRunning) {
      if (isStopping() || shouldStayRunning !== false || hasVisibleWindows()) {
        return "stay";
      }
      return requestQuit() ? "quit" : "stay";
    },
    handleAllWindowsClosed() {
      if (!isStopping() && getShouldStayRunning() === true) {
        setPolicy("accessory");
        return "stay";
      }
      return requestQuit() ? "quit" : "stay";
    },
    beginQuit() {
      quitting = true;
    },
  };
}
