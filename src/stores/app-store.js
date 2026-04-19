import { create } from "zustand";
import themeSeedColors from "@/lib/theme-seed-colors";

const DARK_MODE_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_STORAGE_KEY = "app-theme";

function isTheme(value) {
  return value === "light" || value === "dark";
}

function isThemeMode(value) {
  return value === "system" || isTheme(value);
}

function resolveStorage(storage) {
  return storage ?? globalThis?.window?.localStorage;
}

function resolveElectronAPI(electronAPI) {
  return electronAPI ?? globalThis?.window?.electronAPI;
}

function resolveMatchMedia(matchMedia) {
  return matchMedia ?? globalThis?.window?.matchMedia;
}

export function getStoredThemeMode(storage) {
  const resolvedStorage = resolveStorage(storage);

  if (typeof resolvedStorage?.getItem !== "function") {
    return null;
  }

  const storedThemeMode = resolvedStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(storedThemeMode) ? storedThemeMode : null;
}

export function setStoredThemeMode(themeMode, storage) {
  if (!isThemeMode(themeMode)) {
    return;
  }

  const resolvedStorage = resolveStorage(storage);

  if (typeof resolvedStorage?.setItem !== "function") {
    return;
  }

  resolvedStorage.setItem(THEME_STORAGE_KEY, themeMode);
}

export function getElectronTheme(electronAPI) {
  const resolvedElectronAPI = resolveElectronAPI(electronAPI);
  const systemTheme = resolvedElectronAPI?.getSystemTheme?.();

  return isTheme(systemTheme) ? systemTheme : null;
}

export function getSystemTheme({ electronAPI, matchMedia } = {}) {
  const electronTheme = getElectronTheme(electronAPI);

  if (electronTheme) {
    return electronTheme;
  }

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

export function getInitialThemeMode({ storage } = {}) {
  return getStoredThemeMode(storage) ?? "system";
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

export function createAppStore({ electronAPI, matchMedia, storage } = {}) {
  const initialThemeMode = getInitialThemeMode({ storage });

  return create((set) => ({
    themeMode: initialThemeMode,
    theme: resolveTheme(initialThemeMode, { electronAPI, matchMedia }),
    setThemeMode: (themeMode) => {
      if (!isThemeMode(themeMode)) {
        return;
      }

      const theme = resolveTheme(themeMode, { electronAPI, matchMedia });

      set({ themeMode, theme });
      setStoredThemeMode(themeMode, storage);
    },
    setTheme: (theme) => {
      if (!isTheme(theme)) {
        return;
      }

      set({ themeMode: theme, theme });
      setStoredThemeMode(theme, storage);
    },
    followSystemTheme: () => {
      const themeMode = "system";
      const theme = resolveTheme(themeMode, { electronAPI, matchMedia });

      set({ themeMode, theme });
      setStoredThemeMode(themeMode, storage);
    },
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
      set((state) => {
        const theme = state.theme === "dark" ? "light" : "dark";

        setStoredThemeMode(theme, storage);

        return { themeMode: theme, theme };
      }),
  }));
}

export const useAppStore = createAppStore();
