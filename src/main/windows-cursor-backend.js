import fs from "node:fs/promises";
import { securePrivateDirectory } from "./platform-filesystem.js";
import path from "node:path";
import crypto from "node:crypto";

import {
  createWindowsCursorDesktop,
  runWindowsCursorCommand,
  validateWindowsCursorSnapshot,
} from "./windows-cursor-desktop.js";
import {
  installWindowsCursorTheme,
  readWindowsCursorReceipt,
  removeWindowsCursorThemes,
  WINDOWS_CURSOR_ROLES,
} from "./windows-cursor-theme.js";

import { readCursorTheme } from "./cursor-theme-reader.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function initialState() {
  return {
    schemaVersion: 1,
    selectedThemeIdentifier: null,
    themeSizePercentages: {},
    desiredEnabled: false,
    effectiveTheme: null,
    desktopSnapshot: null,
    transaction: null,
  };
}
function portablePreferences(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !(
      value.selectedThemeIdentifier === null ||
      (typeof value.selectedThemeIdentifier === "string" &&
        IDENTIFIER.test(value.selectedThemeIdentifier))
    ) ||
    !value.themeSizePercentages ||
    typeof value.themeSizePercentages !== "object" ||
    Array.isArray(value.themeSizePercentages) ||
    Object.entries(value.themeSizePercentages).length > 2048 ||
    Object.entries(value.themeSizePercentages).some(
      ([key, size]) =>
        !IDENTIFIER.test(key) ||
        !Number.isInteger(size) ||
        size < 50 ||
        size > 200,
    )
  ) {
    throw new TypeError("The Windows cursor preferences are invalid.");
  }
  return {
    schemaVersion: 1,
    selectedThemeIdentifier: value.selectedThemeIdentifier,
    themeSizePercentages: Object.fromEntries(
      Object.entries(value.themeSizePercentages).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
}

function validateState(value, allowTransaction = true) {
  portablePreferences(value);
  if (
    typeof value.desiredEnabled !== "boolean" ||
    (value.effectiveTheme !== null &&
      (!value.effectiveTheme ||
        typeof value.effectiveTheme !== "object" ||
        Array.isArray(value.effectiveTheme) ||
        typeof value.effectiveTheme.identifier !== "string" ||
        !IDENTIFIER.test(value.effectiveTheme.identifier) ||
        typeof value.effectiveTheme.name !== "string" ||
        !value.effectiveTheme.name ||
        path.basename(value.effectiveTheme.name) !==
          value.effectiveTheme.name ||
        typeof value.effectiveTheme.directory !== "string" ||
        !path.isAbsolute(value.effectiveTheme.directory) ||
        !Number.isInteger(value.effectiveTheme.size) ||
        value.effectiveTheme.size < 1 ||
        value.effectiveTheme.size > 256 ||
        !Number.isInteger(value.effectiveTheme.session) ||
        value.effectiveTheme.session < 1 ||
        !value.effectiveTheme.files ||
        typeof value.effectiveTheme.files !== "object" ||
        Array.isArray(value.effectiveTheme.files) ||
        Object.keys(value.effectiveTheme.files).length !==
          Object.keys(WINDOWS_CURSOR_ROLES).length ||
        Object.keys(WINDOWS_CURSOR_ROLES).some((role) => {
          const filename = value.effectiveTheme.files[role];
          return (
            typeof filename !== "string" ||
            !path.isAbsolute(filename) ||
            !/\.(?:cur|ani)$/i.test(filename)
          );
        })))
  ) {
    throw new TypeError("The Windows cursor state is invalid.");
  }
  if (value.desktopSnapshot !== null) {
    validateWindowsCursorSnapshot(value.desktopSnapshot);
  }
  if (value.transaction !== null) {
    if (
      !allowTransaction ||
      !value.transaction ||
      typeof value.transaction !== "object" ||
      Array.isArray(value.transaction)
    ) {
      throw new TypeError("The Windows cursor recovery journal is invalid.");
    }
    validateState(value.transaction.previousState, false);
    validateWindowsCursorSnapshot(value.transaction.snapshot);
  }
}

function generatedNames(snapshot) {
  return (snapshot?.values ?? [])
    .filter(
      (entry) => entry.exists && typeof entry.value === "string" && entry.value,
    )
    .map((entry) => path.basename(path.dirname(entry.value)));
}

/** Implements the native cursor CLI contract within Electron on Windows. */
export function createWindowsCursorBackend({
  getThemes,
  stateDirectory,
  runCommand = runWindowsCursorCommand,
  desktop = createWindowsCursorDesktop({ runCommand }),
  installTheme = installWindowsCursorTheme,
  encoderExecutable = null,
  readTheme = readCursorTheme,
  verifyInstalledTheme = readWindowsCursorReceipt,
  removeThemes = removeWindowsCursorThemes,
} = {}) {
  if (
    typeof getThemes !== "function" ||
    !path.isAbsolute(stateDirectory ?? "")
  ) {
    throw new TypeError(
      "A Windows cursor library and state directory are required.",
    );
  }
  const statePath = path.join(stateDirectory, "state.json");
  const themesDirectory = path.join(stateDirectory, "themes");
  let state;
  let queue = Promise.resolve();
  let lastError = null;
  const themes = () =>
    getThemes().filter(
      (theme) => IDENTIFIER.test(theme.identifier ?? "") && theme.resourcePath,
    );
  const themeFor = (identifier) =>
    themes().find((theme) => theme.identifier === identifier);
  const save = async (next) => {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    securePrivateDirectory(stateDirectory);
    const temporary = path.join(
      stateDirectory,
      `.state-${crypto.randomUUID()}.json`,
    );
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, statePath);
      state = next;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  const load = async () => {
    if (state) {
      return;
    }
    try {
      const stat = await fs.lstat(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("The Windows cursor state file is unsafe.");
      }
      if (stat.size > 2 * 1024 * 1024) {
        throw new Error("The Windows cursor state file is too large.");
      }
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
      validateState(parsed);
      state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      state = initialState();
    }
  };
  const recover = async () => {
    if (!state.transaction) {
      return;
    }
    const { snapshot, previousState } = state.transaction;
    await desktop.restore(snapshot);
    await save({ ...previousState, transaction: null });
  };
  const status = async (observation = null) => {
    const selected = themeFor(state.selectedThemeIdentifier);
    let matches = false;
    let desktopStatus = null;
    let errorMessage = lastError;
    try {
      // Read the registry and live cursor sentinels in one native command.
      // Each command starts PowerShell and loads the Win32 interop assembly.
      desktopStatus = observation ?? (await desktop.read(state.effectiveTheme));
      if (state.effectiveTheme) {
        await verifyInstalledTheme(state.effectiveTheme.directory);
        if (desktopStatus.matchError) {
          throw new Error(desktopStatus.matchError);
        }
        matches = desktopStatus.matches === true;
      }
    } catch (error) {
      errorMessage = error.message;
    }
    return {
      supported: desktopStatus?.supported === true,
      themeValid: Boolean(selected),
      selectedThemeIdentifier: state.selectedThemeIdentifier ?? "",
      themeDisplayName: selected?.displayName ?? "",
      themeSizePercentage:
        state.themeSizePercentages[state.selectedThemeIdentifier] ?? 100,
      desiredEnabled: state.desiredEnabled,
      effectiveApplied: Boolean(state.effectiveTheme),
      currentSentinelsMatchTheme: Boolean(
        matches &&
        state.effectiveTheme?.identifier === state.selectedThemeIdentifier,
      ),
      launchAtLoginDesired: state.desiredEnabled,
      loginApprovalRequired: false,
      loginItemRegistrationCurrent: state.desiredEnabled,
      transactionPending: Boolean(state.transaction),
      actionError:
        errorMessage ||
        (!desktopStatus?.supported
          ? "Cursor changes require an interactive Windows desktop session."
          : null),
    };
  };
  const transaction = async (operation) => {
    const previousState = structuredClone(state);
    const snapshot = await desktop.capture();
    await save({ ...state, transaction: { snapshot, previousState } });
    try {
      const next = await operation(snapshot);
      await save({ ...next, transaction: null });
      lastError = null;
    } catch (error) {
      lastError = error.message;
      try {
        await desktop.restore(snapshot);
        await save(previousState);
      } catch (rollbackError) {
        const failure = new AggregateError(
          [error, rollbackError],
          `${error.message} The previous cursor could not be fully restored: ${rollbackError.message}`,
        );
        failure.code = "WINDOWS_CURSOR_ROLLBACK_FAILED";
        throw failure;
      }
      throw error;
    }
  };
  const apply = async (identifier, sizeOverride = null) => {
    const desktopStatus = await desktop.requireSupported();
    if (state.desktopSnapshot && state.desktopSnapshot.kind !== desktop.kind) {
      const error = new Error(
        "Restore the cursor in the desktop session where it was applied before applying it in another desktop environment.",
      );
      error.code = "WINDOWS_DESKTOP_CHANGED";
      throw error;
    }
    const theme = themeFor(identifier);
    if (!theme) {
      throw new Error("That cursor theme is not available to apply.");
    }
    const sizePercentage =
      sizeOverride ?? state.themeSizePercentages[identifier] ?? 100;
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    securePrivateDirectory(stateDirectory);
    const installed = await installTheme({
      theme,
      themesDirectory,
      runCommand,
      sizePercentage,
      encoderExecutable,
      systemSize: desktopStatus.cursorSize,
    });
    let appliedDesktopStatus;
    await transaction(async (snapshot) => {
      appliedDesktopStatus = await desktop.apply(installed);
      return {
        ...state,
        selectedThemeIdentifier: identifier,
        desiredEnabled: true,
        themeSizePercentages: {
          ...state.themeSizePercentages,
          [identifier]: sizePercentage,
        },
        effectiveTheme: { identifier, ...installed, session: desktop.session },
        desktopSnapshot: state.desktopSnapshot ?? snapshot,
      };
    });
    // Apply already attests the live images after updating the desktop. Keep
    // that observation instead of immediately launching another native check.
    return status(appliedDesktopStatus);
  };
  const restore = async () => {
    if (state.desktopSnapshot) {
      await transaction(async () => {
        await desktop.restore(state.desktopSnapshot);
        return {
          ...state,
          desiredEnabled: false,
          effectiveTheme: null,
          desktopSnapshot: null,
        };
      });
    } else if (state.desiredEnabled || state.effectiveTheme) {
      throw new Error(
        "The previous desktop cursor snapshot is unavailable; cursor restoration cannot be completed safely.",
      );
    }
    return status();
  };
  const execute = async ({ command, arguments: args = [] }) => {
    await load();
    if (command !== "--status") {
      await recover();
    }
    switch (command) {
      case "--status":
        return status();
      case "--list-themes":
        return {
          themes: themes().map((theme) => ({
            identifier: theme.identifier,
            nativeThemeId: theme.identifier,
            displayName: theme.displayName,
            sizePercentage: state.themeSizePercentages[theme.identifier] ?? 100,
          })),
        };
      case "--validate-theme": {
        const theme = themeFor(args[0]);
        try {
          if (!theme) {
            throw new Error("The cursor theme is unavailable.");
          }
          await readTheme(theme);
          return { valid: true, identifier: theme.identifier };
        } catch (error) {
          return { valid: false, actionError: error.message };
        }
      }
      case "--validate-themes": {
        for (const theme of themes()) {
          await readTheme(theme);
        }
        return { valid: true };
      }
      case "--apply-theme":
        return apply(args[0]);
      case "--setup":
      case "--enable":
        return apply(state.selectedThemeIdentifier ?? themes()[0]?.identifier);
      case "--select-theme": {
        if (!themeFor(args[0])) {
          throw new Error("The cursor theme is unavailable.");
        }
        await save({ ...state, selectedThemeIdentifier: args[0] });
        return status();
      }
      case "--disable":
      case "--teardown":
        return restore();
      case "--set-theme-size": {
        const [identifier, sizeText] = args;
        const size = Number(sizeText);
        if (
          !themeFor(identifier) ||
          !Number.isInteger(size) ||
          size < 50 ||
          size > 200
        ) {
          throw new TypeError(
            "Cursor size must be an integer between 50 and 200 for an installed theme.",
          );
        }
        await save({
          ...state,
          themeSizePercentages: {
            ...state.themeSizePercentages,
            [identifier]: size,
          },
        });
        return status();
      }
      case "--forget-theme-size": {
        if (!IDENTIFIER.test(args[0] ?? "")) {
          throw new TypeError("A cursor identifier is required.");
        }
        const sizes = { ...state.themeSizePercentages };
        delete sizes[args[0]];
        await save({ ...state, themeSizePercentages: sizes });
        const current = desktop.kind ? await desktop.read() : null;
        await removeThemes({
          themesDirectory,
          identifier: args[0],
          keepNames: [
            ...generatedNames(current),
            state.effectiveTheme?.name,
            ...generatedNames(state.desktopSnapshot),
          ].filter(Boolean),
        });
        return { forgotten: true };
      }
      case "--portable-preferences":
        return portablePreferences(state);
      case "--replace-portable-preferences": {
        if (state.desiredEnabled) {
          throw new Error(
            "Restore the system cursor before replacing cursor preferences.",
          );
        }
        const preferences = portablePreferences(JSON.parse(args[0]));
        await save({ ...state, ...preferences });
        return { ...preferences, replaced: true };
      }
      case "--reset-preferences": {
        await restore();
        const current = desktop.kind ? await desktop.read() : null;
        await removeThemes({
          themesDirectory,
          keepNames: generatedNames(current),
        });
        await save(initialState());
        return { reset: true };
      }
      case "--reconcile-login-items": {
        // Windows persists scheme paths; exact per-theme dimensions are
        // verified and reapplied by the background login entry when needed.
        lastError = null;
        const current = await status();
        if (state.desiredEnabled && !current.currentSentinelsMatchTheme) {
          return apply(state.selectedThemeIdentifier);
        }
        return current;
      }
      case "--open-login-settings":
        return desktop.openSettings();
      default:
        throw new Error(`Unknown Windows cursor operation: ${command}`);
    }
  };
  let pendingStatus = null;
  const commandRunner = (request) => {
    if (request.command === "--status" && pendingStatus) {
      return pendingStatus;
    }
    // The renderer and tray often request the same live status together. Share
    // that observation, but never reuse it across an intervening operation.
    pendingStatus = null;
    const result = queue
      .then(() => execute(request))
      .catch(async (error) => {
        lastError = error.message;
        if (state) {
          error.details = await status();
        }
        throw error;
      });
    queue = result.catch(() => {});
    if (request.command === "--status") {
      pendingStatus = result;
      const clear = () => {
        if (pendingStatus === result) {
          pendingStatus = null;
        }
      };
      void result.then(clear, clear);
    }
    return result;
  };
  return { commandRunner };
}
