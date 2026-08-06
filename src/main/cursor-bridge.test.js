import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCursorBridge, registerCursorIpc } from "./cursor-bridge";

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

function writeImportedPack(
  importedPacksRoot,
  {
    packName = "imported-aurora",
    nativeThemeId = "ImportedAurora",
    catalogId = "imported-aurora",
    displayName = "Imported Aurora",
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
    Group: "Imported",
    Variant: "Default",
    Resource: resourceFile,
    SHA256: crypto.createHash("sha256").update(cursorData).digest("hex"),
    UUID: crypto.randomUUID().toUpperCase(),
    preview: previewFile,
    rolePreviews: [
      {
        role: "default",
        macIdentifier: "com.apple.coregraphics.Arrow",
        asset: previewFile,
        frameCount: 1,
        frameDuration: 1,
      },
    ],
  };
  const manifestPath = path.join(packRoot, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 2, themes: [theme] }),
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
  it("never reports a preview-only selection as active", async () => {
    const bridge = createCursorBridge({
      nativePath: "/missing/cursor-bridge",
      discover: false,
    });

    await expect(bridge.status()).resolves.toMatchObject({
      previewMode: true,
      bridgeAvailable: false,
      canApply: false,
      isEnabled: false,
      effectiveVariantId: null,
    });
    await expect(bridge.applyTheme("oreo-blue")).rejects.toThrow(
      "not available to apply",
    );
    expect(
      (await bridge.listThemes()).find((theme) => theme.id === "oreo-blue"),
    ).toMatchObject({ canApply: false, status: "preview" });
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
      nativeThemeId: "MogaClassic",
      available: true,
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
        resourceInstalled: true,
        preview: theme.preview,
      }),
    ]);
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
      nativeThemeId: "ImportedAurora",
      displayName: "Imported Aurora",
      availability: "imported",
      imported: true,
      resourceInstalled: true,
      available: true,
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
      return {
        supported: true,
        themeValid: true,
        selectedThemeIdentifier: "ImportedAurora",
      };
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
      nativeThemeId: "ImportedAurora",
      availability: "imported",
      imported: true,
      nativeListed: true,
      resourceInstalled: true,
      canApply: true,
      status: "available",
    });
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
    for (let index = 0; index < 256; index += 1) {
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
      return {
        supported: true,
        themeValid: true,
        selectedThemeIdentifier: "ImportedAurora",
      };
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
});

describe("cursor bridge live native state", () => {
  function createNativeFixture({ approvalRequired = true } = {}) {
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
    };
    const calls = [];
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
      commandRunner: async ({ command, arguments: args }) => {
        calls.push([command, ...args]);
        if (command === "--list-themes") {
          return [{ Identifier: "OreoBlue", DisplayName: "Oreo Blue" }];
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

  it("uses one atomic command and refetches live status after mutations", async () => {
    const fixture = createNativeFixture();

    await expect(fixture.bridge.applyTheme("oreo-blue")).resolves.toMatchObject(
      {
        selectedVariantId: "oreo-blue",
        requestedVariantId: "oreo-blue",
        effectiveVariantId: "oreo-blue",
        isEnabled: true,
        liveVerified: true,
      },
    );
    expect(fixture.calls).toEqual([
      ["--apply-theme", "OreoBlue"],
      ["--status"],
    ]);

    await expect(fixture.bridge.restore()).resolves.toMatchObject({
      selectedVariantId: "oreo-blue",
      requestedVariantId: null,
      effectiveVariantId: null,
      isEnabled: false,
    });
    expect(fixture.calls.slice(-2)).toEqual([["--teardown"], ["--status"]]);
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
      isEnabled: false,
      liveVerified: false,
      stateDrifted: true,
    });
  });

  it("refreshes authoritative status after a failed mutation", async () => {
    const commandRunner = vi.fn(async ({ command }) => {
      if (command === "--apply-theme") {
        const error = new Error("process exited");
        error.code = 4;
        error.stdout = JSON.stringify({
          actionError: "macOS rejected the cursor change.",
        });
        throw error;
      }
      return {
        supported: true,
        themeValid: true,
        selectedThemeIdentifier: "OreoBlue",
        desiredEnabled: false,
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
      };
    });
    const bridge = createCursorBridge({
      nativePath: "injected",
      discover: false,
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
        isEnabled: false,
      },
    });
    expect(commandRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "--status" }),
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
      restore: vi.fn(),
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
      "cursor:restore",
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
