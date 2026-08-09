import { describe, expect, it, vi } from "vitest";

import { createMainLoginItemReconciler } from "./main-login-item-reconciler.js";

describe("main login item reconciler", () => {
  it("caches only a verified registration and retries contradictory status", () => {
    let status = "not-registered";
    const timers = [];
    const setLoginItemSettings = vi.fn();
    const reconciler = createMainLoginItemReconciler({
      available: true,
      setLoginItemSettings,
      getLoginItemSettings: () => ({ status }),
      retryDelaysMs: [10, 20],
      setTimer(callback, delay) {
        const handle = { unref: vi.fn() };
        timers.push({ callback, delay, handle });
        return handle;
      },
      clearTimer: vi.fn(),
    });

    expect(reconciler.sync(true)).toMatchObject({ satisfied: false });
    expect(timers.map(({ delay }) => delay)).toEqual([10]);
    expect(timers[0].handle.unref).toHaveBeenCalled();
    status = "enabled";
    timers.shift().callback();
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);

    expect(reconciler.sync(true)).toMatchObject({
      skipped: true,
      satisfied: true,
    });
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("bounds retries and starts a fresh attempt on a later sync", () => {
    const timers = [];
    const onUnsatisfied = vi.fn();
    const setLoginItemSettings = vi.fn();
    const reconciler = createMainLoginItemReconciler({
      available: true,
      setLoginItemSettings,
      getLoginItemSettings: () => ({ status: "not-registered" }),
      retryDelaysMs: [1, 2],
      setTimer(callback, delay) {
        timers.push({ callback, delay });
        return { unref: vi.fn() };
      },
      clearTimer: vi.fn(),
      onUnsatisfied,
    });

    reconciler.sync(true);
    timers.shift().callback();
    timers.shift().callback();
    expect(timers).toEqual([]);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(3);
    expect(onUnsatisfied).toHaveBeenCalledTimes(3);

    reconciler.sync(true);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(4);
    expect(timers.map(({ delay }) => delay)).toEqual([1]);
  });

  it("treats approval-required registration as satisfied after reporting guidance", () => {
    const onUnsatisfied = vi.fn();
    const setLoginItemSettings = vi.fn();
    const setTimer = vi.fn();
    const reconciler = createMainLoginItemReconciler({
      available: true,
      setLoginItemSettings,
      getLoginItemSettings: () => ({ status: "requires-approval" }),
      setTimer,
      clearTimer: vi.fn(),
      onUnsatisfied,
    });

    expect(reconciler.sync(true)).toMatchObject({
      satisfied: true,
      status: "requires-approval",
    });
    expect(onUnsatisfied).toHaveBeenCalledWith(
      expect.objectContaining({
        desired: true,
        status: "requires-approval",
        satisfied: true,
      }),
    );
    expect(setTimer).not.toHaveBeenCalled();
    reconciler.sync(true);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  it("invalidates an old retry when desired state changes and clears it on stop", () => {
    const callbacks = [];
    const handles = [];
    const clearTimer = vi.fn();
    let lastDesired = null;
    const setLoginItemSettings = vi.fn(({ openAtLogin }) => {
      lastDesired = openAtLogin;
    });
    const reconciler = createMainLoginItemReconciler({
      available: true,
      setLoginItemSettings,
      getLoginItemSettings: () => ({
        status: lastDesired ? "not-registered" : "enabled",
      }),
      setTimer(callback) {
        callbacks.push(callback);
        const handle = { unref: vi.fn() };
        handles.push(handle);
        return handle;
      },
      clearTimer,
    });

    reconciler.sync(true);
    reconciler.sync(false);
    callbacks[0]();
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    reconciler.stop();
    expect(clearTimer).toHaveBeenCalledWith(handles[1]);
  });
});
