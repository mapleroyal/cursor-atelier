import { describe, expect, it } from "vitest";

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
      appearance: { enabled: true, darkCursorId: "OreoBlack" },
      randomization: { schedule: { mode: "daily", dailyTime: "18:30" } },
    });
    store.update({ appearance: { enabled: true } });
    unsubscribe();
    store.update({ menuBar: { visible: false } });

    expect(updated).toMatchObject({
      appearance: { enabled: true, darkCursorId: "OreoBlack" },
      randomization: {
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
});
