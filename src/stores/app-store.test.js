import { describe, expect, it, vi } from "vitest";

import {
  applyThemeToDocument,
  createAppStore,
  getAppAppearanceMode,
  getInitialTheme,
  getInitialThemeMode,
  resolveTheme,
  subscribeToSystemTheme,
} from "./app-store";

function createElectronAPI(appearanceMode = "system") {
  return {
    getAppAppearanceMode: vi.fn(() => appearanceMode),
    setAppAppearanceMode: vi.fn(async (mode) => mode),
    getOnboardingState: vi.fn(async () => ({
      version: 2,
      completed: false,
      jobs: [],
    })),
    startOnboarding: vi.fn(async (familyIds) => ({
      version: 2,
      completed: true,
      jobs: familyIds.map((familyId) => ({ familyId, status: "queued" })),
    })),
    retryOnboardingImport: vi.fn(async (familyId) => ({
      version: 2,
      completed: true,
      jobs: [{ familyId, status: "queued" }],
    })),
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
  it("keeps desktop appearance separate from an explicit application theme", async () => {
    const electronAPI = {
      ...createElectronAPI("dark"),
      getSystemAppearance: () => "light",
    };
    const store = createAppStore({ electronAPI });
    expect(store.getState()).toMatchObject({
      theme: "dark",
      systemAppearance: "light",
    });
    await store.getState().setThemeMode("light");
    store.getState().syncDesktopAppearance("dark");
    expect(store.getState()).toMatchObject({
      theme: "light",
      systemAppearance: "dark",
    });
  });

  it("keeps imported appearance authoritative when an earlier save replies late", async () => {
    let completeSave;
    const electronAPI = createElectronAPI("system");
    electronAPI.setAppAppearanceMode.mockReturnValue(
      new Promise((resolve) => {
        completeSave = resolve;
      }),
    );
    const store = createAppStore({ electronAPI });
    const saving = store.getState().setThemeMode("light");
    await vi.waitFor(() =>
      expect(electronAPI.setAppAppearanceMode).toHaveBeenCalled(),
    );
    store.getState().syncAppAppearanceMode("dark");
    completeSave("light");
    await saving;
    expect(store.getState()).toMatchObject({
      themeMode: "dark",
      theme: "dark",
      themeError: null,
    });
  });

  it("discards an older queued appearance write after preferences are imported", async () => {
    let completeSave;
    const electronAPI = createElectronAPI("system");
    electronAPI.setAppAppearanceMode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    const store = createAppStore({ electronAPI });
    const first = store.getState().setThemeMode("dark");
    const queued = store.getState().setThemeMode("light");
    await vi.waitFor(() => expect(completeSave).toBeTypeOf("function"));
    store.getState().syncAppAppearanceMode("system");
    completeSave("dark");
    await Promise.all([first, queued]);
    expect(electronAPI.setAppAppearanceMode).toHaveBeenCalledExactlyOnceWith(
      "dark",
    );
    expect(store.getState().themeMode).toBe("system");
  });

  it("defaults to following the system theme when nothing is stored", () => {
    expect(getInitialThemeMode()).toBe("system");
  });

  it("prefers the main-process appearance mode over OS defaults", () => {
    const electronAPI = createElectronAPI("dark");
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(getAppAppearanceMode(electronAPI)).toBe("dark");
    expect(getInitialThemeMode({ electronAPI })).toBe("dark");
    expect(getInitialTheme({ electronAPI, matchMedia })).toBe("dark");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("reads the effective system theme from the renderer media query", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(getInitialTheme({ matchMedia })).toBe("dark");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("resolves system mode into the current effective theme", () => {
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(resolveTheme("system", { matchMedia })).toBe("light");
  });

  it("store starts in system mode and resolves the current system theme", () => {
    const controller = createMatchMediaController("dark");
    const store = createAppStore({ matchMedia: controller.matchMedia });

    expect(store.getState().themeMode).toBe("system");
    expect(store.getState().theme).toBe("dark");
  });

  it("setTheme updates optimistically and persists through Electron", async () => {
    const electronAPI = createElectronAPI();
    const store = createAppStore({ electronAPI });

    await store.getState().setTheme("dark");
    expect(store.getState().themeMode).toBe("dark");
    expect(store.getState().theme).toBe("dark");
    expect(electronAPI.setAppAppearanceMode).toHaveBeenLastCalledWith("dark");

    await store.getState().setTheme("light");
    expect(store.getState().themeMode).toBe("light");
    expect(store.getState().theme).toBe("light");
    expect(electronAPI.setAppAppearanceMode).toHaveBeenLastCalledWith("light");
  });

  it("can switch back to following the current system theme", async () => {
    const controller = createMatchMediaController("dark");
    const electronAPI = createElectronAPI("light");
    const store = createAppStore({
      electronAPI,
      matchMedia: controller.matchMedia,
    });

    await store.getState().followSystemTheme();

    expect(store.getState().themeMode).toBe("system");
    expect(store.getState().theme).toBe("dark");
    expect(electronAPI.setAppAppearanceMode).toHaveBeenLastCalledWith("system");
  });

  it("re-resolves System after Electron removes the explicit override", async () => {
    const controller = createMatchMediaController("light");
    const electronAPI = createElectronAPI("light");
    electronAPI.setAppAppearanceMode.mockImplementation(async (mode) => {
      if (mode === "system") {
        controller.setTheme("dark");
      }
      return mode;
    });
    const store = createAppStore({
      electronAPI,
      matchMedia: controller.matchMedia,
    });

    await store.getState().followSystemTheme();

    expect(store.getState()).toMatchObject({
      themeMode: "system",
      theme: "dark",
      themeError: null,
    });
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

  it("toggleTheme makes the effective theme explicit and persists it", async () => {
    const controller = createMatchMediaController("light");
    const electronAPI = createElectronAPI("system");
    const store = createAppStore({
      electronAPI,
      matchMedia: controller.matchMedia,
    });

    await store.getState().toggleTheme();
    expect(store.getState().themeMode).toBe("dark");
    expect(store.getState().theme).toBe("dark");
    expect(electronAPI.setAppAppearanceMode).toHaveBeenLastCalledWith("dark");

    await store.getState().toggleTheme();
    expect(store.getState().themeMode).toBe("light");
    expect(store.getState().theme).toBe("light");
    expect(electronAPI.setAppAppearanceMode).toHaveBeenLastCalledWith("light");
  });

  it("rolls back and surfaces a persistence failure", async () => {
    const electronAPI = createElectronAPI();
    electronAPI.setAppAppearanceMode.mockRejectedValueOnce(
      new Error("IPC failed"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = createAppStore({ electronAPI });

    const persistence = store.getState().setThemeMode("dark");
    expect(store.getState().themeMode).toBe("dark");

    await expect(persistence).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      themeMode: "system",
      theme: "light",
      themeError: "Couldn’t save the appearance preference.",
    });
    consoleError.mockRestore();
  });

  it("does not let an older failed save roll back a newer choice", async () => {
    const electronAPI = createElectronAPI();
    electronAPI.setAppAppearanceMode
      .mockRejectedValueOnce(new Error("stale failure"))
      .mockResolvedValueOnce("light");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = createAppStore({ electronAPI });

    const darkSave = store.getState().setThemeMode("dark");
    const lightSave = store.getState().setThemeMode("light");

    await expect(darkSave).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      themeMode: "light",
      theme: "light",
      themeError: null,
    });

    await expect(lightSave).resolves.toBe(true);
    consoleError.mockRestore();
  });

  it("rolls two failed rapid changes back to the last confirmed mode", async () => {
    const electronAPI = createElectronAPI("system");
    electronAPI.setAppAppearanceMode
      .mockRejectedValueOnce(new Error("dark failed"))
      .mockRejectedValueOnce(new Error("light failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = createAppStore({ electronAPI });

    const darkSave = store.getState().setThemeMode("dark");
    const lightSave = store.getState().setThemeMode("light");
    expect(store.getState().themeMode).toBe("light");

    await expect(darkSave).resolves.toBe(false);
    await expect(lightSave).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      themeMode: "system",
      theme: "light",
      themeError: "Couldn’t save the appearance preference.",
    });
    consoleError.mockRestore();
  });

  it("rolls a failed latest change back to an earlier confirmed save", async () => {
    const electronAPI = createElectronAPI("system");
    electronAPI.setAppAppearanceMode
      .mockResolvedValueOnce("dark")
      .mockRejectedValueOnce(new Error("light failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = createAppStore({ electronAPI });

    const darkSave = store.getState().setThemeMode("dark");
    const lightSave = store.getState().setThemeMode("light");

    await expect(darkSave).resolves.toBe(true);
    await expect(lightSave).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      themeMode: "dark",
      theme: "dark",
      themeError: "Couldn’t save the appearance preference.",
    });
    consoleError.mockRestore();
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

describe("app store onboarding behavior", () => {
  it("hydrates the persisted first-run state once", async () => {
    const electronAPI = createElectronAPI();
    const store = createAppStore({ electronAPI });

    await Promise.all([
      store.getState().hydrateOnboarding(),
      store.getState().hydrateOnboarding(),
    ]);

    expect(electronAPI.getOnboardingState).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      onboardingLoading: false,
      onboarding: { completed: false, jobs: [] },
    });
  });

  it("moves to the library with optimistic jobs before IPC resolves", async () => {
    const electronAPI = createElectronAPI();
    let resolveStart;
    electronAPI.startOnboarding.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const store = createAppStore({ electronAPI });

    const result = store.getState().completeOnboarding(["oreo", "bibata"]);
    expect(store.getState().onboarding).toMatchObject({
      completed: true,
      jobs: [
        { familyId: "oreo", status: "queued" },
        { familyId: "bibata", status: "queued" },
      ],
    });

    resolveStart({
      version: 2,
      completed: true,
      jobs: [{ familyId: "oreo", status: "downloading" }],
    });
    await result;
    expect(store.getState().onboarding.jobs[0].status).toBe("downloading");
  });

  it("completes an empty onboarding without creating import jobs", async () => {
    const electronAPI = createElectronAPI();
    const store = createAppStore({ electronAPI });

    await store.getState().completeOnboarding([]);

    expect(electronAPI.startOnboarding).toHaveBeenCalledWith([]);
    expect(store.getState().onboarding).toMatchObject({
      completed: true,
      jobs: [],
    });
  });

  it("optimistically queues a failed job when retrying", async () => {
    const electronAPI = createElectronAPI();
    let resolveRetry;
    electronAPI.retryOnboardingImport.mockReturnValue(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    const store = createAppStore({ electronAPI });
    store.getState().syncOnboarding({
      version: 2,
      completed: true,
      jobs: [{ familyId: "future", status: "failed" }],
    });

    const result = store.getState().retryOnboardingImport("future");
    expect(store.getState().onboarding.jobs[0].status).toBe("queued");
    resolveRetry({
      version: 2,
      completed: true,
      jobs: [{ familyId: "future", status: "converting" }],
    });
    await result;
    expect(store.getState().onboarding.jobs[0].status).toBe("converting");
  });
});
