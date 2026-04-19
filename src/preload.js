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
});
