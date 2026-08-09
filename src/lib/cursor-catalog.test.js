import { describe, expect, it } from "vitest";

import {
  CURSOR_CATALOG,
  CURSOR_CATALOG_COUNTS,
  filterCursorCatalog,
  getCursorCatalogEntry,
  mergeCursorCatalogWithNativeThemes,
  normalizeRolePreviews,
  normalizeCursorTheme,
} from "./cursor-catalog";

describe("cursor catalogue", () => {
  it("contains all bundled Oreo variants and requested families", () => {
    expect(CURSOR_CATALOG_COUNTS.bundled).toBe(19);
    expect(CURSOR_CATALOG_COUNTS.total).toBe(38);
    expect(CURSOR_CATALOG.every((entry) => entry.schemaVersion === 1)).toBe(
      true,
    );

    for (const id of [
      "remus",
      "drop",
      "moga-classic",
      "moga-candy",
      "moga-colors",
      "moga-neon",
      "moga-light",
      "volantes",
      "vimix",
      "qogir",
      "bibata-extra",
      "google",
      "simp1e",
      "capitaine",
      "future",
      "future-cyan",
      "nordzy",
      "colloid",
      "bibata",
    ]) {
      expect(CURSOR_CATALOG.some((entry) => entry.id === id)).toBe(true);
    }

    expect(
      CURSOR_CATALOG.filter((entry) => entry.family !== "Oreo").every(
        (entry) => typeof entry.nativeThemeId === "string",
      ),
    ).toBe(true);
  });

  it("points Future Cyan at the author's high-quality SVG source", () => {
    const futureCyan = getCursorCatalogEntry("future-cyan");

    expect(futureCyan.nativeThemeId).toBe("FutureCyan");
    expect(futureCyan.variant).toBe("Cyan");
    expect(futureCyan.sourceUrl).toBe(
      "https://github.com/yeyushengfan258/Future-cursors/tree/master/src/svg-cyan",
    );
  });

  it("keeps catalogue-only packs unavailable without fabricating previews", () => {
    const mogaResults = filterCursorCatalog(CURSOR_CATALOG, "moga neon");
    expect(mogaResults.map((entry) => entry.id)).toEqual(["moga-neon"]);
    expect(mogaResults[0].resourceAvailable).toBe(false);
    expect(mogaResults[0].preview).toBeNull();
    expect(mogaResults[0].rolePreviews).toEqual([]);
  });

  it("keeps stable native IDs before generated resources are installed", () => {
    expect(getCursorCatalogEntry("MogaClassic").id).toBe("moga-classic");
    expect(getCursorCatalogEntry("MogaClassic").nativeThemeId).toBe(
      "MogaClassic",
    );
    expect(getCursorCatalogEntry("MogaClassic").canApply).toBe(false);
  });

  it("upgrades generated manifest themes without losing curated metadata", () => {
    const normalized = normalizeCursorTheme({
      Identifier: "MogaClassic",
      DisplayName: "Moga Classic",
      Resource: "MogaClassic.cursor",
      SHA256: "abc123",
      Group: "Moga",
      resourceInstalled: true,
      canApply: true,
    });
    const [moga] = mergeCursorCatalogWithNativeThemes(CURSOR_CATALOG, [
      normalized,
    ]).filter((entry) => entry.id === "moga-classic");

    expect(moga.resourceAvailable).toBe(true);
    expect(moga.canApply).toBe(true);
    expect(moga.resourceFile).toBe("MogaClassic.cursor");
    expect(moga.license).toBe(getCursorCatalogEntry("moga-classic").license);
    expect(moga).not.toHaveProperty("Identifier");
    expect(moga).not.toHaveProperty("DisplayName");
  });

  it("normalizes exact role previews and animation metadata from manifest v2", () => {
    const rolePreviews = Array.from({ length: 47 }, (_, index) => ({
      macIdentifier:
        index === 0
          ? "com.apple.coregraphics.Arrow"
          : `com.apple.cursor.${index + 1}`,
      role: index === 0 ? "default" : `role-${index + 1}`,
      src: `cursor-preview://asset/role-${index + 1}`,
      frameCount: index === 1 ? 24 : 1,
      frameDuration: index === 1 ? 0.03 : 1,
      hotspot: { x: 4, y: 4 },
      fallback: false,
    }));
    const normalized = normalizeCursorTheme({
      Identifier: "MogaClassic",
      DisplayName: "Moga Classic",
      Resource: "MogaClassic.cursor",
      resourceInstalled: true,
      canApply: true,
      preview: "cursor-preview://asset/arrow",
      rolePreviews,
    });

    expect(normalized.preview).toBe("cursor-preview://asset/arrow");
    expect(normalized.cursorCount).toBe(47);
    expect(normalized.cursorCountEstimated).toBe(false);
    expect(normalized.rolePreviews).toHaveLength(47);
    expect(normalized.rolePreviews[1]).toMatchObject({
      role: "role-2",
      frameCount: 24,
      frameDuration: 0.03,
    });
  });

  it("does not expose raw role-preview manifest fields", () => {
    const [role] = normalizeRolePreviews([
      {
        role: "default",
        asset: "cursor-preview://asset/default",
        resolvedRole: "left_ptr",
        UnknownNativeField: "private",
        frameCount: 1,
        frameDuration: 1,
        hotspot: { x: 4, y: 3 },
      },
    ]);

    expect(role).toEqual({
      role: "default",
      name: "default",
      src: "cursor-preview://asset/default",
      frameCount: 1,
      frameDuration: 1,
      hotspot: { x: 4, y: 3 },
      fallback: false,
    });
    expect(role).not.toHaveProperty("asset");
    expect(role).not.toHaveProperty("resolvedRole");
    expect(role).not.toHaveProperty("UnknownNativeField");
  });

  it("keeps generated variants distinct while inheriting family attribution", () => {
    const vimixWhite = normalizeCursorTheme({
      Identifier: "VimixWhite",
      DisplayName: "Vimix Cursors - White",
      Resource: "VimixWhite.cursor",
      SourceURL: "https://example.test/vimix",
      License: "GPL-3.0",
      Author: "Vince Liuice",
      SHA256: "abc123",
      UUID: "uuid",
      resourceInstalled: true,
    });
    expect(vimixWhite.id).toBe("vimix-white");
    expect(vimixWhite.family).toBe("Vimix");
    expect(vimixWhite.variant).toBe("Vimix Cursors - White");
    expect(vimixWhite.author).toContain("Vince Liuice");
    expect(vimixWhite.sourceUrl).toBe("https://example.test/vimix");
    expect(vimixWhite.sha256).toBe("abc123");
    expect(vimixWhite.uuid).toBe("uuid");
  });

  it("preserves an explicitly named External family for imported themes", () => {
    expect(
      normalizeCursorTheme({
        Identifier: "VimixWhite",
        DisplayName: "Imported Vimix White",
        Group: "External",
        imported: true,
      }).family,
    ).toBe("External");
  });

  it("replaces family placeholders when only named variants are generated", () => {
    const bases = [
      getCursorCatalogEntry("bibata"),
      getCursorCatalogEntry("bibata-extra"),
    ];
    const merged = mergeCursorCatalogWithNativeThemes(bases, [
      {
        Identifier: "BibataModernAmber",
        DisplayName: "Bibata Modern Amber",
        Group: "Bibata",
        Resource: "BibataModernAmber.cursor",
        resourceInstalled: true,
      },
      {
        Identifier: "BibataExtraModernPink",
        DisplayName: "Bibata Extra Modern Pink",
        Group: "Bibata Extra",
        Resource: "BibataExtraModernPink.cursor",
        resourceInstalled: true,
      },
    ]);

    expect(merged.map((entry) => entry.id)).toEqual([
      "bibata-modern-amber",
      "bibata-extra-modern-pink",
    ]);
    expect(merged.some((entry) => entry.variant === "Default")).toBe(false);
  });
});
