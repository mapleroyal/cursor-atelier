import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCursorTheme,
  assignImportedCursorFamily,
  deleteImportedCursor,
  deleteImportedCursorFamily,
  getAutomaticSelectionId,
  getPackRailNavigationIndex,
  getSelectedStatusVariant,
  getStatusEnabled,
  getStatusVariant,
  isPackVerifiedActive,
  isRestoreAvailable,
  isStatusQueryUnavailable,
  isStatusVerifiedActive,
  isStatusVerifiedRestored,
  importCursorPack,
  matchesCursorPack,
  normalizeCursorSizePercentage,
  openLoginItemsSettings,
  resolvePackQuerySource,
  restoreCursors,
  setCursorThemeSize,
} from "@/lib/cursor-ui";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("cursor status presentation", () => {
  it("keeps a restored selection separate from the effective cursor", () => {
    const status = {
      selectedVariantId: "oreo-blue",
      effectiveVariantId: null,
      themeIdentifier: "OreoBlue",
      effectiveApplied: false,
      desiredEnabled: false,
      currentSentinelsMatchTheme: true,
    };

    expect(getSelectedStatusVariant(status)).toBe("oreo-blue");
    expect(getStatusVariant(status)).toBeNull();
    expect(getStatusEnabled(status)).toBe(false);
    expect(isStatusVerifiedActive(status)).toBe(false);
  });

  it("requires live sentinel verification before showing an active pack", () => {
    expect(
      isStatusVerifiedActive({
        effectiveVariantId: "oreo-blue",
        effectiveApplied: true,
        currentSentinelsMatchTheme: false,
      }),
    ).toBe(false);

    expect(
      isStatusVerifiedActive({
        effectiveVariantId: "oreo-blue",
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
      }),
    ).toBe(true);
  });

  it("never presents preview-mode selection as a live system cursor", () => {
    expect(
      isStatusVerifiedActive({
        previewMode: true,
        effectiveVariantId: "oreo-blue",
        effectiveApplied: true,
      }),
    ).toBe(false);
  });

  it("keeps Restore available for drifted or registered startup state", () => {
    expect(
      isRestoreAvailable({
        desiredEnabled: true,
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
      }),
    ).toBe(true);
    expect(
      isRestoreAvailable({
        desiredEnabled: false,
        effectiveApplied: false,
        loginItemRegistrationCurrent: 1,
      }),
    ).toBe(true);
    expect(
      isRestoreAvailable({
        desiredEnabled: false,
        effectiveApplied: false,
        transactionPending: true,
      }),
    ).toBe(true);
    expect(isRestoreAvailable({ desiredEnabled: false })).toBe(false);
  });

  it("verifies restore against live, persisted, login, and journal state", () => {
    expect(
      isStatusVerifiedRestored({
        statusAvailable: true,
        desiredEnabled: false,
        effectiveApplied: false,
        persistedEffectiveApplied: false,
        currentSentinelsMatchTheme: false,
        launchAtLoginDesired: false,
        loginItemRegistrationCurrent: false,
        transactionPending: false,
      }),
    ).toBe(true);
    expect(
      isStatusVerifiedRestored({
        statusAvailable: true,
        desiredEnabled: false,
        currentSentinelsMatchTheme: true,
      }),
    ).toBe(false);
    expect(
      isStatusVerifiedRestored({
        statusAvailable: false,
        desiredEnabled: false,
      }),
    ).toBe(false);
    expect(
      isStatusVerifiedRestored({
        statusAvailable: true,
        desiredEnabled: false,
      }),
    ).toBe(false);
  });

  it("uses only the atomic apply and restore contract across reapplication", async () => {
    const calls = [];
    globalThis.window = {
      electronAPI: {
        applyCursorTheme: vi.fn(async (identifier) => {
          calls.push(["apply", identifier]);
        }),
        restoreCursors: vi.fn(async () => {
          calls.push(["restore"]);
        }),
        openLoginItemsSettings: vi.fn(async () => {
          calls.push(["open-login-settings"]);
        }),
        importCursorPack: vi.fn(async () => {
          calls.push(["import"]);
          return { canceled: false, identifiers: ["ImportedTheme"] };
        }),
        setCursorThemeSize: vi.fn(async (identifier, sizePercentage) => {
          calls.push(["size", identifier, sizePercentage]);
        }),
        assignImportedCursorFamily: vi.fn(async (identifiers, family) => {
          calls.push(["family", identifiers, family]);
        }),
        deleteImportedCursor: vi.fn(async (identifier) => {
          calls.push(["delete", identifier]);
        }),
        deleteImportedCursorFamily: vi.fn(async (family) => {
          calls.push(["delete-family", family]);
        }),
        selectCursorTheme: vi.fn(),
        applyCursors: vi.fn(),
      },
    };

    await applyCursorTheme("OreoBlue");
    await restoreCursors();
    await applyCursorTheme("OreoBlue");
    await openLoginItemsSettings();
    await importCursorPack();
    await setCursorThemeSize("OreoBlue", 135);
    await assignImportedCursorFamily(["ImportedBlue"], "Blue");
    await deleteImportedCursor("ImportedBlue");
    await deleteImportedCursorFamily("Blue");

    expect(calls).toEqual([
      ["apply", "OreoBlue"],
      ["restore"],
      ["apply", "OreoBlue"],
      ["open-login-settings"],
      ["import"],
      ["size", "OreoBlue", 135],
      ["family", ["ImportedBlue"], "Blue"],
      ["delete", "ImportedBlue"],
      ["delete-family", "Blue"],
    ]);
    expect(window.electronAPI.selectCursorTheme).not.toHaveBeenCalled();
    expect(window.electronAPI.applyCursors).not.toHaveBeenCalled();
  });

  it("normalizes only bounded integer cursor sizes", () => {
    expect(normalizeCursorSizePercentage(50)).toBe(50);
    expect(normalizeCursorSizePercentage(200)).toBe(200);
    expect(normalizeCursorSizePercentage(100.5)).toBe(100);
    expect(normalizeCursorSizePercentage(201, 125)).toBe(125);
  });
});

describe("cursor rail behavior", () => {
  it("matches native cursor identifiers case-insensitively", () => {
    const pack = {
      id: "imported-aurora",
      nativeThemeId: "ImportedAurora",
      nativeThemeIds: ["ImportedAuroraAlias"],
    };

    expect(matchesCursorPack(pack, "importedaurora")).toBe(true);
    expect(matchesCursorPack(pack, "IMPORTEDAURORAALIAS")).toBe(true);
    expect(matchesCursorPack(pack, "another-cursor")).toBe(false);
  });

  it("moves a single roving focus target with vertical and boundary keys", () => {
    expect(getPackRailNavigationIndex("ArrowDown", 0, 239)).toBe(1);
    expect(getPackRailNavigationIndex("ArrowUp", 1, 239)).toBe(0);
    expect(getPackRailNavigationIndex("Home", 118, 239)).toBe(0);
    expect(getPackRailNavigationIndex("End", 118, 239)).toBe(238);
    expect(getPackRailNavigationIndex("ArrowUp", 0, 239)).toBe(0);
    expect(getPackRailNavigationIndex("ArrowDown", 238, 239)).toBe(238);
    expect(getPackRailNavigationIndex("Enter", 12, 239)).toBeNull();
  });

  it("chooses the first filtered pack only when the current selection vanished", () => {
    const packs = [{ id: "blue" }, { id: "red" }];

    expect(getAutomaticSelectionId(packs, "missing")).toBe("blue");
    expect(getAutomaticSelectionId(packs, "red")).toBeNull();
    expect(getAutomaticSelectionId([], "red")).toBeNull();
  });

  it("does not substitute static packs after an authoritative empty result or failure", () => {
    const fallback = [{ id: "static" }];
    const native = [{ id: "native" }];

    expect(resolvePackQuerySource({}, fallback)).toBe(fallback);
    expect(
      resolvePackQuerySource({ data: [], isSuccess: true }, fallback),
    ).toEqual([]);
    expect(resolvePackQuerySource({ isError: true }, fallback)).toEqual([]);
    expect(
      resolvePackQuerySource({ data: native, isError: true }, fallback),
    ).toBe(native);
  });

  it("confirms apply success only for the live, sentinel-verified pack", () => {
    const pack = { id: "oreo-blue", nativeThemeId: "OreoBlue" };
    const activeStatus = {
      effectiveVariantId: "OreoBlue",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    };

    expect(isPackVerifiedActive(activeStatus, pack)).toBe(true);
    expect(
      isPackVerifiedActive(
        { ...activeStatus, effectiveVariantId: "OreoRed" },
        pack,
      ),
    ).toBe(false);
    expect(
      isPackVerifiedActive(
        { ...activeStatus, currentSentinelsMatchTheme: false },
        pack,
      ),
    ).toBe(false);
  });

  it("treats structured status failures as retryable query failures", () => {
    expect(isStatusQueryUnavailable({ isError: true })).toBe(true);
    expect(
      isStatusQueryUnavailable({
        isError: false,
        data: { statusAvailable: false },
      }),
    ).toBe(true);
    expect(
      isStatusQueryUnavailable({
        isError: false,
        data: { statusAvailable: true },
      }),
    ).toBe(false);
  });
});
