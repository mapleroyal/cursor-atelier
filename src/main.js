import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";

import { CURSOR_CATALOG } from "./lib/cursor-catalog";
import { createCursorDeletionPreferencesPatch } from "./lib/cursor-preferences";
import themeSeedColors from "./lib/theme-seed-colors";
import { createCursorAutomation } from "./main/cursor-automation";
import { createCursorBridge, registerCursorIpc } from "./main/cursor-bridge";
import {
  createCursorImportStaging,
  installImportedArtifacts,
  removeCursorImportStaging,
} from "./main/cursor-import-install";
import { importCursorSource } from "./main/cursor-importer";
import { createCursorPreferencesStore } from "./main/cursor-preferences-store";
import { createRendererNavigation } from "./main/renderer-navigation";

const PREVIEW_SCHEME = "cursor-preview";
const trustedWebContents = new Set();
const windows = new Set();
let importQueue = Promise.resolve();
let applicationStarted = false;
let backgroundLaunch = false;
let pendingOpen = false;
let pendingNavigation = null;
let tray = null;
let trayRefreshGeneration = 0;
let runtime = null;
let lastMainLoginDesired = null;
let backgroundRegistrationAvailable = false;
const rendererNavigation = createRendererNavigation({
  canSend: (webContents) =>
    trustedWebContents.has(webContents.id) &&
    !webContents.isDestroyed() &&
    isExpectedRendererUrl(webContents.getURL()),
});

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

function broadcastToRenderers(channel, payload) {
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    const webContents = window.webContents;
    if (
      trustedWebContents.has(webContents.id) &&
      !webContents.isDestroyed() &&
      isExpectedRendererUrl(webContents.getURL())
    ) {
      webContents.send(channel, payload);
    }
  }
}

function sendNavigation(window, destination) {
  if (!window || window.isDestroyed()) {
    return;
  }
  rendererNavigation.queue(window.webContents, destination);
}

async function showOrCreateMainWindow({ navigate = null } = {}) {
  await app.whenReady();
  backgroundLaunch = false;
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    try {
      await app.dock.show();
    } catch (error) {
      console.error("Could not show the Cursor Atelier Dock icon.", error);
    }
  }

  let mainWindow = [...windows].find((window) => !window.isDestroyed());
  if (!mainWindow) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  if (navigate) {
    sendNavigation(mainWindow, navigate);
  }
  return mainWindow;
}

function requestMainWindow(options = {}) {
  if (!applicationStarted) {
    pendingOpen = true;
    pendingNavigation = options.navigate ?? pendingNavigation;
    return;
  }
  void showOrCreateMainWindow(options);
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
  const windowWebContents = mainWindow.webContents;
  const webContentsId = windowWebContents.id;
  trustedWebContents.add(webContentsId);
  secureWebContents(windowWebContents);

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

  windowWebContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.error("Renderer failed to load.", errorCode, errorDescription);
        showFailure(errorDescription);
      }
    },
  );
  windowWebContents.on("render-process-gone", (_event, details) => {
    rendererNavigation.markNotReady(windowWebContents);
    console.error("Renderer process exited.", details.reason);
    showFailure("The interface process stopped unexpectedly.");
  });
  windowWebContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        rendererNavigation.markNotReady(windowWebContents);
      }
    },
  );
  mainWindow.on("unresponsive", () => mainWindow.show());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    rendererNavigation.dispose(webContentsId);
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

function needsBackgroundRuntime(preferences) {
  return Boolean(
    preferences?.menuBar?.visible ||
    preferences?.appearance?.enabled ||
    preferences?.randomization?.schedule?.mode !== "off",
  );
}

function syncMainLoginItem(preferences) {
  if (!backgroundRegistrationAvailable) {
    return;
  }

  const desired = needsBackgroundRuntime(preferences);
  if (desired === lastMainLoginDesired) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: desired,
      type: "mainAppService",
    });
    lastMainLoginDesired = desired;
  } catch (error) {
    console.error("Could not update Cursor Atelier’s login item.", error);
  }
}

function createMenuBarIcon() {
  const image = nativeImage.createFromNamedImage("cursorarrow");
  image.setTemplateImage(true);
  return image;
}

function currentCursorMenuLabel(status) {
  if (
    status?.effectiveApplied !== true ||
    status?.currentSentinelsMatchTheme !== true
  ) {
    return "Current cursor: macOS";
  }

  const name =
    status.themeDisplayName ??
    status.effectiveNativeThemeId ??
    status.effectiveVariantId ??
    "Custom";
  return `Current cursor: ${name}`;
}

function setTrayMenu(currentLabel = "Current cursor: Checking…") {
  if (!tray || !runtime) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: currentLabel, enabled: false },
      { type: "separator" },
      {
        label: "Open Cursor Atelier",
        click: () => requestMainWindow(),
      },
      {
        label: "Settings…",
        click: () => requestMainWindow({ navigate: "settings" }),
      },
      {
        label: "New Random Cursor",
        click: () => {
          void runtime.automation.randomize("menu-bar").catch((error) => {
            console.error("Could not choose a random cursor.", error);
          });
        },
      },
      { type: "separator" },
      {
        label: "Hide Menu Bar Item",
        click: () =>
          runtime.preferencesStore.update({ menuBar: { visible: false } }),
      },
      { type: "separator" },
      { role: "quit" },
    ]),
  );
}

async function refreshTrayMenu() {
  if (!tray || !runtime) {
    return;
  }

  const generation = ++trayRefreshGeneration;
  const currentTray = tray;
  try {
    const status = await runtime.bridge.status();
    if (
      tray === currentTray &&
      generation === trayRefreshGeneration &&
      !currentTray.isDestroyed()
    ) {
      setTrayMenu(currentCursorMenuLabel(status));
    }
  } catch (error) {
    console.error("Could not refresh the menu bar cursor status.", error);
    if (
      tray === currentTray &&
      generation === trayRefreshGeneration &&
      !currentTray.isDestroyed()
    ) {
      setTrayMenu("Current cursor: Unavailable");
    }
  }
}

function syncTray(preferences) {
  if (!preferences?.menuBar?.visible) {
    trayRefreshGeneration += 1;
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    tray = new Tray(createMenuBarIcon());
    tray.setToolTip("Cursor Atelier");
    setTrayMenu();
  }
  void refreshTrayMenu();
}

function notifyCursorChanged(payload) {
  broadcastToRenderers("cursor:changed", payload);
  void refreshTrayMenu();
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
  const preferencesStore = createCursorPreferencesStore({
    directory: app.getPath("userData"),
  });
  const bridge = createCursorBridge({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    importedPacksRoot,
    trashImportedArtifact: (artifactPath) => shell.trashItem(artifactPath),
  });
  // Launching app.asar directly (including the Playwright preview) can still
  // report app.isPackaged. Requiring the verified packaged native component
  // keeps that read-only preview from registering a system login item.
  backgroundRegistrationAvailable = Boolean(
    app.isPackaged &&
    process.platform === "darwin" &&
    bridge.nativePath &&
    process.env.CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION !== "1",
  );
  if (backgroundRegistrationAvailable) {
    try {
      backgroundLaunch = Boolean(
        app.getLoginItemSettings({ type: "mainAppService" }).wasOpenedAtLogin,
      );
    } catch (error) {
      console.error("Could not inspect Cursor Atelier’s login item.", error);
    }
    try {
      await bridge.reconcileLoginItems();
    } catch (error) {
      // The UI still needs to open so Restore and Login Items guidance remain
      // available. Status will surface any unresolved helper registration.
      console.error(
        "Could not reconcile Cursor Atelier’s installed login helper.",
        error,
      );
    }
  }
  if (backgroundLaunch && process.platform === "darwin") {
    app.setActivationPolicy("accessory");
    app.dock.hide();
  }

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
  const requireTrustedSender = (event) => {
    if (!isTrustedSender(event)) {
      throw new Error("Cursor IPC is unavailable to this page.");
    }
  };
  const rendererBridge = {
    status: () => bridge.status(),
    listThemes: () => bridge.listThemes(),
    setThemeSize: async (identifier, sizePercentage) => {
      const result = await bridge.setThemeSize(identifier, sizePercentage);
      notifyCursorChanged({
        reason: "renderer-size-preference",
        theme: result,
        changedAt: new Date().toISOString(),
      });
      return result;
    },
    applyTheme: async (identifier) => {
      const status = await bridge.applyTheme(identifier);
      notifyCursorChanged({
        reason: "renderer-apply",
        status,
        changedAt: new Date().toISOString(),
      });
      return status;
    },
    restore: async () => {
      const status = await bridge.restore();
      notifyCursorChanged({
        reason: "renderer-restore",
        status,
        changedAt: new Date().toISOString(),
      });
      return status;
    },
    openLoginSettings: () => bridge.openLoginSettings(),
  };
  registerCursorIpc({
    ipcMain,
    bridge: rendererBridge,
    isTrustedSender,
  });
  ipcMain.handle("cursor:import-pack", (event) => {
    requireTrustedSender(event);
    const operation = importQueue.then(() =>
      chooseAndImportCursorPack(event, bridge, importedPacksRoot),
    );
    importQueue = operation.catch(() => undefined);
    return operation;
  });
  const enqueueImportedLibraryMutation = (operation) => {
    const result = importQueue.then(operation);
    importQueue = result.catch(() => undefined);
    return result;
  };
  const pruneLibraryPreferences = async (identifiers = []) => {
    const themes = await bridge.listThemes();
    const patch = createCursorDeletionPreferencesPatch(
      preferencesStore.get(),
      identifiers,
      [...new Set(themes.map((theme) => theme.family).filter(Boolean))],
    );
    return preferencesStore.update(patch);
  };
  const completeImportedDeletion = async (result, reason) => {
    let preferenceCleanupPending = false;
    try {
      await pruneLibraryPreferences(result.identifiers);
    } catch (error) {
      preferenceCleanupPending = true;
      console.error(
        "The imported cursor was removed, but its saved preferences could not be cleaned up.",
        error,
      );
    }
    if (result.cleanupPending) {
      console.error(
        "An imported cursor was removed from the library but could not be moved to the Trash.",
      );
    }
    notifyCursorChanged({
      reason,
      status: result.status,
      changedAt: new Date().toISOString(),
    });
    return { ...result, preferenceCleanupPending };
  };
  ipcMain.handle(
    "cursor:assign-imported-family",
    (event, identifiers, family) => {
      requireTrustedSender(event);
      return enqueueImportedLibraryMutation(async () => {
        const result = await bridge.assignImportedFamily(identifiers, family);
        await pruneLibraryPreferences();
        return result;
      });
    },
  );
  ipcMain.handle("cursor:delete-imported", (event, identifier) => {
    requireTrustedSender(event);
    return enqueueImportedLibraryMutation(async () =>
      completeImportedDeletion(
        await bridge.deleteImportedThemes([identifier]),
        "renderer-delete-imported",
      ),
    );
  });
  ipcMain.handle("cursor:delete-imported-family", (event, family) => {
    requireTrustedSender(event);
    return enqueueImportedLibraryMutation(async () =>
      completeImportedDeletion(
        await bridge.deleteImportedFamily(family),
        "renderer-delete-imported-family",
      ),
    );
  });

  const automation = createCursorAutomation({
    bridge,
    preferencesStore,
    nativeTheme,
    onCursorChanged: notifyCursorChanged,
    onError: (error, { reason }) => {
      console.error(`Cursor automation failed (${reason}).`, error);
    },
  });
  runtime = { automation, bridge, preferencesStore };

  ipcMain.handle("preferences:get", (event) => {
    requireTrustedSender(event);
    return preferencesStore.get();
  });
  ipcMain.handle("preferences:update", (event, patch) => {
    requireTrustedSender(event);
    return preferencesStore.update(patch);
  });
  ipcMain.handle("cursor:randomize", (event) => {
    requireTrustedSender(event);
    return automation.randomize("renderer");
  });
  ipcMain.on("app:navigation-ready", (event) => {
    if (isTrustedSender(event)) {
      rendererNavigation.markReady(event.sender);
    }
  });
  ipcMain.on("app:navigation-not-ready", (event) => {
    if (isTrustedSender(event)) {
      rendererNavigation.markNotReady(event.sender);
    }
  });

  const unsubscribePreferences = preferencesStore.subscribe((preferences) => {
    broadcastToRenderers("preferences:changed", preferences);
    syncMainLoginItem(preferences);
    syncTray(preferences);
  });
  const initialPreferences = preferencesStore.get();
  syncMainLoginItem(initialPreferences);
  syncTray(initialPreferences);

  const handleNativeThemeUpdated = () => {
    syncWindowBackgrounds();
    void automation.appearanceChanged();
  };
  const handleWake = () => void automation.wake();
  nativeTheme.on("updated", handleNativeThemeUpdated);
  powerMonitor.on("resume", handleWake);
  powerMonitor.on("unlock-screen", handleWake);

  const localNotificationIds = [];
  if (process.platform === "darwin") {
    for (const notification of [
      "NSSystemClockDidChangeNotification",
      "NSSystemTimeZoneDidChangeNotification",
    ]) {
      localNotificationIds.push(
        systemPreferences.subscribeLocalNotification(notification, handleWake),
      );
    }
  }

  void automation.start().catch((error) => {
    console.error("Could not start cursor automation.", error);
  });

  app.once("before-quit", () => {
    automation.stop();
    unsubscribePreferences();
    nativeTheme.off("updated", handleNativeThemeUpdated);
    powerMonitor.off("resume", handleWake);
    powerMonitor.off("unlock-screen", handleWake);
    for (const identifier of localNotificationIds) {
      systemPreferences.unsubscribeLocalNotification(identifier);
    }
    tray?.destroy();
    tray = null;
    runtime = null;
  });

  app.on("activate", () => {
    requestMainWindow();
  });

  applicationStarted = true;
  const shouldOpenWindow = !backgroundLaunch || pendingOpen;
  const navigation = pendingNavigation;
  pendingOpen = false;
  pendingNavigation = null;
  if (shouldOpenWindow) {
    await showOrCreateMainWindow({ navigate: navigation });
  }
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    requestMainWindow();
  });
  app
    .whenReady()
    .then(startApplication)
    .catch((error) => {
      console.error("Cursor Atelier could not start.", error);
      app.quit();
    });
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
