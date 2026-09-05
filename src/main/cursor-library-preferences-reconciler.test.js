import { describe, expect, it, vi } from "vitest";

import {
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "../lib/cursor-preferences.js";
import { createCursorLibraryPreferencesReconciler } from "./cursor-library-preferences-reconciler.js";

function memoryPreferences(initial) {
  let preferences = normalizeCursorPreferences(initial);
  return {
    get: () => structuredClone(preferences),
    update: vi.fn((patch) => {
      preferences = mergeCursorPreferences(preferences, patch);
      return structuredClone(preferences);
    }),
  };
}

function createReconciler(options) {
  return createCursorLibraryPreferencesReconciler({
    runLibraryExclusive: (operation) => Promise.resolve().then(operation),
    ...options,
  });
}

function theme(nativeThemeId, family) {
  return {
    id: nativeThemeId.toLowerCase(),
    nativeThemeId,
    family,
  };
}

describe("cursor library preference reconciliation", () => {
  it("finishes an old catalogue read before a data import replaces preferences", async () => {
    let queue = Promise.resolve();
    const runLibraryExclusive = (operation) => {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    };
    let releaseListing;
    const oldListing = new Promise((resolve) => {
      releaseListing = resolve;
    });
    const bridge = {
      listThemes: vi
        .fn()
        .mockReturnValueOnce(oldListing)
        .mockResolvedValue([theme("NewCursor", "New")]),
    };
    const preferencesStore = memoryPreferences({
      favorites: { cursorIds: ["OldCursor"] },
    });
    const reconciler = createReconciler({
      bridge,
      preferencesStore,
      runLibraryExclusive,
    });
    const reconciling = reconciler.reconcile();
    await vi.waitFor(() => expect(bridge.listThemes).toHaveBeenCalledOnce());
    const replace = vi.fn(async () => {
      preferencesStore.update({
        favorites: { cursorIds: ["NewCursor"] },
        appearance: { lightCursorId: "NewCursor" },
        randomization: { pools: { light: ["NewCursor"] } },
      });
      await reconciler.reconcileInLibraryTransaction();
    });
    const importing = runLibraryExclusive(replace);
    expect(replace).not.toHaveBeenCalled();
    releaseListing([theme("OldCursor", "Old")]);
    await Promise.all([reconciling, importing]);
    expect(preferencesStore.get()).toMatchObject({
      favorites: { cursorIds: ["NewCursor"] },
      appearance: { lightCursorId: "NewCursor" },
      randomization: { pools: { light: ["NewCursor"] } },
    });
  });

  it("removes stale identifiers and families against the authoritative catalogue", async () => {
    const preferencesStore = memoryPreferences({
      favorites: {
        cursorIds: ["OreoWhite", "DeletedCursor"],
        families: ["Oreo", "Deleted Family"],
      },
      appearance: {
        lightCursorId: "OreoWhite",
        darkCursorId: "DeletedCursor",
      },
      randomization: {
        source: "family",
        family: "Deleted Family",
        pools: {
          light: ["OreoWhite", "DeletedCursor"],
          dark: ["DeletedCursor"],
        },
      },
    });
    const reconciler = createReconciler({
      bridge: { listThemes: vi.fn(async () => [theme("OreoWhite", "Oreo")]) },
      preferencesStore,
    });

    await reconciler.reconcile();

    expect(preferencesStore.get()).toMatchObject({
      favorites: { cursorIds: ["OreoWhite"], families: ["Oreo"] },
      appearance: { lightCursorId: "OreoWhite", darkCursorId: null },
      randomization: {
        source: "all",
        family: null,
        pools: { light: ["OreoWhite"], dark: [] },
      },
    });
  });

  it("schedules an unrefed retry after an immediate failure and converges", async () => {
    const timers = [];
    const preferencesStore = memoryPreferences({
      favorites: { cursorIds: ["DeletedCursor"] },
    });
    const bridge = {
      listThemes: vi
        .fn()
        .mockRejectedValueOnce(new Error("catalogue busy"))
        .mockResolvedValueOnce([theme("OreoWhite", "Oreo")]),
    };
    const reconciler = createReconciler({
      bridge,
      preferencesStore,
      retryDelaysMs: [1_000],
      setTimer(callback, delay) {
        const timer = { callback, delay, unref: vi.fn(), cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
    });

    await expect(reconciler.reconcile()).rejects.toThrow("catalogue busy");
    expect(timers[0].delay).toBe(1_000);
    expect(timers[0].unref).toHaveBeenCalledOnce();

    timers[0].callback();
    await vi.waitFor(() =>
      expect(preferencesStore.get().favorites.cursorIds).toEqual([]),
    );
  });

  it("bounds automatic retry attempts", async () => {
    const timers = [];
    const retryErrors = [];
    const reconciler = createReconciler({
      bridge: {
        listThemes: vi.fn(async () => {
          throw new Error("still unavailable");
        }),
      },
      preferencesStore: memoryPreferences({}),
      retryDelaysMs: [10, 20, 30],
      setTimer(callback, delay) {
        const timer = { callback, delay, unref: vi.fn(), cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
      onRetryError: (error, context) => retryErrors.push({ error, context }),
    });

    await expect(reconciler.reconcile()).rejects.toThrow("still unavailable");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      timers[attempt - 1].callback();
      await vi.waitFor(() => expect(retryErrors).toHaveLength(attempt));
    }

    expect(timers.map((timer) => timer.delay)).toEqual([10, 20, 30]);
  });

  it("cancels a pending retry when stopped", async () => {
    let timer;
    const reconciler = createReconciler({
      bridge: {
        listThemes: vi.fn(async () => {
          throw new Error("still unavailable");
        }),
      },
      preferencesStore: memoryPreferences({}),
      retryDelaysMs: [10],
      setTimer(callback, delay) {
        timer = { callback, delay, unref: vi.fn(), cleared: false };
        return timer;
      },
      clearTimer(value) {
        value.cleared = true;
      },
    });

    await expect(reconciler.reconcile()).rejects.toThrow("still unavailable");

    reconciler.stop();

    expect(timer.cleared).toBe(true);
  });
});
