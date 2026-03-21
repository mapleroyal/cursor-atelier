import { describe, expect, it, vi } from "vitest";

import { createAppStore, getElectronTheme, getInitialTheme } from "./app-store";

function createStorage(initialTheme = null) {
  let value = initialTheme;

  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_, nextTheme) => {
      value = nextTheme;
    }),
  };
}

function createElectronAPI(theme = null) {
  return {
    getSystemTheme: vi.fn(() => theme),
  };
}

describe("app store theme behavior", () => {
  it("prefers a persisted user theme over Electron and OS defaults", () => {
    const storage = createStorage("dark");
    const electronAPI = createElectronAPI("light");
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(getInitialTheme({ electronAPI, matchMedia, storage })).toBe("dark");
    expect(electronAPI.getSystemTheme).not.toHaveBeenCalled();
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("reads the preload-provided system theme when available", () => {
    const electronAPI = createElectronAPI("dark");

    expect(getElectronTheme(electronAPI)).toBe("dark");
    expect(electronAPI.getSystemTheme).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Electron system theme before matchMedia", () => {
    const electronAPI = createElectronAPI("dark");
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(getInitialTheme({ electronAPI, matchMedia })).toBe("dark");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("falls back to OS preference when storage and Electron theme are unavailable", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(getInitialTheme({ matchMedia })).toBe("dark");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("store starts with the Electron system theme when no persisted theme exists", () => {
    const electronAPI = createElectronAPI("dark");
    const store = createAppStore({ electronAPI });

    expect(store.getState().theme).toBe("dark");
  });

  it("setTheme updates and persists theme values", () => {
    const storage = createStorage();
    const store = createAppStore({ storage });

    store.getState().setTheme("dark");
    expect(store.getState().theme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "dark");

    store.getState().setTheme("light");
    expect(store.getState().theme).toBe("light");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "light");
  });

  it("toggleTheme flips and persists in both directions", () => {
    const storage = createStorage("light");
    const store = createAppStore({ storage });

    store.getState().toggleTheme();
    expect(store.getState().theme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "dark");

    store.getState().toggleTheme();
    expect(store.getState().theme).toBe("light");
    expect(storage.setItem).toHaveBeenLastCalledWith("app-theme", "light");
  });
});
