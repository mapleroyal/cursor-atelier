import { create } from "zustand";
import themeSeedColors from "@/lib/theme-seed-colors";

const DARK_MODE_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value) {
  return value === "light" || value === "dark";
}

function isThemeMode(value) {
  return value === "system" || isTheme(value);
}

function resolveElectronAPI(electronAPI) {
  return electronAPI ?? globalThis?.window?.electronAPI;
}

function resolveMatchMedia(matchMedia) {
  return matchMedia ?? globalThis?.window?.matchMedia;
}

export function getAppAppearanceMode(electronAPI) {
  try {
    const value = resolveElectronAPI(electronAPI)?.getAppAppearanceMode?.();
    return isThemeMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function getSystemTheme({ matchMedia } = {}) {
  const resolvedMatchMedia = resolveMatchMedia(matchMedia);

  if (typeof resolvedMatchMedia !== "function") {
    return "light";
  }

  return resolvedMatchMedia(DARK_MODE_MEDIA_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(themeMode, options = {}) {
  if (!isThemeMode(themeMode)) {
    return "light";
  }

  return themeMode === "system" ? getSystemTheme(options) : themeMode;
}

export function getInitialThemeMode({ electronAPI } = {}) {
  return getAppAppearanceMode(electronAPI) ?? "system";
}

export function getInitialTheme(options = {}) {
  return resolveTheme(getInitialThemeMode(options), options);
}

export function subscribeToSystemTheme(callback, matchMedia) {
  const resolvedMatchMedia = resolveMatchMedia(matchMedia);

  if (typeof resolvedMatchMedia !== "function") {
    return () => {};
  }

  const mediaQueryList = resolvedMatchMedia(DARK_MODE_MEDIA_QUERY);

  if (!mediaQueryList) {
    return () => {};
  }

  const handleChange = (event) => {
    callback(event.matches ? "dark" : "light");
  };

  if (typeof mediaQueryList.addEventListener === "function") {
    mediaQueryList.addEventListener("change", handleChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }

  if (typeof mediaQueryList.addListener === "function") {
    mediaQueryList.addListener(handleChange);

    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }

  return () => {};
}

export function applyThemeToDocument(
  theme,
  element = globalThis?.document?.documentElement,
) {
  if (!element?.classList || !isTheme(theme)) {
    return;
  }

  element.classList.toggle("dark", theme === "dark");

  if (element.style) {
    element.style.colorScheme = theme;
    element.style.backgroundColor =
      theme === "dark"
        ? themeSeedColors.dark.documentBackground
        : themeSeedColors.light.documentBackground;
  }
}

export function createAppStore({ electronAPI, matchMedia } = {}) {
  const initialThemeMode = getInitialThemeMode({ electronAPI });
  let confirmedThemeMode = initialThemeMode;
  let appearanceRequest = 0;
  let persistenceQueue = Promise.resolve();

  return create((set, get) => ({
    themeMode: initialThemeMode,
    theme: resolveTheme(initialThemeMode, { matchMedia }),
    themeError: null,
    setThemeMode: (themeMode) => {
      if (!isThemeMode(themeMode)) {
        return Promise.resolve(false);
      }

      const theme = resolveTheme(themeMode, { matchMedia });
      const request = ++appearanceRequest;

      set({ themeMode, theme, themeError: null });
      const setter = resolveElectronAPI(electronAPI)?.setAppAppearanceMode;
      if (typeof setter !== "function") {
        confirmedThemeMode = themeMode;
        return Promise.resolve(true);
      }

      const persist = () => setter(themeMode);
      const result = persistenceQueue.then(persist, persist);
      persistenceQueue = result.then(
        () => undefined,
        () => undefined,
      );

      return Promise.resolve(result).then(
        (persistedMode) => {
          const canonicalMode = isThemeMode(persistedMode)
            ? persistedMode
            : themeMode;
          confirmedThemeMode = canonicalMode;
          if (appearanceRequest === request && get().themeMode === themeMode) {
            set({
              themeMode: canonicalMode,
              theme: resolveTheme(canonicalMode, {
                matchMedia,
              }),
              themeError: null,
            });
          }
          return true;
        },
        (error) => {
          if (appearanceRequest === request && get().themeMode === themeMode) {
            set({
              themeMode: confirmedThemeMode,
              theme: resolveTheme(confirmedThemeMode, {
                matchMedia,
              }),
              themeError: "Couldn’t save the appearance preference.",
            });
          }
          console.error("Couldn’t save the appearance preference.", error);
          return false;
        },
      );
    },
    setTheme: (theme) => {
      if (!isTheme(theme)) {
        return Promise.resolve(false);
      }
      return get().setThemeMode(theme);
    },
    followSystemTheme: () => get().setThemeMode("system"),
    syncSystemTheme: (systemTheme) =>
      set((state) => {
        if (state.themeMode !== "system" || !isTheme(systemTheme)) {
          return state;
        }

        if (state.theme === systemTheme) {
          return state;
        }

        return { ...state, theme: systemTheme };
      }),
    toggleTheme: () =>
      get().setThemeMode(get().theme === "dark" ? "light" : "dark"),
  }));
}

export const useAppStore = createAppStore();
