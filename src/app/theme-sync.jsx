import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";

export function ThemeSync() {
  const theme = useAppStore((state) => state.theme);
  const initializeThemeFromSystem = useAppStore(
    (state) => state.initializeThemeFromSystem,
  );

  useEffect(() => {
    initializeThemeFromSystem();
  }, [initializeThemeFromSystem]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return null;
}
