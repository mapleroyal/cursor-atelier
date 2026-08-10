import { describe, expect, it, vi } from "vitest";

import { createDefaultCursorPreferences } from "../lib/cursor-preferences.js";
import { createCursorPreferencesStore } from "./cursor-preferences-store.js";

function memoryStore(initialValue) {
  return class MemoryStore {
    constructor({ defaults }) {
      this.data = structuredClone(
        initialValue === undefined ? defaults : { preferences: initialValue },
      );
    }

    get(key) {
      return structuredClone(this.data[key]);
    }

    set(key, value) {
      this.data[key] = structuredClone(value);
    }
  };
}

describe("cursor preferences store", () => {
  it("normalizes persisted data and returns isolated snapshots", () => {
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore({
        favorites: { cursorIds: [" OreoBlue ", "OreoBlue"] },
        randomization: { schedule: { intervalHours: -2 } },
      }),
    });

    const snapshot = store.get();
    expect(snapshot.favorites.cursorIds).toEqual(["OreoBlue"]);
    expect(snapshot.randomization.schedule.intervalHours).toBe(0.25);

    snapshot.favorites.cursorIds.push("Mutated");
    expect(store.get().favorites.cursorIds).toEqual(["OreoBlue"]);
  });

  it("validates partial merges and emits only material changes", () => {
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore(),
    });
    const changes = [];
    const unsubscribe = store.subscribe((preferences) =>
      changes.push(preferences),
    );

    const updated = store.update({
      appearance: {
        automaticSwitching: true,
        darkCursorId: "OreoBlack",
      },
      randomization: {
        pools: { dark: ["OreoBlack"] },
        schedule: { mode: "daily", dailyTime: "18:30" },
      },
    });
    store.update({
      appearance: {
        automaticSwitching: true,
        darkCursorId: "OreoBlack",
      },
    });
    unsubscribe();
    store.update({ menuBar: { visible: false } });

    expect(updated).toMatchObject({
      appearance: {
        automaticSwitching: true,
        lightCursorId: null,
        darkCursorId: "OreoBlack",
      },
      randomization: {
        pools: { light: [], dark: ["OreoBlack"] },
        schedule: { mode: "daily", dailyTime: "18:30" },
      },
    });
    expect(changes).toHaveLength(1);
    expect(() => store.update(null)).toThrow(TypeError);
  });

  it("starts from the shared default document", () => {
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore(),
    });

    expect(store.get()).toEqual(createDefaultCursorPreferences());
  });

  it("publishes a preference change only after persistence succeeds", () => {
    let failNextWrite = false;
    class FailingStore extends memoryStore() {
      set(key, value) {
        if (failNextWrite && key === "preferences") {
          throw new Error("disk full");
        }
        super.set(key, value);
      }
    }
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: FailingStore,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    failNextWrite = true;
    expect(() => store.update({ menuBar: { visible: false } })).toThrow(
      "disk full",
    );

    expect(store.get().menuBar.visible).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener failures and gives each listener its own snapshot", () => {
    const listenerErrors = [];
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore(),
      onListenerError: (error) => listenerErrors.push(error),
    });
    store.subscribe((preferences) => {
      preferences.menuBar.visible = true;
      throw new Error("broken listener");
    });
    const laterListener = vi.fn();
    store.subscribe(laterListener);

    expect(store.update({ menuBar: { visible: false } }).menuBar.visible).toBe(
      false,
    );
    expect(listenerErrors).toHaveLength(1);
    expect(laterListener).toHaveBeenCalledWith(
      expect.objectContaining({ menuBar: { visible: false } }),
    );
  });

  it("persists and validates the app appearance mode", () => {
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore(),
    });

    expect(store.getAppAppearanceMode()).toBe("system");
    expect(store.setAppAppearanceMode("dark")).toBe("dark");
    expect(store.getAppAppearanceMode()).toBe("dark");
    expect(() => store.setAppAppearanceMode("sepia")).toThrow(TypeError);
    expect(store.getAppAppearanceMode()).toBe("dark");
  });

  it("persists pending native size cleanup IDs before publishing them", () => {
    let failNextWrite = false;
    class FailingStore extends memoryStore() {
      set(key, value) {
        if (failNextWrite && key === "pendingThemeSizeCleanupIds") {
          throw new Error("disk full");
        }
        super.set(key, value);
      }
    }
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: FailingStore,
    });

    expect(
      store.setPendingThemeSizeCleanupIds([
        "ImportedBlue",
        "importedblue",
        "ImportedRed",
      ]),
    ).toEqual(["ImportedBlue", "ImportedRed"]);
    failNextWrite = true;
    expect(() =>
      store.setPendingThemeSizeCleanupIds(["ImportedGreen"]),
    ).toThrow("disk full");
    expect(store.getPendingThemeSizeCleanupIds()).toEqual([
      "ImportedBlue",
      "ImportedRed",
    ]);
    expect(() => store.setPendingThemeSizeCleanupIds(["bad/id"])).toThrow(
      TypeError,
    );
  });

  it("round-trips and resets the complete durable preference document", () => {
    const store = createCursorPreferencesStore({
      directory: "/tmp/cursor-preferences-test",
      Store: memoryStore(),
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.replaceDataSnapshot({
      preferences: {
        favorites: { cursorIds: ["ImportedBlue"] },
        startup: { runInBackground: true },
      },
      appAppearanceMode: "dark",
      pendingThemeSizeCleanupIds: ["ImportedOld"],
    });

    expect(store.getDataSnapshot()).toMatchObject({
      preferences: {
        favorites: { cursorIds: ["ImportedBlue"] },
        startup: { runInBackground: true },
      },
      appAppearanceMode: "dark",
      pendingThemeSizeCleanupIds: ["ImportedOld"],
    });
    expect(listener).toHaveBeenCalledOnce();

    store.resetData();
    expect(store.getDataSnapshot()).toEqual({
      preferences: createDefaultCursorPreferences(),
      appAppearanceMode: "system",
      pendingThemeSizeCleanupIds: [],
    });
  });
});
