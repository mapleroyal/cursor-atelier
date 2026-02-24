import { afterEach, describe, expect, it, vi } from "vitest";

function createMatchMediaMock(prefersDark) {
  return vi.fn().mockImplementation((query) => ({
    matches: query === "(prefers-color-scheme: dark)" ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function loadStore({ systemTheme, prefersDark = false } = {}) {
  vi.resetModules();

  globalThis.window = {
    electronAPI:
      systemTheme === undefined ? {} : { getSystemTheme: () => systemTheme },
    matchMedia: createMatchMediaMock(prefersDark),
  };

  const { useAppStore } = await import("./app-store");
  return useAppStore;
}

afterEach(() => {
  vi.resetModules();
  delete globalThis.window;
});

describe("app store theme behavior", () => {
  it("initializes from the Electron-provided system theme when available", async () => {
    const useAppStore = await loadStore({ systemTheme: "dark" });

    expect(useAppStore.getState().theme).toBe("dark");
    expect(useAppStore.getState().themeSource).toBe("system");
  });

  it("falls back to prefers-color-scheme when Electron theme is unavailable", async () => {
    const useAppStore = await loadStore({ prefersDark: true });

    expect(useAppStore.getState().theme).toBe("dark");
    expect(useAppStore.getState().themeSource).toBe("system");
  });

  it("allows a manual toggle and reset back to system theme for the current session", async () => {
    const useAppStore = await loadStore({ systemTheme: "light" });

    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("dark");
    expect(useAppStore.getState().themeSource).toBe("manual");

    useAppStore.getState().initializeThemeFromSystem();
    expect(useAppStore.getState().theme).toBe("light");
    expect(useAppStore.getState().themeSource).toBe("system");
  });
});
