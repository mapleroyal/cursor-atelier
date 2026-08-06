import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell,
} from "electron";

import { CURSOR_CATALOG } from "./lib/cursor-catalog";
import themeSeedColors from "./lib/theme-seed-colors";
import { createCursorBridge, registerCursorIpc } from "./main/cursor-bridge";
import {
  createCursorImportStaging,
  installImportedArtifacts,
  removeCursorImportStaging,
} from "./main/cursor-import-install";
import { importCursorSource } from "./main/cursor-importer";

const PREVIEW_SCHEME = "cursor-preview";
const trustedWebContents = new Set();
const windows = new Set();
let importQueue = Promise.resolve();

// The native helper and Electron must share one canonical Application Support
// store. Pinning userData here also keeps the single-instance lock aligned with
// that store when Chromium is launched with a custom --user-data-dir argument.
const applicationDataRoot = path.join(app.getPath("appData"), "Cursor Atelier");
fs.mkdirSync(applicationDataRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", applicationDataRoot);

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const allowedExternalUrls = new Set(
  CURSOR_CATALOG.flatMap((entry) => [
    entry.sourceUrl,
    entry.upstreamUrl,
    entry.licenseUrl,
  ])
    .filter(Boolean)
    .map((value) => new URL(value).href),
);

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors
    ? themeSeedColors.dark.windowBackground
    : themeSeedColors.light.windowBackground;
}

function syncWindowBackgrounds() {
  const backgroundColor = getWindowBackgroundColor();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(backgroundColor);
    }
  }
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedExternalUrls.has(url.href);
  } catch {
    return false;
  }
}

function isExpectedRendererUrl(value) {
  try {
    const requested = new URL(value);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const developmentServer = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      return requested.origin === developmentServer.origin;
    }
    const rendererPath = path.resolve(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
    );
    return (
      requested.protocol === "file:" &&
      path.resolve(fileURLToPath(requested)) === rendererPath
    );
  } catch {
    return false;
  }
}

function openExternalUrl(value) {
  if (!isAllowedExternalUrl(value)) {
    return;
  }
  void shell.openExternal(value).catch((error) => {
    console.error("Could not open the external cursor source.", error);
  });
}

function failurePage(description) {
  const message = String(description ?? "The interface could not be loaded.")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const background = getWindowBackgroundColor();
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>html,body{height:100%;margin:0;background:${background};color:CanvasText;font:14px -apple-system,BlinkMacSystemFont,sans-serif}body{display:grid;place-items:center}.message{max-width:32rem;padding:32px;text-align:center}.message strong{display:block;font-size:16px;margin-bottom:8px}</style></head>
<body><div class="message"><strong>Cursor Atelier couldn’t open.</strong><span>${message}</span></div></body></html>`)}`;
}

function secureWebContents(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isExpectedRendererUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalUrl(url);
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Cursor Atelier",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: getWindowBackgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  windows.add(mainWindow);
  const webContentsId = mainWindow.webContents.id;
  trustedWebContents.add(webContentsId);
  secureWebContents(mainWindow.webContents);

  let showingFailure = false;
  const showFailure = (description) => {
    if (showingFailure || mainWindow.isDestroyed()) {
      return;
    }
    showingFailure = true;
    void mainWindow.loadURL(failurePage(description)).finally(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });
  };

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.error("Renderer failed to load.", errorCode, errorDescription);
        showFailure(errorDescription);
      }
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process exited.", details.reason);
    showFailure("The interface process stopped unexpectedly.");
  });
  mainWindow.on("unresponsive", () => mainWindow.show());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    trustedWebContents.delete(webContentsId);
    windows.delete(mainWindow);
  });

  const loadPromise = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );
  void loadPromise.catch((error) => showFailure(error.message));

  return mainWindow;
}

async function chooseAndImportCursorPack(event, bridge, importedPacksRoot) {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Import cursor pack",
    buttonLabel: "Import",
    message:
      "Choose a compiled Xcursor folder, ZIP or tar archive, Mousecape file, or Cursor Atelier cursor file.",
    filters: [
      {
        name: "Cursor packs",
        extensions: ["zip", "tar", "gz", "tgz", "xz", "txz", "cape", "cursor"],
      },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile", "openDirectory"],
  };
  const selection = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || selection.filePaths.length !== 1) {
    return { canceled: true };
  }

  const stagingDirectory = await createCursorImportStaging(importedPacksRoot);
  try {
    const converted = await importCursorSource({
      sourcePath: selection.filePaths[0],
      stagingDirectory,
    });
    const installed = await installImportedArtifacts({
      artifacts: converted.artifacts,
      stagingDirectory,
      importedPacksRoot,
      validateInstalled: ({ identifiers }) =>
        bridge.validateImportedThemes(identifiers),
    });
    // Remove duplicate/unmoved staging artifacts before refreshing the
    // manifest index so the store is observed only in its committed state.
    try {
      await removeCursorImportStaging({
        stagingDirectory,
        importedPacksRoot,
      });
    } catch {
      // Promotion and native validation have already committed. Staging names
      // are never indexed; a cleanup failure must not turn a successful import
      // into a false failure in the UI. The finalizer below retries cleanup.
    }
    await bridge.invalidateManifests();
    const warnings = [
      ...(Array.isArray(converted.warnings) ? converted.warnings : []),
      ...converted.artifacts.flatMap((artifact) =>
        Array.isArray(artifact.warnings) ? artifact.warnings : [],
      ),
    ];
    return {
      canceled: false,
      sourceFormat: converted.sourceFormat,
      warnings: [...new Set(warnings.map(String))],
      ...installed,
    };
  } finally {
    try {
      await removeCursorImportStaging({
        stagingDirectory,
        importedPacksRoot,
      });
    } catch (error) {
      console.error("Could not remove cursor import staging data.", error);
    }
  }
}

async function startApplication() {
  const importedPacksRoot = path.join(app.getPath("userData"), "ImportedPacks");
  const bridge = createCursorBridge({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    importedPacksRoot,
  });

  await protocol.handle(PREVIEW_SCHEME, async (request) => {
    const assetPath = bridge.resolvePreviewAsset(request.url);
    if (!assetPath) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return new Response(await fs.promises.readFile(assetPath), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  if (app.isPackaged) {
    session.defaultSession.webRequest.onBeforeRequest(
      {
        urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
      },
      (_details, callback) => callback({ cancel: true }),
    );
  }
  const isTrustedSender = (event) =>
    trustedWebContents.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    isExpectedRendererUrl(event.senderFrame.url);
  registerCursorIpc({
    ipcMain,
    bridge,
    isTrustedSender,
  });
  ipcMain.handle("cursor:import-pack", (event) => {
    if (!isTrustedSender(event)) {
      throw new Error("Cursor IPC is unavailable to this page.");
    }
    const operation = importQueue.then(() =>
      chooseAndImportCursorPack(event, bridge, importedPacksRoot),
    );
    importQueue = operation.catch(() => undefined);
    return operation;
  });

  nativeTheme.on("updated", syncWindowBackgrounds);
  createWindow();

  app.on("activate", () => {
    if (windows.size === 0) {
      createWindow();
    }
  });
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    const primaryWindow = [...windows].find((window) => !window.isDestroyed());
    if (primaryWindow) {
      if (primaryWindow.isMinimized()) {
        primaryWindow.restore();
      }
      primaryWindow.show();
      primaryWindow.focus();
    }
  });
  app.whenReady().then(startApplication);
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
