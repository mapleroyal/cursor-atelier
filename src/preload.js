const { contextBridge } = require("electron");
const electron = require("electron");
let navigationListenerCount = 0;

function subscribe(channel, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("An event listener is required.");
  }

  const listener = (_event, payload) => callback(payload);
  electron.ipcRenderer.on(channel, listener);
  return () => electron.ipcRenderer.removeListener(channel, listener);
}

function subscribeToNavigation(callback) {
  const unsubscribe = subscribe("app:navigate", callback);
  let subscribed = true;
  navigationListenerCount += 1;
  if (navigationListenerCount === 1) {
    electron.ipcRenderer.send("app:navigation-ready");
  }

  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    unsubscribe();
    navigationListenerCount -= 1;
    if (navigationListenerCount === 0) {
      electron.ipcRenderer.send("app:navigation-not-ready");
    }
  };
}

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
  assignImportedCursorFamily: (identifiers, family) =>
    electron.ipcRenderer.invoke(
      "cursor:assign-imported-family",
      identifiers,
      family,
    ),
  deleteImportedCursor: (identifier) =>
    electron.ipcRenderer.invoke("cursor:delete-imported", identifier),
  deleteImportedCursorFamily: (family) =>
    electron.ipcRenderer.invoke("cursor:delete-imported-family", family),
  applyCursorTheme: (identifier) =>
    electron.ipcRenderer.invoke("cursor:apply-theme", identifier),
  setCursorThemeSize: (identifier, sizePercentage) =>
    electron.ipcRenderer.invoke(
      "cursor:set-theme-size",
      identifier,
      sizePercentage,
    ),
  restoreCursors: () => electron.ipcRenderer.invoke("cursor:restore"),
  openLoginItemsSettings: () =>
    electron.ipcRenderer.invoke("cursor:open-login-settings"),
  getCursorPreferences: () => electron.ipcRenderer.invoke("preferences:get"),
  updateCursorPreferences: (patch) =>
    electron.ipcRenderer.invoke("preferences:update", patch),
  randomizeCursor: () => electron.ipcRenderer.invoke("cursor:randomize"),
  onCursorPreferencesChanged: (callback) =>
    subscribe("preferences:changed", callback),
  onCursorChanged: (callback) => subscribe("cursor:changed", callback),
  onNavigate: subscribeToNavigation,
});
