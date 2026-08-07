import ElectronStore from "electron-store";

import {
  createDefaultCursorPreferences,
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "../lib/cursor-preferences.js";

const STORE_NAME = "cursor-preferences";
const STORE_KEY = "preferences";

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

export function createCursorPreferencesStore({
  directory,
  Store = ElectronStore,
} = {}) {
  if (typeof directory !== "string" || !directory) {
    throw new TypeError("A preferences directory is required.");
  }

  const backingStore = new Store({
    cwd: directory,
    name: STORE_NAME,
    defaults: {
      [STORE_KEY]: createDefaultCursorPreferences(),
    },
  });
  const listeners = new Set();
  let preferences = normalizeCursorPreferences(backingStore.get(STORE_KEY));

  // Persist normalization once at startup so malformed or partial data cannot
  // remain authoritative after it has been read.
  backingStore.set(STORE_KEY, preferences);

  const emit = () => {
    const snapshot = clonePreferences(preferences);
    for (const listener of listeners) {
      listener(snapshot);
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

      preferences = next;
      backingStore.set(STORE_KEY, preferences);
      emit();
      return clonePreferences(preferences);
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
