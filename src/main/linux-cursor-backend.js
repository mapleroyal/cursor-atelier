import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  createLinuxCursorDesktop,
  runLinuxCursorCommand,
} from "./linux-cursor-desktop.js";
import {
  installLinuxCursorTheme,
  readLinuxCursorTheme,
  removeLinuxCursorThemes,
} from "./linux-cursor-theme.js";

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
      IDENTIFIER.test(value.selectedThemeIdentifier ?? "")
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
    throw new TypeError("The Linux cursor preferences are invalid.");
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

/** Implements the native cursor CLI contract within Electron on Linux. */
export function createLinuxCursorBackend({
  getThemes,
  stateDirectory,
  homeDirectory = os.homedir(),
  env = process.env,
  runCommand = runLinuxCursorCommand,
  desktop = createLinuxCursorDesktop({ env, runCommand }),
  installTheme = installLinuxCursorTheme,
  encoderExecutable = null,
} = {}) {
  if (
    typeof getThemes !== "function" ||
    !path.isAbsolute(stateDirectory ?? "")
  ) {
    throw new TypeError(
      "A Linux cursor library and state directory are required.",
    );
  }
  const statePath = path.join(stateDirectory, "state.json");
  // ~/.icons is part of libXcursor's search path even on distributions whose
  // libXcursor build does not include XDG_DATA_HOME/icons.
  const iconsDirectory = path.join(homeDirectory, ".icons");
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
    const temporary = path.join(
      stateDirectory,
      `.state-${crypto.randomUUID()}.json`,
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
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
      const stat = await fs.stat(statePath);
      if (stat.size > 2 * 1024 * 1024) {
        throw new Error("The Linux cursor state file is too large.");
      }
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
      portablePreferences(parsed);
      if (typeof parsed.desiredEnabled !== "boolean") {
        throw new Error("The Linux cursor state is invalid.");
      }
      state = { ...initialState(), ...parsed };
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
  const status = async () => {
    const selected = themeFor(state.selectedThemeIdentifier);
    let matches = false;
    let errorMessage = lastError;
    try {
      if (state.effectiveTheme) {
        matches = await desktop.matches(state.effectiveTheme);
      }
    } catch (error) {
      errorMessage = error.message;
    }
    return {
      supported: Boolean(desktop.kind),
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
        (!desktop.kind
          ? "Cursor application is available on GNOME, KDE Plasma, and Hyprland Linux sessions."
          : null),
    };
  };
  const transaction = async (operation) => {
    const previousState = structuredClone(state);
    const snapshot = await desktop.capture();
    // If Hyprland was already applying our theme, its inherited environment
    // still names the original cursor. Recovery must restore the live theme.
    if (
      desktop.kind === "hyprland" &&
      previousState.effectiveTheme &&
      (await desktop.matches(previousState.effectiveTheme))
    ) {
      snapshot.compositorTheme = previousState.effectiveTheme.name;
      snapshot.compositorSize = previousState.effectiveTheme.size;
    }
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
        failure.code = "LINUX_CURSOR_ROLLBACK_FAILED";
        throw failure;
      }
      throw error;
    }
  };
  const apply = async (identifier, sizeOverride = null) => {
    desktop.requireSupported();
    if (state.desktopSnapshot && state.desktopSnapshot.kind !== desktop.kind) {
      const error = new Error(
        "Restore the cursor in the desktop session where it was applied before applying it in another desktop environment.",
      );
      error.code = "LINUX_DESKTOP_CHANGED";
      throw error;
    }
    const theme = themeFor(identifier);
    if (!theme) {
      throw new Error("That cursor theme is not available to apply.");
    }
    const sizePercentage =
      sizeOverride ?? state.themeSizePercentages[identifier] ?? 100;
    const installed = await installTheme({
      theme,
      iconsDirectory,
      runCommand,
      sizePercentage,
      encoderExecutable,
    });
    await transaction(async (snapshot) => {
      await desktop.apply(installed);
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
    return status();
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
          await readLinuxCursorTheme(theme);
          return { valid: true, identifier: theme.identifier };
        } catch (error) {
          return { valid: false, actionError: error.message };
        }
      }
      case "--validate-themes": {
        for (const theme of themes()) {
          await readLinuxCursorTheme(theme);
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
        await removeLinuxCursorThemes({
          iconsDirectory,
          identifier: args[0],
          keepNames: [
            current?.theme,
            state.effectiveTheme?.name,
            state.desktopSnapshot?.theme,
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
        await removeLinuxCursorThemes({
          iconsDirectory,
          keepNames: [current?.theme].filter(Boolean),
        });
        await save(initialState());
        return { reset: true };
      }
      case "--reconcile-login-items": {
        // Desktop settings persist on GNOME/Plasma. Hyprland's cursor manager is
        // session-local and is reapplied by the app's XDG background login entry.
        if (
          state.desiredEnabled &&
          (!state.effectiveTheme ||
            !(await desktop.matches(state.effectiveTheme)))
        ) {
          return apply(state.selectedThemeIdentifier);
        }
        return status();
      }
      case "--open-login-settings":
        throw new Error(
          "Linux cursor changes do not require Login Items approval.",
        );
      default:
        throw new Error(`Unknown Linux cursor operation: ${command}`);
    }
  };
  const commandRunner = (request) => {
    const result = queue.then(() => execute(request));
    queue = result.catch(() => {});
    return result.catch(async (error) => {
      lastError = error.message;
      if (state) {
        error.details = await status();
      }
      throw error;
    });
  };
  return { commandRunner };
}
