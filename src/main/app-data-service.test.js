import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCursorPreferences } from "../lib/cursor-preferences.js";
import {
  createAppDataService,
  normalizeAppDataArchiveDocument,
} from "./app-data-service.js";
import { normalizeOnboardingStoreState } from "./onboarding-store.js";

const temporaryDirectories = [];

function temporaryDirectory() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-data-service-test-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function preferencesStore(initial = {}) {
  let data = structuredClone({
    preferences: {
      ...createDefaultCursorPreferences(),
      ...initial,
    },
    appAppearanceMode: "system",
    pendingThemeSizeCleanupIds: [],
  });
  return {
    getDataSnapshot: () => structuredClone(data),
    replaceDataSnapshot: vi.fn((next) => {
      data = structuredClone(next);
      return structuredClone(data);
    }),
    resetData: vi.fn(() => {
      data = {
        preferences: createDefaultCursorPreferences(),
        appAppearanceMode: "system",
        pendingThemeSizeCleanupIds: [],
      };
      return structuredClone(data);
    }),
  };
}

function onboardingStore(initial = normalizeOnboardingStoreState(null)) {
  let data = structuredClone(initial);
  return {
    get: () => structuredClone(data),
    replaceDataSnapshot: vi.fn((next) => {
      data = structuredClone(next);
      return structuredClone(data);
    }),
    resetData: vi.fn(() => {
      data = normalizeOnboardingStoreState(null);
      return structuredClone(data);
    }),
  };
}

function inactiveStatus() {
  return {
    bridgeAvailable: true,
    supported: true,
    previewMode: false,
    statusAvailable: true,
    currentSentinelsMatchTheme: false,
    desiredEnabled: false,
    effectiveApplied: false,
    persistedEffectiveApplied: false,
    loginItemRegistrationCurrent: false,
    launchAtLoginDesired: false,
    transactionPending: false,
  };
}

function archiveDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    product: "Cursor Atelier",
    appVersion: "0.1.0",
    exportedAt: "2026-08-10T12:00:00.000Z",
    preferences: {
      preferences: createDefaultCursorPreferences(),
      appAppearanceMode: "system",
      pendingThemeSizeCleanupIds: [],
    },
    onboarding: normalizeOnboardingStoreState(null),
    nativePreferences: {
      schemaVersion: 1,
      selectedThemeIdentifier: null,
      themeSizePercentages: {},
    },
    importedThemeIdentifiers: [],
    ...overrides,
  };
}

function fixture({ document = archiveDocument() } = {}) {
  const userDataRoot = temporaryDirectory();
  const importedPacksRoot = path.join(userDataRoot, "ImportedPacks");
  fs.mkdirSync(importedPacksRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(importedPacksRoot, "old.txt"), "old");
  const preferences = preferencesStore({ menuBar: { visible: false } });
  const onboarding = onboardingStore();
  let portablePreferences = {
    schemaVersion: 1,
    selectedThemeIdentifier: null,
    themeSizePercentages: {},
  };
  const bridge = {
    getPortablePreferences: vi.fn(() => structuredClone(portablePreferences)),
    replacePortablePreferences: vi.fn((next) => {
      portablePreferences = structuredClone(next);
      return structuredClone(next);
    }),
    resetPreferences: vi.fn(() => {
      portablePreferences = {
        schemaVersion: 1,
        selectedThemeIdentifier: null,
        themeSizePercentages: {},
      };
      return true;
    }),
    restore: vi.fn(() => inactiveStatus()),
    applyTheme: vi.fn(),
    invalidateManifests: vi.fn(),
    validateImportedThemes: vi.fn(),
  };
  const pauseAutomation = vi.fn();
  const resumeAutomation = vi.fn();
  const moveToTrash = vi.fn(async (target) => {
    fs.rmSync(target, { recursive: true });
  });
  const onResetComplete = vi.fn();
  const syncMainLoginItem = vi.fn();
  const reconcileLibraryPreferences = vi.fn();
  const extractArchive = vi.fn(async () => {
    const stage = fs.mkdtempSync(path.join(userDataRoot, ".data-import-"));
    const incoming = path.join(stage, "ImportedPacks");
    fs.mkdirSync(incoming, { mode: 0o700 });
    return {
      document: structuredClone(document),
      importedPacksRoot: incoming,
      library: { packCount: 0, identifiers: [] },
      stage,
      cleanup: async () => fs.rmSync(stage, { recursive: true, force: true }),
    };
  });
  const service = createAppDataService({
    userDataRoot,
    importedPacksRoot,
    appVersion: "0.1.0",
    preferencesStore: preferences,
    onboardingStore: onboarding,
    bridge,
    validateImportedPacksRoot: () => ({ packCount: 0, identifiers: [] }),
    createArchive: vi.fn(),
    extractArchive,
    moveToTrash,
    runLibraryExclusive: (operation) => operation(),
    assertIdle: vi.fn(),
    pauseAutomation,
    resumeAutomation,
    reconcileLibraryPreferences,
    applyAppearanceMode: vi.fn(),
    syncMainLoginItem,
    onDataChanged: vi.fn(),
    onResetComplete,
  });
  return {
    bridge,
    importedPacksRoot,
    moveToTrash,
    onboarding,
    onResetComplete,
    pauseAutomation,
    preferences,
    reconcileLibraryPreferences,
    resumeAutomation,
    service,
    syncMainLoginItem,
    userDataRoot,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("app data archive document", () => {
  it("normalizes settings and requires the manifest to match the library", () => {
    expect(
      normalizeAppDataArchiveDocument(archiveDocument(), {
        identifiers: [],
      }),
    ).toMatchObject({
      schemaVersion: 1,
      product: "Cursor Atelier",
      importedThemeIdentifiers: [],
    });

    expect(() =>
      normalizeAppDataArchiveDocument(
        archiveDocument({ importedThemeIdentifiers: ["Missing"] }),
        { identifiers: [] },
      ),
    ).toThrow(/does not match/);

    expect(() =>
      normalizeAppDataArchiveDocument(
        archiveDocument({ exportedAt: "not-a-date" }),
        { identifiers: [] },
      ),
    ).toThrow(/invalid export date/);
  });
});

describe("app data service", () => {
  it.each(["import", "reset"])(
    "blocks new settings and starter imports for the entire %s operation",
    async (operation) => {
      const context = fixture();
      let finishPause;
      context.pauseAutomation.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPause = resolve;
          }),
      );
      expect(() => context.service.assertMutationAvailable()).not.toThrow();
      const pending =
        operation === "import"
          ? context.service.importFrom(
              path.join(context.userDataRoot, "backup"),
            )
          : context.service.reset();

      expect(() => context.service.assertMutationAvailable()).toThrow(
        expect.objectContaining({ code: "DATA_OPERATION_BUSY" }),
      );
      await vi.waitFor(() => expect(finishPause).toBeTypeOf("function"));
      expect(() => context.service.assertMutationAvailable()).toThrow(
        expect.objectContaining({ code: "DATA_OPERATION_BUSY" }),
      );
      finishPause();
      await pending;
      expect(() => context.service.assertMutationAvailable()).not.toThrow();
    },
  );

  it.each([
    ["import", { transactionPending: true }],
    ["import", { currentSentinelsMatchTheme: true }],
    ["reset", { transactionPending: true }],
    ["reset", { currentSentinelsMatchTheme: true }],
  ])(
    "rejects %s before replacing data when restore retains %j",
    async (operation, residualState) => {
      const context = fixture();
      context.bridge.restore.mockReturnValue({
        ...inactiveStatus(),
        ...residualState,
      });

      await expect(
        operation === "import"
          ? context.service.importFrom(
              path.join(context.userDataRoot, "backup"),
            )
          : context.service.reset(),
      ).rejects.toMatchObject({ code: "CURSOR_RESTORE_UNVERIFIED" });

      expect(
        fs.readFileSync(
          path.join(context.importedPacksRoot, "old.txt"),
          "utf8",
        ),
      ).toBe("old");
      expect(context.preferences.replaceDataSnapshot).not.toHaveBeenCalled();
      expect(context.preferences.resetData).not.toHaveBeenCalled();
      expect(context.bridge.replacePortablePreferences).not.toHaveBeenCalled();
      expect(context.bridge.resetPreferences).not.toHaveBeenCalled();
      expect(context.moveToTrash).not.toHaveBeenCalled();
      expect(() => context.service.assertMutationAvailable()).not.toThrow();
    },
  );

  it("imports data only after restoring Apple cursors and never applies one", async () => {
    const importedPreferences = {
      ...createDefaultCursorPreferences(),
      startup: { runInBackground: true },
    };
    const context = fixture({
      document: archiveDocument({
        preferences: {
          preferences: importedPreferences,
          appAppearanceMode: "dark",
          pendingThemeSizeCleanupIds: [],
        },
      }),
    });
    let finishAutomationPause;
    context.pauseAutomation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAutomationPause = resolve;
        }),
    );

    const imported = context.service.importFrom(
      path.join(context.userDataRoot, "backup"),
    );
    await vi.waitFor(() => {
      expect(context.pauseAutomation).toHaveBeenCalledOnce();
    });
    expect(context.bridge.restore).not.toHaveBeenCalled();
    finishAutomationPause();
    await expect(imported).resolves.toEqual({
      canceled: false,
      imported: true,
    });

    expect(context.bridge.restore).toHaveBeenCalledBefore(
      context.bridge.replacePortablePreferences,
    );
    expect(context.pauseAutomation).toHaveBeenCalledOnce();
    expect(context.resumeAutomation).toHaveBeenCalledWith({
      runLaunch: false,
      syncAppearance: false,
    });
    expect(context.preferences.getDataSnapshot()).toMatchObject({
      preferences: { startup: { runInBackground: true } },
      appAppearanceMode: "dark",
    });
    expect(fs.existsSync(path.join(context.importedPacksRoot, "old.txt"))).toBe(
      false,
    );
  });

  it("fully resets app-owned paths and requests a clean relaunch", async () => {
    const context = fixture();
    const curatedSources = path.join(context.userDataRoot, "CuratedSources");
    fs.mkdirSync(curatedSources, { mode: 0o700 });
    fs.writeFileSync(path.join(curatedSources, "cache"), "cache");
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(
      async (source, destination) => {
        if (source === curatedSources) {
          const transactionName = fs
            .readdirSync(context.userDataRoot)
            .find((name) => name.startsWith(".data-reset-"));
          const marker = JSON.parse(
            fs.readFileSync(
              path.join(
                context.userDataRoot,
                transactionName,
                ".cursor-atelier-data-transaction.json",
              ),
              "utf8",
            ),
          );
          expect(marker.movedPaths).toContain("CuratedSources");
        }
        return rename(source, destination);
      },
    );
    context.bridge.restore.mockImplementation(() => {
      expect(
        fs
          .readdirSync(context.userDataRoot)
          .filter((name) => name.startsWith(".data-reset-")),
      ).toEqual([]);
      return inactiveStatus();
    });
    let finishLoginItemSync;
    context.syncMainLoginItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoginItemSync = resolve;
        }),
    );

    const reset = context.service.reset();
    await vi.waitFor(() => {
      expect(context.syncMainLoginItem).toHaveBeenCalledWith(null);
    });
    expect(context.onResetComplete).not.toHaveBeenCalled();
    finishLoginItemSync();
    await expect(reset).resolves.toEqual({ reset: true });

    expect(context.bridge.restore).toHaveBeenCalledBefore(
      context.bridge.resetPreferences,
    );
    expect(context.preferences.resetData).toHaveBeenCalledOnce();
    expect(context.onboarding.resetData).toHaveBeenCalledOnce();
    expect(fs.readdirSync(context.importedPacksRoot)).toEqual([]);
    expect(fs.existsSync(curatedSources)).toBe(false);
    expect(context.moveToTrash).toHaveBeenCalledOnce();
    expect(context.onResetComplete).toHaveBeenCalledOnce();
  });

  it("never rolls back a committed reset when relaunch fails", async () => {
    const context = fixture();
    context.onResetComplete.mockImplementation(() => {
      throw new Error("relaunch unavailable");
    });

    await expect(context.service.reset()).rejects.toMatchObject({
      code: "RESET_RELAUNCH_FAILED",
    });

    expect(context.preferences.resetData).toHaveBeenCalledOnce();
    expect(context.onboarding.resetData).toHaveBeenCalledOnce();
    expect(context.bridge.resetPreferences).toHaveBeenCalledOnce();
    expect(context.bridge.replacePortablePreferences).not.toHaveBeenCalled();
    expect(fs.readdirSync(context.importedPacksRoot)).toEqual([]);
  });

  it("retains an uncommitted import transaction when state rollback fails", async () => {
    const context = fixture();
    context.bridge.replacePortablePreferences.mockRejectedValue(
      new Error("native settings unavailable"),
    );

    await expect(
      context.service.importFrom(path.join(context.userDataRoot, "backup")),
    ).rejects.toBeInstanceOf(AggregateError);

    const transactions = fs
      .readdirSync(context.userDataRoot)
      .filter((name) => name.startsWith(".data-import-"));
    expect(transactions).toHaveLength(1);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            context.userDataRoot,
            transactions[0],
            ".cursor-atelier-data-transaction.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ kind: "import", committed: false });
    expect(
      fs.readFileSync(path.join(context.importedPacksRoot, "old.txt"), "utf8"),
    ).toBe("old");
    await expect(context.service.reset()).rejects.toMatchObject({
      code: "DATA_RECOVERY_REQUIRED",
    });
    expect(context.resumeAutomation).not.toHaveBeenCalled();
    expect(() => context.service.assertMutationAvailable()).toThrow(
      expect.objectContaining({ code: "DATA_RECOVERY_REQUIRED" }),
    );
  });

  it("keeps automation paused and data recoverable when reset rollback fails", async () => {
    const context = fixture();
    context.bridge.resetPreferences.mockRejectedValue(
      new Error("reset failed"),
    );
    context.bridge.replacePortablePreferences.mockRejectedValue(
      new Error("native settings unavailable"),
    );

    await expect(context.service.reset()).rejects.toBeInstanceOf(
      AggregateError,
    );

    expect(
      fs.readFileSync(path.join(context.importedPacksRoot, "old.txt"), "utf8"),
    ).toBe("old");
    expect(
      fs
        .readdirSync(context.userDataRoot)
        .filter((name) => name.startsWith(".data-reset-")),
    ).toHaveLength(1);
    expect(context.resumeAutomation).not.toHaveBeenCalled();
    expect(() => context.service.assertMutationAvailable()).toThrow(
      expect.objectContaining({ code: "DATA_RECOVERY_REQUIRED" }),
    );
    expect(context.moveToTrash).not.toHaveBeenCalled();
  });

  it("leaves Apple cursors active instead of guessing at live state after a failed import", async () => {
    const context = fixture();
    context.reconcileLibraryPreferences.mockRejectedValue(
      new Error("preference reconciliation failed"),
    );

    await expect(
      context.service.importFrom(path.join(context.userDataRoot, "backup")),
    ).rejects.toThrow("preference reconciliation failed");

    expect(context.bridge.restore).toHaveBeenCalledOnce();
    expect(context.bridge.applyTheme).not.toHaveBeenCalled();
    expect(context.resumeAutomation).toHaveBeenCalledWith({
      runLaunch: false,
      syncAppearance: false,
    });
    expect(
      fs.readFileSync(path.join(context.importedPacksRoot, "old.txt"), "utf8"),
    ).toBe("old");
  });

  it("does not block startup when committed recovery data cannot reach Trash", async () => {
    const context = fixture();
    const transaction = path.join(
      context.userDataRoot,
      ".data-import-committed",
    );
    fs.mkdirSync(transaction, { mode: 0o700 });
    fs.writeFileSync(
      path.join(transaction, ".cursor-atelier-data-transaction.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "import",
        committed: true,
        previous: {},
        movedPaths: ["ImportedPacks"],
      }),
      { mode: 0o600 },
    );
    context.moveToTrash.mockRejectedValue(new Error("Trash unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      context.service.reconcileTransactions(),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(transaction)).toBe(true);
    expect(consoleError).toHaveBeenCalled();
  });
});
