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

export function getStatusVariant(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  const value =
    status.effectiveVariantId ??
    status.activeVariantId ??
    status.currentVariantId ??
    status.currentThemeId ??
    status.activeThemeId;

  return value === null || value === undefined ? null : String(value);
}

export function getSelectedStatusVariant(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  const value =
    status.selectedVariantId ??
    status.selectedThemeId ??
    status.selectedThemeIdentifier ??
    status.themeIdentifier;

  return value === null || value === undefined ? null : String(value);
}

export function getStatusEnabled(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  for (const key of [
    "effectiveApplied",
    "isEnabled",
    "enabled",
    "customCursorsEnabled",
    "active",
  ]) {
    if (typeof status[key] === "boolean") {
      return status[key];
    }
  }
  return null;
}

export function isStatusVerifiedActive(status) {
  if (getStatusEnabled(status) !== true || !getStatusVariant(status)) {
    return false;
  }
  if (status?.previewMode) {
    return false;
  }
  if (typeof status?.currentSentinelsMatchTheme === "boolean") {
    return status.currentSentinelsMatchTheme;
  }
  return true;
}

export function matchesCursorPack(pack, identifier) {
  if (!pack || !identifier) {
    return false;
  }
  const expected = String(identifier).toLowerCase();
  return [pack.id, pack.nativeThemeId, ...(pack.nativeThemeIds ?? [])].some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.toLowerCase() === expected,
  );
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

export function isStatusQueryUnavailable(query) {
  return Boolean(query?.isError || query?.data?.statusAvailable === false);
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
  return Boolean(
    status &&
    status.statusAvailable === true &&
    status.currentSentinelsMatchTheme === false &&
    !isRestoreAvailable(status),
  );
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

export async function restoreCursors() {
  const restore = window.electronAPI?.restoreCursors;
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
