import { create } from "zustand";

const DARK_MODE_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_STORAGE_KEY = "app-theme";

function isTheme(value) {
  return value === "light" || value === "dark";
}

function resolveStorage(storage) {
  return storage ?? globalThis?.window?.localStorage;
}

function resolveElectronAPI(electronAPI) {
  return electronAPI ?? globalThis?.window?.electronAPI;
}

export function getStoredTheme(storage) {
  const resolvedStorage = resolveStorage(storage);

  if (typeof resolvedStorage?.getItem !== "function") {
    return null;
  }

  const storedTheme = resolvedStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(storedTheme) ? storedTheme : null;
}

export function setStoredTheme(theme, storage) {
  if (!isTheme(theme)) {
    return;
  }

  const resolvedStorage = resolveStorage(storage);

  if (typeof resolvedStorage?.setItem !== "function") {
    return;
  }

  resolvedStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function getElectronTheme(electronAPI) {
  const resolvedElectronAPI = resolveElectronAPI(electronAPI);
  const systemTheme = resolvedElectronAPI?.getSystemTheme?.();

  return isTheme(systemTheme) ? systemTheme : null;
}

export function getSystemTheme(matchMedia) {
  const resolveMatchMedia = matchMedia ?? globalThis?.window?.matchMedia;

  if (typeof resolveMatchMedia !== "function") {
    return "light";
  }

  return resolveMatchMedia(DARK_MODE_MEDIA_QUERY).matches ? "dark" : "light";
}

export function getInitialTheme({ electronAPI, matchMedia, storage } = {}) {
  return (
    getStoredTheme(storage) ??
    getElectronTheme(electronAPI) ??
    getSystemTheme(matchMedia)
  );
}

export function createAppStore({ electronAPI, matchMedia, storage } = {}) {
  return create((set) => ({
    theme: getInitialTheme({ electronAPI, matchMedia, storage }),
    setTheme: (theme) => {
      if (!isTheme(theme)) {
        return;
      }

      set({ theme });
      setStoredTheme(theme, storage);
    },
    toggleTheme: () =>
      set((state) => {
        const nextTheme = state.theme === "dark" ? "light" : "dark";
        setStoredTheme(nextTheme, storage);

        return { theme: nextTheme };
      }),
  }));
}

export const useAppStore = createAppStore();
