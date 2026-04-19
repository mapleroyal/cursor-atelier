import path from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import themeSeedColors from "./lib/theme-seed-colors";

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors
    ? themeSeedColors.dark.windowBackground
    : themeSeedColors.light.windowBackground;
}

function syncWindowBackgrounds() {
  const backgroundColor = getWindowBackgroundColor();

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(backgroundColor);
    }
  }
}

if (require("electron-squirrel-startup")) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    show: false,
    backgroundColor: getWindowBackgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
};

app.whenReady().then(() => {
  nativeTheme.on("updated", syncWindowBackgrounds);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
