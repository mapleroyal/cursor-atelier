import { create } from "zustand";

function resolveSystemTheme() {
  if (typeof window === "undefined") {
    return "light";
  }

  try {
    const systemTheme = window.electronAPI?.getSystemTheme?.();

    if (systemTheme === "dark" || systemTheme === "light") {
      return systemTheme;
    }
  } catch {
    // Fall through to browser media query fallback.
  }

  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }

  return "light";
}

export const useAppStore = create((set) => ({
  ctaClicks: 0,
  theme: resolveSystemTheme(),
  themeSource: "system",
  incrementCtaClicks: () =>
    set((state) => ({ ctaClicks: state.ctaClicks + 1 })),
  initializeThemeFromSystem: () =>
    set(() => ({
      theme: resolveSystemTheme(),
      themeSource: "system",
    })),
  toggleTheme: () =>
    set((state) => ({
      theme: state.theme === "dark" ? "light" : "dark",
      themeSource: "manual",
    })),
}));
