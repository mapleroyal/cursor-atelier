import {
  CURSOR_APPEARANCES,
  chooseRandomCursor,
  cursorMatchesIdentifier,
  getCursorPreferenceId,
  getNextRandomizationDate,
  resolveRandomCursorPool,
} from "../lib/cursor-preferences.js";

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const MIN_TIMER_DELAY_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

function currentCursorIdentifier(status) {
  if (
    !status ||
    typeof status !== "object" ||
    status.effectiveApplied !== true ||
    status.currentSentinelsMatchTheme !== true
  ) {
    return null;
  }

  return status.effectiveNativeThemeId ?? status.effectiveVariantId ?? null;
}

function isCurrentCursorActive(status, cursor) {
  const identifier = currentCursorIdentifier(status);
  return Boolean(
    identifier &&
    cursorMatchesIdentifier(cursor, identifier) &&
    status?.effectiveApplied === true &&
    status?.currentSentinelsMatchTheme === true,
  );
}

function cursorSummary(cursor) {
  return {
    id: cursor?.id ?? null,
    nativeThemeId: cursor?.nativeThemeId ?? null,
    name: cursor?.name ?? cursor?.displayName ?? null,
    variant: cursor?.variant ?? null,
    family: cursor?.family ?? null,
  };
}

function appearanceForNativeTheme(nativeTheme) {
  return nativeTheme?.shouldUseDarkColors ? "dark" : "light";
}

function automaticAppearancePreferences(preferences) {
  return {
    automaticSwitching: preferences?.appearance?.automaticSwitching === true,
    lightCursorId: preferences?.appearance?.lightCursorId ?? null,
    darkCursorId: preferences?.appearance?.darkCursorId ?? null,
  };
}

function plainError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireVerifiedApplication(status, cursor) {
  if (!isCurrentCursorActive(status, cursor)) {
    throw plainError(
      "The cursor change could not be verified.",
      "CURSOR_APPLY_UNVERIFIED",
    );
  }
  return status;
}

export function createCursorAutomation({
  bridge,
  preferencesStore,
  nativeTheme,
  random = Math.random,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  onCursorChanged = () => {},
  onError = () => {},
} = {}) {
  if (
    !bridge ||
    typeof bridge.listThemes !== "function" ||
    typeof bridge.status !== "function" ||
    typeof bridge.applyTheme !== "function"
  ) {
    throw new TypeError("A complete cursor bridge is required.");
  }
  if (
    !preferencesStore ||
    typeof preferencesStore.get !== "function" ||
    typeof preferencesStore.update !== "function" ||
    typeof preferencesStore.subscribe !== "function"
  ) {
    throw new TypeError("A cursor preferences store is required.");
  }

  let started = false;
  let timer = null;
  let nextRunAt = null;
  let retryAt = null;
  let unsubscribePreferences = null;
  let observedPreferences = preferencesStore.get();
  let lastAppearance = null;
  let operationQueue = Promise.resolve();

  const getNow = () => {
    const value = new Date(now());
    return Number.isFinite(value.getTime()) ? value : new Date();
  };

  const getSystemAppearance = () => appearanceForNativeTheme(nativeTheme);

  const reportError = (error, reason) => {
    try {
      onError(error, { reason });
    } catch (callbackError) {
      console.error("Cursor automation error callback failed.", callbackError);
    }
  };

  const enqueue = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  };

  const clearScheduledTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const notifyCursorChanged = (cursor, status, reason) => {
    try {
      onCursorChanged({
        reason,
        cursor: cursorSummary(cursor),
        status,
        changedAt: getNow().toISOString(),
      });
    } catch (error) {
      console.error("Cursor change callback failed.", error);
    }
  };

  const authoritativeThemes = async () => {
    const themes = await bridge.listThemes();
    if (!Array.isArray(themes)) {
      throw plainError(
        "The native cursor catalogue is unavailable.",
        "CURSOR_CATALOGUE_UNAVAILABLE",
      );
    }
    return themes;
  };

  const applyRandomCursor = async (reason) => {
    const preferences = preferencesStore.get();
    const themes = await authoritativeThemes();
    const status = await bridge.status();
    const appearance = getSystemAppearance();
    const pool = resolveRandomCursorPool(themes, preferences, appearance);
    const cursor = chooseRandomCursor(
      pool,
      currentCursorIdentifier(status),
      random,
    );
    if (!cursor) {
      throw plainError(
        "No available cursors match the randomization settings.",
        "EMPTY_CURSOR_POOL",
      );
    }

    const identifier = getCursorPreferenceId(cursor);
    if (!identifier) {
      throw plainError(
        "The selected random cursor has no valid identifier.",
        "INVALID_CURSOR_IDENTIFIER",
      );
    }

    const nextStatus = requireVerifiedApplication(
      await bridge.applyTheme(identifier),
      cursor,
    );
    preferencesStore.update({
      appearance: {
        [`${appearance}CursorId`]: identifier,
      },
      randomization: { lastRunAt: getNow().toISOString() },
    });
    retryAt = null;
    notifyCursorChanged(cursor, nextStatus, reason);
    return { cursor: cursorSummary(cursor), status: nextStatus };
  };

  const syncAppearance = async (reason, { force = false } = {}) => {
    const appearance = getSystemAppearance();
    const appearanceChanged = appearance !== lastAppearance;
    lastAppearance = appearance;
    if (!force && !appearanceChanged) {
      return null;
    }

    const preferences = preferencesStore.get();
    if (preferences.appearance.automaticSwitching !== true) {
      return null;
    }
    const targetIdentifier =
      appearance === "dark"
        ? preferences.appearance.darkCursorId
        : preferences.appearance.lightCursorId;
    if (!targetIdentifier) {
      return null;
    }

    const themes = await authoritativeThemes();
    const cursor = themes.find(
      (theme) =>
        theme?.canApply === true &&
        cursorMatchesIdentifier(theme, targetIdentifier),
    );
    if (!cursor) {
      throw plainError(
        `The ${appearance} appearance cursor is unavailable.`,
        "APPEARANCE_CURSOR_UNAVAILABLE",
      );
    }

    const status = await bridge.status();
    if (isCurrentCursorActive(status, cursor)) {
      return { cursor: cursorSummary(cursor), status };
    }

    const latestPreferences = preferencesStore.get();
    const latestAppearance = getSystemAppearance();
    const latestTargetIdentifier =
      latestAppearance === "dark"
        ? latestPreferences.appearance.darkCursorId
        : latestPreferences.appearance.lightCursorId;
    if (
      latestPreferences.appearance.automaticSwitching !== true ||
      latestAppearance !== appearance ||
      latestTargetIdentifier !== targetIdentifier
    ) {
      return null;
    }

    const identifier = getCursorPreferenceId(cursor);
    const nextStatus = requireVerifiedApplication(
      await bridge.applyTheme(identifier),
      cursor,
    );
    notifyCursorChanged(cursor, nextStatus, reason);
    return { cursor: cursorSummary(cursor), status: nextStatus };
  };

  const scheduleNext = () => {
    clearScheduledTimer();
    nextRunAt = null;
    if (!started) {
      return;
    }

    const current = getNow();
    const scheduled = getNextRandomizationDate(preferencesStore.get(), current);
    if (!scheduled && !retryAt) {
      return;
    }

    nextRunAt =
      retryAt && retryAt > current
        ? new Date(retryAt)
        : scheduled
          ? new Date(scheduled)
          : null;
    if (!nextRunAt || !Number.isFinite(nextRunAt.getTime())) {
      nextRunAt = null;
      return;
    }

    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(MIN_TIMER_DELAY_MS, nextRunAt.getTime() - current.getTime()),
    );
    timer = setTimer(() => {
      timer = null;
      void enqueue(runScheduledIfDue);
    }, delay);
  };

  const handleAutomaticFailure = (error, reason) => {
    retryAt = new Date(getNow().getTime() + Math.max(retryDelayMs, 1_000));
    reportError(error, reason);
  };

  async function runScheduledIfDue() {
    if (!started) {
      return null;
    }

    const preferences = preferencesStore.get();
    const mode = preferences.randomization.schedule.mode;
    if (!nextRunAt || nextRunAt > getNow()) {
      scheduleNext();
      return null;
    }
    if (!retryAt && !["interval", "daily", "times"].includes(mode)) {
      scheduleNext();
      return null;
    }

    const reason = retryAt ? `retry:${mode}` : `schedule:${mode}`;
    try {
      const result = await applyRandomCursor(reason);
      retryAt = null;
      return result;
    } catch (error) {
      handleAutomaticFailure(error, reason);
      return null;
    } finally {
      scheduleNext();
    }
  }

  const preferencesChanged = (preferences) => {
    const appearanceChanged =
      JSON.stringify(automaticAppearancePreferences(preferences)) !==
      JSON.stringify(automaticAppearancePreferences(observedPreferences));
    observedPreferences = preferences;
    retryAt = null;
    clearScheduledTimer();
    void enqueue(async () => {
      if (appearanceChanged) {
        try {
          await syncAppearance("preferences", { force: true });
        } catch (error) {
          reportError(error, "preferences");
        }
      }
      scheduleNext();
    });
  };

  return {
    start({ runLaunch = true } = {}) {
      if (started) {
        return operationQueue;
      }

      started = true;
      observedPreferences = preferencesStore.get();
      unsubscribePreferences = preferencesStore.subscribe(preferencesChanged);
      return enqueue(async () => {
        try {
          await syncAppearance("startup", { force: true });
        } catch (error) {
          reportError(error, "startup-appearance");
        }

        if (
          runLaunch &&
          preferencesStore.get().randomization.schedule.mode === "launch"
        ) {
          try {
            await applyRandomCursor("schedule:launch");
          } catch (error) {
            reportError(error, "schedule:launch");
          }
        }
        scheduleNext();
      });
    },
    stop() {
      started = false;
      clearScheduledTimer();
      nextRunAt = null;
      retryAt = null;
      unsubscribePreferences?.();
      unsubscribePreferences = null;
    },
    randomize(reason = "manual") {
      return enqueue(async () => {
        try {
          return await applyRandomCursor(reason);
        } finally {
          scheduleNext();
        }
      });
    },
    setAppearanceCursor(appearance, identifier) {
      return enqueue(async () => {
        if (!CURSOR_APPEARANCES.includes(appearance)) {
          throw new TypeError("A valid system appearance is required.");
        }
        if (identifier === null) {
          const preferences = preferencesStore.update({
            appearance: { [`${appearance}CursorId`]: null },
          });
          return { cursor: null, preferences, status: null };
        }
        if (typeof identifier !== "string" || !identifier.trim()) {
          throw new TypeError("A valid cursor identifier is required.");
        }

        const themes = await authoritativeThemes();
        const cursor = themes.find(
          (theme) =>
            theme?.canApply === true &&
            cursorMatchesIdentifier(theme, identifier),
        );
        if (!cursor) {
          throw plainError(
            "That cursor is unavailable.",
            "APPEARANCE_CURSOR_UNAVAILABLE",
          );
        }

        const preferencePatch = {
          appearance: {
            [`${appearance}CursorId`]: getCursorPreferenceId(cursor),
          },
        };
        if (getSystemAppearance() !== appearance) {
          const preferences = preferencesStore.update(preferencePatch);
          return { cursor: cursorSummary(cursor), preferences, status: null };
        }

        const status = await bridge.status();
        if (isCurrentCursorActive(status, cursor)) {
          const preferences = preferencesStore.update(preferencePatch);
          return { cursor: cursorSummary(cursor), preferences, status };
        }

        const nextStatus = requireVerifiedApplication(
          await bridge.applyTheme(getCursorPreferenceId(cursor)),
          cursor,
        );
        const preferences = preferencesStore.update(preferencePatch);
        notifyCursorChanged(cursor, nextStatus, `assign:${appearance}`);
        return {
          cursor: cursorSummary(cursor),
          preferences,
          status: nextStatus,
        };
      });
    },
    appearanceChanged() {
      return enqueue(async () => {
        try {
          return await syncAppearance("appearance");
        } catch (error) {
          reportError(error, "appearance");
          return null;
        }
      });
    },
    wake() {
      return enqueue(async () => {
        try {
          await syncAppearance("wake", { force: true });
        } catch (error) {
          reportError(error, "wake-appearance");
        }
        return runScheduledIfDue();
      });
    },
    reschedule() {
      return enqueue(() => scheduleNext());
    },
    getNextRunAt() {
      return nextRunAt ? new Date(nextRunAt) : null;
    },
  };
}
