import { getCursorPreferenceId } from "../lib/cursor-preferences.js";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000]);

function authoritativeIdentifiers(themes) {
  const identifiers = new Set();
  for (const theme of Array.isArray(themes) ? themes : []) {
    for (const identifier of [
      getCursorPreferenceId(theme),
      theme?.id,
      theme?.nativeThemeId,
      ...(Array.isArray(theme?.nativeThemeIds) ? theme.nativeThemeIds : []),
    ]) {
      if (typeof identifier === "string" && identifier.trim()) {
        identifiers.add(identifier.trim().toLowerCase());
      }
    }
  }
  return identifiers;
}

export function createAuthoritativeLibraryPreferencesPatch(
  preferences,
  themes,
) {
  const identifiers = authoritativeIdentifiers(themes);
  const families = new Set(
    (Array.isArray(themes) ? themes : [])
      .map((theme) => theme?.family)
      .filter((family) => typeof family === "string" && family),
  );
  const keepIdentifier = (identifier) =>
    !identifier || identifiers.has(identifier.toLowerCase());
  const selectedFamily = families.has(preferences.randomization.family)
    ? preferences.randomization.family
    : null;

  return {
    favorites: {
      cursorIds: preferences.favorites.cursorIds.filter(keepIdentifier),
      families: preferences.favorites.families.filter((family) =>
        families.has(family),
      ),
    },
    appearance: {
      lightCursorId: keepIdentifier(preferences.appearance.lightCursorId)
        ? preferences.appearance.lightCursorId
        : null,
      darkCursorId: keepIdentifier(preferences.appearance.darkCursorId)
        ? preferences.appearance.darkCursorId
        : null,
    },
    randomization: {
      source:
        preferences.randomization.source === "family" && !selectedFamily
          ? "all"
          : preferences.randomization.source,
      family: selectedFamily,
      pools: {
        light: preferences.randomization.pools.light.filter(keepIdentifier),
        dark: preferences.randomization.pools.dark.filter(keepIdentifier),
      },
    },
  };
}

export function createCursorLibraryPreferencesReconciler({
  bridge,
  preferencesStore,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRetryError = () => {},
} = {}) {
  if (!bridge || typeof bridge.listThemes !== "function") {
    throw new TypeError("A cursor catalogue bridge is required.");
  }
  if (
    !preferencesStore ||
    typeof preferencesStore.get !== "function" ||
    typeof preferencesStore.update !== "function"
  ) {
    throw new TypeError("A cursor preferences store is required.");
  }
  if (
    !Array.isArray(retryDelaysMs) ||
    retryDelaysMs.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 60_000,
    )
  ) {
    throw new TypeError("Cursor library retry delays are invalid.");
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
    const themes = await bridge.listThemes();
    if (!Array.isArray(themes)) {
      throw new Error(
        "The cursor catalogue is unavailable for reconciliation.",
      );
    }
    const patch = createAuthoritativeLibraryPreferencesPatch(
      preferencesStore.get(),
      themes,
    );
    return preferencesStore.update(patch);
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
              "Cursor library reconciliation error reporter failed.",
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
