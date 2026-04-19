import { useEffect, useLayoutEffect } from "react";

import {
  applyThemeToDocument,
  subscribeToSystemTheme,
  useAppStore,
} from "@/stores/app-store";

export function ThemeSync() {
  const theme = useAppStore((state) => state.theme);
  const syncSystemTheme = useAppStore((state) => state.syncSystemTheme);

  useLayoutEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => subscribeToSystemTheme(syncSystemTheme), [syncSystemTheme]);

  return null;
}
