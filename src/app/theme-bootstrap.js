import { applyThemeToDocument, useAppStore } from "../stores/app-store";

applyThemeToDocument(useAppStore.getState().theme);
