import ElectronStore from "electron-store";

import {
  createDefaultCursorPreferences,
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "../lib/cursor-preferences.js";

const STORE_NAME = "cursor-preferences";
const STORE_KEY = "preferences";
const APP_APPEARANCE_MODE_KEY = "appAppearanceMode";
const PENDING_THEME_SIZE_CLEANUP_IDS_KEY = "pendingThemeSizeCleanupIds";
const APP_APPEARANCE_MODES = new Set(["system", "light", "dark"]);
const CURSOR_IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PENDING_THEME_SIZE_CLEANUPS = 512;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePreferences(preferences) {
  return structuredClone(preferences);
}

function normalizeAppAppearanceMode(value) {
  return APP_APPEARANCE_MODES.has(value) ? value : "system";
}

function normalizePendingThemeSizeCleanupIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const identifiers = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !CURSOR_IDENTIFIER.test(candidate) ||
      seen.has(candidate.toLowerCase())
    ) {
      continue;
    }
    seen.add(candidate.toLowerCase());
    identifiers.push(candidate);
    if (identifiers.length === MAX_PENDING_THEME_SIZE_CLEANUPS) {
      break;
    }
  }
  return identifiers;
}

export function createCursorPreferencesStore({
  directory,
  Store = ElectronStore,
  onListenerError = (error) =>
    console.error("Cursor preference listener failed.", error),
} = {}) {
  if (typeof directory !== "string" || !directory) {
    throw new TypeError("A preferences directory is required.");
  }

  const backingStore = new Store({
    cwd: directory,
    name: STORE_NAME,
    defaults: {
      [STORE_KEY]: createDefaultCursorPreferences(),
      [APP_APPEARANCE_MODE_KEY]: "system",
      [PENDING_THEME_SIZE_CLEANUP_IDS_KEY]: [],
    },
  });
  const listeners = new Set();
  const storedPreferences = backingStore.get(STORE_KEY);
  let preferences = normalizeCursorPreferences(storedPreferences);
  const storedAppAppearanceMode = backingStore.get(APP_APPEARANCE_MODE_KEY);
  let appAppearanceMode = normalizeAppAppearanceMode(storedAppAppearanceMode);
  const storedPendingThemeSizeCleanupIds = backingStore.get(
    PENDING_THEME_SIZE_CLEANUP_IDS_KEY,
  );
  let pendingThemeSizeCleanupIds = normalizePendingThemeSizeCleanupIds(
    storedPendingThemeSizeCleanupIds,
  );

  // Persist normalization once at startup so malformed or partial data cannot
  // remain authoritative after it has been read.
  if (JSON.stringify(storedPreferences) !== JSON.stringify(preferences)) {
    backingStore.set(STORE_KEY, preferences);
  }
  if (storedAppAppearanceMode !== appAppearanceMode) {
    backingStore.set(APP_APPEARANCE_MODE_KEY, appAppearanceMode);
  }
  if (
    JSON.stringify(storedPendingThemeSizeCleanupIds) !==
    JSON.stringify(pendingThemeSizeCleanupIds)
  ) {
    backingStore.set(
      PENDING_THEME_SIZE_CLEANUP_IDS_KEY,
      pendingThemeSizeCleanupIds,
    );
  }

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(clonePreferences(preferences));
      } catch (error) {
        try {
          onListenerError(error);
        } catch (reportingError) {
          console.error(
            "Cursor preference listener error reporter failed.",
            reportingError,
          );
        }
      }
    }
  };

  return {
    get() {
      return clonePreferences(preferences);
    },
    update(patch) {
      if (!isPlainObject(patch)) {
        throw new TypeError("Cursor preference updates must be an object.");
      }

      const next = mergeCursorPreferences(preferences, patch);
      if (JSON.stringify(next) === JSON.stringify(preferences)) {
        return clonePreferences(preferences);
      }

      backingStore.set(STORE_KEY, next);
      preferences = next;
      emit();
      return clonePreferences(preferences);
    },
    getAppAppearanceMode() {
      return appAppearanceMode;
    },
    setAppAppearanceMode(mode) {
      if (!APP_APPEARANCE_MODES.has(mode)) {
        throw new TypeError(
          "App appearance mode must be system, light, or dark.",
        );
      }
      if (mode === appAppearanceMode) {
        return appAppearanceMode;
      }

      backingStore.set(APP_APPEARANCE_MODE_KEY, mode);
      appAppearanceMode = mode;
      return appAppearanceMode;
    },
    getPendingThemeSizeCleanupIds() {
      return [...pendingThemeSizeCleanupIds];
    },
    setPendingThemeSizeCleanupIds(identifiers) {
      if (
        !Array.isArray(identifiers) ||
        identifiers.length > MAX_PENDING_THEME_SIZE_CLEANUPS ||
        identifiers.some(
          (identifier) =>
            typeof identifier !== "string" ||
            !CURSOR_IDENTIFIER.test(identifier),
        )
      ) {
        throw new TypeError("Pending cursor size cleanup IDs are invalid.");
      }
      const next = normalizePendingThemeSizeCleanupIds(identifiers);
      if (JSON.stringify(next) === JSON.stringify(pendingThemeSizeCleanupIds)) {
        return [...pendingThemeSizeCleanupIds];
      }
      backingStore.set(PENDING_THEME_SIZE_CLEANUP_IDS_KEY, next);
      pendingThemeSizeCleanupIds = next;
      return [...pendingThemeSizeCleanupIds];
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("A cursor preference listener is required.");
      }

      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
