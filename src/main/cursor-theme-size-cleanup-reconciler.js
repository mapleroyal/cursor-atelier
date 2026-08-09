const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000]);

function cleanupPendingError(identifiers) {
  const error = new Error(
    "Some deleted cursor size preferences still require cleanup.",
  );
  error.code = "THEME_SIZE_CLEANUP_PENDING";
  error.identifiers = identifiers;
  return error;
}

export function createCursorThemeSizeCleanupReconciler({
  bridge,
  preferencesStore,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRetryError = () => {},
} = {}) {
  if (!bridge || typeof bridge.forgetThemeSizes !== "function") {
    throw new TypeError("A native cursor cleanup bridge is required.");
  }
  if (
    !preferencesStore ||
    typeof preferencesStore.getPendingThemeSizeCleanupIds !== "function" ||
    typeof preferencesStore.setPendingThemeSizeCleanupIds !== "function"
  ) {
    throw new TypeError("A persistent cursor cleanup store is required.");
  }
  if (
    !Array.isArray(retryDelaysMs) ||
    retryDelaysMs.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 60_000,
    )
  ) {
    throw new TypeError("Cursor cleanup retry delays are invalid.");
  }

  let stopped = false;
  let retryTimer = null;
  let retryIndex = 0;
  let operationQueue = Promise.resolve();

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const enqueue = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  };

  const perform = async () => {
    const identifiers = preferencesStore.getPendingThemeSizeCleanupIds();
    if (identifiers.length === 0) {
      return [];
    }
    const result = await bridge.forgetThemeSizes(identifiers);
    const failedIdentifiers = Array.isArray(result?.failedIdentifiers)
      ? result.failedIdentifiers
      : identifiers;
    const failedKeys = new Set(
      failedIdentifiers.map((identifier) => identifier.toLowerCase()),
    );
    const successfulKeys = new Set(
      identifiers
        .filter((identifier) => !failedKeys.has(identifier.toLowerCase()))
        .map((identifier) => identifier.toLowerCase()),
    );
    const remaining = preferencesStore
      .getPendingThemeSizeCleanupIds()
      .filter((identifier) => !successfulKeys.has(identifier.toLowerCase()));
    const remainingKeys = new Set(
      remaining.map((identifier) => identifier.toLowerCase()),
    );
    for (const identifier of failedIdentifiers) {
      if (!remainingKeys.has(identifier.toLowerCase())) {
        remainingKeys.add(identifier.toLowerCase());
        remaining.push(identifier);
      }
    }
    preferencesStore.setPendingThemeSizeCleanupIds(remaining);
    if (remaining.length) {
      throw cleanupPendingError(remaining);
    }
    return [];
  };

  const scheduleRetry = () => {
    clearRetry();
    if (stopped || retryIndex >= retryDelaysMs.length) {
      return;
    }
    const attempt = retryIndex + 1;
    const delay = retryDelaysMs[retryIndex];
    retryIndex += 1;
    const scheduledTimer = setTimer(() => {
      if (retryTimer !== scheduledTimer) {
        return;
      }
      retryTimer = null;
      void enqueue(perform).then(
        () => {
          retryIndex = 0;
        },
        (error) => {
          try {
            onRetryError(error, { attempt });
          } catch (reportingError) {
            console.error(
              "Cursor size cleanup error reporter failed.",
              reportingError,
            );
          }
          scheduleRetry();
        },
      );
    }, delay);
    retryTimer = scheduledTimer;
    scheduledTimer?.unref?.();
  };

  return {
    async recordPending(identifiers) {
      return enqueue(() => {
        const pending = preferencesStore.getPendingThemeSizeCleanupIds();
        const merged = [...pending];
        const seen = new Set(
          pending.map((identifier) => identifier.toLowerCase()),
        );
        let added = false;
        for (const identifier of identifiers) {
          if (!seen.has(identifier.toLowerCase())) {
            seen.add(identifier.toLowerCase());
            merged.push(identifier);
            added = true;
          }
        }
        const saved = preferencesStore.setPendingThemeSizeCleanupIds(merged);
        if (saved.length && retryTimer === null) {
          if (added) {
            retryIndex = 0;
          }
          scheduleRetry();
        }
        return saved;
      });
    },
    async reconcile() {
      clearRetry();
      retryIndex = 0;
      try {
        return await enqueue(perform);
      } catch (error) {
        scheduleRetry();
        throw error;
      }
    },
    stop() {
      stopped = true;
      clearRetry();
    },
  };
}
