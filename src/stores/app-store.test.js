import { describe, expect, it, vi } from "vitest";

import {
  applyThemeToDocument,
  createAppStore,
  getElectronTheme,
  getInitialTheme,
  getInitialThemeMode,
  getStoredThemeMode,
  resolveTheme,
  subscribeToSystemTheme,
} from "./app-store";

function createStorage(initialThemeMode = null) {
  let value = initialThemeMode;

  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_, nextThemeMode) => {
      value = nextThemeMode;
    }),
  };
}

function createElectronAPI(theme = null) {
  return {
    getSystemTheme: vi.fn(() => theme),
  };
}

function createMatchMediaController(initialTheme = "light") {
  let matches = initialTheme === "dark";
  const listeners = new Set();

  const mediaQueryList = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((eventName, listener) => {
      if (eventName === "change") {
        listeners.add(listener);
      }
    }),
    removeEventListener: vi.fn((eventName, listener) => {
      if (eventName === "change") {
        listeners.delete(listener);
      }
    }),
  };

  return {
    matchMedia: vi.fn(() => mediaQueryList),
    setTheme(nextTheme) {
      matches = nextTheme === "dark";

      for (const listener of listeners) {
        listener({ matches });
      }
    },
  };
}

describe("app store theme behavior", () => {
  it("defaults to following the system theme when nothing is stored", () => {
    expect(getInitialThemeMode()).toBe("system");
  });

  it("prefers a persisted explicit theme over Electron and OS defaults", () => {
    const storage = createStorage("dark");
    const electronAPI = createElectronAPI("light");
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(getStoredThemeMode(storage)).toBe("dark");
    expect(getInitialThemeMode({ storage })).toBe("dark");
    expect(getInitialTheme({ electronAPI, matchMedia, storage })).toBe("dark");
    expect(electronAPI.getSystemTheme).not.toHaveBeenCalled();
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("reads the preload-provided system theme when available", () => {
    const electronAPI = createElectronAPI("dark");

    expect(getElectronTheme(electronAPI)).toBe("dark");
    expect(electronAPI.getSystemTheme).toHaveBeenCalledTimes(1);
  });

  it("falls back to OS preference when Electron theme is unavailable", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(getInitialTheme({ matchMedia })).toBe("dark");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("resolves system mode into the current effective theme", () => {
    const electronAPI = createElectronAPI("light");

    expect(resolveTheme("system", { electronAPI })).toBe("light");
  });

  it("store starts in system mode and resolves the current system theme", () => {
    const electronAPI = createElectronAPI("dark");
    const store = createAppStore({ electronAPI });

    expect(store.getState().themeMode).toBe("system");
    expect(store.getState().theme).toBe("dark");
  });

  it("setTheme updates and persists explicit theme values", () => {
    const storage = createStorage();
    const store = createAppStore({ storage });

    store.getState().setTheme("dark");
    expect(store.getState().themeMode).toBe("dark");
    expect(store.getState().theme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "dark");

    store.getState().setTheme("light");
    expect(store.getState().themeMode).toBe("light");
    expect(store.getState().theme).toBe("light");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "light");
  });

  it("can switch back to following the current system theme", () => {
    const electronAPI = createElectronAPI("dark");
    const storage = createStorage("light");
    const store = createAppStore({ electronAPI, storage });

    store.getState().followSystemTheme();

    expect(store.getState().themeMode).toBe("system");
    expect(store.getState().theme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "system");
  });

  it("syncs with system theme changes while in system mode", () => {
    const controller = createMatchMediaController("light");
    const store = createAppStore({ matchMedia: controller.matchMedia });

    const unsubscribe = subscribeToSystemTheme(
      store.getState().syncSystemTheme,
      controller.matchMedia,
    );

    controller.setTheme("dark");

    expect(store.getState().themeMode).toBe("system");
    expect(store.getState().theme).toBe("dark");

    unsubscribe();
  });

  it("ignores system theme changes after an explicit theme override", () => {
    const controller = createMatchMediaController("light");
    const store = createAppStore({ matchMedia: controller.matchMedia });

    store.getState().setTheme("dark");

    const unsubscribe = subscribeToSystemTheme(
      store.getState().syncSystemTheme,
      controller.matchMedia,
    );

    controller.setTheme("light");

    expect(store.getState().themeMode).toBe("dark");
    expect(store.getState().theme).toBe("dark");

    unsubscribe();
  });

  it("toggleTheme makes the effective theme explicit and persists it", () => {
    const storage = createStorage("system");
    const controller = createMatchMediaController("light");
    const store = createAppStore({
      matchMedia: controller.matchMedia,
      storage,
    });

    store.getState().toggleTheme();
    expect(store.getState().themeMode).toBe("dark");
    expect(store.getState().theme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "dark");

    store.getState().toggleTheme();
    expect(store.getState().themeMode).toBe("light");
    expect(store.getState().theme).toBe("light");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "light");
  });

  it("applies the current theme to the document root", () => {
    const toggle = vi.fn();
    const element = {
      classList: {
        toggle,
      },
      style: {},
    };

    applyThemeToDocument("dark", element);

    expect(toggle).toHaveBeenCalledWith("dark", true);
    expect(element.style.colorScheme).toBe("dark");
    expect(element.style.backgroundColor).toBe("oklch(0.145 0 0)");
  });
});
