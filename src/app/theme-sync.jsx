import { useEffect, useLayoutEffect } from "react";

import {
  applyThemeToDocument,
  subscribeToSystemTheme,
  useAppStore,
} from "@/stores/app-store";

export function ThemeSync() {
  const theme = useAppStore((state) => state.theme);
  const syncSystemTheme = useAppStore((state) => state.syncSystemTheme);
  const syncAppAppearanceMode = useAppStore(
    (state) => state.syncAppAppearanceMode,
  );
  const syncDesktopAppearance = useAppStore(
    (state) => state.syncDesktopAppearance,
  );

  useLayoutEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => subscribeToSystemTheme(syncSystemTheme), [syncSystemTheme]);

  useEffect(() => {
    const api = window.electronAPI;
    const unsubscribeMode = api?.onAppAppearanceChanged?.(
      syncAppAppearanceMode,
    );
    const unsubscribeDesktop = api?.onSystemAppearanceChanged?.(
      syncDesktopAppearance,
    );
    // Subscribe before the synchronous snapshot so a startup/import update
    // cannot fall between initial store construction and listener setup.
    syncAppAppearanceMode(api?.getAppAppearanceMode?.());
    syncDesktopAppearance(api?.getSystemAppearance?.());
    return () => {
      unsubscribeMode?.();
      unsubscribeDesktop?.();
    };
  }, [syncAppAppearanceMode, syncDesktopAppearance]);

  return null;
}
