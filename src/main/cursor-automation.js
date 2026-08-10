import {
  CURSOR_APPEARANCES,
  chooseRandomCursor,
  cursorMatchesIdentifier,
  getCursorPreferenceId,
  getNextRandomizationDate,
  resolveRandomCursorPool,
} from "../lib/cursor-preferences.js";
import { isVerifiedRestoredStatus } from "./cursor-state-service.js";

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const MIN_TIMER_DELAY_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_APPEARANCE_RETRY_ATTEMPTS = 3;

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

function automaticAppearancePreferences(preferences) {
  return {
    automaticSwitching: preferences?.appearance?.automaticSwitching === true,
    lightCursorId: preferences?.appearance?.lightCursorId ?? null,
    darkCursorId: preferences?.appearance?.darkCursorId ?? null,
  };
}

function automaticRandomizationPreferences(preferences) {
  const randomization = preferences?.randomization ?? {};
  const schedule = randomization.schedule ?? {};
  const scheduleConfiguration = { mode: schedule.mode ?? null };
  if (schedule.mode === "interval") {
    scheduleConfiguration.intervalHours = schedule.intervalHours ?? null;
  } else if (schedule.mode === "daily") {
    scheduleConfiguration.dailyTime = schedule.dailyTime ?? null;
  } else if (schedule.mode === "times") {
    scheduleConfiguration.times = schedule.times ?? null;
  }
  return {
    automaticEnabled: randomization.automaticEnabled === true,
    source: randomization.source ?? null,
    sourceSelection:
      randomization.source === "favorites"
        ? (preferences?.favorites ?? null)
        : randomization.source === "family"
          ? (randomization.family ?? null)
          : null,
    pools: randomization.pools ?? null,
    schedule: scheduleConfiguration,
  };
}

function plainError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isStaleApplyResult(status) {
  return status?.applySkipped === true && status?.reason === "stale-request";
}

function activeNativeRecovery(status) {
  const selectedIdentifier = status?.selectedNativeThemeId ?? null;
  const effectiveIdentifier = status?.effectiveNativeThemeId;
  if (
    !status ||
    typeof status !== "object" ||
    status.bridgeAvailable !== true ||
    status.supported !== true ||
    status.previewMode === true ||
    status.statusAvailable !== true ||
    status.stateDrifted !== false ||
    status.transactionPending !== false ||
    status.desiredEnabled !== true ||
    status.persistedEffectiveApplied !== true ||
    status.effectiveApplied !== true ||
    status.currentSentinelsMatchTheme !== true ||
    typeof effectiveIdentifier !== "string" ||
    !effectiveIdentifier.trim() ||
    (selectedIdentifier !== null &&
      (typeof selectedIdentifier !== "string" || !selectedIdentifier.trim())) ||
    typeof status.launchAtLoginDesired !== "boolean" ||
    typeof status.loginItemRegistrationCurrent !== "boolean"
  ) {
    return null;
  }
  return {
    previousSelectedIdentifier: selectedIdentifier,
    previousEffectiveIdentifier: effectiveIdentifier,
    previousCursorWasLive: true,
    previousDesiredEnabled: true,
    previousLaunchAtLoginDesired: status.launchAtLoginDesired,
    previousLoginItemRegistrationCurrent: status.loginItemRegistrationCurrent,
    previousTransactionPending: false,
    teardownPlanned: true,
    teardownCurrent: true,
  };
}

function recoveredNativeStateMatches(recovery, status) {
  const recovered = activeNativeRecovery(status);
  const identifiersMatch = (left, right) =>
    String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
  return Boolean(
    recovered &&
    identifiersMatch(
      recovered.previousSelectedIdentifier,
      recovery.previousSelectedIdentifier,
    ) &&
    identifiersMatch(
      recovered.previousEffectiveIdentifier,
      recovery.previousEffectiveIdentifier,
    ) &&
    recovered.previousLaunchAtLoginDesired ===
      recovery.previousLaunchAtLoginDesired &&
    (recovery.previousLaunchAtLoginDesired
      ? status.loginItemRegistrationCurrent === true ||
        status.loginApprovalRequired === true
      : recovered.previousLoginItemRegistrationCurrent ===
        recovery.previousLoginItemRegistrationCurrent),
  );
}

function requireVerifiedApplication(status, cursor) {
  if (!isCurrentCursorActive(status, cursor)) {
    const error = plainError(
      "The cursor change could not be verified.",
      "CURSOR_APPLY_UNVERIFIED",
    );
    error.status = status;
    throw error;
  }
  return status;
}

export function createCursorAutomation({
  bridge,
  preferencesStore,
  getSystemAppearance,
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
    typeof bridge.applyTheme !== "function" ||
    typeof bridge.restore !== "function" ||
    typeof bridge.recoverNativeState !== "function"
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
  if (typeof getSystemAppearance !== "function") {
    throw new TypeError("A system appearance reader is required.");
  }

  let started = false;
  let suspended = false;
  let timer = null;
  let appearanceRetryTimer = null;
  let appearanceRetryAttempts = 0;
  let appearanceRetryIncident = null;
  let nextRunAt = null;
  let retryAt = null;
  let unsubscribePreferences = null;
  let observedPreferences = preferencesStore.get();
  let lastAppearance = null;
  let operationQueue = Promise.resolve();
  let scheduleGeneration = 0;
  let randomizationActivatedAt = null;

  const getNow = () => {
    const value = new Date(now());
    return Number.isFinite(value.getTime()) ? value : new Date();
  };

  const readSystemAppearance = () => {
    const appearance = getSystemAppearance();
    if (!CURSOR_APPEARANCES.includes(appearance)) {
      throw new TypeError("The system appearance must be light or dark.");
    }
    return appearance;
  };

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

  const suspendedOperation = () => {
    const error = plainError(
      "Cursor operations are paused while app data is changing.",
      "CURSOR_OPERATIONS_PAUSED",
    );
    return Promise.reject(error);
  };

  const clearScheduledTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const clearAppearanceRetryTimer = () => {
    if (appearanceRetryTimer !== null) {
      clearTimer(appearanceRetryTimer);
      appearanceRetryTimer = null;
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

  const recoverVerifiedUnverifiedApplication = async (error, cursor) => {
    if (error?.code !== "CURSOR_APPLY_UNVERIFIED") {
      return null;
    }
    try {
      const refreshedStatus = await bridge.status();
      return isCurrentCursorActive(refreshedStatus, cursor)
        ? refreshedStatus
        : null;
    } catch {
      return null;
    }
  };

  const failAfterPreferenceRollback = async ({
    error,
    rollbackPatch,
    rollbackCode,
    rollbackMessage,
    cursor,
    reason,
    rollbackPatchForCurrent = () => rollbackPatch,
  }) => {
    let rollbackError = null;
    try {
      const currentRollbackPatch = rollbackPatchForCurrent();
      if (currentRollbackPatch) {
        preferencesStore.update(currentRollbackPatch);
      }
    } catch (failure) {
      rollbackError = failure;
    }

    let truthfulStatus = error?.status ?? null;
    try {
      truthfulStatus = await bridge.status();
    } catch {
      // A status captured from a failed verification is still preferable to
      // inventing state when the follow-up status read is unavailable.
    }

    if (truthfulStatus && typeof truthfulStatus === "object") {
      notifyCursorChanged(
        isCurrentCursorActive(truthfulStatus, cursor) ? cursor : null,
        truthfulStatus,
        `${reason}:compensated`,
      );
    }

    if (rollbackError) {
      const aggregate = new AggregateError(
        [error, rollbackError],
        rollbackMessage,
      );
      aggregate.code = rollbackCode;
      aggregate.status = truthfulStatus;
      throw aggregate;
    }

    if (
      truthfulStatus &&
      error &&
      (typeof error === "object" || typeof error === "function")
    ) {
      error.status = truthfulStatus;
    }
    throw error;
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

  const compensateStaleApplication = async (previousStatus, reason) => {
    const recovery = activeNativeRecovery(previousStatus);
    let previousCursor = null;
    let compensatedStatus;

    if (recovery) {
      previousCursor = {
        nativeThemeId: recovery.previousEffectiveIdentifier,
      };
      compensatedStatus = await bridge.recoverNativeState(recovery);
      if (!recoveredNativeStateMatches(recovery, compensatedStatus)) {
        const error = plainError(
          "The prior native cursor state could not be verified after reverting an obsolete cursor change.",
          "CURSOR_STALE_APPLY_COMPENSATION_FAILED",
        );
        error.status = compensatedStatus;
        throw error;
      }
    } else if (isVerifiedRestoredStatus(previousStatus)) {
      try {
        compensatedStatus = await bridge.restore();
      } catch (error) {
        if (!isVerifiedRestoredStatus(error?.status)) {
          throw error;
        }
        compensatedStatus = error.status;
      }
      if (!isVerifiedRestoredStatus(compensatedStatus)) {
        const error = plainError(
          "The obsolete cursor change could not be reverted.",
          "CURSOR_STALE_APPLY_COMPENSATION_FAILED",
        );
        error.status = compensatedStatus;
        throw error;
      }
    } else {
      const error = plainError(
        "The native cursor state before the obsolete change was not safe to reconstruct.",
        "CURSOR_STALE_APPLY_PRIOR_STATE_UNVERIFIED",
      );
      error.status = previousStatus;
      throw error;
    }

    notifyCursorChanged(
      previousCursor,
      compensatedStatus,
      `${reason}:stale-compensated`,
    );
    return compensatedStatus;
  };

  const applyRandomCursor = async (
    reason,
    { expectedMode = null, expectedScheduleGeneration = null } = {},
  ) => {
    const automaticRequestIsCurrent = (preferences) =>
      expectedMode === null ||
      (started &&
        preferences.randomization.automaticEnabled === true &&
        preferences.randomization.schedule.mode === expectedMode &&
        (expectedScheduleGeneration === null ||
          expectedScheduleGeneration === scheduleGeneration));
    if (!automaticRequestIsCurrent(preferencesStore.get())) {
      return null;
    }
    const themes = await authoritativeThemes();
    const status = await bridge.status();
    const preferences = preferencesStore.get();
    if (!automaticRequestIsCurrent(preferences)) {
      return null;
    }
    const appearance = readSystemAppearance();
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

    const appearancePreference = `${appearance}CursorId`;
    const lastRunAt = getNow().toISOString();
    const rollbackPatch = {
      appearance: {
        [appearancePreference]: preferences.appearance[appearancePreference],
      },
      randomization: {
        lastRunAt: preferences.randomization.lastRunAt,
      },
    };
    preferencesStore.update({
      appearance: { [appearancePreference]: identifier },
      randomization: { lastRunAt },
    });

    const transactionIsCurrent = () => {
      const latestPreferences = preferencesStore.get();
      return (
        latestPreferences.appearance[appearancePreference] === identifier &&
        latestPreferences.randomization.lastRunAt === lastRunAt
      );
    };
    const rollbackPatchForCurrent = () => {
      const latestPreferences = preferencesStore.get();
      const currentRollbackPatch = {};
      if (latestPreferences.appearance[appearancePreference] === identifier) {
        currentRollbackPatch.appearance = rollbackPatch.appearance;
      }
      if (latestPreferences.randomization.lastRunAt === lastRunAt) {
        currentRollbackPatch.randomization = rollbackPatch.randomization;
      }
      return Object.keys(currentRollbackPatch).length
        ? currentRollbackPatch
        : null;
    };
    const rollbackStaleRandomization = () => {
      const currentRollbackPatch = rollbackPatchForCurrent();
      if (!currentRollbackPatch) {
        return;
      }
      preferencesStore.update(currentRollbackPatch);
    };
    const rollbackSkippedRandomization = () => {
      try {
        rollbackStaleRandomization();
      } catch (rollbackError) {
        const aggregate = new AggregateError(
          [rollbackError],
          "The stale cursor change could not restore its saved randomization state.",
        );
        aggregate.code = "CURSOR_RANDOMIZATION_ROLLBACK_FAILED";
        throw aggregate;
      }
    };
    const recoverStaleRandomization = async () => {
      let rollbackError = null;
      let compensationError = null;
      try {
        rollbackStaleRandomization();
      } catch (error) {
        rollbackError = error;
      }
      try {
        await compensateStaleApplication(status, reason);
      } catch (error) {
        compensationError = error;
      }
      const errors = [rollbackError, compensationError].filter(Boolean);
      if (errors.length) {
        const aggregate = new AggregateError(
          errors,
          "The obsolete cursor change could not restore all prior application state.",
        );
        aggregate.code = "CURSOR_STALE_RANDOMIZATION_RECOVERY_FAILED";
        aggregate.rollbackError = rollbackError;
        aggregate.compensationError = compensationError;
        aggregate.status = compensationError?.status ?? null;
        throw aggregate;
      }
    };
    const randomizationConfiguration = JSON.stringify(
      automaticRandomizationPreferences(preferences),
    );
    const shouldApply = () => {
      const latestPreferences = preferencesStore.get();
      return (
        transactionIsCurrent() &&
        readSystemAppearance() === appearance &&
        JSON.stringify(automaticRandomizationPreferences(latestPreferences)) ===
          randomizationConfiguration &&
        automaticRequestIsCurrent(latestPreferences)
      );
    };

    let nextStatus;
    try {
      const appliedStatus = await bridge.applyTheme(identifier, {
        shouldApply,
      });
      if (isStaleApplyResult(appliedStatus)) {
        rollbackSkippedRandomization();
        return null;
      }
      nextStatus = requireVerifiedApplication(appliedStatus, cursor);
    } catch (error) {
      if (error?.code === "CURSOR_RANDOMIZATION_ROLLBACK_FAILED") {
        throw error;
      }
      const recoveredStatus = await recoverVerifiedUnverifiedApplication(
        error,
        cursor,
      );
      if (recoveredStatus) {
        nextStatus = recoveredStatus;
      } else {
        return failAfterPreferenceRollback({
          error,
          rollbackPatch,
          rollbackCode: "CURSOR_RANDOMIZATION_ROLLBACK_FAILED",
          rollbackMessage:
            "The cursor change failed and its saved randomization state could not be restored.",
          cursor,
          reason,
          rollbackPatchForCurrent,
        });
      }
    }
    if (!shouldApply()) {
      await recoverStaleRandomization();
      return null;
    }
    retryAt = null;
    notifyCursorChanged(cursor, nextStatus, reason);
    return { cursor: cursorSummary(cursor), status: nextStatus };
  };

  const syncAppearance = async (reason, { force = false } = {}) => {
    const appearance = readSystemAppearance();
    const appearanceChanged = appearance !== lastAppearance;
    if (!force && !appearanceChanged) {
      return null;
    }

    const preferences = preferencesStore.get();
    if (preferences.appearance.automaticSwitching !== true) {
      lastAppearance = appearance;
      return null;
    }
    const targetIdentifier =
      appearance === "dark"
        ? preferences.appearance.darkCursorId
        : preferences.appearance.lightCursorId;
    if (!targetIdentifier) {
      lastAppearance = appearance;
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
      lastAppearance = appearance;
      return { cursor: cursorSummary(cursor), status };
    }

    const latestPreferences = preferencesStore.get();
    const latestAppearance = readSystemAppearance();
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
    const shouldApply = () => {
      const currentPreferences = preferencesStore.get();
      const currentAppearance = readSystemAppearance();
      const currentTargetIdentifier =
        currentAppearance === "dark"
          ? currentPreferences.appearance.darkCursorId
          : currentPreferences.appearance.lightCursorId;
      return (
        currentPreferences.appearance.automaticSwitching === true &&
        currentAppearance === appearance &&
        currentTargetIdentifier === targetIdentifier
      );
    };
    const appliedStatus = await bridge.applyTheme(identifier, {
      shouldApply,
    });
    if (isStaleApplyResult(appliedStatus)) {
      return null;
    }
    const nextStatus = requireVerifiedApplication(appliedStatus, cursor);
    if (!shouldApply()) {
      await compensateStaleApplication(status, reason);
      return null;
    }
    lastAppearance = appearance;
    notifyCursorChanged(cursor, nextStatus, reason);
    return { cursor: cursorSummary(cursor), status: nextStatus };
  };

  const scheduleAppearanceRetry = (reason) => {
    clearAppearanceRetryTimer();
    if (!started || appearanceRetryAttempts >= MAX_APPEARANCE_RETRY_ATTEMPTS) {
      return;
    }
    appearanceRetryAttempts += 1;
    appearanceRetryTimer = setTimer(
      () => {
        appearanceRetryTimer = null;
        void enqueue(() =>
          syncAppearanceWithRetry(`retry:${reason}`, { force: true }),
        );
      },
      Math.max(retryDelayMs, 1_000),
    );
  };

  const syncAppearanceWithRetry = async (
    reason,
    options,
    failureReason = reason,
  ) => {
    try {
      const preferences = preferencesStore.get();
      const appearance = readSystemAppearance();
      const incident = JSON.stringify({
        appearance,
        automaticSwitching: preferences.appearance.automaticSwitching === true,
        targetIdentifier:
          appearance === "dark"
            ? preferences.appearance.darkCursorId
            : preferences.appearance.lightCursorId,
      });
      if (incident !== appearanceRetryIncident) {
        clearAppearanceRetryTimer();
        appearanceRetryAttempts = 0;
        appearanceRetryIncident = incident;
      }
      const result = await syncAppearance(reason, options);
      clearAppearanceRetryTimer();
      appearanceRetryAttempts = 0;
      appearanceRetryIncident = null;
      return result;
    } catch (error) {
      reportError(error, failureReason);
      scheduleAppearanceRetry(failureReason);
      return null;
    }
  };

  const scheduleNext = () => {
    clearScheduledTimer();
    nextRunAt = null;
    if (!started) {
      return;
    }

    const current = getNow();
    const preferences = preferencesStore.get();
    if (preferences.randomization.automaticEnabled !== true) {
      retryAt = null;
      return;
    }
    const schedulingPreferences =
      randomizationActivatedAt &&
      preferences.randomization.schedule.mode === "interval"
        ? {
            ...preferences,
            randomization: {
              ...preferences.randomization,
              lastRunAt:
                !preferences.randomization.lastRunAt ||
                new Date(preferences.randomization.lastRunAt) <
                  randomizationActivatedAt
                  ? randomizationActivatedAt.toISOString()
                  : preferences.randomization.lastRunAt,
            },
          }
        : preferences;
    const scheduled = getNextRandomizationDate(schedulingPreferences, current);
    if (!scheduled && !retryAt) {
      return;
    }

    nextRunAt = retryAt
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
    const generation = scheduleGeneration;
    const scheduledTimer = setTimer(() => {
      if (timer === scheduledTimer) {
        timer = null;
      }
      void enqueue(() => runScheduledIfDue(generation));
    }, delay);
    timer = scheduledTimer;
  };

  const handleAutomaticFailure = (error, reason) => {
    retryAt = new Date(getNow().getTime() + Math.max(retryDelayMs, 1_000));
    reportError(error, reason);
  };

  async function runScheduledIfDue(expectedGeneration = scheduleGeneration) {
    if (!started || expectedGeneration !== scheduleGeneration) {
      return null;
    }

    const preferences = preferencesStore.get();
    const mode = preferences.randomization.schedule.mode;
    if (preferences.randomization.automaticEnabled !== true) {
      scheduleNext();
      return null;
    }
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
      const result = await applyRandomCursor(reason, {
        expectedMode: mode,
        expectedScheduleGeneration: expectedGeneration,
      });
      retryAt = null;
      return result;
    } catch (error) {
      if (expectedGeneration !== scheduleGeneration) {
        return null;
      }
      handleAutomaticFailure(error, reason);
      return null;
    } finally {
      scheduleNext();
    }
  }

  const preferencesChanged = (preferences) => {
    const wasRandomizationEnabled =
      observedPreferences.randomization.automaticEnabled === true;
    const randomizationEnabled =
      preferences.randomization.automaticEnabled === true;
    const appearanceChanged =
      JSON.stringify(automaticAppearancePreferences(preferences)) !==
      JSON.stringify(automaticAppearancePreferences(observedPreferences));
    const randomizationChanged =
      JSON.stringify(automaticRandomizationPreferences(preferences)) !==
      JSON.stringify(automaticRandomizationPreferences(observedPreferences));
    observedPreferences = preferences;
    if (randomizationChanged) {
      scheduleGeneration += 1;
      nextRunAt = null;
      retryAt = null;
    }
    if (!wasRandomizationEnabled && randomizationEnabled) {
      randomizationActivatedAt = getNow();
    } else if (!randomizationEnabled) {
      randomizationActivatedAt = null;
    }
    clearScheduledTimer();
    void enqueue(async () => {
      if (appearanceChanged) {
        await syncAppearanceWithRetry("preferences", { force: true });
      }
      scheduleNext();
    });
  };

  return {
    start({ runLaunch = true, syncAppearance = true } = {}) {
      if (started) {
        return operationQueue;
      }

      suspended = false;
      started = true;
      scheduleGeneration += 1;
      observedPreferences = preferencesStore.get();
      const launchGeneration = scheduleGeneration;
      const shouldRunLaunch =
        runLaunch &&
        observedPreferences.randomization.automaticEnabled === true &&
        observedPreferences.randomization.schedule.mode === "launch";
      unsubscribePreferences = preferencesStore.subscribe(preferencesChanged);
      return enqueue(async () => {
        if (syncAppearance) {
          await syncAppearanceWithRetry(
            "startup",
            { force: true },
            "startup-appearance",
          );
        } else {
          lastAppearance = readSystemAppearance();
        }

        if (shouldRunLaunch) {
          try {
            await applyRandomCursor("schedule:launch", {
              expectedMode: "launch",
              expectedScheduleGeneration: launchGeneration,
            });
          } catch (error) {
            reportError(error, "schedule:launch");
          }
        }
        scheduleNext();
      });
    },
    stop() {
      started = false;
      suspended = true;
      scheduleGeneration += 1;
      clearScheduledTimer();
      clearAppearanceRetryTimer();
      appearanceRetryAttempts = 0;
      appearanceRetryIncident = null;
      nextRunAt = null;
      retryAt = null;
      randomizationActivatedAt = null;
      unsubscribePreferences?.();
      unsubscribePreferences = null;
      return operationQueue;
    },
    randomize(reason = "manual") {
      if (suspended) {
        return suspendedOperation();
      }
      return enqueue(async () => {
        try {
          return await applyRandomCursor(reason);
        } finally {
          scheduleNext();
        }
      });
    },
    setAppearanceCursor(appearance, identifier) {
      if (suspended) {
        return suspendedOperation();
      }
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
        if (readSystemAppearance() !== appearance) {
          const preferences = preferencesStore.update(preferencePatch);
          return { cursor: cursorSummary(cursor), preferences, status: null };
        }

        const appearancePreference = `${appearance}CursorId`;
        const previousPreferences = preferencesStore.get();
        const rollbackPatch = {
          appearance: {
            [appearancePreference]:
              previousPreferences.appearance[appearancePreference],
          },
        };
        const preferences = preferencesStore.update(preferencePatch);
        if (readSystemAppearance() !== appearance) {
          return { cursor: cursorSummary(cursor), preferences, status: null };
        }

        let nextStatus;
        let previousStatus;
        const transactionIdentifier = getCursorPreferenceId(cursor);
        const transactionIsCurrent = () =>
          preferencesStore.get().appearance[appearancePreference] ===
          transactionIdentifier;
        const shouldApply = () =>
          readSystemAppearance() === appearance && transactionIsCurrent();
        const rollbackPatchForCurrent = () =>
          transactionIsCurrent() ? rollbackPatch : null;
        try {
          previousStatus = await bridge.status();
          if (isCurrentCursorActive(previousStatus, cursor)) {
            return {
              cursor: cursorSummary(cursor),
              preferences: preferencesStore.get(),
              status: previousStatus,
            };
          }

          const appliedStatus = await bridge.applyTheme(transactionIdentifier, {
            shouldApply,
          });
          if (isStaleApplyResult(appliedStatus)) {
            return {
              cursor: cursorSummary(cursor),
              preferences: preferencesStore.get(),
              status: null,
            };
          }
          nextStatus = requireVerifiedApplication(appliedStatus, cursor);
        } catch (error) {
          const recoveredStatus = await recoverVerifiedUnverifiedApplication(
            error,
            cursor,
          );
          if (recoveredStatus) {
            nextStatus = recoveredStatus;
          } else {
            return failAfterPreferenceRollback({
              error,
              rollbackPatch,
              rollbackCode: "APPEARANCE_ASSIGNMENT_ROLLBACK_FAILED",
              rollbackMessage:
                "The cursor assignment failed and its saved appearance preference could not be restored.",
              cursor,
              reason: `assign:${appearance}`,
              rollbackPatchForCurrent,
            });
          }
        }
        if (!shouldApply()) {
          await compensateStaleApplication(
            previousStatus,
            `assign:${appearance}`,
          );
          return {
            cursor: cursorSummary(cursor),
            preferences: preferencesStore.get(),
            status: null,
          };
        }
        notifyCursorChanged(cursor, nextStatus, `assign:${appearance}`);
        return {
          cursor: cursorSummary(cursor),
          preferences: preferencesStore.get(),
          status: nextStatus,
        };
      });
    },
    appearanceChanged() {
      if (suspended) {
        return operationQueue;
      }
      return enqueue(() => syncAppearanceWithRetry("appearance"));
    },
    wake() {
      if (suspended) {
        return operationQueue;
      }
      return enqueue(async () => {
        await syncAppearanceWithRetry(
          "wake",
          { force: true },
          "wake-appearance",
        );
        return runScheduledIfDue();
      });
    },
    reschedule() {
      if (suspended) {
        return operationQueue;
      }
      return enqueue(() => scheduleNext());
    },
    runExclusive(operation) {
      if (typeof operation !== "function") {
        throw new TypeError("A cursor operation is required.");
      }
      if (suspended) {
        return suspendedOperation();
      }
      return enqueue(() => operation());
    },
    getNextRunAt() {
      return nextRunAt ? new Date(nextRunAt) : null;
    },
  };
}
