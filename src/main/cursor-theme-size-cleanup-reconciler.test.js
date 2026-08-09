import { describe, expect, it, vi } from "vitest";

import { createCursorThemeSizeCleanupReconciler } from "./cursor-theme-size-cleanup-reconciler.js";

function memoryCleanupStore(initial = []) {
  let identifiers = [...initial];
  return {
    getPendingThemeSizeCleanupIds: vi.fn(() => [...identifiers]),
    setPendingThemeSizeCleanupIds: vi.fn((next) => {
      identifiers = [...next];
      return [...identifiers];
    }),
  };
}

describe("cursor theme size cleanup reconciler", () => {
  it("persists exact failed identifiers and clears them on a bounded retry", async () => {
    const store = memoryCleanupStore();
    const bridge = {
      forgetThemeSizes: vi
        .fn()
        .mockResolvedValueOnce({ failedIdentifiers: ["ImportedBlue"] })
        .mockResolvedValueOnce({ failedIdentifiers: [] }),
    };
    const timers = [];
    const timer = { unref: vi.fn() };
    const reconciler = createCursorThemeSizeCleanupReconciler({
      bridge,
      preferencesStore: store,
      retryDelaysMs: [10, 20],
      setTimer(callback, delay) {
        timers.push({ callback, delay });
        return timer;
      },
      clearTimer: vi.fn(),
    });

    await reconciler.recordPending(["ImportedBlue"]);
    expect(store.getPendingThemeSizeCleanupIds()).toEqual(["ImportedBlue"]);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(10);
    expect(timer.unref).toHaveBeenCalled();

    timers.shift().callback();
    await vi.waitFor(() => expect(bridge.forgetThemeSizes).toHaveBeenCalled());
    expect(store.getPendingThemeSizeCleanupIds()).toEqual(["ImportedBlue"]);
    expect(timers).toHaveLength(1);
    timers.shift().callback();
    await vi.waitFor(() =>
      expect(store.getPendingThemeSizeCleanupIds()).toEqual([]),
    );
  });

  it("retries a persisted startup cleanup and stops after the configured budget", async () => {
    const store = memoryCleanupStore(["ImportedRed"]);
    const bridge = {
      forgetThemeSizes: vi.fn().mockResolvedValue({
        failedIdentifiers: ["ImportedRed"],
      }),
    };
    const timers = [];
    const onRetryError = vi.fn();
    const reconciler = createCursorThemeSizeCleanupReconciler({
      bridge,
      preferencesStore: store,
      retryDelaysMs: [1, 2],
      setTimer(callback, delay) {
        timers.push({ callback, delay });
        return { unref: vi.fn() };
      },
      clearTimer: vi.fn(),
      onRetryError,
    });

    await expect(reconciler.reconcile()).rejects.toMatchObject({
      code: "THEME_SIZE_CLEANUP_PENDING",
    });
    expect(timers.map(({ delay }) => delay)).toEqual([1]);
    timers.shift().callback();
    await vi.waitFor(() => expect(onRetryError).toHaveBeenCalledTimes(1));
    expect(timers.map(({ delay }) => delay)).toEqual([2]);
    timers.shift().callback();
    await vi.waitFor(() => expect(onRetryError).toHaveBeenCalledTimes(2));
    expect(timers).toEqual([]);
    expect(store.getPendingThemeSizeCleanupIds()).toEqual(["ImportedRed"]);
  });

  it("clears an unref'ed retry when stopped", async () => {
    const store = memoryCleanupStore();
    const clearTimer = vi.fn();
    const handle = { unref: vi.fn() };
    const reconciler = createCursorThemeSizeCleanupReconciler({
      bridge: { forgetThemeSizes: vi.fn() },
      preferencesStore: store,
      setTimer: vi.fn(() => handle),
      clearTimer,
    });

    await reconciler.recordPending(["ImportedGreen"]);
    reconciler.stop();

    expect(handle.unref).toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalledWith(handle);
  });

  it("does not drop a deletion recorded while cleanup is awaiting native work", async () => {
    const store = memoryCleanupStore(["ImportedOld"]);
    let resolveCleanup;
    const bridge = {
      forgetThemeSizes: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCleanup = resolve;
          }),
      ),
    };
    const reconciler = createCursorThemeSizeCleanupReconciler({
      bridge,
      preferencesStore: store,
      setTimer: vi.fn(() => ({ unref: vi.fn() })),
      clearTimer: vi.fn(),
    });

    const reconciliation = reconciler.reconcile();
    await vi.waitFor(() => expect(bridge.forgetThemeSizes).toHaveBeenCalled());
    const recorded = reconciler.recordPending(["ImportedNew"]);
    resolveCleanup({ failedIdentifiers: [] });

    await reconciliation;
    await recorded;
    expect(store.getPendingThemeSizeCleanupIds()).toEqual(["ImportedNew"]);
  });

  it("starts a fresh bounded retry incident when new work arrives after exhaustion", async () => {
    const store = memoryCleanupStore(["ImportedOld"]);
    const timers = [];
    const reconciler = createCursorThemeSizeCleanupReconciler({
      bridge: {
        forgetThemeSizes: vi.fn().mockResolvedValue({
          failedIdentifiers: ["ImportedOld"],
        }),
      },
      preferencesStore: store,
      retryDelaysMs: [1],
      setTimer(callback) {
        timers.push(callback);
        return { unref: vi.fn() };
      },
      clearTimer: vi.fn(),
    });

    await expect(reconciler.reconcile()).rejects.toMatchObject({
      code: "THEME_SIZE_CLEANUP_PENDING",
    });
    timers.shift()();
    await vi.waitFor(() => expect(timers).toHaveLength(0));

    await reconciler.recordPending(["ImportedNew"]);
    expect(timers).toHaveLength(1);
    expect(store.getPendingThemeSizeCleanupIds()).toEqual([
      "ImportedOld",
      "ImportedNew",
    ]);
  });
});
