function appearanceCursorRollbackPatch(previousPreferences, preferences) {
  const appearance = {};
  for (const preference of ["lightCursorId", "darkCursorId"]) {
    if (
      preferences.appearance[preference] === null &&
      previousPreferences.appearance[preference] !== null
    ) {
      appearance[preference] = previousPreferences.appearance[preference];
    }
  }
  return Object.keys(appearance).length ? { appearance } : null;
}

export function isVerifiedRestoredStatus(status) {
  if (
    !status ||
    typeof status !== "object" ||
    status.bridgeAvailable !== true ||
    status.supported !== true ||
    status.previewMode !== false ||
    status.statusAvailable !== true ||
    status.currentSentinelsMatchTheme !== false
  ) {
    return false;
  }
  return [
    "desiredEnabled",
    "persistedEffectiveApplied",
    "effectiveApplied",
    "launchAtLoginDesired",
    "loginItemRegistrationCurrent",
    "transactionPending",
  ].every((key) => status[key] === false || status[key] === 0);
}

export async function restoreCursorState({
  bridge,
  preferencesStore,
  onRestored = () => {},
  onRestoreFailed = () => {},
  onNotificationError = (error) =>
    console.error("Cursor restore notification failed.", error),
} = {}) {
  if (!bridge || typeof bridge.restore !== "function") {
    throw new TypeError("A cursor restore bridge is required.");
  }
  if (
    !preferencesStore ||
    typeof preferencesStore.get !== "function" ||
    typeof preferencesStore.update !== "function"
  ) {
    throw new TypeError("A cursor preferences store is required.");
  }

  const previousPreferences = preferencesStore.get();
  preferencesStore.update({
    appearance: { lightCursorId: null, darkCursorId: null },
  });

  let status;
  try {
    status = await bridge.restore();
    if (!isVerifiedRestoredStatus(status)) {
      const error = new Error(
        "The native cursor restore could not be verified.",
      );
      error.code = "CURSOR_RESTORE_UNVERIFIED";
      error.status = status;
      throw error;
    }
  } catch (restoreError) {
    if (isVerifiedRestoredStatus(restoreError?.status)) {
      status = restoreError.status;
    } else {
      let failure = restoreError;
      try {
        const rollbackPatch = appearanceCursorRollbackPatch(
          previousPreferences,
          preferencesStore.get(),
        );
        if (rollbackPatch) {
          preferencesStore.update(rollbackPatch);
        }
      } catch (rollbackError) {
        const error = new AggregateError(
          [restoreError, rollbackError],
          `${restoreError.message} Saved cursor assignments could not be restored after the native restore failed.`,
          { cause: restoreError },
        );
        error.code = "CURSOR_RESTORE_ROLLBACK_FAILED";
        error.rollbackError = rollbackError;
        error.status = restoreError?.status ?? null;
        failure = error;
      }
      if (failure?.status && typeof failure.status === "object") {
        try {
          onRestoreFailed(failure.status);
        } catch (notificationError) {
          try {
            onNotificationError(notificationError);
          } catch (reportingError) {
            console.error(
              "Cursor restore failure notification reporter failed.",
              reportingError,
            );
          }
        }
      }
      throw failure;
    }
  }

  try {
    onRestored(status);
  } catch (notificationError) {
    try {
      onNotificationError(notificationError);
    } catch (reportingError) {
      console.error(
        "Cursor restore notification error reporter failed.",
        reportingError,
      );
    }
  }
  return { status, preferences: preferencesStore.get() };
}
