import fs from "node:fs";
import path from "node:path";

import {
  createDefaultCursorPreferences,
  normalizeCursorPreferences,
} from "../lib/cursor-preferences.js";
import { normalizeOnboardingStoreState } from "./onboarding-store.js";
import { isVerifiedRestoredStatus } from "./cursor-state-service.js";

export const APP_DATA_ARCHIVE_SCHEMA_VERSION = 1;

const fsPromises = fs.promises;
const TRANSACTION_SCHEMA_VERSION = 1;
const IMPORT_PREFIX = ".data-import-";
const RESET_PREFIX = ".data-reset-";
const MARKER_NAME = ".cursor-atelier-data-transaction.json";
const PREVIOUS_LIBRARY_NAME = "PreviousImportedPacks";
const DISCARD_LIBRARY_NAME = "DiscardedImportedPacks";
const RESET_OWNED_PATHS = Object.freeze([
  "ImportedPacks",
  "CuratedSources",
  "CuratedConversion",
  "ImportedThemeValidation.json",
  "StockSnapshot.plist",
  "Transaction.plist",
  "Operation.lock",
]);
const RESET_DIRECTORY_PATHS = new Set([
  "ImportedPacks",
  "CuratedSources",
  "CuratedConversion",
]);
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const APPEARANCE_MODES = new Set(["system", "light", "dark"]);
const RUNNING_ONBOARDING_STATUSES = new Set([
  "queued",
  "downloading",
  "converting",
  "installing",
]);

function serviceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizePortablePreferences(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    (value.selectedThemeIdentifier !== null &&
      (typeof value.selectedThemeIdentifier !== "string" ||
        !IDENTIFIER.test(value.selectedThemeIdentifier))) ||
    !isPlainObject(value.themeSizePercentages)
  ) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive has invalid native cursor settings.",
    );
  }
  const entries = Object.entries(value.themeSizePercentages);
  if (
    entries.length > 2048 ||
    entries.some(
      ([identifier, size]) =>
        !IDENTIFIER.test(identifier) ||
        !Number.isInteger(size) ||
        size < 50 ||
        size > 200,
    )
  ) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive has invalid native cursor settings.",
    );
  }
  return {
    schemaVersion: 1,
    selectedThemeIdentifier: value.selectedThemeIdentifier,
    themeSizePercentages: Object.fromEntries(
      entries.sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function normalizePreferencesData(value) {
  if (!isPlainObject(value) || !isPlainObject(value.preferences)) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive has invalid app settings.",
    );
  }
  const appAppearanceMode = APPEARANCE_MODES.has(value.appAppearanceMode)
    ? value.appAppearanceMode
    : "system";
  const pendingThemeSizeCleanupIds = Array.isArray(
    value.pendingThemeSizeCleanupIds,
  )
    ? value.pendingThemeSizeCleanupIds.filter(
        (identifier) =>
          typeof identifier === "string" && IDENTIFIER.test(identifier),
      )
    : [];
  return {
    preferences: normalizeCursorPreferences(value.preferences),
    appAppearanceMode,
    pendingThemeSizeCleanupIds: [...new Set(pendingThemeSizeCleanupIds)].slice(
      0,
      512,
    ),
  };
}

export function normalizeAppDataArchiveDocument(value, library) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== APP_DATA_ARCHIVE_SCHEMA_VERSION ||
    value.product !== "Cursor Atelier" ||
    !Array.isArray(value.importedThemeIdentifiers) ||
    !Array.isArray(library?.identifiers)
  ) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "This is not a Cursor Atelier data archive.",
    );
  }
  const identifiers = value.importedThemeIdentifiers;
  if (
    identifiers.length !== library.identifiers.length ||
    identifiers.some(
      (identifier, index) =>
        typeof identifier !== "string" ||
        !IDENTIFIER.test(identifier) ||
        identifier !== library.identifiers[index],
    )
  ) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive manifest does not match its cursor library.",
    );
  }
  let onboarding = normalizeOnboardingStoreState(value.onboarding);
  if (onboarding.version !== value.onboarding?.version) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive has an unsupported onboarding state.",
    );
  }
  onboarding = {
    ...onboarding,
    jobs: onboarding.jobs.map((job) =>
      RUNNING_ONBOARDING_STATUSES.has(job.status)
        ? {
            ...job,
            status: "failed",
            progress: null,
            error: "Interrupted. Try again.",
            failure: {
              code: "INTERRUPTED",
              message:
                "Curated family import was interrupted before archiving.",
            },
            currentVariant: null,
          }
        : job,
    ),
  };
  const exportedAt = new Date(value.exportedAt);
  if (!Number.isFinite(exportedAt.getTime())) {
    throw serviceError(
      "INVALID_DATA_ARCHIVE",
      "The archive has an invalid export date.",
    );
  }
  return {
    schemaVersion: APP_DATA_ARCHIVE_SCHEMA_VERSION,
    product: "Cursor Atelier",
    appVersion:
      typeof value.appVersion === "string" ? value.appVersion.slice(0, 64) : "",
    exportedAt: exportedAt.toISOString(),
    preferences: normalizePreferencesData(value.preferences),
    onboarding,
    nativePreferences: normalizePortablePreferences(value.nativePreferences),
    importedThemeIdentifiers: [...identifiers],
  };
}

async function writeMarker(transactionRoot, marker) {
  const markerPath = path.join(transactionRoot, MARKER_NAME);
  const temporaryPath = `${markerPath}.tmp`;
  await fsPromises.writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fsPromises.rename(temporaryPath, markerPath);
}

async function replaceMarker(transactionRoot, marker) {
  const markerPath = path.join(transactionRoot, MARKER_NAME);
  const temporaryPath = `${markerPath}.next`;
  await fsPromises.writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fsPromises.rename(temporaryPath, markerPath);
}

async function readMarker(transactionRoot) {
  try {
    const value = JSON.parse(
      await fsPromises.readFile(
        path.join(transactionRoot, MARKER_NAME),
        "utf8",
      ),
    );
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
      !["import", "reset"].includes(value.kind) ||
      typeof value.committed !== "boolean" ||
      !isPlainObject(value.previous) ||
      !Array.isArray(value.movedPaths)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function transactionHasRecoveryPayload(transactionRoot) {
  for (const relativePath of [PREVIOUS_LIBRARY_NAME, "Previous"]) {
    const stat = await fsPromises
      .lstat(path.join(transactionRoot, relativePath))
      .catch((error) =>
        error?.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (stat) {
      return true;
    }
  }
  return false;
}

async function removeOwnedTemporaryDirectory(userDataRoot, transactionRoot) {
  if (!isPathWithin(userDataRoot, transactionRoot)) {
    throw new Error("Refusing to remove an unexpected data transaction.");
  }
  const stat = await fsPromises
    .lstat(transactionRoot)
    .catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
  if (!stat) {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The data transaction path is invalid.");
  }
  await fsPromises.rm(transactionRoot, { recursive: true });
}

function requiredDependencies(options) {
  const callbacks = [
    "validateImportedPacksRoot",
    "createArchive",
    "extractArchive",
    "moveToTrash",
    "runLibraryExclusive",
    "assertIdle",
    "pauseAutomation",
    "resumeAutomation",
    "reconcileLibraryPreferences",
    "applyAppearanceMode",
    "syncMainLoginItem",
    "onDataChanged",
    "onResetComplete",
  ];
  if (
    !options ||
    typeof options.userDataRoot !== "string" ||
    !path.isAbsolute(options.userDataRoot) ||
    typeof options.importedPacksRoot !== "string" ||
    !path.isAbsolute(options.importedPacksRoot) ||
    !options.preferencesStore ||
    !options.onboardingStore ||
    !options.bridge ||
    callbacks.some((name) => typeof options[name] !== "function")
  ) {
    throw new TypeError("App data service dependencies are incomplete.");
  }
}

export function createAppDataService(options) {
  requiredDependencies(options);
  const {
    userDataRoot,
    importedPacksRoot,
    appVersion = "",
    preferencesStore,
    onboardingStore,
    bridge,
    validateImportedPacksRoot,
    createArchive,
    extractArchive,
    moveToTrash,
    runLibraryExclusive,
    assertIdle,
    pauseAutomation,
    resumeAutomation,
    reconcileLibraryPreferences,
    applyAppearanceMode,
    syncMainLoginItem,
    onDataChanged,
    onResetComplete,
  } = options;
  let dataOperationActive = false;
  let dataRecoveryRequired = false;

  const assertMutationAvailable = () => {
    if (dataRecoveryRequired) {
      throw serviceError(
        "DATA_RECOVERY_REQUIRED",
        "Restart Cursor Atelier to recover the previous data operation before making changes.",
      );
    }
    if (dataOperationActive) {
      throw serviceError(
        "DATA_OPERATION_BUSY",
        "Wait for the current data operation to finish before making changes.",
      );
    }
  };

  const beginDataOperation = async () => {
    assertMutationAvailable();
    dataOperationActive = true;
    try {
      const entries = await fsPromises.readdir(userDataRoot, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (
          !entry.name.startsWith(IMPORT_PREFIX) &&
          !entry.name.startsWith(RESET_PREFIX)
        ) {
          continue;
        }
        if (!entry.isDirectory()) {
          throw serviceError(
            "DATA_RECOVERY_REQUIRED",
            "A prior data operation needs recovery before managing app data.",
          );
        }
        const marker = await readMarker(path.join(userDataRoot, entry.name));
        if (!marker?.committed) {
          throw serviceError(
            "DATA_RECOVERY_REQUIRED",
            "A prior data operation needs recovery before managing app data.",
          );
        }
      }
    } catch (error) {
      dataOperationActive = false;
      throw error;
    }
  };

  const endDataOperation = () => {
    dataOperationActive = false;
  };

  const snapshot = async () => ({
    preferences: preferencesStore.getDataSnapshot(),
    onboarding: onboardingStore.get(),
    nativePreferences: await bridge.getPortablePreferences(),
  });

  const restoreState = async (previous) => {
    preferencesStore.replaceDataSnapshot(previous.preferences);
    onboardingStore.replaceDataSnapshot(previous.onboarding);
    await bridge.replacePortablePreferences(previous.nativePreferences);
    applyAppearanceMode(previous.preferences.appAppearanceMode);
    await syncMainLoginItem(previous.preferences.preferences);
  };

  const rollbackLibrary = async (transactionRoot) => {
    const previousRoot = path.join(transactionRoot, PREVIOUS_LIBRARY_NAME);
    const previousStat = await fsPromises
      .lstat(previousRoot)
      .catch((error) =>
        error?.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (!previousStat) {
      return;
    }
    if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
      throw new Error("The prior imported cursor library is invalid.");
    }
    const currentStat = await fsPromises
      .lstat(importedPacksRoot)
      .catch((error) =>
        error?.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (currentStat) {
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new Error("The promoted imported cursor library is invalid.");
      }
      const discard = path.join(transactionRoot, DISCARD_LIBRARY_NAME);
      await fsPromises.rename(importedPacksRoot, discard);
    }
    await fsPromises.rename(previousRoot, importedPacksRoot);
    await bridge.invalidateManifests();
  };

  const rollbackResetPaths = async (transactionRoot, movedPaths) => {
    for (const name of [...movedPaths].reverse()) {
      if (!RESET_OWNED_PATHS.includes(name)) {
        throw new Error("The reset transaction contains an invalid path.");
      }
      const previous = path.join(transactionRoot, "Previous", name);
      const priorStat = await fsPromises
        .lstat(previous)
        .catch((error) =>
          error?.code === "ENOENT" ? null : Promise.reject(error),
        );
      if (!priorStat) {
        continue;
      }
      const current = path.join(userDataRoot, name);
      const currentStat = await fsPromises
        .lstat(current)
        .catch((error) =>
          error?.code === "ENOENT" ? null : Promise.reject(error),
        );
      if (currentStat) {
        if (
          !RESET_DIRECTORY_PATHS.has(name) ||
          !currentStat.isDirectory() ||
          currentStat.isSymbolicLink()
        ) {
          throw new Error("The reset rollback target is occupied.");
        }
        await fsPromises.rmdir(current);
      }
      await fsPromises.mkdir(path.dirname(previous), {
        recursive: true,
        mode: 0o700,
      });
      await fsPromises.rename(previous, current);
    }
    await bridge.invalidateManifests();
  };

  const reconcileTransaction = async (transactionRoot, marker) => {
    if (marker.committed) {
      try {
        await moveToTrash(transactionRoot);
      } catch (error) {
        console.error(
          "Committed prior app data remains recoverable and will be cleaned up on a later launch.",
          error,
        );
      }
      return;
    }
    if (marker.kind === "import") {
      await rollbackLibrary(transactionRoot);
    } else {
      await rollbackResetPaths(transactionRoot, marker.movedPaths);
    }
    await restoreState(marker.previous);
    await removeOwnedTemporaryDirectory(userDataRoot, transactionRoot);
  };

  return {
    assertMutationAvailable,
    async reconcileTransactions() {
      const entries = await fsPromises.readdir(userDataRoot, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (
          (!entry.name.startsWith(IMPORT_PREFIX) &&
            !entry.name.startsWith(RESET_PREFIX)) ||
          !entry.isDirectory()
        ) {
          continue;
        }
        const transactionRoot = path.join(userDataRoot, entry.name);
        const stat = await fsPromises.lstat(transactionRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("An app data transaction path is invalid.");
        }
        const marker = await readMarker(transactionRoot);
        if (!marker) {
          if (await transactionHasRecoveryPayload(transactionRoot)) {
            throw serviceError(
              "DATA_RECOVERY_REQUIRED",
              "A prior data operation needs recovery before Cursor Atelier can start.",
            );
          }
          await removeOwnedTemporaryDirectory(userDataRoot, transactionRoot);
          continue;
        }
        await reconcileTransaction(transactionRoot, marker);
      }
    },

    async exportTo(destination) {
      await beginDataOperation();
      try {
        return await runLibraryExclusive(async () => {
          assertIdle();
          await fsPromises.mkdir(importedPacksRoot, {
            recursive: true,
            mode: 0o700,
          });
          const library = validateImportedPacksRoot(importedPacksRoot);
          const current = await snapshot();
          const document = {
            schemaVersion: APP_DATA_ARCHIVE_SCHEMA_VERSION,
            product: "Cursor Atelier",
            appVersion,
            exportedAt: new Date().toISOString(),
            ...current,
            importedThemeIdentifiers: library.identifiers,
          };
          return createArchive({
            destination,
            importedPacksRoot,
            document,
            validateImportedPacksRoot,
          });
        });
      } finally {
        endDataOperation();
      }
    },

    async importFrom(archivePath) {
      await beginDataOperation();
      let extracted = null;
      let cleanStage = true;
      try {
        assertIdle();
        extracted = await extractArchive({
          archivePath,
          stagingRoot: userDataRoot,
          validateImportedPacksRoot,
        });
        return await runLibraryExclusive(async () => {
          assertIdle();
          const document = normalizeAppDataArchiveDocument(
            extracted.document,
            extracted.library,
          );
          let automationPaused = false;
          let inactiveVerified = false;
          let previous = null;
          let transactionStarted = false;
          try {
            await pauseAutomation();
            automationPaused = true;
            previous = await snapshot();
            const marker = {
              schemaVersion: TRANSACTION_SCHEMA_VERSION,
              kind: "import",
              committed: false,
              previous,
              movedPaths: ["ImportedPacks"],
            };
            const restored = await bridge.restore();
            if (!isVerifiedRestoredStatus(restored)) {
              throw serviceError(
                "CURSOR_RESTORE_UNVERIFIED",
                "System cursors could not be verified before importing data.",
              );
            }
            inactiveVerified = true;
            await writeMarker(extracted.stage, marker);
            transactionStarted = true;
            await fsPromises.rename(
              importedPacksRoot,
              path.join(extracted.stage, PREVIOUS_LIBRARY_NAME),
            );
            await fsPromises.rename(
              extracted.importedPacksRoot,
              importedPacksRoot,
            );
            await bridge.invalidateManifests();
            validateImportedPacksRoot(importedPacksRoot);
            if (document.importedThemeIdentifiers.length) {
              await bridge.validateImportedThemes(
                document.importedThemeIdentifiers,
              );
            }
            preferencesStore.replaceDataSnapshot(document.preferences);
            onboardingStore.replaceDataSnapshot(document.onboarding);
            await bridge.replacePortablePreferences(document.nativePreferences);
            applyAppearanceMode(document.preferences.appAppearanceMode);
            await reconcileLibraryPreferences();
            await syncMainLoginItem(document.preferences.preferences);
            await replaceMarker(extracted.stage, {
              ...marker,
              committed: true,
            });
          } catch (error) {
            const rollbackErrors = [];
            if (transactionStarted) {
              try {
                await rollbackLibrary(extracted.stage);
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
              }
            }
            if (inactiveVerified && previous) {
              try {
                await restoreState(previous);
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
              }
            }
            if (rollbackErrors.length) {
              dataRecoveryRequired = true;
              cleanStage = !transactionStarted;
              throw new AggregateError(
                [error, ...rollbackErrors],
                "Data import failed and could not be fully rolled back. Restart Cursor Atelier to recover it.",
                { cause: error },
              );
            }
            if (automationPaused) {
              try {
                resumeAutomation({ runLaunch: false, syncAppearance: false });
              } catch (resumeError) {
                console.error(
                  "Could not resume cursor automation after a failed data import.",
                  resumeError,
                );
              }
            }
            throw error;
          }

          try {
            onDataChanged({ reason: "data-import" });
          } catch (error) {
            console.error("Could not announce imported app data.", error);
          }
          try {
            await moveToTrash(extracted.stage);
          } catch (error) {
            cleanStage = false;
            console.error(
              "Imported data is active, but the prior library remains recoverable in its committed transaction.",
              error,
            );
          }
          try {
            resumeAutomation({ runLaunch: false, syncAppearance: false });
          } catch (error) {
            console.error(
              "Could not resume cursor automation after importing data.",
              error,
            );
          }
          return { canceled: false, imported: true };
        });
      } finally {
        try {
          if (cleanStage && extracted) {
            await extracted.cleanup();
          }
        } finally {
          endDataOperation();
        }
      }
    },

    async reset() {
      await beginDataOperation();
      try {
        assertIdle();
        return await runLibraryExclusive(async () => {
          assertIdle();
          await pauseAutomation();
          let previous = null;
          let transactionRoot = null;
          let inactiveVerified = false;
          let marker = null;
          try {
            previous = await snapshot();
            marker = {
              schemaVersion: TRANSACTION_SCHEMA_VERSION,
              kind: "reset",
              committed: false,
              previous,
              movedPaths: [],
            };
            const restored = await bridge.restore();
            if (!isVerifiedRestoredStatus(restored)) {
              throw serviceError(
                "CURSOR_RESTORE_UNVERIFIED",
                "System cursors could not be verified before resetting data.",
              );
            }
            inactiveVerified = true;
            transactionRoot = await fsPromises.mkdtemp(
              path.join(userDataRoot, RESET_PREFIX),
            );
            await fsPromises.chmod(transactionRoot, 0o700);
            await writeMarker(transactionRoot, marker);
            await syncMainLoginItem(null);
            const previousRoot = path.join(transactionRoot, "Previous");
            for (const name of RESET_OWNED_PATHS) {
              const source = path.join(userDataRoot, name);
              const stat = await fsPromises
                .lstat(source)
                .catch((error) =>
                  error?.code === "ENOENT" ? null : Promise.reject(error),
                );
              if (!stat) {
                continue;
              }
              if (stat.isSymbolicLink()) {
                throw new Error(
                  `The app-owned ${name} path is a symbolic link.`,
                );
              }
              if (
                (RESET_DIRECTORY_PATHS.has(name) && !stat.isDirectory()) ||
                (!RESET_DIRECTORY_PATHS.has(name) && !stat.isFile())
              ) {
                throw new Error(
                  `The app-owned ${name} path has an invalid type.`,
                );
              }
              const destination = path.join(previousRoot, name);
              await fsPromises.mkdir(path.dirname(destination), {
                recursive: true,
                mode: 0o700,
              });
              marker.movedPaths.push(name);
              await replaceMarker(transactionRoot, marker);
              await fsPromises.rename(source, destination);
            }
            await fsPromises.mkdir(importedPacksRoot, {
              recursive: true,
              mode: 0o700,
            });
            preferencesStore.resetData();
            onboardingStore.resetData();
            await bridge.resetPreferences();
            applyAppearanceMode("system");
            await replaceMarker(transactionRoot, {
              ...marker,
              committed: true,
            });
          } catch (error) {
            const rollbackErrors = [];
            if (transactionRoot) {
              try {
                await rollbackResetPaths(
                  transactionRoot,
                  marker?.movedPaths ?? [],
                );
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
              }
            }
            if (inactiveVerified && previous) {
              try {
                await restoreState(previous);
              } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
              }
            }
            if (rollbackErrors.length) {
              dataRecoveryRequired = true;
              throw new AggregateError(
                [error, ...rollbackErrors],
                "Data reset failed and could not be fully rolled back. Restart Cursor Atelier to recover it.",
                { cause: error },
              );
            }
            resumeAutomation({ runLaunch: false, syncAppearance: false });
            if (transactionRoot) {
              await removeOwnedTemporaryDirectory(
                userDataRoot,
                transactionRoot,
              );
            }
            throw error;
          }

          try {
            onDataChanged({ reason: "data-reset" });
          } catch (error) {
            console.error(
              "Could not announce the completed data reset.",
              error,
            );
          }
          try {
            await moveToTrash(transactionRoot);
          } catch (error) {
            console.error(
              "Reset completed, but prior data remains recoverable in its committed transaction.",
              error,
            );
          }
          try {
            onResetComplete();
          } catch (error) {
            throw serviceError(
              "RESET_RELAUNCH_FAILED",
              "Data reset completed, but Cursor Atelier could not relaunch.",
              error,
            );
          }
          return { reset: true };
        });
      } finally {
        endDataOperation();
      }
    },
  };
}

export function defaultResetPreferencesData() {
  return {
    preferences: createDefaultCursorPreferences(),
    appAppearanceMode: "system",
    pendingThemeSizeCleanupIds: [],
  };
}
