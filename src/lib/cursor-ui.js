import {
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "./cursor-preferences.js";

export const MIN_CURSOR_SIZE_PERCENTAGE = 50;
export const MAX_CURSOR_SIZE_PERCENTAGE = 200;
export const DEFAULT_CURSOR_SIZE_PERCENTAGE = 100;

export function normalizeCursorSizePercentage(
  value,
  fallback = DEFAULT_CURSOR_SIZE_PERCENTAGE,
) {
  const size = Number(value);
  return Number.isInteger(size) &&
    size >= MIN_CURSOR_SIZE_PERCENTAGE &&
    size <= MAX_CURSOR_SIZE_PERCENTAGE
    ? size
    : fallback;
}

export async function readRevisionStable(revisionRef, key, readSnapshot) {
  for (;;) {
    const revision = revisionRef.current[key];
    const snapshot = await readSnapshot();
    if (revision === revisionRef.current[key]) {
      return snapshot;
    }
  }
}

export function resolveCursorPreferenceUpdate(update, preferences) {
  const patch =
    typeof update === "function"
      ? update(normalizeCursorPreferences(preferences))
      : update;
  return patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch
    : {};
}

export function applyCursorPreferenceUpdates(preferences, updates) {
  return (Array.isArray(updates) ? updates : []).reduce(
    (current, entry) =>
      mergeCursorPreferences(
        current,
        resolveCursorPreferenceUpdate(entry?.update ?? entry, current),
      ),
    normalizeCursorPreferences(preferences),
  );
}

export function getStatusVariant(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  const value = status.effectiveVariantId;
  return value === null || value === undefined ? null : String(value);
}

export function getSelectedStatusVariant(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  const value = status.selectedVariantId;
  return value === null || value === undefined ? null : String(value);
}

export function getStatusEnabled(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  return typeof status.effectiveApplied === "boolean"
    ? status.effectiveApplied
    : null;
}

export function isStatusVerifiedActive(status) {
  if (getStatusEnabled(status) !== true || !getStatusVariant(status)) {
    return false;
  }
  return Boolean(
    status?.statusAvailable === true &&
    status?.previewMode !== true &&
    status?.currentSentinelsMatchTheme === true,
  );
}

export function matchesCursorPack(pack, identifier) {
  if (!pack || !identifier) {
    return false;
  }
  const expected = String(identifier).toLowerCase();
  return [pack.id, pack.nativeThemeId, ...(pack.nativeThemeIds ?? [])].some(
    (candidate) =>
      typeof candidate === "string" && candidate.toLowerCase() === expected,
  );
}

export function resolveCursorPoolPacks(packs, identifiers) {
  if (!Array.isArray(packs) || !Array.isArray(identifiers)) {
    return [];
  }

  const seenPackIds = new Set();
  const resolved = [];
  for (const identifier of identifiers) {
    const pack = packs.find((candidate) =>
      matchesCursorPack(candidate, identifier),
    );
    if (!pack || seenPackIds.has(pack.id)) {
      continue;
    }
    seenPackIds.add(pack.id);
    resolved.push(pack);
  }
  return resolved;
}

export function getRandomizationPoolSourceLabel(preferences) {
  const { randomization } = normalizeCursorPreferences(preferences);
  if (randomization.source === "favorites") {
    return "All favorites";
  }
  if (randomization.source === "family" && randomization.family) {
    return `All in ${randomization.family}`;
  }
  return "All cursors";
}

export function isCursorFamilyManagementDisabled({
  family,
  operation,
  pendingPreferenceCount,
  addingFamilyNames,
}) {
  if (operation !== "idle" || pendingPreferenceCount > 0) {
    return true;
  }
  const familyKey = String(family ?? "").toLocaleLowerCase();
  return Boolean(familyKey && addingFamilyNames?.has(familyKey));
}

export function getPackRailNavigationIndex(key, currentIndex, itemCount) {
  if (currentIndex < 0 || itemCount < 1) {
    return null;
  }

  switch (key) {
    case "ArrowDown":
      return Math.min(currentIndex + 1, itemCount - 1);
    case "ArrowUp":
      return Math.max(currentIndex - 1, 0);
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return null;
  }
}

export function isPackVerifiedActive(status, pack) {
  return Boolean(
    isStatusVerifiedActive(status) &&
    matchesCursorPack(pack, getStatusVariant(status)),
  );
}

export function isRandomizationResultVerified(result) {
  const cursor = result?.cursor;
  return Boolean(
    cursor &&
    (cursor.id || cursor.nativeThemeId) &&
    isPackVerifiedActive(result?.status, cursor),
  );
}

export function isStatusQueryUnavailable(query) {
  return Boolean(query?.isError || query?.data?.statusAvailable === false);
}

export function getAuthoritativeStatus(query) {
  return isStatusQueryUnavailable(query) ? null : (query?.data ?? null);
}

export function resolvePackQuerySource(query, fallback) {
  const nativeThemes = Array.isArray(query?.data) ? query.data : [];
  if (nativeThemes.length) {
    return nativeThemes;
  }
  if (query?.isError || query?.isSuccess) {
    return [];
  }
  return fallback;
}

export function getAutomaticSelectionId(packs, selectedId) {
  if (!Array.isArray(packs) || packs.length === 0) {
    return null;
  }
  return packs.some((pack) => pack.id === selectedId) ? null : packs[0].id;
}

export function getPackScopedFeedback(feedback, packId) {
  if (!feedback?.targetPackId || feedback.targetPackId === packId) {
    return feedback ?? null;
  }
  return null;
}

export function getPackScopedOperation(operation, targetPackId, packId) {
  return !targetPackId || targetPackId === packId ? operation : "idle";
}

export function isRestoreAvailable(status) {
  if (!status || typeof status !== "object") {
    return false;
  }

  return [
    "desiredEnabled",
    "persistedEffectiveApplied",
    "effectiveApplied",
    "launchAtLoginDesired",
    "loginItemRegistrationCurrent",
    "transactionPending",
  ].some((key) => status[key] === true || status[key] === 1);
}

export function isStatusVerifiedRestored(status) {
  if (
    !status ||
    status.bridgeAvailable !== true ||
    status.supported !== true ||
    status.statusAvailable !== true ||
    status.previewMode !== false ||
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

export async function applyCursorTheme(packId) {
  const apply = window.electronAPI?.applyCursorTheme;
  if (typeof apply !== "function") {
    throw new Error("Applying cursor packs is unavailable in this build.");
  }
  return apply(packId);
}

export async function setCursorThemeSize(packId, sizePercentage) {
  const setSize = window.electronAPI?.setCursorThemeSize;
  if (typeof setSize !== "function") {
    throw new Error("Cursor size customization is unavailable in this build.");
  }
  return setSize(packId, sizePercentage);
}

export function getCursorErrorMessage(error) {
  const rawMessage =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error.message === "string"
          ? error.message
          : null;

  if (!rawMessage) {
    return "The cursor engine could not complete that operation.";
  }

  const sanitized = rawMessage
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return sanitized || "The cursor engine could not complete that operation.";
}

export async function restoreCursorState() {
  const restore = window.electronAPI?.restoreCursorState;
  if (typeof restore !== "function") {
    throw new Error("Restoring the macOS cursor is unavailable in this build.");
  }
  return restore();
}

export async function openLoginItemsSettings() {
  const open = window.electronAPI?.openLoginItemsSettings;
  if (typeof open !== "function") {
    throw new Error("Login Items settings are unavailable in this build.");
  }
  return open();
}

export async function importCursorPack() {
  const importPack = window.electronAPI?.importCursorPack;
  if (typeof importPack !== "function") {
    throw new Error("Importing cursor packs is unavailable in this build.");
  }
  return importPack();
}

export async function assignImportedCursorFamily(identifiers, family) {
  const assignFamily = window.electronAPI?.assignImportedCursorFamily;
  if (typeof assignFamily !== "function") {
    throw new Error(
      "Organizing imported cursor packs is unavailable in this build.",
    );
  }
  return assignFamily(identifiers, family);
}

export async function deleteImportedCursor(identifier) {
  const deleteCursor = window.electronAPI?.deleteImportedCursor;
  if (typeof deleteCursor !== "function") {
    throw new Error(
      "Deleting imported cursor packs is unavailable in this build.",
    );
  }
  return deleteCursor(identifier);
}

export async function deleteImportedCursorFamily(family) {
  const deleteFamily = window.electronAPI?.deleteImportedCursorFamily;
  if (typeof deleteFamily !== "function") {
    throw new Error(
      "Deleting imported cursor families is unavailable in this build.",
    );
  }
  return deleteFamily(family);
}
