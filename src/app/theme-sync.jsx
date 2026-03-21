import { useLayoutEffect } from "react";

import { useAppStore } from "@/stores/app-store";

export function ThemeSync() {
  const theme = useAppStore((state) => state.theme);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return null;
}
