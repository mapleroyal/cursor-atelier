import { describe, expect, it, vi } from "vitest";

import {
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "../lib/cursor-preferences.js";
import { createCursorAutomation } from "./cursor-automation.js";

function createMemoryPreferences(initial) {
  let preferences = normalizeCursorPreferences(initial);
  const listeners = new Set();
  return {
    get: () => structuredClone(preferences),
    update: (patch) => {
      preferences = mergeCursorPreferences(preferences, patch);
      const snapshot = structuredClone(preferences);
      for (const listener of listeners) {
        listener(snapshot);
      }
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function theme(nativeThemeId, family = "Oreo") {
  return {
    id: nativeThemeId.toLowerCase(),
    nativeThemeId,
    name: nativeThemeId,
    family,
    canApply: true,
  };
}

function bridge({ themes, status, applyTheme } = {}) {
  return {
    listThemes: vi.fn(async () => themes ?? []),
    status: vi.fn(async () => status ?? {}),
    applyTheme: vi.fn(
      applyTheme ??
        (async (identifier) => ({
          selectedNativeThemeId: identifier,
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        })),
    ),
  };
}

describe("cursor automation", () => {
  it("uses the current appearance pool, applies, and remembers the result", async () => {
    const preferencesStore = createMemoryPreferences({
      favorites: { cursorIds: ["OreoWhite", "OreoBlack"] },
      randomization: {
        source: "favorites",
        pools: { light: ["OreoWhite"], dark: ["OreoBlack"] },
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack"), theme("Moga", "Moga")],
      status: { effectiveNativeThemeId: "OreoWhite" },
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: true },
      random: () => 0,
      now: () => new Date("2026-08-06T20:15:00.000Z"),
      onCursorChanged: changed,
    });

    const result = await automation.randomize("menu");

    expect(result.cursor.nativeThemeId).toBe("OreoBlack");
    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoBlack");
    expect(preferencesStore.get().randomization.lastRunAt).toBe(
      "2026-08-06T20:15:00.000Z",
    );
    expect(preferencesStore.get().appearance).toEqual({
      automaticSwitching: false,
      lightCursorId: null,
      darkCursorId: "OreoBlack",
    });
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "menu" }),
    );
  });

  it("fails closed when no cursor matches instead of widening the pool", async () => {
    const preferencesStore = createMemoryPreferences({
      favorites: { cursorIds: ["Missing"] },
      randomization: { source: "favorites" },
    });
    const nativeBridge = bridge({ themes: [theme("OreoWhite")] });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    await expect(automation.randomize()).rejects.toMatchObject({
      code: "EMPTY_CURSOR_POOL",
    });
    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
  });

  it("serializes overlapping randomization requests", async () => {
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    let active = 0;
    let maximumActive = 0;
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      applyTheme: async (identifier) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    await Promise.all([automation.randomize(), automation.randomize()]);

    expect(maximumActive).toBe(1);
    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(2);
  });

  it("does not exclude a stale selected cursor from the random pool", async () => {
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: {
        selectedNativeThemeId: "OreoWhite",
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
      random: () => 0,
    });

    await automation.randomize();

    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoWhite");
  });

  it("records success only after the applied cursor is live and verified", async () => {
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      applyTheme: async () => ({
        selectedNativeThemeId: "OreoWhite",
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
      }),
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
      onCursorChanged: changed,
    });

    await expect(automation.randomize()).rejects.toMatchObject({
      code: "CURSOR_APPLY_UNVERIFIED",
    });
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not switch appearances until automatic switching is enabled", async () => {
    const nativeTheme = { shouldUseDarkColors: false };
    const preferencesStore = createMemoryPreferences({
      appearance: {
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: {
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme,
    });

    await automation.start({ runLaunch: false });
    nativeTheme.shouldUseDarkColors = true;
    await automation.appearanceChanged();

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();

    preferencesStore.update({
      appearance: { automaticSwitching: true },
    });
    await automation.reschedule();

    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoBlack");
    automation.stop();
  });

  it("cancels an appearance apply when automatic switching is disabled while resolving it", async () => {
    let resolveThemes;
    const themesPromise = new Promise((resolve) => {
      resolveThemes = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
      },
    });
    const nativeBridge = bridge({
      status: {
        effectiveNativeThemeId: "OreoBlack",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    nativeBridge.listThemes.mockImplementation(() => themesPromise);
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    const startup = automation.start({ runLaunch: false });
    await vi.waitFor(() => expect(nativeBridge.listThemes).toHaveBeenCalled());
    preferencesStore.update({
      appearance: { automaticSwitching: false },
    });
    resolveThemes([theme("OreoWhite"), theme("OreoBlack")]);
    await startup;
    await automation.reschedule();

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    automation.stop();
  });

  it("applies the fixed cursor when the OS appearance changes", async () => {
    const nativeTheme = { shouldUseDarkColors: false };
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: {
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme,
    });

    await automation.start({ runLaunch: false });
    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();

    nativeTheme.shouldUseDarkColors = true;
    await automation.appearanceChanged();

    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoBlack");
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
    automation.stop();
  });

  it("does not reapply a fixed cursor when only randomization pools change", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: {
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    await automation.start({ runLaunch: false });
    preferencesStore.update({
      randomization: { pools: { dark: ["OreoBlack"] } },
    });
    await automation.reschedule();

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    automation.stop();
  });

  it("applies an assigned cursor immediately only for the current appearance", async () => {
    const preferencesStore = createMemoryPreferences({});
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: {
        effectiveNativeThemeId: "OreoBlack",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
      onCursorChanged: changed,
    });

    const lightResult = await automation.setAppearanceCursor(
      "light",
      "OreoWhite",
    );
    const darkResult = await automation.setAppearanceCursor(
      "dark",
      "OreoBlack",
    );

    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(1);
    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoWhite");
    expect(lightResult.status).toMatchObject({
      effectiveNativeThemeId: "OreoWhite",
    });
    expect(darkResult.status).toBeNull();
    expect(preferencesStore.get().appearance).toEqual({
      automaticSwitching: false,
      lightCursorId: "OreoWhite",
      darkCursorId: "OreoBlack",
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "assign:light" }),
    );
  });

  it("does not remember a current-mode assignment that fails to apply", async () => {
    const preferencesStore = createMemoryPreferences({});
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      applyTheme: async () => ({
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
      }),
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    await expect(
      automation.setAppearanceCursor("light", "OreoWhite"),
    ).rejects.toMatchObject({ code: "CURSOR_APPLY_UNVERIFIED" });

    expect(preferencesStore.get().appearance.lightCursorId).toBeNull();
  });

  it("clears an appearance assignment without changing the live cursor", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: {
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
      onCursorChanged: changed,
    });

    const result = await automation.setAppearanceCursor("light", null);

    expect(result).toMatchObject({ cursor: null, status: null });
    expect(result.preferences.appearance).toEqual({
      automaticSwitching: false,
      lightCursorId: null,
      darkCursorId: "OreoBlack",
    });
    expect(nativeBridge.listThemes).not.toHaveBeenCalled();
    expect(nativeBridge.status).not.toHaveBeenCalled();
    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("reconciles the fixed cursor after wake when the OS appearance changed", async () => {
    const nativeTheme = { shouldUseDarkColors: false };
    const liveStatus = {
      effectiveNativeThemeId: "OreoWhite",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    };
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: liveStatus,
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme,
      onCursorChanged: changed,
    });

    await automation.start({ runLaunch: false });
    nativeTheme.shouldUseDarkColors = true;
    await automation.wake();

    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expect(nativeBridge.applyTheme).toHaveBeenCalledWith("OreoBlack");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "wake" }),
    );
    automation.stop();
  });

  it("backs off a failed due schedule instead of creating a zero-delay loop", async () => {
    let current = new Date("2026-08-06T12:00:00.000Z");
    const timers = [];
    const preferencesStore = createMemoryPreferences({
      randomization: {
        source: "all",
        schedule: { mode: "interval", intervalHours: 1 },
        lastRunAt: "2026-08-06T10:00:00.000Z",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      applyTheme: async () => {
        throw new Error("busy");
      },
    });
    const errors = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
      now: () => current,
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.cleared = true;
      },
      retryDelayMs: 60_000,
      onError: errors,
    });

    await automation.start({ runLaunch: false });
    await automation.wake();

    const activeTimer = timers.findLast((timer) => !timer.cleared);
    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "busy" }),
      expect.objectContaining({ reason: "schedule:interval" }),
    );
    expect(activeTimer.delay).toBe(60_000);

    current = new Date("2026-08-06T12:00:01.000Z");
    await automation.reschedule();
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(59_000);
    automation.stop();
  });

  it("runs launch schedules once when the service starts", async () => {
    const preferencesStore = createMemoryPreferences({
      randomization: {
        source: "all",
        schedule: { mode: "launch" },
      },
    });
    const liveStatus = {};
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: liveStatus,
      applyTheme: async (identifier) => {
        Object.assign(liveStatus, {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        });
        return { ...liveStatus };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      nativeTheme: { shouldUseDarkColors: false },
    });

    await automation.start();
    await automation.start();

    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(1);
    automation.stop();
  });
});
