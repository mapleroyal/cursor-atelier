import { describe, expect, it, vi } from "vitest";

import { createCursorPreferencesStore } from "./cursor-preferences-store.js";
import {
  isVerifiedRestoredStatus,
  restoreCursorState,
} from "./cursor-state-service.js";

function controlledStore({ failClear = false, failRollback = false } = {}) {
  let writes = 0;
  class Store {
    constructor({ defaults }) {
      this.data = structuredClone(defaults);
      this.data.preferences.appearance.lightCursorId = "OreoWhite";
      this.data.preferences.appearance.darkCursorId = "OreoBlack";
    }

    get(key) {
      return structuredClone(this.data[key]);
    }

    set(key, value) {
      if (key === "preferences") {
        writes += 1;
        if (failClear && writes === 1) {
          throw new Error("clear write failed");
        }
        if (failRollback && writes === 2) {
          throw new Error("rollback write failed");
        }
      }
      this.data[key] = structuredClone(value);
    }
  }
  return createCursorPreferencesStore({ directory: "/tmp/state-test", Store });
}

function verifiedRestoredStatus(overrides = {}) {
  return {
    bridgeAvailable: true,
    supported: true,
    previewMode: false,
    statusAvailable: true,
    currentSentinelsMatchTheme: false,
    desiredEnabled: false,
    persistedEffectiveApplied: false,
    effectiveApplied: false,
    launchAtLoginDesired: false,
    loginItemRegistrationCurrent: false,
    transactionPending: false,
    ...overrides,
  };
}

describe("cursor state restore", () => {
  it("rejects authoritative-looking restore statuses with missing state flags", () => {
    const incompleteStatus = verifiedRestoredStatus();
    delete incompleteStatus.transactionPending;

    expect(isVerifiedRestoredStatus(incompleteStatus)).toBe(false);
  });

  it("does not touch native state when clearing assignments cannot persist", async () => {
    const bridge = { restore: vi.fn() };
    const preferencesStore = controlledStore({ failClear: true });

    await expect(
      restoreCursorState({ bridge, preferencesStore }),
    ).rejects.toThrow("clear write failed");

    expect(bridge.restore).not.toHaveBeenCalled();
    expect(preferencesStore.get().appearance).toMatchObject({
      lightCursorId: "OreoWhite",
      darkCursorId: "OreoBlack",
    });
  });

  it("rolls assignments back when native restore fails", async () => {
    const bridge = {
      restore: vi.fn(async () => {
        throw new Error("native restore failed");
      }),
    };
    const preferencesStore = controlledStore();

    await expect(
      restoreCursorState({ bridge, preferencesStore }),
    ).rejects.toThrow("native restore failed");

    expect(preferencesStore.get().appearance).toMatchObject({
      lightCursorId: "OreoWhite",
      darkCursorId: "OreoBlack",
    });
  });

  it("rolls back only assignments that are still cleared after a native failure", async () => {
    let rejectRestore;
    let markRestoreStarted;
    const restoreStarted = new Promise((resolve) => {
      markRestoreStarted = resolve;
    });
    const bridge = {
      restore: vi.fn(() => {
        markRestoreStarted();
        return new Promise((_resolve, reject) => {
          rejectRestore = reject;
        });
      }),
    };
    const preferencesStore = controlledStore();

    const restoration = restoreCursorState({
      bridge,
      preferencesStore,
    }).catch((error) => error);
    await restoreStarted;
    preferencesStore.update({
      appearance: { lightCursorId: "NewerLight" },
      menuBar: { visible: false },
    });
    rejectRestore(new Error("native restore failed"));

    await expect(restoration).resolves.toMatchObject({
      message: "native restore failed",
    });
    expect(preferencesStore.get()).toMatchObject({
      appearance: {
        lightCursorId: "NewerLight",
        darkCursorId: "OreoBlack",
      },
      menuBar: { visible: false },
    });
  });

  it("surfaces an explicit aggregate error when rollback also fails", async () => {
    const bridge = {
      restore: vi.fn(async () => {
        throw new Error("native restore failed");
      }),
    };
    const preferencesStore = controlledStore({ failRollback: true });

    await expect(
      restoreCursorState({ bridge, preferencesStore }),
    ).rejects.toMatchObject({
      code: "CURSOR_RESTORE_ROLLBACK_FAILED",
      errors: [
        expect.objectContaining({ message: "native restore failed" }),
        expect.objectContaining({ message: "rollback write failed" }),
      ],
    });
  });

  it("returns status and cleared preferences only after both commit", async () => {
    const status = verifiedRestoredStatus();
    const bridge = { restore: vi.fn(async () => status) };
    const preferencesStore = controlledStore();
    const onRestored = vi.fn();

    await expect(
      restoreCursorState({ bridge, preferencesStore, onRestored }),
    ).resolves.toEqual({
      status,
      preferences: expect.objectContaining({
        appearance: expect.objectContaining({
          lightCursorId: null,
          darkCursorId: null,
        }),
      }),
    });
    expect(onRestored).toHaveBeenCalledWith(status);
  });

  it("commits when a failed native command carries verified restored state", async () => {
    const status = verifiedRestoredStatus();
    const transportError = Object.assign(
      new Error("native command exited before reporting success"),
      { status },
    );
    const bridge = {
      restore: vi.fn(async () => Promise.reject(transportError)),
    };
    const preferencesStore = controlledStore();
    const onRestored = vi.fn();
    const onRestoreFailed = vi.fn();

    await expect(
      restoreCursorState({
        bridge,
        preferencesStore,
        onRestored,
        onRestoreFailed,
      }),
    ).resolves.toEqual({
      status,
      preferences: expect.objectContaining({
        appearance: expect.objectContaining({
          lightCursorId: null,
          darkCursorId: null,
        }),
      }),
    });
    expect(onRestored).toHaveBeenCalledWith(status);
    expect(onRestoreFailed).not.toHaveBeenCalled();
  });

  it("returns the authoritative preferences after a concurrent successful restore", async () => {
    let resolveRestore;
    let markRestoreStarted;
    const restoreStarted = new Promise((resolve) => {
      markRestoreStarted = resolve;
    });
    const status = verifiedRestoredStatus();
    const bridge = {
      restore: vi.fn(() => {
        markRestoreStarted();
        return new Promise((resolve) => {
          resolveRestore = resolve;
        });
      }),
    };
    const preferencesStore = controlledStore();

    const restoration = restoreCursorState({ bridge, preferencesStore });
    await restoreStarted;
    preferencesStore.update({
      appearance: { darkCursorId: "NewerDark" },
      menuBar: { visible: false },
    });
    resolveRestore(status);

    await expect(restoration).resolves.toEqual({
      status,
      preferences: expect.objectContaining({
        appearance: expect.objectContaining({
          lightCursorId: null,
          darkCursorId: "NewerDark",
        }),
        menuBar: { visible: false },
      }),
    });
  });

  it("does not report a committed restore as failed when notification throws", async () => {
    const status = verifiedRestoredStatus();
    const bridge = { restore: vi.fn(async () => status) };
    const preferencesStore = controlledStore();
    const notificationErrors = [];

    await expect(
      restoreCursorState({
        bridge,
        preferencesStore,
        onRestored() {
          throw new Error("renderer disappeared");
        },
        onNotificationError: (error) => notificationErrors.push(error),
      }),
    ).resolves.toMatchObject({ status });
    expect(notificationErrors).toEqual([
      expect.objectContaining({ message: "renderer disappeared" }),
    ]);
  });

  it("rolls assignments back and publishes status when native restore is unverified", async () => {
    const status = verifiedRestoredStatus({ desiredEnabled: true });
    const bridge = { restore: vi.fn(async () => status) };
    const preferencesStore = controlledStore();
    const onRestoreFailed = vi.fn();

    await expect(
      restoreCursorState({ bridge, preferencesStore, onRestoreFailed }),
    ).rejects.toMatchObject({
      code: "CURSOR_RESTORE_UNVERIFIED",
      status,
    });
    expect(preferencesStore.get().appearance).toMatchObject({
      lightCursorId: "OreoWhite",
      darkCursorId: "OreoBlack",
    });
    expect(onRestoreFailed).toHaveBeenCalledWith(status);
  });

  it.each([
    ["native bridge is unavailable", { bridgeAvailable: false }],
    ["platform is unsupported", { supported: false }],
    ["bridge is in preview mode", { previewMode: true }],
  ])(
    "rejects restored-looking state when the %s",
    async (_label, overrides) => {
      const status = verifiedRestoredStatus(overrides);
      const preferencesStore = controlledStore();

      await expect(
        restoreCursorState({
          bridge: { restore: vi.fn(async () => status) },
          preferencesStore,
        }),
      ).rejects.toMatchObject({ code: "CURSOR_RESTORE_UNVERIFIED", status });
      expect(preferencesStore.get().appearance).toMatchObject({
        lightCursorId: "OreoWhite",
        darkCursorId: "OreoBlack",
      });
    },
  );

  it("fails closed when restored status omits sentinel verification", async () => {
    const status = verifiedRestoredStatus();
    delete status.currentSentinelsMatchTheme;
    const preferencesStore = controlledStore();

    await expect(
      restoreCursorState({
        bridge: { restore: vi.fn(async () => status) },
        preferencesStore,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_RESTORE_UNVERIFIED", status });
    expect(preferencesStore.get().appearance).toMatchObject({
      lightCursorId: "OreoWhite",
      darkCursorId: "OreoBlack",
    });
  });

  it("preserves failure status through rollback errors", async () => {
    const status = verifiedRestoredStatus({ transactionPending: true });
    const nativeError = Object.assign(new Error("native restore failed"), {
      status,
    });
    const bridge = { restore: vi.fn(async () => Promise.reject(nativeError)) };
    const preferencesStore = controlledStore({ failRollback: true });
    const onRestoreFailed = vi.fn();

    await expect(
      restoreCursorState({ bridge, preferencesStore, onRestoreFailed }),
    ).rejects.toMatchObject({
      code: "CURSOR_RESTORE_ROLLBACK_FAILED",
      status,
    });
    expect(onRestoreFailed).toHaveBeenCalledWith(status);
  });
});
