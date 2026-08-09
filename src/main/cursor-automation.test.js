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

function verifiedActiveStatus(identifier, overrides = {}) {
  return {
    bridgeAvailable: true,
    supported: true,
    previewMode: false,
    statusAvailable: true,
    selectedNativeThemeId: identifier,
    effectiveNativeThemeId: identifier,
    desiredEnabled: true,
    persistedEffectiveApplied: true,
    effectiveApplied: true,
    currentSentinelsMatchTheme: true,
    launchAtLoginDesired: false,
    loginApprovalRequired: false,
    loginItemRegistrationCurrent: false,
    transactionPending: false,
    stateDrifted: false,
    ...overrides,
  };
}

function verifiedRestoredStatus(overrides = {}) {
  return {
    bridgeAvailable: true,
    supported: true,
    previewMode: false,
    statusAvailable: true,
    selectedNativeThemeId: "OreoWhite",
    effectiveNativeThemeId: null,
    desiredEnabled: false,
    persistedEffectiveApplied: false,
    effectiveApplied: false,
    currentSentinelsMatchTheme: false,
    launchAtLoginDesired: false,
    loginApprovalRequired: false,
    loginItemRegistrationCurrent: false,
    transactionPending: false,
    stateDrifted: false,
    ...overrides,
  };
}

function bridge({
  themes,
  status,
  applyTheme,
  restore,
  recoverNativeState,
} = {}) {
  const apply =
    applyTheme ??
    (async (identifier) => ({
      selectedNativeThemeId: identifier,
      effectiveNativeThemeId: identifier,
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    }));
  const restoreState =
    restore ??
    (async () => {
      const restored = verifiedRestoredStatus();
      if (status && typeof status === "object") {
        Object.assign(status, restored);
      }
      return restored;
    });
  const recoverState =
    recoverNativeState ??
    (async (recovery) => {
      const recovered = verifiedActiveStatus(
        recovery.previousEffectiveIdentifier,
        {
          selectedNativeThemeId: recovery.previousSelectedIdentifier,
          launchAtLoginDesired: recovery.previousLaunchAtLoginDesired,
          loginItemRegistrationCurrent:
            recovery.previousLoginItemRegistrationCurrent,
        },
      );
      if (status && typeof status === "object") {
        Object.assign(status, recovered);
      }
      return recovered;
    });
  return {
    listThemes: vi.fn(async () => themes ?? []),
    status: vi.fn(async () => structuredClone(status ?? {})),
    restore: vi.fn(restoreState),
    recoverNativeState: vi.fn(recoverState),
    applyTheme: vi.fn(async (identifier, options) => {
      if (options?.shouldApply && options.shouldApply() !== true) {
        return { applySkipped: true, reason: "stale-request" };
      }
      return apply(identifier, options);
    }),
  };
}

function expectGuardedApply(mock, identifier) {
  expect(mock).toHaveBeenCalledWith(identifier, {
    shouldApply: expect.any(Function),
  });
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
      getSystemAppearance: () => "dark",
      random: () => 0,
      now: () => new Date("2026-08-06T20:15:00.000Z"),
      onCursorChanged: changed,
    });

    const result = await automation.randomize("menu");

    expect(result.cursor.nativeThemeId).toBe("OreoBlack");
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
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

  it("keeps randomization state when a follow-up status verifies an initially unverified apply", async () => {
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: {
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
      applyTheme: async () => ({ statusAvailable: false }),
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      now: () => new Date("2026-08-06T20:15:00.000Z"),
    });

    await expect(automation.randomize("menu")).resolves.toMatchObject({
      cursor: { nativeThemeId: "OreoWhite" },
      status: { effectiveNativeThemeId: "OreoWhite" },
    });
    expect(preferencesStore.get().randomization.lastRunAt).toBe(
      "2026-08-06T20:15:00.000Z",
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
      getSystemAppearance: () => "light",
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
      getSystemAppearance: () => "light",
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
      getSystemAppearance: () => "light",
      random: () => 0,
    });

    await automation.randomize();

    expectGuardedApply(nativeBridge.applyTheme, "OreoWhite");
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
      getSystemAppearance: () => "light",
      onCursorChanged: changed,
    });

    await expect(automation.randomize()).rejects.toMatchObject({
      code: "CURSOR_APPLY_UNVERIFIED",
    });
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
    expect(preferencesStore.get().appearance.lightCursorId).toBeNull();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual:compensated",
        status: {},
      }),
    );
  });

  it("does not touch the native cursor when randomization state cannot be saved", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
      randomization: { source: "all" },
    });
    preferencesStore.update = vi.fn(() => {
      throw new Error("disk full");
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: { effectiveNativeThemeId: "Original" },
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      onCursorChanged: changed,
    });

    await expect(automation.randomize()).rejects.toThrow("disk full");

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    expect(preferencesStore.get().appearance.lightCursorId).toBe("Original");
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("skips a queued random apply and rolls back only transaction values", async () => {
    let releaseGuard;
    let markGuardReached;
    let nativeMutations = 0;
    const guardReached = new Promise((resolve) => {
      markGuardReached = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: { effectiveNativeThemeId: "Original" },
    });
    nativeBridge.applyTheme.mockImplementation(
      async (identifier, { shouldApply }) => {
        markGuardReached();
        await new Promise((resolve) => {
          releaseGuard = resolve;
        });
        if (!shouldApply()) {
          return { applySkipped: true, reason: "stale-request" };
        }
        nativeMutations += 1;
        return {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        };
      },
    );
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      now: () => new Date("2026-08-06T20:15:00.000Z"),
    });

    const randomization = automation.randomize();
    await guardReached;
    preferencesStore.update({
      appearance: { lightCursorId: "NewerChoice" },
      favorites: { cursorIds: ["NewerChoice"] },
      randomization: { source: "favorites" },
    });
    releaseGuard();

    await expect(randomization).resolves.toBeNull();
    expect(nativeMutations).toBe(0);
    expect(preferencesStore.get().appearance.lightCursorId).toBe("NewerChoice");
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
  });

  it("restores authoritative stock state when a random cursor becomes stale during native execution", async () => {
    let releaseApply;
    let markApplyStarted;
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const liveStatus = verifiedRestoredStatus();
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const changed = vi.fn();
    let firstApply = true;
    const nativeBridge = bridge({
      themes: [theme("OreoBlack"), theme("OreoWhite")],
      status: liveStatus,
      applyTheme: async (identifier) => {
        if (firstApply) {
          firstApply = false;
          markApplyStarted();
          await new Promise((resolve) => {
            releaseApply = resolve;
          });
        }
        Object.assign(
          liveStatus,
          verifiedActiveStatus(identifier, {
            launchAtLoginDesired: true,
            loginItemRegistrationCurrent: true,
          }),
        );
        return { ...liveStatus };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      random: () => 0,
      now: () => new Date("2026-08-06T20:15:00.000Z"),
      onCursorChanged: changed,
    });

    const randomization = automation.randomize();
    await applyStarted;
    preferencesStore.update({
      favorites: { cursorIds: ["OreoBlack"] },
      randomization: { source: "favorites" },
    });
    releaseApply();

    await expect(randomization).resolves.toBeNull();
    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
    expect(nativeBridge.restore).toHaveBeenCalledOnce();
    expect(nativeBridge.recoverNativeState).not.toHaveBeenCalled();
    expect(liveStatus.effectiveNativeThemeId).toBeNull();
    expect(liveStatus.launchAtLoginDesired).toBe(false);
    expect(liveStatus.loginItemRegistrationCurrent).toBe(false);
    expect(preferencesStore.get()).toMatchObject({
      appearance: { lightCursorId: null },
      randomization: { source: "favorites", lastRunAt: null },
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual:stale-compensated",
        cursor: expect.objectContaining({ nativeThemeId: null }),
      }),
    );
  });

  it("compensates a stale random apply even when preference rollback fails", async () => {
    let releaseApply;
    let markApplyStarted;
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const liveStatus = verifiedActiveStatus("OreoWhite");
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const update = preferencesStore.update;
    let updateCalls = 0;
    preferencesStore.update = vi.fn((patch) => {
      updateCalls += 1;
      if (updateCalls === 3) {
        throw new Error("rollback write failed");
      }
      return update(patch);
    });
    let firstApply = true;
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: liveStatus,
      applyTheme: async (identifier) => {
        if (firstApply) {
          firstApply = false;
          markApplyStarted();
          await new Promise((resolve) => {
            releaseApply = resolve;
          });
        }
        Object.assign(liveStatus, {
          selectedNativeThemeId: identifier,
          effectiveNativeThemeId: identifier,
          launchAtLoginDesired: true,
          loginItemRegistrationCurrent: true,
        });
        return { ...liveStatus };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      random: () => 0,
      now: () => new Date("2026-08-06T20:15:00.000Z"),
    });

    const randomization = automation.randomize();
    await applyStarted;
    preferencesStore.update({
      favorites: { cursorIds: ["OreoBlack"] },
      randomization: { source: "favorites" },
    });
    releaseApply();
    const failure = await randomization.catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: "CURSOR_STALE_RANDOMIZATION_RECOVERY_FAILED",
      rollbackError: expect.objectContaining({
        message: "rollback write failed",
      }),
      compensationError: null,
    });
    expect(nativeBridge.recoverNativeState).toHaveBeenCalledOnce();
    expect(liveStatus).toMatchObject({
      effectiveNativeThemeId: "OreoWhite",
      launchAtLoginDesired: false,
      loginItemRegistrationCurrent: false,
    });
  });

  it("rolls back stale randomization preferences without reconstructing drifted prior native state", async () => {
    const liveStatus = verifiedActiveStatus("OreoWhite", {
      stateDrifted: true,
    });
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: liveStatus,
      applyTheme: async (identifier) => {
        preferencesStore.update({
          favorites: { cursorIds: [identifier] },
          randomization: { source: "favorites" },
        });
        Object.assign(
          liveStatus,
          verifiedActiveStatus(identifier, {
            launchAtLoginDesired: true,
            loginItemRegistrationCurrent: true,
          }),
        );
        return { ...liveStatus };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      random: () => 0,
      now: () => new Date("2026-08-06T20:15:00.000Z"),
    });

    const failure = await automation.randomize().catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: "CURSOR_STALE_RANDOMIZATION_RECOVERY_FAILED",
      rollbackError: null,
      compensationError: expect.objectContaining({
        code: "CURSOR_STALE_APPLY_PRIOR_STATE_UNVERIFIED",
      }),
    });
    expect(preferencesStore.get()).toMatchObject({
      appearance: { lightCursorId: null },
      randomization: { source: "favorites", lastRunAt: null },
    });
    expect(nativeBridge.recoverNativeState).not.toHaveBeenCalled();
    expect(nativeBridge.restore).not.toHaveBeenCalled();
  });

  it("does not switch appearances until automatic switching is enabled", async () => {
    let systemAppearance = "light";
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
      getSystemAppearance: () => systemAppearance,
    });

    await automation.start({ runLaunch: false });
    systemAppearance = "dark";
    await automation.appearanceChanged();

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();

    preferencesStore.update({
      appearance: { automaticSwitching: true },
    });
    await automation.reschedule();

    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
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
      getSystemAppearance: () => "light",
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

  it("skips an automatic apply when the system appearance changes in the native queue", async () => {
    let systemAppearance = "light";
    let releaseGuard;
    let markGuardReached;
    let nativeMutations = 0;
    const guardReached = new Promise((resolve) => {
      markGuardReached = resolve;
    });
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
        effectiveNativeThemeId: "Other",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    nativeBridge.applyTheme.mockImplementation(
      async (identifier, { shouldApply }) => {
        markGuardReached();
        await new Promise((resolve) => {
          releaseGuard = resolve;
        });
        if (!shouldApply()) {
          return { applySkipped: true, reason: "stale-request" };
        }
        nativeMutations += 1;
        return {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        };
      },
    );
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => systemAppearance,
      onCursorChanged: changed,
    });

    const startup = automation.start({ runLaunch: false });
    await guardReached;
    systemAppearance = "dark";
    releaseGuard();
    await startup;

    expect(nativeMutations).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    automation.stop();
  });

  it("reverts an appearance cursor that becomes stale during native execution", async () => {
    let systemAppearance = "light";
    let releaseApply;
    let markApplyStarted;
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const liveStatus = verifiedActiveStatus("OreoWhite");
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const changed = vi.fn();
    let delayNextApply = false;
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: liveStatus,
      applyTheme: async (identifier) => {
        if (delayNextApply) {
          delayNextApply = false;
          markApplyStarted();
          await new Promise((resolve) => {
            releaseApply = resolve;
          });
        }
        Object.assign(liveStatus, {
          selectedNativeThemeId: identifier,
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
          launchAtLoginDesired: true,
          loginItemRegistrationCurrent: true,
        });
        return { ...liveStatus };
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => systemAppearance,
      onCursorChanged: changed,
    });

    await automation.start({ runLaunch: false });
    systemAppearance = "dark";
    delayNextApply = true;
    const appearanceChange = automation.appearanceChanged();
    await applyStarted;
    systemAppearance = "light";
    releaseApply();

    await expect(appearanceChange).resolves.toBeNull();
    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
    expect(nativeBridge.recoverNativeState).toHaveBeenCalledWith(
      expect.objectContaining({
        previousEffectiveIdentifier: "OreoWhite",
        previousLaunchAtLoginDesired: false,
        previousLoginItemRegistrationCurrent: false,
        teardownCurrent: true,
      }),
    );
    expect(liveStatus.effectiveNativeThemeId).toBe("OreoWhite");
    expect(liveStatus.launchAtLoginDesired).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "appearance:stale-compensated",
        cursor: expect.objectContaining({ nativeThemeId: "OreoWhite" }),
      }),
    );
    automation.stop();
  });

  it("applies the fixed cursor when the OS appearance changes", async () => {
    let systemAppearance = "light";
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
      getSystemAppearance: () => systemAppearance,
    });

    await automation.start({ runLaunch: false });
    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();

    systemAppearance = "dark";
    await automation.appearanceChanged();

    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
    expect(preferencesStore.get().randomization.lastRunAt).toBeNull();
    automation.stop();
  });

  it("retries the same appearance after a transient apply failure", async () => {
    let systemAppearance = "light";
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const liveStatus = {
      effectiveNativeThemeId: "OreoWhite",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    };
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack")],
      status: liveStatus,
      applyTheme: vi
        .fn()
        .mockRejectedValueOnce(new Error("helper busy"))
        .mockImplementationOnce(async (identifier) => ({
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        })),
    });
    const errors = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => systemAppearance,
      onError: errors,
    });

    await automation.start({ runLaunch: false });
    systemAppearance = "dark";
    await automation.appearanceChanged();
    await automation.appearanceChanged();

    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(2);
    expect(nativeBridge.applyTheme).toHaveBeenLastCalledWith("OreoBlack", {
      shouldApply: expect.any(Function),
    });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "helper busy" }),
      expect.objectContaining({ reason: "appearance" }),
    );
    automation.stop();
  });

  it("bounds automatic appearance retries while allowing later explicit retries", async () => {
    let systemAppearance = "light";
    const timers = [];
    const preferencesStore = createMemoryPreferences({
      appearance: {
        automaticSwitching: true,
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite"), theme("OreoBlack"), theme("OreoGray")],
      status: {
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
      applyTheme: async () => {
        throw new Error("helper unavailable");
      },
    });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => systemAppearance,
      retryDelayMs: 1_000,
      setTimer(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
    });

    await automation.start({ runLaunch: false });
    systemAppearance = "dark";
    await automation.appearanceChanged();
    for (let expectedCalls = 2; expectedCalls <= 4; expectedCalls += 1) {
      const activeTimer = timers.findLast((timer) => !timer.cleared);
      expect(activeTimer.delay).toBe(1_000);
      activeTimer.cleared = true;
      activeTimer.callback();
      await vi.waitFor(() =>
        expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(expectedCalls),
      );
    }
    expect(timers.some((timer) => !timer.cleared)).toBe(false);

    await automation.appearanceChanged();
    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(5);
    expect(timers.some((timer) => !timer.cleared)).toBe(false);

    preferencesStore.update({
      appearance: { darkCursorId: "OreoGray" },
    });
    await automation.reschedule();
    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(6);
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(1_000);
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
      getSystemAppearance: () => "light",
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
      getSystemAppearance: () => "light",
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
    expectGuardedApply(nativeBridge.applyTheme, "OreoWhite");
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
      getSystemAppearance: () => "light",
    });

    await expect(
      automation.setAppearanceCursor("light", "OreoWhite"),
    ).rejects.toMatchObject({ code: "CURSOR_APPLY_UNVERIFIED" });

    expect(preferencesStore.get().appearance.lightCursorId).toBeNull();
  });

  it("keeps a persisted assignment when a follow-up status verifies an initially unverified apply", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      applyTheme: async () => ({ statusAvailable: false }),
    });
    nativeBridge.status
      .mockResolvedValueOnce({ effectiveNativeThemeId: "Original" })
      .mockResolvedValueOnce({
        effectiveNativeThemeId: "OreoWhite",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
    });

    await expect(
      automation.setAppearanceCursor("light", "OreoWhite"),
    ).resolves.toMatchObject({
      preferences: {
        appearance: { lightCursorId: "OreoWhite" },
      },
      status: { effectiveNativeThemeId: "OreoWhite" },
    });
    expect(preferencesStore.get().appearance.lightCursorId).toBe("OreoWhite");
  });

  it("persists a current assignment before native work and rolls it back on apply failure", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    const originalUpdate = preferencesStore.update;
    preferencesStore.update = vi.fn(originalUpdate);
    const liveStatus = {
      effectiveNativeThemeId: "Original",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    };
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: liveStatus,
      applyTheme: async () => {
        expect(preferencesStore.get().appearance.lightCursorId).toBe(
          "OreoWhite",
        );
        throw new Error("native apply failed");
      },
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      onCursorChanged: changed,
    });

    await expect(
      automation.setAppearanceCursor("light", "OreoWhite"),
    ).rejects.toThrow("native apply failed");

    expect(preferencesStore.update).toHaveBeenCalledTimes(2);
    expect(preferencesStore.get().appearance.lightCursorId).toBe("Original");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "assign:light:compensated",
        status: liveStatus,
      }),
    );
  });

  it("does not touch the native cursor when an assignment cannot be saved", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    preferencesStore.update = vi.fn(() => {
      throw new Error("preferences unavailable");
    });
    const nativeBridge = bridge({ themes: [theme("OreoWhite")] });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
    });

    await expect(
      automation.setAppearanceCursor("light", "OreoWhite"),
    ).rejects.toThrow("preferences unavailable");

    expect(nativeBridge.status).not.toHaveBeenCalled();
    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    expect(preferencesStore.get().appearance.lightCursorId).toBe("Original");
  });

  it("aggregates an assignment failure when saved preferences cannot roll back", async () => {
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    const originalUpdate = preferencesStore.update;
    let updateCalls = 0;
    preferencesStore.update = vi.fn((patch) => {
      updateCalls += 1;
      if (updateCalls === 2) {
        throw new Error("rollback write failed");
      }
      return originalUpdate(patch);
    });
    const liveStatus = {
      effectiveNativeThemeId: "Original",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    };
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: liveStatus,
      applyTheme: async () => {
        throw new Error("native apply failed");
      },
    });
    const changed = vi.fn();
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      onCursorChanged: changed,
    });

    const failure = await automation
      .setAppearanceCursor("light", "OreoWhite")
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: "APPEARANCE_ASSIGNMENT_ROLLBACK_FAILED",
      status: liveStatus,
    });
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: "native apply failed" }),
      expect.objectContaining({ message: "rollback write failed" }),
    ]);
    expect(preferencesStore.get().appearance.lightCursorId).toBe("OreoWhite");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "assign:light:compensated",
        status: liveStatus,
      }),
    );
  });

  it("does not overwrite a newer assignment when a queued apply goes stale", async () => {
    let releaseGuard;
    let markGuardReached;
    let nativeMutations = 0;
    const guardReached = new Promise((resolve) => {
      markGuardReached = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: {
        effectiveNativeThemeId: "Original",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    nativeBridge.applyTheme.mockImplementation(
      async (identifier, { shouldApply }) => {
        markGuardReached();
        await new Promise((resolve) => {
          releaseGuard = resolve;
        });
        if (!shouldApply()) {
          return { applySkipped: true, reason: "stale-request" };
        }
        nativeMutations += 1;
        return {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        };
      },
    );
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
    });

    const assignment = automation.setAppearanceCursor("light", "OreoWhite");
    await guardReached;
    preferencesStore.update({
      appearance: { lightCursorId: "NewerChoice" },
    });
    releaseGuard();

    await expect(assignment).resolves.toMatchObject({
      preferences: {
        appearance: { lightCursorId: "NewerChoice" },
      },
      status: null,
    });
    expect(nativeMutations).toBe(0);
    expect(preferencesStore.get().appearance.lightCursorId).toBe("NewerChoice");
  });

  it("returns preferences with unrelated edits made during an assignment apply", async () => {
    let releaseApply;
    let markApplyReached;
    const applyReached = new Promise((resolve) => {
      markApplyReached = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      appearance: { lightCursorId: "Original" },
    });
    const nativeBridge = bridge({
      themes: [theme("OreoWhite")],
      status: {
        effectiveNativeThemeId: "Original",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      },
    });
    nativeBridge.applyTheme.mockImplementation(
      async (identifier, { shouldApply }) => {
        markApplyReached();
        await new Promise((resolve) => {
          releaseApply = resolve;
        });
        expect(shouldApply()).toBe(true);
        return {
          effectiveNativeThemeId: identifier,
          effectiveApplied: true,
          currentSentinelsMatchTheme: true,
        };
      },
    );
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
    });

    const assignment = automation.setAppearanceCursor("light", "OreoWhite");
    await applyReached;
    preferencesStore.update({ menuBar: { visible: false } });
    releaseApply();

    await expect(assignment).resolves.toMatchObject({
      preferences: {
        appearance: { lightCursorId: "OreoWhite" },
        menuBar: { visible: false },
      },
      status: { effectiveNativeThemeId: "OreoWhite" },
    });
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
      getSystemAppearance: () => "light",
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
    let systemAppearance = "light";
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
      getSystemAppearance: () => systemAppearance,
      onCursorChanged: changed,
    });

    await automation.start({ runLaunch: false });
    systemAppearance = "dark";
    await automation.wake();

    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
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
      getSystemAppearance: () => "light",
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

    preferencesStore.update({ menuBar: { visible: false } });
    await automation.reschedule();
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(60_000);

    preferencesStore.update({ favorites: { cursorIds: ["OreoWhite"] } });
    await automation.reschedule();
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(60_000);

    current = new Date("2026-08-06T12:00:01.000Z");
    await automation.reschedule();
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(59_000);
    automation.stop();
  });

  it.each([
    ["daily", { mode: "daily", dailyTime: "09:00" }],
    ["times", { mode: "times", times: ["09:00", "17:00"] }],
  ])(
    "preserves an overdue retry when unrelated preferences reschedule a %s timer",
    async (_mode, schedule) => {
      let current = new Date(2026, 7, 6, 8, 0);
      const timers = [];
      const preferencesStore = createMemoryPreferences({
        randomization: { source: "all", schedule },
      });
      const nativeBridge = bridge({
        themes: [theme("OreoWhite")],
        applyTheme: async () => {
          throw new Error("busy");
        },
      });
      const automation = createCursorAutomation({
        bridge: nativeBridge,
        preferencesStore,
        getSystemAppearance: () => "light",
        now: () => current,
        setTimer(callback, delay) {
          const timer = { callback, delay, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimer(timer) {
          timer.cleared = true;
        },
        retryDelayMs: 60_000,
      });

      await automation.start({ runLaunch: false });
      const scheduledTimer = timers.findLast((timer) => !timer.cleared);
      expect(scheduledTimer.delay).toBe(60 * 60 * 1_000);

      current = new Date(2026, 7, 6, 9, 0);
      scheduledTimer.callback();
      await automation.reschedule();
      expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
      expect(timers.findLast((timer) => !timer.cleared).delay).toBe(60_000);

      current = new Date(2026, 7, 6, 9, 2);
      preferencesStore.update({ menuBar: { visible: false } });
      await automation.reschedule();

      expect(automation.getNextRunAt()).toEqual(new Date(2026, 7, 6, 9, 1));
      expect(timers.findLast((timer) => !timer.cleared).delay).toBe(250);
      automation.stop();
    },
  );

  it("invalidates a fired timer when its interval changes before the queued run", async () => {
    let current = new Date("2026-08-06T12:00:00.000Z");
    const timers = [];
    const preferencesStore = createMemoryPreferences({
      randomization: {
        source: "all",
        schedule: { mode: "interval", intervalHours: 1 },
        lastRunAt: "2026-08-06T12:00:00.000Z",
      },
    });
    const nativeBridge = bridge({ themes: [theme("OreoWhite")] });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      now: () => current,
      setTimer(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
    });

    await automation.start({ runLaunch: false });
    const oldTimer = timers.findLast((timer) => !timer.cleared);
    expect(oldTimer.delay).toBe(60 * 60 * 1_000);

    current = new Date("2026-08-06T13:00:00.000Z");
    oldTimer.cleared = true;
    oldTimer.callback();
    preferencesStore.update({
      randomization: {
        schedule: { mode: "interval", intervalHours: 24 },
      },
    });
    await automation.reschedule();

    expect(nativeBridge.applyTheme).not.toHaveBeenCalled();
    expect(automation.getNextRunAt()?.toISOString()).toBe(
      "2026-08-07T12:00:00.000Z",
    );
    expect(timers.findLast((timer) => !timer.cleared).delay).toBe(
      23 * 60 * 60 * 1_000,
    );
    automation.stop();
  });

  it("uses the latest randomization pool after asynchronous discovery", async () => {
    let resolveThemes;
    const themesPromise = new Promise((resolve) => {
      resolveThemes = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      favorites: { cursorIds: ["OreoWhite"] },
      randomization: { source: "favorites" },
    });
    const nativeBridge = bridge({
      status: { effectiveNativeThemeId: "Current" },
    });
    nativeBridge.listThemes.mockImplementationOnce(() => themesPromise);
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
      random: () => 0,
    });

    const randomization = automation.randomize();
    await vi.waitFor(() => expect(nativeBridge.listThemes).toHaveBeenCalled());
    preferencesStore.update({
      favorites: { cursorIds: ["OreoBlack"] },
    });
    resolveThemes([theme("OreoWhite"), theme("OreoBlack")]);
    await randomization;

    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
    expectGuardedApply(nativeBridge.applyTheme, "OreoBlack");
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
      getSystemAppearance: () => "light",
    });

    await automation.start();
    await automation.start();

    expect(nativeBridge.applyTheme).toHaveBeenCalledTimes(1);
    automation.stop();
  });

  it("runs external cursor state work exclusively with automation mutations", async () => {
    let releaseExclusive;
    let markExclusiveStarted;
    const exclusiveStarted = new Promise((resolve) => {
      markExclusiveStarted = resolve;
    });
    const preferencesStore = createMemoryPreferences({
      randomization: { source: "all" },
    });
    const nativeBridge = bridge({ themes: [theme("OreoWhite")] });
    const automation = createCursorAutomation({
      bridge: nativeBridge,
      preferencesStore,
      getSystemAppearance: () => "light",
    });
    const operation = vi.fn(async () => {
      markExclusiveStarted();
      await new Promise((resolve) => {
        releaseExclusive = resolve;
      });
      return "restored";
    });

    const exclusive = automation.runExclusive(operation);
    await exclusiveStarted;
    const randomization = automation.randomize();
    await Promise.resolve();

    expect(operation).toHaveBeenCalledWith();
    expect(nativeBridge.listThemes).not.toHaveBeenCalled();

    releaseExclusive();
    await expect(exclusive).resolves.toBe("restored");
    await randomization;
    expect(nativeBridge.applyTheme).toHaveBeenCalledOnce();
  });
});
