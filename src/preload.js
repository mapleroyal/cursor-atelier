const { contextBridge } = require("electron");
const electron = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSystemTheme: () => {
    const nativeTheme = electron.nativeTheme;

    if (nativeTheme && typeof nativeTheme.shouldUseDarkColors === "boolean") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }

    return null;
  },
  getCursorStatus: () => electron.ipcRenderer.invoke("cursor:status"),
  listCursorThemes: () => electron.ipcRenderer.invoke("cursor:list-themes"),
  importCursorPack: () => electron.ipcRenderer.invoke("cursor:import-pack"),
  applyCursorTheme: (identifier) =>
    electron.ipcRenderer.invoke("cursor:apply-theme", identifier),
  restoreCursors: () => electron.ipcRenderer.invoke("cursor:restore"),
  openLoginItemsSettings: () =>
    electron.ipcRenderer.invoke("cursor:open-login-settings"),
});
