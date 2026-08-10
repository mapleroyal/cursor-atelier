import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCursorBridge,
  registerCursorIpc,
  validateImportedPacksRoot,
} from "./cursor-bridge";

const temporaryDirectories = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function temporaryDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridge-test-"));
  temporaryDirectories.push(root);
  return root;
}

function completeNativeStatus(overrides = {}) {
  return {
    supported: true,
    themeValid: true,
    selectedThemeIdentifier: "OreoWhite",
    desiredEnabled: false,
    effectiveApplied: false,
    currentSentinelsMatchTheme: false,
    launchAtLoginDesired: false,
    loginApprovalRequired: false,
    loginItemRegistrationCurrent: false,
    transactionPending: false,
    ...overrides,
  };
}

function writeImportedPack(
  importedPacksRoot,
  {
    packName = "imported-aurora",
    nativeThemeId = "ImportedAurora",
    catalogId = "imported-aurora",
    displayName = "Imported Aurora",
    family = "Imported",
    cursorData = Buffer.from("cursor resource"),
    previewData = ONE_PIXEL_PNG,
  } = {},
) {
  const packRoot = path.join(importedPacksRoot, packName);
  const resourceFile = `${nativeThemeId}.cursor`;
  const previewFile = `previews/${nativeThemeId}/default.png`;
  fs.mkdirSync(path.join(packRoot, "previews", nativeThemeId), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(path.join(packRoot, resourceFile), cursorData, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(packRoot, previewFile), previewData, {
    mode: 0o600,
  });
  const theme = {
    Identifier: nativeThemeId,
    catalogId,
    DisplayName: displayName,
    ThemeName: displayName,
    Group: family,
    Variant: "Default",
    Resource: resourceFile,
    SHA256: crypto.createHash("sha256").update(cursorData).digest("hex"),
    UUID: crypto.randomUUID().toUpperCase(),
    preview: previewFile,
    rolePreviews: Array.from({ length: 47 }, (_, index) => ({
      role: index === 0 ? "default" : `role-${index}`,
      macIdentifier:
        index === 0
          ? "com.apple.coregraphics.Arrow"
          : `com.example.cursor.Role${index}`,
      asset: previewFile,
      frameCount: 1,
      frameDuration: 1,
    })),
  };
  const manifestPath = path.join(packRoot, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 2, roleCount: 47, themes: [theme] }),
    { mode: 0o600 },
  );
  return {
    manifestPath,
    packRoot,
    previewPath: path.join(packRoot, previewFile),
    resourcePath: path.join(packRoot, resourceFile),
    theme,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("cursor bridge unavailable state", () => {
  it("strictly validates a portable imported-library root", () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "ImportedAurora",
      nativeThemeId: "ImportedAurora",
    });

    expect(validateImportedPacksRoot(importedPacksRoot)).toEqual({
      packCount: 1,
      identifiers: ["ImportedAurora"],
    });

    fs.writeFileSync(path.join(importedPacksRoot, "unexpected.txt"), "bad", {
      mode: 0o600,
    });
    expect(() => validateImportedPacksRoot(importedPacksRoot)).toThrow(
      /unsupported data/,
    );
  });

  it("retains every requested native cleanup when the bridge is unavailable", async () => {
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
    });

    await expect(
      bridge.forgetThemeSizes(["ImportedBlue", "ImportedBlue", "ImportedRed"]),
    ).resolves.toEqual({
      failedIdentifiers: ["ImportedBlue", "ImportedRed"],
    });
  });

  it("never reports an unavailable bridge as active or invents installed packs", async () => {
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
    });

    await expect(bridge.status()).resolves.toMatchObject({
      schemaVersion: 1,
      previewMode: true,
      bridgeAvailable: false,
      canApply: false,
      effectiveApplied: false,
      effectiveVariantId: null,
    });
    await expect(bridge.applyTheme("oreo-blue")).rejects.toThrow(
      "not available to apply",
    );
    await expect(bridge.listThemes()).resolves.toEqual([]);
  });

  it("exposes only validated manifest preview assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridge-test-"));
    temporaryDirectories.push(root);
    fs.writeFileSync(path.join(root, "MogaClassic.cursor"), "cursor");
    fs.mkdirSync(path.join(root, "previews", "MogaClassic"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "previews", "MogaClassic", "arrow.png"),
      "png",
    );

    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      manifestRoot: root,
      manifestData: {
        schemaVersion: 2,
        themes: [
          {
            Identifier: "MogaClassic",
            DisplayName: "Moga Classic",
            Resource: "MogaClassic.cursor",
            preview: "previews/MogaClassic/arrow.png",
            rolePreviews: [
              {
                role: "default",
                macIdentifier: "com.apple.coregraphics.Arrow",
                asset: "previews/MogaClassic/arrow.png",
              },
              { role: "unsafe", asset: "../../outside.png" },
            ],
          },
        ],
      },
    });

    const [theme] = await bridge.listThemes();
    expect(theme).toMatchObject({
      schemaVersion: 1,
      nativeThemeId: "MogaClassic",
      resourceAvailable: true,
      canApply: false,
    });
    expect(theme.preview).toMatch(
      /^cursor-preview:\/\/asset\/[a-f0-9]{64}\.png$/,
    );
    expect(theme.rolePreviews[0].src).toBe(theme.preview);
    expect(theme.rolePreviews[1].src).toBeNull();
    expect(bridge.resolvePreviewAsset(theme.preview)).toBe(
      fs.realpathSync(path.join(root, "previews", "MogaClassic", "arrow.png")),
    );
    expect(
      bridge.resolvePreviewAsset("cursor-preview://asset/not-a-token.png"),
    ).toBeNull();

    fs.renameSync(
      path.join(root, "MogaClassic.cursor"),
      path.join(root, "MogaClassic.cursor.moved"),
    );
    fs.renameSync(
      path.join(root, "previews", "MogaClassic", "arrow.png"),
      path.join(root, "previews", "MogaClassic", "arrow.png.moved"),
    );
    await expect(bridge.listThemes()).resolves.toEqual([
      expect.objectContaining({
        nativeThemeId: "MogaClassic",
        resourceAvailable: true,
        preview: theme.preview,
      }),
    ]);
  });

  it("uses stable file metadata for immutable built-in preview URLs", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "Fixture.cursor"), "cursor");
    fs.mkdirSync(path.join(root, "previews"), { mode: 0o700 });
    fs.writeFileSync(path.join(root, "previews", "fixture.png"), ONE_PIXEL_PNG);
    const readSpy = vi.spyOn(fs, "readSync");
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      manifestRoot: root,
      manifestData: {
        schemaVersion: 2,
        themes: [
          {
            Identifier: "Fixture",
            DisplayName: "Fixture",
            Resource: "Fixture.cursor",
            preview: "previews/fixture.png",
            rolePreviews: [
              {
                role: "default",
                macIdentifier: "com.apple.coregraphics.Arrow",
                asset: "previews/fixture.png",
              },
            ],
          },
        ],
      },
    });

    const first = (await bridge.listThemes())[0].preview;
    await bridge.invalidateManifests();
    const second = (await bridge.listThemes())[0].preview;

    expect(second).toBe(first);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("prefers the manifest staged beside a discovered development bridge", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridge-test-"));
    temporaryDirectories.push(root);
    const bridgePath = path.join(
      root,
      "native",
      "oreo",
      "build",
      "Release",
      "Oreo Cursor.app",
      "Contents",
      "MacOS",
      "OreoCursor",
    );
    const adjacentManifest = path.resolve(
      path.dirname(bridgePath),
      "..",
      "Resources",
      "Themes",
      "manifest.json",
    );
    const generatedManifest = path.join(
      root,
      "native",
      "cursor-packs",
      "generated",
      "manifest.json",
    );
    fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
    fs.mkdirSync(path.dirname(adjacentManifest), { recursive: true });
    fs.mkdirSync(path.dirname(generatedManifest), { recursive: true });
    fs.writeFileSync(bridgePath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bridgePath, 0o755);
    fs.writeFileSync(adjacentManifest, JSON.stringify({ themes: [] }));
    fs.writeFileSync(generatedManifest, JSON.stringify({ themes: [] }));

    const bridge = createCursorBridge({
      nativePath: bridgePath,
      appPath: root,
    });

    expect(bridge.manifestPath).toBe(adjacentManifest);
  });
});

describe("cursor bridge imported manifests", () => {
  it("lists a validated imported pack and exposes only its preview assets", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });

    const theme = (await bridge.listThemes()).find(
      (candidate) => candidate.id === "imported-aurora",
    );
    expect(theme).toMatchObject({
      schemaVersion: 1,
      nativeThemeId: "ImportedAurora",
      displayName: "Imported Aurora",
      availability: "imported",
      imported: true,
      resourceAvailable: true,
      canApply: false,
      nativeListed: false,
      status: "preview",
    });
    expect(theme.preview).toMatch(
      /^cursor-preview:\/\/asset\/[a-f0-9]{64}\.png$/,
    );
    expect(theme.rolePreviews[0].src).toBe(theme.preview);
    expect(bridge.resolvePreviewAsset(theme.preview)).toBe(
      fs.realpathSync(pack.previewPath),
    );
    expect(theme).not.toHaveProperty("identifier");
    expect(theme).not.toHaveProperty("available");
    expect(theme).not.toHaveProperty("isAvailable");
    expect(theme).not.toHaveProperty("SizePercentage");
    expect(theme).not.toHaveProperty("resourceInstalled");
  });

  it("lets an authoritative native inventory make a valid import applyable", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot);
    const commandRunner = vi.fn(async ({ command }) => {
      if (command === "--list-themes") {
        return [
          { Identifier: "ImportedAurora", DisplayName: "Imported Aurora" },
        ];
      }
      return completeNativeStatus({
        selectedThemeIdentifier: "ImportedAurora",
      });
    });
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner,
    });

    const theme = (await bridge.listThemes()).find(
      (candidate) => candidate.id === "imported-aurora",
    );
    expect(theme).toMatchObject({
      schemaVersion: 1,
      nativeThemeId: "ImportedAurora",
      availability: "imported",
      imported: true,
      nativeListed: true,
      resourceAvailable: true,
      canApply: true,
      status: "available",
    });
  });

  it("persists family assignment and canonicalizes case to an existing label", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "vimix-blue",
      nativeThemeId: "VimixBlueImport",
      catalogId: "vimix-blue-import",
      displayName: "Vimix Blue Import",
      family: "Vimix",
    });
    const reassigned = writeImportedPack(importedPacksRoot, {
      packName: "vimix-red",
      nativeThemeId: "VimixRedImport",
      catalogId: "vimix-red-import",
      displayName: "Vimix Red Import",
    });
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });

    await expect(
      bridge.assignImportedFamily(["VimixRedImport"], "vimix"),
    ).resolves.toMatchObject({
      family: "Vimix",
      identifiers: ["VimixRedImport"],
      updatedCount: 1,
    });
    expect(
      JSON.parse(fs.readFileSync(reassigned.manifestPath, "utf8")).themes[0]
        .Group,
    ).toBe("Vimix");
    expect(
      (await bridge.listThemes())
        .filter((theme) => theme.imported)
        .map((theme) => theme.family),
    ).toEqual(["Vimix", "Vimix"]);
  });

  it("tears down a selected active import and persists another installed selection before trashing it", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    const fallback = writeImportedPack(importedPacksRoot, {
      packName: "imported-cobalt",
      nativeThemeId: "ImportedCobalt",
      catalogId: "imported-cobalt",
      displayName: "Imported Cobalt",
    });
    let rawStatus = completeNativeStatus({
      selectedThemeIdentifier: "ImportedAurora",
      desiredEnabled: true,
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
      launchAtLoginDesired: true,
      loginItemRegistrationCurrent: true,
    });
    const calls = [];
    const trashed = [];
    let artifactPresentDuringTeardown = null;
    let artifactPresentDuringSizeCleanup = null;
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      manifestData: { schemaVersion: 2, themes: [] },
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--list-themes") {
          return [
            {
              Identifier: "ImportedAurora",
              DisplayName: "Imported Aurora",
            },
            {
              Identifier: "ImportedCobalt",
              DisplayName: "Imported Cobalt",
            },
          ];
        } else if (command === "--teardown") {
          artifactPresentDuringTeardown = fs.existsSync(pack.packRoot);
          rawStatus = {
            ...rawStatus,
            desiredEnabled: false,
            effectiveApplied: false,
            currentSentinelsMatchTheme: false,
            launchAtLoginDesired: false,
            loginItemRegistrationCurrent: false,
          };
        } else if (command === "--select-theme") {
          rawStatus = {
            ...rawStatus,
            selectedThemeIdentifier: args[0],
            themeValid: true,
          };
        } else if (command === "--forget-theme-size") {
          artifactPresentDuringSizeCleanup = fs.existsSync(pack.packRoot);
        }
        return { ...rawStatus };
      },
      trashImportedArtifact: async (artifactPath) => {
        trashed.push(path.basename(artifactPath));
        await fs.promises.rm(artifactPath, { recursive: true });
      },
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).resolves.toMatchObject({
      identifiers: ["ImportedAurora"],
      removedCount: 1,
      cleanupPending: false,
      recoverable: true,
      restoredToMacOS: true,
      selectionReassigned: true,
      status: {
        selectedNativeThemeId: "ImportedCobalt",
        effectiveApplied: false,
      },
    });
    expect(calls).toEqual([
      ["--status"],
      ["--list-themes"],
      ["--teardown"],
      ["--select-theme", "ImportedCobalt"],
      ["--forget-theme-size", "ImportedAurora"],
      ["--status"],
    ]);
    expect(artifactPresentDuringSizeCleanup).toBe(false);
    expect(artifactPresentDuringTeardown).toBe(false);
    expect(trashed).toEqual(["imported-aurora"]);
    expect(fs.existsSync(pack.packRoot)).toBe(false);
    expect(fs.existsSync(fallback.packRoot)).toBe(true);
  });

  it("restores quarantined artifacts and reapplies the prior cursor when native deletion fails", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--status") {
          return completeNativeStatus({
            selectedThemeIdentifier: "ImportedAurora",
            effectiveNativeThemeId: "ImportedAurora",
            desiredEnabled: true,
            effectiveApplied: true,
            currentSentinelsMatchTheme: true,
            launchAtLoginDesired: true,
            loginItemRegistrationCurrent: true,
          });
        }
        if (command === "--list-themes") {
          return [
            { Identifier: "OreoWhite", DisplayName: "Oreo White" },
            {
              Identifier: "ImportedAurora",
              DisplayName: "Imported Aurora",
            },
          ];
        }
        if (command === "--teardown") {
          throw new Error("teardown failed");
        }
        return {};
      },
      trashImportedArtifact: vi.fn(),
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).rejects.toThrow("native cursor operation could not be completed");

    expect(fs.existsSync(pack.packRoot)).toBe(true);
    expect(calls).toEqual([
      ["--status"],
      ["--list-themes"],
      ["--teardown"],
      ["--apply-theme", "ImportedAurora"],
      ["--status"],
    ]);
  });

  it("restores an inactive imported selection when fallback selection fails", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    writeImportedPack(importedPacksRoot, {
      packName: "imported-cobalt",
      nativeThemeId: "ImportedCobalt",
      catalogId: "imported-cobalt",
      displayName: "Imported Cobalt",
    });
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      manifestData: { schemaVersion: 2, themes: [] },
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--status") {
          return completeNativeStatus({
            selectedThemeIdentifier: "ImportedAurora",
            desiredEnabled: false,
            effectiveApplied: false,
            currentSentinelsMatchTheme: false,
          });
        }
        if (command === "--list-themes") {
          return [
            {
              Identifier: "ImportedAurora",
              DisplayName: "Imported Aurora",
            },
            {
              Identifier: "ImportedCobalt",
              DisplayName: "Imported Cobalt",
            },
          ];
        }
        if (command === "--select-theme" && args[0] === "ImportedCobalt") {
          throw new Error("selection failed");
        }
        return {};
      },
      trashImportedArtifact: vi.fn(),
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).rejects.toThrow("native cursor operation could not be completed");

    expect(fs.existsSync(pack.packRoot)).toBe(true);
    expect(calls).toEqual([
      ["--status"],
      ["--list-themes"],
      ["--select-theme", "ImportedCobalt"],
      ["--select-theme", "ImportedAurora"],
      ["--status"],
    ]);
  });

  it("restores Apple cursors when deleting the last selected installed theme", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    let rawStatus = completeNativeStatus({
      selectedThemeIdentifier: "ImportedAurora",
      desiredEnabled: true,
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
      launchAtLoginDesired: true,
      loginItemRegistrationCurrent: true,
    });
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      manifestData: { schemaVersion: 2, themes: [] },
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--list-themes") {
          return [
            {
              Identifier: "ImportedAurora",
              DisplayName: "Imported Aurora",
            },
          ];
        }
        if (command === "--teardown") {
          rawStatus = {
            ...rawStatus,
            themeValid: false,
            desiredEnabled: false,
            effectiveApplied: false,
            currentSentinelsMatchTheme: false,
            launchAtLoginDesired: false,
            loginItemRegistrationCurrent: false,
          };
        }
        return { ...rawStatus };
      },
      trashImportedArtifact: (artifactPath) =>
        fs.promises.rm(artifactPath, { recursive: true }),
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).resolves.toMatchObject({
      removedCount: 1,
      restoredToMacOS: true,
      selectionReassigned: false,
      status: {
        selectedNativeThemeId: "ImportedAurora",
        effectiveApplied: false,
      },
    });
    expect(calls).toEqual([
      ["--status"],
      ["--list-themes"],
      ["--teardown"],
      ["--forget-theme-size", "ImportedAurora"],
      ["--status"],
    ]);
    expect(fs.existsSync(pack.packRoot)).toBe(false);
  });

  it.each([
    {
      label: "without launch intent",
      launchDesired: false,
      priorRegistrationCurrent: false,
      expectedCommands: [
        ["--select-theme", "ImportedAurora"],
        ["--enable"],
        ["--status"],
      ],
    },
    {
      label: "with launch intent awaiting convergence",
      launchDesired: true,
      priorRegistrationCurrent: false,
      expectedCommands: [["--apply-theme", "ImportedAurora"], ["--status"]],
    },
  ])(
    "recovers exact live deletion state $label",
    async ({ launchDesired, priorRegistrationCurrent, expectedCommands }) => {
      const importedPacksRoot = temporaryDirectory();
      writeImportedPack(importedPacksRoot);
      let rawStatus = completeNativeStatus({
        selectedThemeIdentifier: "OreoWhite",
      });
      const calls = [];
      const bridge = createCursorBridge({
        nativePath: "injected",
        discover: false,
        importedPacksRoot,
        commandRunner: async ({ command, arguments: args }) => {
          calls.push([command, ...args]);
          if (command === "--select-theme") {
            rawStatus = { ...rawStatus, selectedThemeIdentifier: args[0] };
          }
          if (command === "--enable" || command === "--apply-theme") {
            rawStatus = {
              ...rawStatus,
              selectedThemeIdentifier:
                command === "--apply-theme"
                  ? args[0]
                  : rawStatus.selectedThemeIdentifier,
              desiredEnabled: true,
              effectiveApplied: true,
              currentSentinelsMatchTheme: true,
              launchAtLoginDesired: launchDesired,
              loginItemRegistrationCurrent: launchDesired,
            };
          }
          return { ...rawStatus };
        },
      });

      await expect(
        bridge.recoverNativeState({
          previousSelectedIdentifier: "ImportedAurora",
          previousEffectiveIdentifier: "ImportedAurora",
          previousCursorWasLive: true,
          previousDesiredEnabled: true,
          previousLaunchAtLoginDesired: launchDesired,
          previousLoginItemRegistrationCurrent: priorRegistrationCurrent,
          previousTransactionPending: false,
          teardownPlanned: true,
          teardownCurrent: true,
        }),
      ).resolves.toMatchObject({
        desiredEnabled: true,
        effectiveApplied: true,
        launchAtLoginDesired: launchDesired,
      });
      expect(calls).toEqual([["--teardown"], ...expectedCommands]);
    },
  );

  it("refuses desired-but-inactive deletion before fallback selection can apply it", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    const rawStatus = completeNativeStatus({
      selectedThemeIdentifier: "ImportedAurora",
      desiredEnabled: true,
      effectiveApplied: false,
      currentSentinelsMatchTheme: false,
      launchAtLoginDesired: true,
      loginItemRegistrationCurrent: true,
    });
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        return { ...rawStatus };
      },
      trashImportedArtifact: vi.fn(),
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).rejects.toMatchObject({ code: "NATIVE_RECOVERY_UNSUPPORTED" });

    expect(fs.existsSync(pack.packRoot)).toBe(true);
    expect(calls).toEqual([["--status"]]);
    const recoveryDirectories = fs
      .readdirSync(importedPacksRoot)
      .filter((name) => name.startsWith(".delete-"));
    expect(recoveryDirectories).toHaveLength(0);
  });

  it.each([
    {
      label: "persisted application",
      persistedEffectiveApplied: true,
      currentSentinelsMatchTheme: false,
    },
    {
      label: "live sentinels",
      persistedEffectiveApplied: false,
      currentSentinelsMatchTheme: true,
    },
  ])(
    "refuses selected inactive deletion with contradictory $label state",
    async ({ persistedEffectiveApplied, currentSentinelsMatchTheme }) => {
      const importedPacksRoot = temporaryDirectory();
      const pack = writeImportedPack(importedPacksRoot);
      const calls = [];
      const bridge = createCursorBridge({
        nativePath: "injected",
        discover: false,
        importedPacksRoot,
        commandRunner: async ({ command, arguments: args }) => {
          calls.push([command, ...args]);
          return completeNativeStatus({
            selectedThemeIdentifier: "ImportedAurora",
            desiredEnabled: false,
            effectiveApplied: persistedEffectiveApplied,
            currentSentinelsMatchTheme,
          });
        },
        trashImportedArtifact: vi.fn(),
      });

      await expect(
        bridge.deleteImportedThemes(["ImportedAurora"]),
      ).rejects.toMatchObject({ code: "NATIVE_RECOVERY_UNSUPPORTED" });

      expect(fs.existsSync(pack.packRoot)).toBe(true);
      expect(calls).toEqual([["--status"]]);
      expect(
        fs
          .readdirSync(importedPacksRoot)
          .some((name) => name.startsWith(".delete-")),
      ).toBe(false);
    },
  );

  it("refuses deletion while the persisted live cursor cannot be identified", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot);
    let rawStatus = completeNativeStatus({
      selectedThemeIdentifier: "OreoWhite",
      desiredEnabled: true,
      effectiveApplied: true,
      currentSentinelsMatchTheme: false,
      launchAtLoginDesired: true,
      loginItemRegistrationCurrent: true,
    });
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--teardown") {
          rawStatus = {
            ...rawStatus,
            desiredEnabled: false,
            effectiveApplied: false,
            launchAtLoginDesired: false,
            loginItemRegistrationCurrent: false,
          };
        }
        return { ...rawStatus };
      },
      trashImportedArtifact: (artifactPath) =>
        fs.promises.rm(artifactPath, { recursive: true }),
    });

    await expect(
      bridge.deleteImportedThemes(["ImportedAurora"]),
    ).rejects.toMatchObject({ code: "EFFECTIVE_CURSOR_UNIDENTIFIED" });
    expect(calls).toEqual([["--status"]]);
    expect(fs.existsSync(path.join(importedPacksRoot, "imported-aurora"))).toBe(
      true,
    );
  });

  it("forgets every deleted family member after removal and reports cleanup failures without undoing deletion", async () => {
    const importedPacksRoot = temporaryDirectory();
    const blue = writeImportedPack(importedPacksRoot, {
      packName: "aurora-blue",
      nativeThemeId: "ImportedAuroraBlue",
      catalogId: "imported-aurora-blue",
      displayName: "Imported Aurora Blue",
      family: "Aurora",
    });
    const red = writeImportedPack(importedPacksRoot, {
      packName: "aurora-red",
      nativeThemeId: "ImportedAuroraRed",
      catalogId: "imported-aurora-red",
      displayName: "Imported Aurora Red",
      family: "Aurora",
    });
    const calls = [];
    const persistPendingThemeSizeCleanup = vi.fn();
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--list-themes") {
          return [
            {
              Identifier: "ImportedAuroraBlue",
              DisplayName: "Imported Aurora Blue",
              Group: "Aurora",
            },
            {
              Identifier: "ImportedAuroraRed",
              DisplayName: "Imported Aurora Red",
              Group: "Aurora",
            },
          ];
        }
        if (
          command === "--forget-theme-size" &&
          args[0] === "ImportedAuroraBlue"
        ) {
          throw new Error("preferences unavailable");
        }
        return completeNativeStatus({
          selectedThemeIdentifier: "OreoWhite",
        });
      },
      trashImportedArtifact: (artifactPath) =>
        fs.promises.rm(artifactPath, { recursive: true }),
      persistPendingThemeSizeCleanup,
    });

    await expect(bridge.deleteImportedFamily("Aurora")).resolves.toMatchObject({
      removedCount: 2,
      sizePreferenceCleanupPending: true,
      sizePreferenceCleanupIdentifiers: ["ImportedAuroraBlue"],
    });
    expect(
      calls.filter(([command]) => command === "--forget-theme-size"),
    ).toEqual([
      ["--forget-theme-size", "ImportedAuroraBlue"],
      ["--forget-theme-size", "ImportedAuroraRed"],
    ]);
    expect(persistPendingThemeSizeCleanup).toHaveBeenCalledWith([
      "ImportedAuroraBlue",
    ]);
    expect(fs.existsSync(blue.packRoot)).toBe(false);
    expect(fs.existsSync(red.packRoot)).toBe(false);
  });

  it("deletes installed members when curated entries share their family", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot, { family: "Oreo" });
    const disposed = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner: async ({ command }) => {
        if (command === "--list-themes") {
          return [
            { Identifier: "OreoWhite", DisplayName: "Oreo White" },
            { Identifier: "ImportedAurora", DisplayName: "Imported Aurora" },
          ];
        }
        return completeNativeStatus({
          selectedThemeIdentifier: "OreoWhite",
        });
      },
      trashImportedArtifact: async (artifactPath) => {
        disposed.push(path.basename(artifactPath));
        await fs.promises.rm(artifactPath, { recursive: true });
      },
    });

    await expect(bridge.deleteImportedFamily("Oreo")).resolves.toMatchObject({
      identifiers: ["ImportedAurora"],
      removedCount: 1,
    });
    expect(disposed).toEqual(["imported-aurora"]);
    expect(fs.existsSync(pack.packRoot)).toBe(false);
  });

  it("deletes every pack in an imported-only family as one mutation", async () => {
    const importedPacksRoot = temporaryDirectory();
    const blue = writeImportedPack(importedPacksRoot, {
      packName: "studio-blue",
      nativeThemeId: "StudioBlue",
      catalogId: "studio-blue",
      family: "Studio",
    });
    const red = writeImportedPack(importedPacksRoot, {
      packName: "studio-red",
      nativeThemeId: "StudioRed",
      catalogId: "studio-red",
      family: "Studio",
    });
    const disposed = [];
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
      trashImportedArtifact: async (artifactPath) => {
        disposed.push(path.basename(artifactPath));
        await fs.promises.rm(artifactPath, { recursive: true });
      },
    });

    await expect(bridge.deleteImportedFamily("Studio")).resolves.toMatchObject({
      identifiers: ["StudioBlue", "StudioRed"],
      removedCount: 2,
      recoverable: true,
    });
    expect(disposed.sort()).toEqual(["studio-blue", "studio-red"]);
    expect(fs.existsSync(blue.packRoot)).toBe(false);
    expect(fs.existsSync(red.packRoot)).toBe(false);
  });

  it("keeps bundled native and catalogue identifiers immutable on collision", async () => {
    const bundledRoot = temporaryDirectory();
    fs.mkdirSync(path.join(bundledRoot, "previews"), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, "Stable.cursor"), "cursor");
    fs.writeFileSync(
      path.join(bundledRoot, "previews", "stable.png"),
      ONE_PIXEL_PNG,
    );
    const bundledTheme = {
      Identifier: "StableCollision",
      catalogId: "stable-collision",
      DisplayName: "Bundled Stable",
      Resource: "Stable.cursor",
      preview: "previews/stable.png",
      rolePreviews: [
        {
          role: "default",
          macIdentifier: "com.apple.coregraphics.Arrow",
          asset: "previews/stable.png",
        },
      ],
    };
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "native-collision",
      nativeThemeId: "stablecollision",
      catalogId: "different-catalog-id",
      displayName: "Imported Native Collision",
    });
    writeImportedPack(importedPacksRoot, {
      packName: "catalog-collision",
      nativeThemeId: "DifferentNativeId",
      catalogId: "STABLE-COLLISION",
      displayName: "Imported Catalogue Collision",
    });
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      manifestRoot: bundledRoot,
      manifestData: { schemaVersion: 2, themes: [bundledTheme] },
      importedPacksRoot,
    });

    const themes = await bridge.listThemes();
    expect(themes).toEqual([
      expect.objectContaining({
        id: "stable-collision",
        nativeThemeId: "StableCollision",
        displayName: "Bundled Stable",
        availability: "bundled",
        imported: false,
      }),
    ]);
  });

  it("rejects path escapes, unsafe pack names, and symlinked packs or assets", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "good-pack",
      nativeThemeId: "GoodPack",
      catalogId: "good-pack",
      displayName: "Good Pack",
    });

    const outsideRoot = temporaryDirectory();
    const outsideCursor = path.join(outsideRoot, "outside.cursor");
    const outsidePreview = path.join(outsideRoot, "outside.png");
    fs.writeFileSync(outsideCursor, "cursor resource");
    fs.writeFileSync(outsidePreview, ONE_PIXEL_PNG);

    const escaped = writeImportedPack(importedPacksRoot, {
      packName: "escaped-resource",
      nativeThemeId: "EscapedResource",
    });
    fs.writeFileSync(
      escaped.manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        themes: [{ ...escaped.theme, Resource: "../outside.cursor" }],
      }),
    );

    const linkedResource = writeImportedPack(importedPacksRoot, {
      packName: "linked-resource",
      nativeThemeId: "LinkedResource",
    });
    fs.unlinkSync(linkedResource.resourcePath);
    fs.symlinkSync(outsideCursor, linkedResource.resourcePath);

    const linkedPreview = writeImportedPack(importedPacksRoot, {
      packName: "linked-preview",
      nativeThemeId: "LinkedPreview",
    });
    fs.unlinkSync(linkedPreview.previewPath);
    fs.symlinkSync(outsidePreview, linkedPreview.previewPath);

    const nonRegularResource = writeImportedPack(importedPacksRoot, {
      packName: "non-regular-resource",
      nativeThemeId: "NonRegularResource",
    });
    fs.unlinkSync(nonRegularResource.resourcePath);
    fs.mkdirSync(nonRegularResource.resourcePath);

    const flatPreview = writeImportedPack(importedPacksRoot, {
      packName: "flat-preview",
      nativeThemeId: "FlatPreview",
    });
    fs.writeFileSync(
      path.join(flatPreview.packRoot, "flat.png"),
      ONE_PIXEL_PNG,
    );
    fs.writeFileSync(
      flatPreview.manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        themes: [
          {
            ...flatPreview.theme,
            preview: "flat.png",
            rolePreviews: [
              { ...flatPreview.theme.rolePreviews[0], asset: "flat.png" },
            ],
          },
        ],
      }),
    );

    const externalPackRoot = path.join(outsideRoot, "ExternalPack");
    fs.mkdirSync(externalPackRoot);
    fs.writeFileSync(
      path.join(externalPackRoot, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, themes: [] }),
    );
    fs.symlinkSync(
      externalPackRoot,
      path.join(importedPacksRoot, "linked-pack"),
    );
    writeImportedPack(importedPacksRoot, {
      packName: "unsafe pack name",
      nativeThemeId: "UnsafeName",
    });

    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });
    const importedThemes = (await bridge.listThemes()).filter(
      (theme) => theme.imported,
    );
    expect(importedThemes).toEqual([
      expect.objectContaining({
        id: "good-pack",
        nativeThemeId: "GoodPack",
      }),
    ]);
  });

  it("rejects imported packs with public modes or hardlinked files", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "good-pack",
      nativeThemeId: "GoodPack",
      catalogId: "good-pack",
    });

    const publicPack = writeImportedPack(importedPacksRoot, {
      packName: "public-pack",
      nativeThemeId: "PublicPack",
    });
    fs.chmodSync(publicPack.packRoot, 0o755);

    const publicPreview = writeImportedPack(importedPacksRoot, {
      packName: "public-preview",
      nativeThemeId: "PublicPreview",
    });
    fs.chmodSync(publicPreview.previewPath, 0o644);

    const hardlinked = writeImportedPack(importedPacksRoot, {
      packName: "hardlinked",
      nativeThemeId: "Hardlinked",
    });
    fs.linkSync(
      hardlinked.resourcePath,
      path.join(temporaryDirectory(), "linked.cursor"),
    );

    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });
    expect(
      (await bridge.listThemes())
        .filter((theme) => theme.imported)
        .map((theme) => theme.nativeThemeId),
    ).toEqual(["GoodPack"]);
  });

  it("rejects malformed, oversized, overfull, duplicate, or hash-mismatched packs", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "good-pack",
      nativeThemeId: "GoodPack",
      catalogId: "good-pack",
    });

    const malformedRoot = path.join(importedPacksRoot, "malformed");
    fs.mkdirSync(malformedRoot);
    fs.writeFileSync(path.join(malformedRoot, "manifest.json"), "{");

    const oldSchema = writeImportedPack(importedPacksRoot, {
      packName: "old-schema",
      nativeThemeId: "OldSchema",
    });
    fs.writeFileSync(
      oldSchema.manifestPath,
      JSON.stringify({ schemaVersion: 1, themes: [oldSchema.theme] }),
    );

    const badHash = writeImportedPack(importedPacksRoot, {
      packName: "bad-hash",
      nativeThemeId: "BadHash",
    });
    fs.writeFileSync(
      badHash.manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        themes: [{ ...badHash.theme, SHA256: "0".repeat(64) }],
      }),
    );

    const missingMetadata = writeImportedPack(importedPacksRoot, {
      packName: "missing-metadata",
      nativeThemeId: "MissingMetadata",
    });
    const themeWithoutUuid = { ...missingMetadata.theme };
    delete themeWithoutUuid.UUID;
    fs.writeFileSync(
      missingMetadata.manifestPath,
      JSON.stringify({ schemaVersion: 2, themes: [themeWithoutUuid] }),
    );

    const duplicate = writeImportedPack(importedPacksRoot, {
      packName: "duplicate-ids",
      nativeThemeId: "DuplicateId",
      catalogId: "duplicate-id",
    });
    fs.writeFileSync(
      duplicate.manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        themes: [duplicate.theme, duplicate.theme],
      }),
    );

    const overfullRoot = path.join(importedPacksRoot, "overfull");
    fs.mkdirSync(overfullRoot);
    fs.writeFileSync(
      path.join(overfullRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        themes: Array.from({ length: 65 }, (_, index) => ({
          Identifier: `Overfull${index}`,
        })),
      }),
    );

    const oversizedRoot = path.join(importedPacksRoot, "oversized");
    fs.mkdirSync(oversizedRoot);
    const oversizedManifest = path.join(oversizedRoot, "manifest.json");
    fs.writeFileSync(oversizedManifest, "{}");
    fs.truncateSync(oversizedManifest, 17 * 1024 * 1024);

    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });
    expect(
      (await bridge.listThemes())
        .filter((theme) => theme.imported)
        .map((theme) => theme.nativeThemeId),
    ).toEqual(["GoodPack"]);
  });

  it("fails closed when the imported store contains too many manifests", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot, {
      packName: "good-pack",
      nativeThemeId: "GoodPack",
    });
    for (let index = 0; index < 512; index += 1) {
      const packRoot = path.join(importedPacksRoot, `extra-${index}`);
      fs.mkdirSync(packRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(packRoot, "manifest.json"), "{}", {
        mode: 0o600,
      });
    }
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });

    expect((await bridge.listThemes()).some((theme) => theme.imported)).toBe(
      false,
    );
  });

  it("invalidates manifest caches and permanently revokes stale preview tokens", async () => {
    const importedPacksRoot = temporaryDirectory();
    const pack = writeImportedPack(importedPacksRoot);
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
      importedPacksRoot,
    });
    const firstTheme = (await bridge.listThemes()).find(
      (theme) => theme.imported,
    );
    const firstPreview = firstTheme.preview;

    fs.writeFileSync(
      pack.previewPath,
      Buffer.concat([ONE_PIXEL_PNG, Buffer.from("updated")]),
    );
    await bridge.invalidateManifests();
    expect(bridge.resolvePreviewAsset(firstPreview)).toBeNull();

    const nextTheme = (await bridge.listThemes()).find(
      (theme) => theme.imported,
    );
    expect(nextTheme.preview).not.toBe(firstPreview);
    expect(bridge.resolvePreviewAsset(firstPreview)).toBeNull();
    expect(bridge.resolvePreviewAsset(nextTheme.preview)).toBe(
      fs.realpathSync(pack.previewPath),
    );
  });

  it("serializes manifest invalidation behind an in-flight cursor mutation", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot);
    let releaseApply;
    let markApplyStarted;
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const commandRunner = vi.fn(async ({ command }) => {
      if (command === "--list-themes") {
        return [{ Identifier: "ImportedAurora" }];
      }
      if (command === "--apply-theme") {
        markApplyStarted();
        await new Promise((resolve) => {
          releaseApply = resolve;
        });
      }
      return completeNativeStatus({
        selectedThemeIdentifier: "ImportedAurora",
      });
    });
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner,
    });
    await bridge.listThemes();

    const applying = bridge.applyTheme("imported-aurora");
    await applyStarted;
    let invalidated = false;
    const invalidating = bridge.invalidateManifests().then(() => {
      invalidated = true;
    });
    await Promise.resolve();
    expect(invalidated).toBe(false);
    releaseApply();
    await applying;
    await invalidating;
    expect(invalidated).toBe(true);
  });

  it("checks an apply guard after earlier native mutations leave the queue", async () => {
    const importedPacksRoot = temporaryDirectory();
    writeImportedPack(importedPacksRoot);
    let releaseFirstApply;
    let markFirstApplyStarted;
    let applyCalls = 0;
    const firstApplyStarted = new Promise((resolve) => {
      markFirstApplyStarted = resolve;
    });
    const commandRunner = vi.fn(async ({ command }) => {
      if (command === "--list-themes") {
        return [{ Identifier: "ImportedAurora" }];
      }
      if (command === "--apply-theme") {
        applyCalls += 1;
        if (applyCalls === 1) {
          markFirstApplyStarted();
          await new Promise((resolve) => {
            releaseFirstApply = resolve;
          });
        }
      }
      return completeNativeStatus({
        effectiveApplied: true,
        currentSentinelsMatchTheme: true,
        selectedThemeIdentifier: "ImportedAurora",
      });
    });
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      importedPacksRoot,
      commandRunner,
    });
    await bridge.listThemes();

    const firstApply = bridge.applyTheme("imported-aurora");
    await firstApplyStarted;
    let current = true;
    const shouldApply = vi.fn(() => current);
    const staleApply = bridge.applyTheme("imported-aurora", { shouldApply });
    current = false;
    releaseFirstApply();

    await firstApply;
    await expect(staleApply).resolves.toEqual({
      applySkipped: true,
      reason: "stale-request",
    });
    expect(shouldApply).toHaveBeenCalledOnce();
    expect(
      commandRunner.mock.calls.filter(
        ([request]) => request.command === "--apply-theme",
      ),
    ).toHaveLength(1);
  });
});

describe("cursor bridge live native state", () => {
  function createNativeFixture({ approvalRequired = true } = {}) {
    const manifestRoot = temporaryDirectory();
    fs.writeFileSync(path.join(manifestRoot, "OreoBlue.cursor"), "cursor");
    let rawStatus = {
      supported: 1,
      themeValid: 1,
      selectedThemeIdentifier: "OreoBlue",
      desiredEnabled: 0,
      effectiveApplied: 0,
      currentSentinelsMatchTheme: 0,
      launchAtLoginDesired: 1,
      loginApprovalRequired: approvalRequired ? 1 : 0,
      loginItemRegistrationCurrent: 0,
      transactionPending: 0,
    };
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      manifestRoot,
      manifestData: {
        schemaVersion: 2,
        themes: [
          {
            Identifier: "OreoBlue",
            DisplayName: "Oreo Blue",
            ThemeName: "Oreo Blue",
            Group: "Oreo",
            Variant: "Blue",
            Resource: "OreoBlue.cursor",
          },
        ],
      },
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--list-themes") {
          return [
            {
              Identifier: "OreoBlue",
              DisplayName: "Oreo Blue",
              SizePercentage: 125,
            },
          ];
        }
        if (command === "--apply-theme") {
          rawStatus = {
            ...rawStatus,
            desiredEnabled: true,
            effectiveApplied: true,
            currentSentinelsMatchTheme: true,
          };
          return { ...rawStatus, action: "apply-theme" };
        }
        if (command === "--teardown") {
          rawStatus = {
            ...rawStatus,
            desiredEnabled: false,
            effectiveApplied: false,
            currentSentinelsMatchTheme: false,
          };
          return { ...rawStatus, action: "teardown" };
        }
        if (command === "--open-login-settings") {
          return { ...rawStatus, action: "open-login-settings" };
        }
        if (command === "--portable-preferences") {
          return {
            schemaVersion: 1,
            selectedThemeIdentifier: "OreoBlue",
            themeSizePercentages: { OreoBlue: 125 },
          };
        }
        if (command === "--replace-portable-preferences") {
          return { ...JSON.parse(args[0]), replaced: true };
        }
        if (command === "--reset-preferences") {
          return { reset: true };
        }
        return { ...rawStatus, action: "status" };
      },
    });
    return {
      bridge,
      calls,
      drift() {
        rawStatus = {
          ...rawStatus,
          desiredEnabled: true,
          effectiveApplied: true,
          currentSentinelsMatchTheme: false,
        };
      },
    };
  }

  it("uses the atomic native mutation diagnostics as live status", async () => {
    const fixture = createNativeFixture();

    const applied = await fixture.bridge.applyTheme("oreo-blue");
    expect(applied).toMatchObject({
      schemaVersion: 1,
      selectedVariantId: "oreo-blue",
      requestedVariantId: "oreo-blue",
      effectiveVariantId: "oreo-blue",
      effectiveApplied: true,
      currentSentinelsMatchTheme: true,
    });
    expect(applied).not.toHaveProperty("selectedThemeIdentifier");
    expect(applied).not.toHaveProperty("themeIdentifier");
    expect(applied).not.toHaveProperty("isEnabled");
    expect(applied).not.toHaveProperty("liveVerified");
    expect(fixture.calls).toEqual([["--apply-theme", "OreoBlue"]]);

    await expect(fixture.bridge.restore()).resolves.toMatchObject({
      selectedVariantId: "oreo-blue",
      requestedVariantId: null,
      effectiveVariantId: null,
      effectiveApplied: false,
    });
    expect(fixture.calls.slice(-1)).toEqual([["--teardown"]]);
  });

  it("reconciles the installed login helper without applying a cursor", async () => {
    const fixture = createNativeFixture();

    await expect(fixture.bridge.reconcileLoginItems()).resolves.toMatchObject({
      selectedThemeIdentifier: "OreoBlue",
      desiredEnabled: 0,
      effectiveApplied: 0,
    });
    expect(fixture.calls).toEqual([["--reconcile-login-items"]]);
  });

  it("saves bounded per-theme size without reading or changing live state", async () => {
    const fixture = createNativeFixture();

    await expect(fixture.bridge.listThemes()).resolves.toEqual([
      expect.objectContaining({
        nativeThemeId: "OreoBlue",
        sizePercentage: 125,
      }),
    ]);
    fixture.calls.length = 0;

    await expect(
      fixture.bridge.setThemeSize("oreo-blue", 135),
    ).resolves.toEqual({
      schemaVersion: 1,
      id: "oreo-blue",
      nativeThemeId: "OreoBlue",
      sizePercentage: 135,
    });
    expect(fixture.calls).toEqual([["--set-theme-size", "OreoBlue", "135"]]);

    await expect(fixture.bridge.setThemeSize("oreo-blue", 49)).rejects.toThrow(
      "between 50 and 200",
    );
    await expect(
      fixture.bridge.setThemeSize("oreo-blue", 100.5),
    ).rejects.toThrow("between 50 and 200");
    expect(fixture.calls).toHaveLength(1);
  });

  it("round-trips portable native settings without an apply command", async () => {
    const fixture = createNativeFixture();

    await expect(fixture.bridge.getPortablePreferences()).resolves.toEqual({
      schemaVersion: 1,
      selectedThemeIdentifier: "OreoBlue",
      themeSizePercentages: { OreoBlue: 125 },
    });
    await expect(
      fixture.bridge.replacePortablePreferences({
        schemaVersion: 1,
        selectedThemeIdentifier: "OreoBlue",
        themeSizePercentages: { OreoBlue: 140 },
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      selectedThemeIdentifier: "OreoBlue",
      themeSizePercentages: { OreoBlue: 140 },
    });
    await expect(fixture.bridge.resetPreferences()).resolves.toBe(true);

    expect(fixture.calls.map(([command]) => command)).toEqual([
      "--portable-preferences",
      "--replace-portable-preferences",
      "--reset-preferences",
    ]);
    expect(fixture.calls).not.toContainEqual(["--apply-theme", "OreoBlue"]);
  });

  it("requires every imported theme to pass the native decoder", async () => {
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--validate-theme") {
          return args[0] === "Broken"
            ? { valid: false, actionError: "The cursor plist is malformed." }
            : { valid: true };
        }
        return {};
      },
    });

    await expect(
      bridge.validateImportedThemes(["ImportedOne", "ImportedTwo"]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["--validate-theme", "ImportedOne"],
      ["--validate-theme", "ImportedTwo"],
    ]);

    await expect(
      bridge.validateImportedThemes(["Broken"]),
    ).rejects.toMatchObject({
      name: "NativeCursorError",
      code: "INVALID_IMPORTED_CURSOR",
      message: "The cursor plist is malformed.",
    });
  });

  it("normalizes native numeric booleans and gates Login Items settings", async () => {
    const fixture = createNativeFixture();

    await expect(fixture.bridge.status()).resolves.toMatchObject({
      supported: true,
      launchAtLoginDesired: true,
      loginApprovalRequired: true,
      loginItemRegistrationCurrent: false,
    });
    await expect(fixture.bridge.openLoginSettings()).resolves.toMatchObject({
      loginApprovalRequired: true,
    });
    expect(fixture.calls.slice(-2)).toEqual([
      ["--status"],
      ["--open-login-settings"],
    ]);

    const unnecessary = createNativeFixture({ approvalRequired: false });
    await expect(unnecessary.bridge.openLoginSettings()).rejects.toThrow(
      "not currently required",
    );
    expect(unnecessary.calls).toEqual([["--status"]]);
  });

  it("accepts clean zero-theme status with no selected cursor", async () => {
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      manifestData: { schemaVersion: 2, roleCount: 47, themes: [] },
      commandRunner: async () =>
        completeNativeStatus({
          themeValid: false,
          selectedThemeIdentifier: "",
        }),
    });

    await expect(bridge.status()).resolves.toMatchObject({
      bridgeAvailable: true,
      statusAvailable: true,
      selectedVariantId: null,
      selectedNativeThemeId: null,
      themeDisplayName: null,
      resourceAvailable: false,
      canApply: false,
      effectiveApplied: false,
    });
  });

  it.each([
    ["omits required diagnostics", {}],
    [
      "uses a non-boolean diagnostic",
      completeNativeStatus({ transactionPending: "false" }),
    ],
    [
      "uses a malformed diagnostic alongside a valid alias",
      completeNativeStatus({
        transactionPending: "false",
        TransactionPending: false,
      }),
    ],
    [
      "uses conflicting duplicate diagnostics",
      completeNativeStatus({
        transactionPending: false,
        TransactionPending: true,
      }),
    ],
    [
      "uses a malformed selected theme alongside a valid alias",
      completeNativeStatus({
        selectedThemeIdentifier: 7,
        SelectedThemeIdentifier: "OreoWhite",
      }),
    ],
    [
      "uses conflicting duplicate selected themes",
      completeNativeStatus({
        selectedThemeIdentifier: "OreoWhite",
        SelectedThemeIdentifier: "OreoBlue",
      }),
    ],
    [
      "omits the selected native theme",
      completeNativeStatus({ selectedThemeIdentifier: null }),
    ],
  ])("fails closed when native status %s", async (_label, nativeStatus) => {
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      commandRunner: async () => nativeStatus,
    });

    await expect(bridge.status()).resolves.toMatchObject({
      bridgeAvailable: true,
      statusAvailable: false,
      canApply: false,
      effectiveApplied: false,
      effectiveVariantId: null,
    });
  });

  it("rejects a mutation when neither response provides complete status", async () => {
    const commandRunner = vi.fn(async () => ({}));
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      commandRunner,
    });

    await expect(bridge.restore()).rejects.toMatchObject({
      code: "NATIVE_STATUS_UNAVAILABLE",
      status: {
        statusAvailable: false,
        canApply: false,
        effectiveApplied: false,
      },
    });
    expect(
      commandRunner.mock.calls.map(([request]) => request.command),
    ).toEqual(["--teardown", "--status"]);
  });

  it("surfaces authoritative native inventory failures", async () => {
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      manifestData: { themes: [] },
      commandRunner: async ({ command }) => {
        if (command === "--list-themes") {
          throw new Error("inventory unavailable");
        }
        return {};
      },
    });

    await expect(bridge.listThemes()).rejects.toThrow(
      "The native cursor operation could not be completed.",
    );
  });

  it("does not call persisted state active after live sentinel drift", async () => {
    const fixture = createNativeFixture();
    fixture.drift();

    await expect(fixture.bridge.status()).resolves.toMatchObject({
      selectedVariantId: "oreo-blue",
      requestedVariantId: "oreo-blue",
      effectiveVariantId: null,
      desiredEnabled: true,
      persistedEffectiveApplied: true,
      effectiveApplied: false,
      stateDrifted: true,
    });
  });

  it("uses authoritative diagnostics returned by a failed mutation", async () => {
    const manifestRoot = temporaryDirectory();
    fs.writeFileSync(path.join(manifestRoot, "OreoBlue.cursor"), "cursor");
    const commandRunner = vi.fn(async ({ command }) => {
      if (command === "--apply-theme") {
        const error = new Error("process exited");
        error.code = 4;
        error.stdout = JSON.stringify({
          actionError: "macOS rejected the cursor change.",
        });
        throw error;
      }
      return completeNativeStatus({
        selectedThemeIdentifier: "OreoBlue",
      });
    });
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      manifestRoot,
      manifestData: {
        schemaVersion: 2,
        themes: [
          {
            Identifier: "OreoBlue",
            DisplayName: "Oreo Blue",
            ThemeName: "Oreo Blue",
            Group: "Oreo",
            Variant: "Blue",
            Resource: "OreoBlue.cursor",
          },
        ],
      },
      commandRunner,
    });

    let failure;
    try {
      await bridge.applyTheme("oreo-blue");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "macOS rejected the cursor change.",
      status: {
        effectiveVariantId: null,
        effectiveApplied: false,
      },
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "--apply-theme" }),
    );
  });
});

describe("cursor IPC", () => {
  it("registers only the minimal contract and rejects untrusted senders", async () => {
    const handlers = new Map();
    const ipcMain = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    };
    const bridge = {
      status: vi.fn(() => ({ isEnabled: false })),
      listThemes: vi.fn(() => []),
      applyTheme: vi.fn(),
      setThemeSize: vi.fn(),
      restoreState: vi.fn(),
      openLoginSettings: vi.fn(),
    };
    registerCursorIpc({
      ipcMain,
      bridge,
      isTrustedSender: (event) => event.trusted === true,
    });

    expect([...handlers.keys()]).toEqual([
      "cursor:status",
      "cursor:list-themes",
      "cursor:apply-theme",
      "cursor:set-theme-size",
      "cursor:restore-state",
      "cursor:open-login-settings",
    ]);
    expect(() => handlers.get("cursor:status")({ trusted: false })).toThrow(
      "unavailable to this page",
    );
    expect(handlers.get("cursor:status")({ trusted: true })).toEqual({
      isEnabled: false,
    });
  });
});
