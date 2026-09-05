import { describe, expect, it, vi } from "vitest";

import {
  GET_APP_APPEARANCE_MODE_CHANNEL,
  GET_SYSTEM_APPEARANCE_CHANNEL,
  registerAppAppearanceIpc,
  SET_APP_APPEARANCE_MODE_CHANNEL,
  syncWindowBackgroundColors,
} from "./app-appearance-ipc.js";

function fixture({
  nativeTheme = { themeSource: "system" },
  onAppearanceChanged = vi.fn(),
  onAppearanceChangeError = vi.fn(),
  preferencesStore: providedPreferencesStore = null,
} = {}) {
  const listeners = new Map();
  const handlers = new Map();
  const ipcMain = {
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeListener: vi.fn((channel, listener) => {
      if (listeners.get(channel) === listener) {
        listeners.delete(channel);
      }
    }),
    removeHandler: vi.fn((channel) => handlers.delete(channel)),
  };
  let mode = "dark";
  const preferencesStore = providedPreferencesStore ?? {
    getAppAppearanceMode: vi.fn(() => mode),
    setAppAppearanceMode: vi.fn((nextMode) => {
      if (!new Set(["system", "light", "dark"]).has(nextMode)) {
        throw new TypeError("invalid appearance");
      }
      mode = nextMode;
      return mode;
    }),
  };
  const dispose = registerAppAppearanceIpc({
    ipcMain,
    preferencesStore,
    nativeTheme,
    isTrustedSender: (event) => event.trusted === true,
    getSystemAppearance: () => "light",
    onAppearanceChanged,
    onAppearanceChangeError,
  });
  return {
    dispose,
    handlers,
    listeners,
    ipcMain,
    nativeTheme,
    onAppearanceChanged,
    onAppearanceChangeError,
    preferencesStore,
  };
}

describe("app appearance IPC", () => {
  it("returns desktop appearance independently of a forced application mode", () => {
    const { listeners, nativeTheme } = fixture({
      nativeTheme: { themeSource: "dark" },
    });
    const event = { trusted: true };
    listeners.get(GET_SYSTEM_APPEARANCE_CHANNEL)(event);
    expect(event.returnValue).toBe("light");
    expect(nativeTheme.themeSource).toBe("dark");
    const untrusted = { trusted: false };
    listeners.get(GET_SYSTEM_APPEARANCE_CHANNEL)(untrusted);
    expect(untrusted.returnValue).toBeNull();
  });

  it("returns the persisted mode synchronously only to a trusted renderer", () => {
    const { listeners, preferencesStore } = fixture();
    const listener = listeners.get(GET_APP_APPEARANCE_MODE_CHANNEL);
    const trustedEvent = { trusted: true, returnValue: undefined };
    const untrustedEvent = { trusted: false, returnValue: undefined };

    listener(trustedEvent);
    listener(untrustedEvent);

    expect(trustedEvent.returnValue).toBe("dark");
    expect(untrustedEvent.returnValue).toBe("system");
    expect(preferencesStore.getAppAppearanceMode).toHaveBeenCalledOnce();
  });

  it("keeps writes validated and main-owned", () => {
    const { handlers, nativeTheme, onAppearanceChanged, preferencesStore } =
      fixture();
    const handler = handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL);
    const sender = { id: 7 };

    expect(handler({ trusted: true, sender }, "light")).toBe("light");
    expect(preferencesStore.setAppAppearanceMode).toHaveBeenCalledWith("light");
    expect(nativeTheme.themeSource).toBe("light");
    expect(onAppearanceChanged).toHaveBeenCalledWith("light", sender);
    expect(() => handler({ trusted: false }, "dark")).toThrow(
      "unavailable to this page",
    );
  });

  it("does not touch the native theme when persistence fails", () => {
    const persistenceError = new Error("disk full");
    const setNativeTheme = vi.fn();
    const nativeTheme = {};
    Object.defineProperty(nativeTheme, "themeSource", {
      configurable: true,
      get: () => "system",
      set: setNativeTheme,
    });
    const preferencesStore = {
      getAppAppearanceMode: vi.fn(() => "dark"),
      setAppAppearanceMode: vi.fn(() => {
        throw persistenceError;
      }),
    };
    const { handlers, onAppearanceChanged } = fixture({
      nativeTheme,
      preferencesStore,
    });

    expect(() =>
      handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL)({ trusted: true }, "light"),
    ).toThrow(persistenceError);
    expect(setNativeTheme).not.toHaveBeenCalled();
    expect(onAppearanceChanged).not.toHaveBeenCalled();
  });

  it("restores the prior persisted and native modes when native assignment fails", () => {
    const assignmentError = new Error("native theme rejected the change");
    let nativeMode = "system";
    const nativeAssignments = [];
    const nativeTheme = {};
    Object.defineProperty(nativeTheme, "themeSource", {
      configurable: true,
      get: () => nativeMode,
      set: (nextMode) => {
        nativeAssignments.push(nextMode);
        nativeMode = nextMode;
        if (nextMode === "light") {
          throw assignmentError;
        }
      },
    });
    const { handlers, onAppearanceChanged, preferencesStore } = fixture({
      nativeTheme,
    });

    expect(() =>
      handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL)({ trusted: true }, "light"),
    ).toThrow(assignmentError);
    expect(nativeAssignments).toEqual(["light", "system"]);
    expect(nativeMode).toBe("system");
    expect(preferencesStore.getAppAppearanceMode()).toBe("dark");
    expect(preferencesStore.setAppAppearanceMode).toHaveBeenNthCalledWith(
      2,
      "dark",
    );
    expect(onAppearanceChanged).not.toHaveBeenCalled();
  });

  it("aggregates rollback failures after attempting both compensations", () => {
    const assignmentError = new Error("native assignment failed");
    const nativeRollbackError = new Error("native rollback failed");
    const preferenceRollbackError = new Error("preference rollback failed");
    let nativeMode = "system";
    let persistedMode = "dark";
    const nativeTheme = {};
    Object.defineProperty(nativeTheme, "themeSource", {
      configurable: true,
      get: () => nativeMode,
      set: (nextMode) => {
        if (nextMode === "light") {
          nativeMode = nextMode;
          throw assignmentError;
        }
        throw nativeRollbackError;
      },
    });
    const preferencesStore = {
      getAppAppearanceMode: vi.fn(() => persistedMode),
      setAppAppearanceMode: vi.fn((nextMode) => {
        if (nextMode === "dark") {
          throw preferenceRollbackError;
        }
        persistedMode = nextMode;
        return persistedMode;
      }),
    };
    const { handlers } = fixture({ nativeTheme, preferencesStore });

    let failure;
    try {
      handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL)({ trusted: true }, "light");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: "APP_APPEARANCE_ROLLBACK_FAILED",
      cause: assignmentError,
      rollbackErrors: [nativeRollbackError, preferenceRollbackError],
    });
    expect(failure.errors).toEqual([
      assignmentError,
      nativeRollbackError,
      preferenceRollbackError,
    ]);
    expect(preferencesStore.setAppAppearanceMode).toHaveBeenCalledTimes(2);
  });

  it("keeps a committed change successful when the refresh callback throws", () => {
    const refreshError = new Error("window disappeared");
    const onAppearanceChanged = vi.fn(() => {
      throw refreshError;
    });
    const onAppearanceChangeError = vi.fn();
    const { handlers, nativeTheme, preferencesStore } = fixture({
      onAppearanceChanged,
      onAppearanceChangeError,
    });

    expect(
      handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL)({ trusted: true }, "light"),
    ).toBe("light");
    expect(preferencesStore.getAppAppearanceMode()).toBe("light");
    expect(nativeTheme.themeSource).toBe("light");
    expect(onAppearanceChangeError).toHaveBeenCalledWith(refreshError, {
      operation: "appearance-changed",
      mode: "light",
    });
  });

  it("contains an asynchronous refresh rejection after commit", async () => {
    const refreshError = new Error("refresh rejected");
    const onAppearanceChangeError = vi.fn();
    const { handlers } = fixture({
      onAppearanceChanged: () => Promise.reject(refreshError),
      onAppearanceChangeError,
    });

    expect(
      handlers.get(SET_APP_APPEARANCE_MODE_CHANNEL)({ trusted: true }, "light"),
    ).toBe("light");
    await vi.waitFor(() => {
      expect(onAppearanceChangeError).toHaveBeenCalledWith(refreshError, {
        operation: "appearance-changed",
        mode: "light",
      });
    });
  });

  it("removes both handlers during shutdown", () => {
    const { dispose, handlers, listeners, ipcMain } = fixture();

    dispose();

    expect(listeners.has(GET_APP_APPEARANCE_MODE_CHANNEL)).toBe(false);
    expect(handlers.has(SET_APP_APPEARANCE_MODE_CHANNEL)).toBe(false);
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(2);
    expect(ipcMain.removeHandler).toHaveBeenCalledOnce();
  });
});

describe("window background synchronization", () => {
  it("continues after a window fails and skips destroyed windows", () => {
    const backgroundError = new Error("window was closing");
    const failedWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(() => {
        throw backgroundError;
      }),
    };
    const laterWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    const destroyedWindow = {
      isDestroyed: () => true,
      setBackgroundColor: vi.fn(),
    };
    const onWindowError = vi.fn();

    syncWindowBackgroundColors({
      windows: [failedWindow, laterWindow, destroyedWindow],
      backgroundColor: "#123456",
      onWindowError,
    });

    expect(onWindowError).toHaveBeenCalledWith(backgroundError, {
      operation: "window-background",
      window: failedWindow,
      backgroundColor: "#123456",
    });
    expect(laterWindow.setBackgroundColor).toHaveBeenCalledWith("#123456");
    expect(destroyedWindow.setBackgroundColor).not.toHaveBeenCalled();
  });
});
