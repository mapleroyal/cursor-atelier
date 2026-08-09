const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000]);

function isSatisfied(desired, status) {
  return desired
    ? status === "enabled" || status === "requires-approval"
    : status === "not-registered" || status === "not-found";
}

export function createMainLoginItemReconciler({
  available,
  setLoginItemSettings,
  getLoginItemSettings,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onUnsatisfied = () => {},
  onError = () => {},
} = {}) {
  if (typeof available !== "boolean") {
    throw new TypeError("Login item availability is required.");
  }
  if (
    typeof setLoginItemSettings !== "function" ||
    typeof getLoginItemSettings !== "function"
  ) {
    throw new TypeError("Login item settings handlers are required.");
  }
  if (
    !Array.isArray(retryDelaysMs) ||
    retryDelaysMs.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 60_000,
    )
  ) {
    throw new TypeError("Login item retry delays are invalid.");
  }

  let stopped = false;
  let retryTimer = null;
  let retryIndex = 0;
  let currentDesired = null;
  let lastSatisfiedDesired = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const report = (callback, ...args) => {
    try {
      callback(...args);
    } catch (error) {
      console.error("Login item reconciliation reporter failed.", error);
    }
  };

  const scheduleRetry = () => {
    clearRetry();
    if (
      stopped ||
      !available ||
      currentDesired === null ||
      retryIndex >= retryDelaysMs.length
    ) {
      return;
    }
    const desired = currentDesired;
    const attempt = retryIndex + 1;
    const delay = retryDelaysMs[retryIndex];
    retryIndex += 1;
    const scheduledTimer = setTimer(() => {
      if (retryTimer !== scheduledTimer) {
        return;
      }
      retryTimer = null;
      if (!stopped && currentDesired === desired) {
        attemptSync(desired, attempt);
      }
    }, delay);
    retryTimer = scheduledTimer;
    scheduledTimer?.unref?.();
  };

  const attemptSync = (desired, attempt = 0) => {
    try {
      setLoginItemSettings({ openAtLogin: desired, type: "mainAppService" });
      const status = getLoginItemSettings({ type: "mainAppService" })?.status;
      if (isSatisfied(desired, status)) {
        lastSatisfiedDesired = desired;
        retryIndex = 0;
        clearRetry();
        if (desired && status === "requires-approval") {
          report(onUnsatisfied, { desired, status, attempt, satisfied: true });
        }
        return { desired, status, satisfied: true };
      }
      lastSatisfiedDesired = null;
      report(onUnsatisfied, { desired, status, attempt });
      scheduleRetry();
      return { desired, status, satisfied: false };
    } catch (error) {
      lastSatisfiedDesired = null;
      report(onError, error, { desired, attempt });
      scheduleRetry();
      return { desired, status: null, satisfied: false, error };
    }
  };

  return {
    sync(desired) {
      if (typeof desired !== "boolean") {
        throw new TypeError("A desired login item state is required.");
      }
      if (!available || stopped) {
        return { desired, skipped: true, satisfied: !available };
      }
      if (currentDesired !== desired) {
        currentDesired = desired;
        retryIndex = 0;
        clearRetry();
      }
      if (lastSatisfiedDesired === desired) {
        return { desired, skipped: true, satisfied: true };
      }
      retryIndex = 0;
      clearRetry();
      return attemptSync(desired);
    },
    stop() {
      stopped = true;
      clearRetry();
    },
  };
}
