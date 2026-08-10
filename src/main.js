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
import themeSeedColors from "./lib/theme-seed-colors";
import {
  registerAppAppearanceIpc,
  syncWindowBackgroundColors,
} from "./main/app-appearance-ipc";
import { createCursorAutomation } from "./main/cursor-automation";
import { createCursorBridge, registerCursorIpc } from "./main/cursor-bridge";
import {
  createCursorImportStaging,
  installImportedArtifacts,
  reconcileCursorImportTransactions,
  removeCursorImportStaging,
} from "./main/cursor-import-install";
import { createCursorLibraryPreferencesReconciler } from "./main/cursor-library-preferences-reconciler";
import { createCursorPreferencesStore } from "./main/cursor-preferences-store";
import { restoreCursorState } from "./main/cursor-state-service";
import { createCursorThemeSizeCleanupReconciler } from "./main/cursor-theme-size-cleanup-reconciler";
import {
  createCuratedConversionWorkspace,
  reconcileCuratedConversionWorkspaces,
  removeCuratedConversionWorkspace,
} from "./main/curated-conversion-workspace";
import { convertCuratedFamily } from "./main/curated-converter-client";
import {
  CURATED_FAMILY_CATALOG,
  CURATED_VARIANTS_BY_FAMILY,
} from "./main/curated-family-catalog";
import { createCuratedFamilyService } from "./main/curated-family-service";
import {
  acquireCuratedFamilySources,
  CURATED_FAMILY_IDS,
  CURATED_SOURCE_CATALOG,
  reconcileCuratedSourceTransactions,
  removeCuratedFamilySources,
} from "./main/curated-source-acquisition";
import { createCuratedVariantInstaller } from "./main/curated-variant-installer";
import { createMainLoginItemReconciler } from "./main/main-login-item-reconciler";
import { createOnboardingStore } from "./main/onboarding-store";
import { broadcastToRendererWindows } from "./main/renderer-broadcast";
import { createRendererNavigation } from "./main/renderer-navigation";
import {
  createWindowLifecycle,
  shouldMainAppStayRunning,
  shouldRegisterMainAppLoginItem,
} from "./main/window-lifecycle";

const PREVIEW_SCHEME = "cursor-preview";
const trustedWebContents = new Set();
const windows = new Set();
const requestedWindowPresentation = new WeakSet();
const failedWindows = new WeakSet();
const rendererRecovery = new WeakMap();
let importQueue = Promise.resolve();
let applicationStarted = false;
let backgroundLaunch = false;
let pendingOpen = false;
let pendingNavigation = null;
let tray = null;
let trayRefreshGeneration = 0;
let runtime = null;
let windowLifecycle = null;
let lastSystemAppearance = "light";
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

function getSystemAppearance() {
  if (process.platform !== "darwin") {
    lastSystemAppearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    return lastSystemAppearance;
  }
  try {
    const appleInterfaceStyle = systemPreferences.getUserDefault(
      "AppleInterfaceStyle",
      "string",
    );
    lastSystemAppearance =
      String(appleInterfaceStyle ?? "")
        .trim()
        .toLocaleLowerCase() === "dark"
        ? "dark"
        : "light";
    return lastSystemAppearance;
  } catch (error) {
    console.error("Could not read the macOS interface appearance.", error);
    return lastSystemAppearance;
  }
}

function syncWindowBackgrounds() {
  syncWindowBackgroundColors({
    windows,
    backgroundColor: getWindowBackgroundColor(),
    onWindowError: (error) =>
      console.error("Could not update a window background.", error),
  });
}

function hasVisibleWindows(excludedWindow = null) {
  return [...windows].some(
    (window) =>
      window !== excludedWindow && !window.isDestroyed() && window.isVisible(),
  );
}

function broadcastToRenderers(channel, payload) {
  broadcastToRendererWindows({
    windows,
    channel,
    payload,
    canSend: (webContents) =>
      trustedWebContents.has(webContents.id) &&
      !webContents.isDestroyed() &&
      isExpectedRendererUrl(webContents.getURL()),
    onSendError: (error) =>
      console.error(`Could not broadcast ${channel} to a renderer.`, error),
  });
}

function sendNavigation(window, destination) {
  if (!window || window.isDestroyed()) {
    return;
  }
  rendererNavigation.queue(window.webContents, destination);
}

async function showOrCreateMainWindow({ navigate = null } = {}) {
  await app.whenReady();
  if (windowLifecycle && !windowLifecycle.prepareToShowWindow()) {
    return null;
  }
  backgroundLaunch = false;

  let mainWindow = [...windows].find((window) => !window.isDestroyed());
  if (!mainWindow) {
    mainWindow = createWindow();
  }
  requestedWindowPresentation.add(mainWindow);
  if (failedWindows.has(mainWindow)) {
    await rendererRecovery.get(mainWindow)?.();
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
  void showOrCreateMainWindow(options).catch((error) => {
    console.error("Cursor Atelier could not show its window.", error);
  });
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

function createWindow({ showWhenReady = true } = {}) {
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
  if (showWhenReady) {
    requestedWindowPresentation.add(mainWindow);
  }
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
    failedWindows.add(mainWindow);
    void mainWindow
      .loadURL(failurePage(description))
      .finally(() => {
        if (
          !mainWindow.isDestroyed() &&
          requestedWindowPresentation.has(mainWindow)
        ) {
          mainWindow.show();
        }
      })
      .catch((error) => {
        console.error("Could not load the renderer failure page.", error);
      });
  };
  const loadRenderer = async () => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    showingFailure = false;
    failedWindows.delete(mainWindow);
    try {
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      } else {
        await mainWindow.loadFile(
          path.join(
            __dirname,
            `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
          ),
        );
      }
    } catch (error) {
      showFailure(error.message);
    }
  };
  rendererRecovery.set(mainWindow, loadRenderer);

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
  mainWindow.on("unresponsive", () => {
    if (requestedWindowPresentation.has(mainWindow)) {
      mainWindow.show();
    }
  });
  mainWindow.once("ready-to-show", () => {
    if (requestedWindowPresentation.has(mainWindow)) {
      mainWindow.show();
    }
  });
  mainWindow.on("close", (event) => {
    windowLifecycle?.handleWindowClose(event, mainWindow);
  });
  mainWindow.on("closed", () => {
    rendererNavigation.dispose(webContentsId);
    trustedWebContents.delete(webContentsId);
    failedWindows.delete(mainWindow);
    rendererRecovery.delete(mainWindow);
    windows.delete(mainWindow);
  });

  void loadRenderer();

  return mainWindow;
}

function installApplicationMenu() {
  const settingsItem = {
    id: "settings",
    label: "Settings…",
    accelerator: "CommandOrControl+,",
    click: () => requestMainWindow({ navigate: "settings" }),
  };
  const viewItem = app.isPackaged
    ? {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      }
    : { role: "viewMenu" };
  const template =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "fileMenu" },
          { role: "editMenu" },
          viewItem,
          { role: "windowMenu" },
        ]
      : [
          {
            role: "fileMenu",
            submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          viewItem,
          { role: "windowMenu" },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMenuBarIcon() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "MenuBarIconTemplate.png")
    : path.join(app.getAppPath(), "assets", "MenuBarIconTemplate.png");
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) {
    console.error(`Could not load the menu bar icon at ${iconPath}.`);
    return null;
  }
  const image = source.resize({ width: 18, height: 18, quality: "best" });
  if (image.isEmpty()) {
    console.error(`Could not resize the menu bar icon at ${iconPath}.`);
    return null;
  }
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
    const icon = createMenuBarIcon();
    if (!icon) {
      return;
    }
    tray = new Tray(icon);
    tray.setToolTip("Cursor Atelier");
    setTrayMenu();
  }
  void refreshTrayMenu();
}

function notifyCursorChanged(payload) {
  broadcastToRenderers("cursor:changed", payload);
  void refreshTrayMenu();
}

function notifyLibraryChanged(payload) {
  broadcastToRenderers("cursor:library-changed", {
    ...payload,
    changedAt: new Date().toISOString(),
  });
  void refreshTrayMenu();
}

function curatedConverterInvocation() {
  if (app.isPackaged) {
    return {
      command: path.join(
        process.resourcesPath,
        "curated-cursor-converter",
        "curated-cursor-converter",
      ),
      commandArguments: [],
    };
  }
  return {
    command: "/usr/bin/python3",
    commandArguments: [
      path.join(
        app.getAppPath(),
        "native",
        "cursor-packs",
        "curated_runtime.py",
      ),
    ],
  };
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

  const [installModule, importerModule] = await Promise.all([
    import("./main/cursor-import-install.js"),
    import("./main/cursor-import-worker-client.js"),
  ]);
  const {
    createCursorImportStaging,
    installImportedArtifacts,
    removeCursorImportStaging,
  } = installModule;
  const { importCursorSourceInWorker } = importerModule;
  const stagingDirectory = await createCursorImportStaging(importedPacksRoot);
  try {
    const converted = await importCursorSourceInWorker({
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
  const curatedSourceRoot = path.join(
    app.getPath("userData"),
    "CuratedSources",
  );
  const curatedWorkRoot = path.join(
    app.getPath("userData"),
    "CuratedConversion",
  );
  const preferencesStore = createCursorPreferencesStore({
    directory: app.getPath("userData"),
  });
  const onboardingStore = createOnboardingStore({
    directory: app.getPath("userData"),
  });
  getSystemAppearance();
  nativeTheme.themeSource = preferencesStore.getAppAppearanceMode();
  const initialPreferences = preferencesStore.get();
  const persistPendingThemeSizeCleanup = (identifiers) => {
    const pending = preferencesStore.getPendingThemeSizeCleanupIds();
    const seen = new Set(pending.map((identifier) => identifier.toLowerCase()));
    for (const identifier of identifiers) {
      if (!seen.has(identifier.toLowerCase())) {
        seen.add(identifier.toLowerCase());
        pending.push(identifier);
      }
    }
    return preferencesStore.setPendingThemeSizeCleanupIds(pending);
  };
  const bridge = createCursorBridge({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    importedPacksRoot,
    trashImportedArtifact: (artifactPath) => shell.trashItem(artifactPath),
    persistPendingThemeSizeCleanup,
  });
  try {
    const reconciliation = await reconcileCursorImportTransactions({
      importedPacksRoot,
      disposeArtifact: (artifactPath) => shell.trashItem(artifactPath),
      recoverDeletionNativeState: (recovery) =>
        bridge.recoverNativeState(recovery),
      persistPendingThemeSizeCleanup,
    });
    if (reconciliation.cleanupPending) {
      console.error(
        "Some interrupted cursor import transactions still require cleanup.",
      );
    }
  } catch (error) {
    console.error("Could not reconcile interrupted cursor imports.", error);
  }
  try {
    const reconciliation =
      await reconcileCuratedConversionWorkspaces(curatedWorkRoot);
    if (reconciliation.cleanupPending) {
      console.error(
        "Some interrupted curated conversions still require cleanup.",
      );
    }
  } catch (error) {
    console.error(
      "Could not reconcile interrupted curated conversions.",
      error,
    );
  }
  try {
    const reconciliation = await reconcileCuratedSourceTransactions({
      cacheRoot: curatedSourceRoot,
    });
    if (reconciliation.cleanupPending) {
      console.error(
        "Some interrupted curated source acquisitions still require cleanup.",
      );
    }
  } catch (error) {
    console.error(
      "Could not reconcile interrupted curated source acquisitions.",
      error,
    );
  }
  const completedSourceFamilies = onboardingStore
    .get()
    .jobs.filter((job) => job.status === "completed")
    .map((job) => job.familyId)
    .filter((familyId) => CURATED_FAMILY_IDS.includes(familyId));
  if (completedSourceFamilies.length) {
    void removeCuratedFamilySources({
      familyIds: completedSourceFamilies,
      cacheRoot: curatedSourceRoot,
    }).catch((error) =>
      console.error("Could not remove completed curated source caches.", error),
    );
  }

  const converter = curatedConverterInvocation();
  const installCuratedVariants = createCuratedVariantInstaller({
    workRoot: curatedWorkRoot,
    importedPacksRoot,
    bridge,
    createStaging: createCursorImportStaging,
    removeStaging: removeCursorImportStaging,
    installArtifacts: installImportedArtifacts,
  });
  const localArchiveRoot =
    process.env.CURSOR_ATELIER_CURATED_ARCHIVE_ROOT || undefined;
  const runImportedLibraryExclusive = (operation) => {
    const result = importQueue.then(operation);
    importQueue = result.catch(() => undefined);
    return result;
  };
  const curatedFamilyService = createCuratedFamilyService({
    familyIds: CURATED_FAMILY_IDS,
    variantsByFamily: CURATED_VARIANTS_BY_FAMILY,
    store: onboardingStore,
    acquireFamilySources: ({ familyId, signal, onProgress }) => {
      const sourceIds = CURATED_SOURCE_CATALOG.families.find(
        (family) => family.id === familyId,
      ).sourceIds;
      const sourceProgress = new Map(
        sourceIds.map((sourceId) => [sourceId, 0]),
      );
      return acquireCuratedFamilySources({
        familyIds: [familyId],
        cacheRoot: curatedSourceRoot,
        localArchiveRoot,
        signal,
        onProgress: (event) => {
          if (sourceProgress.has(event?.sourceId)) {
            sourceProgress.set(
              event.sourceId,
              Math.min(1, Math.max(0, Number(event.progress) || 0)),
            );
          }
          onProgress(
            [...sourceProgress.values()].reduce(
              (total, progress) => total + progress,
              0,
            ) / sourceProgress.size,
          );
        },
      });
    },
    releaseFamilySources: ({ familyId }) =>
      removeCuratedFamilySources({
        familyIds: [familyId],
        cacheRoot: curatedSourceRoot,
      }),
    getInstalledVariantIds: ({ familyId }) =>
      runImportedLibraryExclusive(async () => {
        const expected = new Set(CURATED_VARIANTS_BY_FAMILY.get(familyId));
        return (await bridge.listThemes())
          .filter(
            (theme) =>
              expected.has(theme.nativeThemeId) &&
              theme.curatedFamilyId === familyId &&
              theme.sourceFormat === "curated-source" &&
              theme.curatedCatalogSha256 === CURATED_FAMILY_CATALOG.sha256,
          )
          .map((theme) => theme.nativeThemeId);
      }),
    convertFamily: async ({
      familyId,
      sourceRoot,
      skipIdentifiers,
      signal,
      onEvent,
    }) => {
      const workspace = await createCuratedConversionWorkspace(curatedWorkRoot);
      try {
        await convertCuratedFamily({
          ...converter,
          familyId,
          sourceRoot,
          outputRoot: workspace,
          skipIdentifiers,
          signal,
          onEvent,
        });
      } finally {
        try {
          await removeCuratedConversionWorkspace({
            root: curatedWorkRoot,
            workspace,
          });
        } catch (error) {
          console.error(
            "Could not remove a curated conversion workspace.",
            error,
          );
        }
      }
    },
    installVariants: installCuratedVariants,
    runInstallExclusive: runImportedLibraryExclusive,
    onLibraryChanged: notifyLibraryChanged,
  });
  const libraryPreferencesReconciler = createCursorLibraryPreferencesReconciler(
    {
      bridge,
      preferencesStore,
      onRetryError: (error, { attempt }) => {
        console.error(
          `Cursor library preference reconciliation retry ${attempt} failed.`,
          error,
        );
      },
    },
  );
  const themeSizeCleanupReconciler = createCursorThemeSizeCleanupReconciler({
    bridge,
    preferencesStore,
    onRetryError: (error, { attempt }) => {
      console.error(
        `Deleted cursor size cleanup retry ${attempt} failed.`,
        error,
      );
    },
  });
  // Launching app.asar directly (including the Playwright preview) can still
  // report app.isPackaged. Requiring the verified packaged native component
  // keeps that read-only preview from registering a system login item.
  const backgroundRegistrationAvailable = Boolean(
    app.isPackaged &&
    process.platform === "darwin" &&
    bridge.nativePath &&
    process.env.CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION !== "1",
  );
  let loginItemReconciliation = Promise.resolve();
  if (backgroundRegistrationAvailable) {
    try {
      backgroundLaunch = Boolean(
        app.getLoginItemSettings({ type: "mainAppService" }).wasOpenedAtLogin,
      );
    } catch (error) {
      console.error("Could not inspect Cursor Atelier’s login item.", error);
    }
  }
  const mainLoginItemReconciler = createMainLoginItemReconciler({
    available: backgroundRegistrationAvailable,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    getLoginItemSettings: (settings) => app.getLoginItemSettings(settings),
    onUnsatisfied: ({ desired, status }) => {
      if (desired && status === "requires-approval") {
        console.warn(
          "Cursor Atelier’s background launch requires approval in macOS Login Items.",
        );
      } else {
        console.error(
          `Cursor Atelier’s background launch reconciliation has status: ${status}.`,
        );
      }
    },
    onError: (error) => {
      console.error("Could not update Cursor Atelier’s login item.", error);
    },
  });
  windowLifecycle = createWindowLifecycle({
    isMacOS: process.platform === "darwin",
    setActivationPolicy: (policy) => app.setActivationPolicy(policy),
    quit: () => app.quit(),
    getMenuBarVisible: () => preferencesStore.get().menuBar.visible === true,
    getShouldStayRunning: () =>
      shouldMainAppStayRunning(preferencesStore.get()),
    hasVisibleWindows,
    hideWindow: (window) => {
      requestedWindowPresentation.delete(window);
      window.hide();
    },
    onError: (error, { policy }) => {
      console.error(
        `Could not set Cursor Atelier’s macOS activation policy to ${policy}.`,
        error,
      );
    },
  });
  // Reconcile the Electron login item before handling a stale background
  // launch so an app with no resident feature does not relaunch headlessly at
  // the next login. The native cursor helper has its own lifecycle.
  mainLoginItemReconciler.sync(
    shouldRegisterMainAppLoginItem(initialPreferences),
  );
  if (backgroundLaunch) {
    windowLifecycle.enterBackground();
    if (!shouldRegisterMainAppLoginItem(initialPreferences)) {
      mainLoginItemReconciler.stop();
      libraryPreferencesReconciler.stop();
      themeSizeCleanupReconciler.stop();
      windowLifecycle.handleBackgroundPreferenceChanged(false);
      return;
    }
  }
  if (backgroundRegistrationAvailable) {
    // Start update reconciliation immediately so later cursor mutations queue
    // behind it, but do not keep an interactive launch from showing its shell
    // while ServiceManagement replaces or re-registers an older helper.
    loginItemReconciliation = bridge.reconcileLoginItems().catch((error) => {
      // The UI still needs to open so Restore and Login Items guidance remain
      // available. Status will surface any unresolved helper registration.
      console.error(
        "Could not reconcile Cursor Atelier’s installed login helper.",
        error,
      );
    });
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
  const unsubscribeOnboarding = curatedFamilyService.subscribe((state) => {
    broadcastToRenderers("onboarding:changed", state);
  });
  ipcMain.handle("onboarding:get", (event) => {
    requireTrustedSender(event);
    return curatedFamilyService.getState();
  });
  ipcMain.handle("onboarding:start", (event, familyIds) => {
    requireTrustedSender(event);
    return curatedFamilyService.start(familyIds);
  });
  ipcMain.handle("onboarding:retry", (event, familyId) => {
    requireTrustedSender(event);
    return curatedFamilyService.retry(familyId);
  });
  const disposeAppAppearanceIpc = registerAppAppearanceIpc({
    ipcMain,
    preferencesStore,
    nativeTheme,
    isTrustedSender,
    onAppearanceChanged: syncWindowBackgrounds,
  });
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
    applyTheme: (identifier) =>
      automation.runExclusive(async () => {
        const status = await bridge.applyTheme(identifier);
        notifyCursorChanged({
          reason: "renderer-apply",
          status,
          changedAt: new Date().toISOString(),
        });
        return status;
      }),
    restoreState: async () => {
      return automation.runExclusive(() =>
        restoreCursorState({
          bridge,
          preferencesStore,
          onRestored: (status) => {
            notifyCursorChanged({
              reason: "renderer-restore",
              status,
              changedAt: new Date().toISOString(),
            });
          },
          onRestoreFailed: (status) => {
            notifyCursorChanged({
              reason: "renderer-restore-failed",
              status,
              changedAt: new Date().toISOString(),
            });
          },
        }),
      );
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
    const operation = importQueue.then(async () => {
      const result = await chooseAndImportCursorPack(
        event,
        bridge,
        importedPacksRoot,
      );
      if (!result.canceled) {
        notifyLibraryChanged({
          reason: "renderer-import",
          identifiers: result.identifiers,
        });
      }
      return result;
    });
    importQueue = operation.catch(() => undefined);
    return operation;
  });
  const enqueueImportedLibraryMutation = (operation) => {
    const result = importQueue.then(operation);
    importQueue = result.catch(() => undefined);
    return result;
  };
  const assertCuratedMutationIdle = () => {
    const active = curatedFamilyService
      .getState()
      .jobs.some((job) =>
        ["queued", "downloading", "converting", "installing"].includes(
          job.status,
        ),
      );
    if (active) {
      const error = new Error(
        "Wait for this curated family to finish before changing it.",
      );
      error.code = "CURATED_FAMILY_BUSY";
      throw error;
    }
  };
  const completeImportedDeletion = async (result, reason) => {
    if (result.sizePreferenceCleanupIdentifiers?.length) {
      try {
        await themeSizeCleanupReconciler.recordPending(
          result.sizePreferenceCleanupIdentifiers,
        );
      } catch (error) {
        console.error(
          "The imported cursor was removed, but its pending native size cleanup could not be persisted.",
          error,
        );
      }
    }
    let preferenceCleanupPending = false;
    try {
      await libraryPreferencesReconciler.reconcile();
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
    notifyLibraryChanged({ reason, identifiers: result.identifiers });
    return { ...result, preferenceCleanupPending };
  };
  ipcMain.handle(
    "cursor:assign-imported-family",
    (event, identifiers, family) => {
      requireTrustedSender(event);
      return enqueueImportedLibraryMutation(async () => {
        assertCuratedMutationIdle();
        const result = await bridge.assignImportedFamily(identifiers, family);
        let preferenceCleanupPending = false;
        try {
          await libraryPreferencesReconciler.reconcile();
        } catch (error) {
          preferenceCleanupPending = true;
          console.error(
            "The imported cursor family changed, but saved preferences could not be reconciled.",
            error,
          );
        }
        notifyLibraryChanged({
          reason: "renderer-assign-imported-family",
          identifiers: result.identifiers,
        });
        return { ...result, preferenceCleanupPending };
      });
    },
  );
  ipcMain.handle("cursor:delete-imported", (event, identifier) => {
    requireTrustedSender(event);
    return enqueueImportedLibraryMutation(async () => {
      assertCuratedMutationIdle();
      return completeImportedDeletion(
        await bridge.deleteImportedThemes([identifier]),
        "renderer-delete-imported",
      );
    });
  });
  ipcMain.handle("cursor:delete-imported-family", (event, family) => {
    requireTrustedSender(event);
    return enqueueImportedLibraryMutation(async () => {
      assertCuratedMutationIdle();
      return completeImportedDeletion(
        await bridge.deleteImportedFamily(family),
        "renderer-delete-imported-family",
      );
    });
  });

  const automation = createCursorAutomation({
    bridge,
    preferencesStore,
    getSystemAppearance,
    onCursorChanged: notifyCursorChanged,
    onError: (error, { reason }) => {
      console.error(`Cursor automation failed (${reason}).`, error);
    },
  });
  runtime = {
    automation,
    bridge,
    preferencesStore,
    curatedFamilyService,
    curatedCatalogSha256: CURATED_FAMILY_CATALOG.sha256,
  };

  ipcMain.handle(
    "cursor:set-appearance-cursor",
    (event, appearance, identifier) => {
      requireTrustedSender(event);
      return automation.setAppearanceCursor(appearance, identifier);
    },
  );
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

  let menuBarVisible = initialPreferences.menuBar.visible === true;
  let shouldStayRunning = shouldMainAppStayRunning(initialPreferences);
  const unsubscribePreferences = preferencesStore.subscribe((preferences) => {
    const nextMenuBarVisible = preferences.menuBar.visible === true;
    const menuBarVisibilityChanged = nextMenuBarVisible !== menuBarVisible;
    const nextShouldStayRunning = shouldMainAppStayRunning(preferences);
    const backgroundPreferenceChanged =
      nextShouldStayRunning !== shouldStayRunning;
    menuBarVisible = nextMenuBarVisible;
    shouldStayRunning = nextShouldStayRunning;
    broadcastToRenderers("preferences:changed", preferences);
    mainLoginItemReconciler.sync(shouldRegisterMainAppLoginItem(preferences));
    syncTray(preferences);
    if (backgroundPreferenceChanged) {
      windowLifecycle?.handleBackgroundPreferenceChanged(nextShouldStayRunning);
    }
    if (
      menuBarVisibilityChanged &&
      !nextMenuBarVisible &&
      nextShouldStayRunning &&
      !hasVisibleWindows()
    ) {
      for (const window of windows) {
        if (!window.isDestroyed() && !window.isVisible()) {
          window.destroy();
        }
      }
    }
  });
  syncTray(initialPreferences);
  installApplicationMenu();

  const handleNativeThemeUpdated = () => {
    syncWindowBackgrounds();
  };
  const handleSystemAppearanceUpdated = () =>
    void automation.appearanceChanged();
  const handleWake = () => void automation.wake();
  nativeTheme.on("updated", handleNativeThemeUpdated);
  powerMonitor.on("resume", handleWake);
  powerMonitor.on("unlock-screen", handleWake);

  const localNotificationIds = [];
  let appearanceNotificationId = null;
  if (process.platform === "darwin") {
    appearanceNotificationId = systemPreferences.subscribeNotification(
      "AppleInterfaceThemeChangedNotification",
      handleSystemAppearanceUpdated,
    );
    for (const notification of [
      "NSSystemClockDidChangeNotification",
      "NSSystemTimeZoneDidChangeNotification",
    ]) {
      localNotificationIds.push(
        systemPreferences.subscribeLocalNotification(notification, handleWake),
      );
    }
  }

  let stopping = false;
  let shutdownReady = false;
  const handleBeforeQuit = (event) => {
    if (shutdownReady) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    windowLifecycle?.beginQuit();
    automation.stop();
    libraryPreferencesReconciler.stop();
    themeSizeCleanupReconciler.stop();
    mainLoginItemReconciler.stop();
    curatedFamilyService.stop();
    unsubscribeOnboarding();
    disposeAppAppearanceIpc();
    unsubscribePreferences();
    nativeTheme.off("updated", handleNativeThemeUpdated);
    powerMonitor.off("resume", handleWake);
    powerMonitor.off("unlock-screen", handleWake);
    for (const identifier of localNotificationIds) {
      systemPreferences.unsubscribeLocalNotification(identifier);
    }
    if (appearanceNotificationId !== null) {
      systemPreferences.unsubscribeNotification(appearanceNotificationId);
      appearanceNotificationId = null;
    }
    tray?.destroy();
    tray = null;
    runtime = null;
    let timeoutId;
    void Promise.race([
      curatedFamilyService.whenIdle(),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, 7_000);
      }),
    ]).finally(() => {
      clearTimeout(timeoutId);
      shutdownReady = true;
      app.quit();
    });
  };
  app.on("before-quit", handleBeforeQuit);

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
  } else if (initialPreferences.menuBar.visible) {
    // A login/background launch otherwise has no renderer until the first
    // menu-bar click. Warm one invisibly so Open and Settings are immediate;
    // closing a visible menu-bar window retains the same warm renderer.
    createWindow({ showWhenReady: false });
  }
  await loginItemReconciliation;
  if (!stopping) {
    try {
      await themeSizeCleanupReconciler.reconcile();
    } catch (error) {
      console.error(
        "Deleted cursor size preferences could not be reconciled at startup.",
        error,
      );
    }
  }
  if (!stopping) {
    try {
      await libraryPreferencesReconciler.reconcile();
    } catch (error) {
      console.error(
        "Cursor library preferences could not be reconciled at startup.",
        error,
      );
    }
    const automationStart = automation.start().catch((error) => {
      console.error("Could not start cursor automation.", error);
    });
    if (backgroundLaunch) {
      void automationStart.finally(() => {
        if (
          !stopping &&
          !shouldMainAppStayRunning(preferencesStore.get()) &&
          !hasVisibleWindows()
        ) {
          windowLifecycle?.handleBackgroundPreferenceChanged(false);
        }
      });
    }
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
  if (windowLifecycle) {
    windowLifecycle.handleAllWindowsClosed();
  } else if (process.platform !== "darwin") {
    app.quit();
  }
});
