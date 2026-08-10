import OREO_CATALOG_MANIFEST from "../../native/oreo/Resources/Themes/catalog.json";

import { CURSOR_DTO_SCHEMA_VERSION } from "./cursor-dto.js";

/**
 * The curated cursor catalogue is deliberately static. The app acquires each
 * selected family's pinned original upstream inputs and runs its source recipe
 * locally; no converted cursor payload is shipped or separately published.
 * Oreo identity comes from the same source catalog consumed by the converter,
 * while this module adds metadata for the remaining upstream families.
 * User imports are not added here: the Electron bridge merges separately
 * validated schema-v2 manifests from the private per-user store at runtime.
 *
 * Every pack has a stable source nativeThemeId, but no cursor payload ships in
 * the app. The Electron bridge exposes only locally converted resources in the
 * private per-user store. Keeping catalog identity stable across source builds
 * and installation prevents selection/status drift.
 */

/**
 * Semantic roles represented by the original Oreo conversion. Generated
 * manifests can provide the complete native role list and replace this
 * fallback at runtime.
 */
export const CURSOR_ROLES = Object.freeze([
  "alias",
  "bd_double_arrow",
  "bottom_left_corner",
  "bottom_right_corner",
  "cell",
  "circle",
  "col-resize",
  "copy",
  "cross",
  "crosshair",
  "default",
  "dnd-move",
  "dotbox",
  "fd_double_arrow",
  "fleur",
  "help",
  "left-arrow",
  "no-drop",
  "not-allowed",
  "openhand",
  "pencil",
  "pointer",
  "progress",
  "right-arrow",
  "right_ptr",
  "row-resize",
  "sb_h_double_arrow",
  "sb_v_double_arrow",
  "size_bdiag",
  "size_fdiag",
  "size_hor",
  "size_ver",
  "text",
  "top_left_corner",
  "top_right_corner",
  "up-arrow",
  "wait",
  "x-cursor",
]);

/** Number of cursor records emitted by the current native converter. */
export const NATIVE_CURSOR_COUNT = 47;
export const NATIVE_CURSOR_ALIAS_COUNT = 77;
export const DEFAULT_CURSOR_NATIVE_THEME_ID =
  OREO_CATALOG_MANIFEST.defaultThemeId;

export function normalizePreviewSource(value) {
  const source =
    typeof value === "string"
      ? value
      : (value?.src ??
        value?.asset ??
        value?.preview ??
        value?.url ??
        value?.dataUrl ??
        value?.previewUrl ??
        value?.assetUrl);

  return typeof source === "string" && source.trim() ? source : null;
}

export function normalizeRolePreviews(value) {
  const entries = Array.isArray(value)
    ? value.map((entry) => ({ entry, roleHint: null }))
    : value && typeof value === "object"
      ? Object.entries(value).map(([roleHint, entry]) => ({
          entry: typeof entry === "string" ? { src: entry } : entry,
          roleHint,
        }))
      : [];

  return entries
    .filter(({ entry }) => entry && typeof entry === "object")
    .map(({ entry, roleHint }) => {
      const role = String(
        roleHint ?? entry.role ?? entry.name ?? entry.macIdentifier ?? "Cursor",
      );
      const hotspotX = Number(entry.hotspot?.x);
      const hotspotY = Number(entry.hotspot?.y);
      return {
        role,
        name: String(entry.name ?? entry.role ?? role),
        ...(entry.macIdentifier
          ? { macIdentifier: String(entry.macIdentifier) }
          : {}),
        src: normalizePreviewSource(entry),
        frameCount: Number.isFinite(Number(entry.frameCount))
          ? Number(entry.frameCount)
          : 1,
        frameDuration: Number.isFinite(Number(entry.frameDuration))
          ? Number(entry.frameDuration)
          : null,
        hotspot:
          Number.isFinite(hotspotX) && Number.isFinite(hotspotY)
            ? { x: hotspotX, y: hotspotY }
            : null,
        fallback: Boolean(entry.fallback),
      };
    });
}

function createEntry({
  id,
  family,
  name,
  variant = name,
  sourceUrl,
  license,
  licenseUrl,
  author,
  accentColor,
  nativeThemeId = null,
  nativeThemeIds = [],
  bundled = Boolean(nativeThemeId),
  resourceFile = nativeThemeId ? `${nativeThemeId}.cursor` : null,
  cursorCount = NATIVE_CURSOR_COUNT,
  cursorCountEstimated = false,
  tags = [],
  upstreamUrl,
}) {
  const nativeIdentifiers = Object.freeze([
    ...new Set([nativeThemeId, ...nativeThemeIds].filter(Boolean)),
  ]);

  return Object.freeze({
    schemaVersion: CURSOR_DTO_SCHEMA_VERSION,
    id,
    family,
    name,
    variant,
    variantLabel: variant,
    displayName: `${family} ${name}`,
    author,
    sourceUrl,
    ...(upstreamUrl ? { upstreamUrl } : {}),
    license,
    ...(licenseUrl ? { licenseUrl } : {}),
    platform: "macOS",
    nativeThemeId,
    nativeThemeIds: nativeIdentifiers,
    resourceFile,
    availability: bundled ? "bundled" : "catalogued",
    resourceAvailable: bundled,
    canApply: bundled,
    status: bundled ? "available" : "unavailable",
    cursorRoles: CURSOR_ROLES,
    cursorRoleCount: CURSOR_ROLES.length,
    cursorCount,
    cursorCountEstimated,
    cursorAliasCount: NATIVE_CURSOR_ALIAS_COUNT,
    accentColor,
    preview: null,
    rolePreviews: Object.freeze([]),
    tags: Object.freeze([...tags]),
  });
}

const OREO_CATALOG = OREO_CATALOG_MANIFEST.themes.map((theme) =>
  createEntry({
    ...theme,
    family: OREO_CATALOG_MANIFEST.family,
    sourceUrl: OREO_CATALOG_MANIFEST.sourceUrl,
    upstreamUrl: OREO_CATALOG_MANIFEST.upstreamUrl,
    license: OREO_CATALOG_MANIFEST.license,
    licenseUrl: OREO_CATALOG_MANIFEST.licenseUrl,
    author: OREO_CATALOG_MANIFEST.author,
    bundled: false,
    tags: ["oreo", theme.category, "on-demand", "macos"],
  }),
);

// The GNOME-Look page tags are inconsistent with the license text embedded
// in the downloaded archives. The upstream ReadMe files explicitly grant
// CC BY-NC-ND 4.0, so use the restrictive license in the catalogue and
// attribution UI rather than inferring broader redistribution rights from a
// page tag.
const GNOME_LOOK_LICENSE = "CC BY-NC-ND 4.0";
const GNOME_LOOK_LICENSE_URL =
  "https://creativecommons.org/licenses/by-nc-nd/4.0/";
const MOYASH_AUTHOR = "Moyash (moyash / moyashos)";

const EXTERNAL_CATALOG = [
  createEntry({
    id: "remus",
    family: "Remus",
    name: "Remus",
    variant: "Default",
    sourceUrl: "https://www.gnome-look.org/p/2355234",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#8b5cf6",
    nativeThemeId: "Remus",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["remus", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "drop",
    family: "Drop",
    name: "Drop",
    variant: "Default",
    sourceUrl: "https://www.gnome-look.org/p/2330173",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#f97316",
    nativeThemeId: "Drop",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["drop", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "moga-classic",
    family: "Moga",
    name: "Classic",
    sourceUrl: "https://www.gnome-look.org/p/2296782",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#3b82f6",
    nativeThemeId: "MogaClassic",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["moga", "classic", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "moga-candy",
    family: "Moga",
    name: "Candy",
    sourceUrl: "https://www.gnome-look.org/p/2299255",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#14b8a6",
    nativeThemeId: "MogaCandy",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["moga", "candy", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "moga-colors",
    family: "Moga",
    name: "Colors",
    sourceUrl: "https://www.gnome-look.org/p/2297654",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#ec4899",
    nativeThemeId: "MogaColors",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["moga", "colors", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "moga-neon",
    family: "Moga",
    name: "Neon",
    sourceUrl: "https://www.gnome-look.org/p/2302110",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#eab308",
    nativeThemeId: "MogaNeon",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["moga", "neon", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "moga-light",
    family: "Moga",
    name: "Light",
    sourceUrl: "https://www.gnome-look.org/p/2364891",
    license: GNOME_LOOK_LICENSE,
    licenseUrl: GNOME_LOOK_LICENSE_URL,
    author: MOYASH_AUTHOR,
    accentColor: "#60a5fa",
    nativeThemeId: "MogaLight",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["moga", "light", "gnome-look", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "volantes",
    family: "Volantes",
    name: "Volantes",
    variant: "Default",
    sourceUrl: "https://github.com/varlesh/volantes-cursors",
    license: "GPL-2.0",
    licenseUrl:
      "https://github.com/varlesh/volantes-cursors/blob/master/LICENSE",
    author: "Alexey Varfolomeev (varlesh)",
    accentColor: "#22c55e",
    nativeThemeId: "Volantes",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["volantes", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "vimix",
    family: "Vimix",
    name: "Vimix",
    variant: "Default",
    sourceUrl: "https://github.com/vinceliuice/Vimix-cursors",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/vinceliuice/Vimix-cursors/blob/master/LICENSE",
    author: "Vince Liuice (vinceliuice)",
    accentColor: "#38bdf8",
    nativeThemeId: "Vimix",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["vimix", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "qogir",
    family: "Qogir",
    name: "Qogir",
    variant: "Default",
    sourceUrl:
      "https://github.com/vinceliuice/Qogir-icon-theme/tree/master/src/cursors",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/vinceliuice/Qogir-icon-theme/blob/master/COPYING",
    author: "Vince Liuice (vinceliuice)",
    accentColor: "#2563eb",
    nativeThemeId: "Qogir",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["qogir", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "bibata-extra",
    family: "Bibata Extra",
    name: "Bibata Extra",
    variant: "Default",
    sourceUrl: "https://github.com/ful1e5/Bibata_Extra_Cursor",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/ful1e5/Bibata_Extra_Cursor/blob/main/LICENSE",
    author: "Abdulkaiz Khatri (ful1e5)",
    accentColor: "#ef4444",
    nativeThemeId: "BibataExtra",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["bibata", "extra", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "google",
    family: "Google",
    name: "Google",
    variant: "Default",
    sourceUrl: "https://github.com/ful1e5/Google_Cursor",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/ful1e5/Google_Cursor/blob/main/LICENSE",
    author: "Abdulkaiz Khatri (ful1e5)",
    accentColor: "#4285f4",
    nativeThemeId: "Google",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["google", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "simp1e",
    family: "Simp1e",
    name: "Simp1e",
    variant: "Default",
    sourceUrl: "https://gitlab.com/cursors/simp1e",
    license: "GPL-3.0",
    licenseUrl: "https://gitlab.com/cursors/simp1e/-/blob/master/LICENSE",
    author: "Ács Zoltán (zoli111)",
    accentColor: "#94a3b8",
    nativeThemeId: "Simp1e",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["simp1e", "gitlab", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "capitaine",
    family: "Capitaine",
    name: "Capitaine",
    variant: "Default",
    sourceUrl: "https://github.com/keeferrourke/capitaine-cursors",
    license: "LGPL-3.0-or-later",
    licenseUrl:
      "https://github.com/keeferrourke/capitaine-cursors/blob/master/COPYING",
    author: "Keefer Rourke and contributors",
    accentColor: "#d97706",
    nativeThemeId: "Capitaine",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["capitaine", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "future",
    family: "Future",
    name: "Future",
    variant: "Default",
    sourceUrl: "https://github.com/yeyushengfan258/Future-cursors",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/yeyushengfan258/Future-cursors/blob/master/LICENSE",
    author: "Yeyu Shengfan (yeyushengfan258)",
    accentColor: "#64748b",
    nativeThemeId: "Future",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["future", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "future-cyan",
    family: "Future",
    name: "Cyan",
    variant: "Cyan",
    sourceUrl:
      "https://github.com/yeyushengfan258/Future-cursors/tree/master/src/svg-cyan",
    upstreamUrl: "https://github.com/yeyushengfan258/Future-cursors",
    license: "GPL-3.0-only",
    licenseUrl:
      "https://github.com/yeyushengfan258/Future-cursors/blob/master/LICENSE",
    author: "Yeyu Shengfan (yeyushengfan258)",
    accentColor: "#23afc8",
    nativeThemeId: "FutureCyan",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["future", "cyan", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "nordzy",
    family: "Nordzy",
    name: "Nordzy",
    variant: "Default",
    sourceUrl: "https://github.com/guillaumeboehm/Nordzy-cursors",
    upstreamUrl: "https://github.com/guillaumeboehm/Nordzy-cursors",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/guillaumeboehm/Nordzy-cursors/blob/main/COPYING",
    author: "Guillaume Boehm (gboehm)",
    accentColor: "#81a1c1",
    nativeThemeId: "Nordzy",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["nordzy", "nord", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "colloid",
    family: "Colloid",
    name: "Colloid",
    variant: "Default",
    sourceUrl:
      "https://github.com/vinceliuice/Colloid-icon-theme/tree/main/cursors",
    license: "GPL-3.0",
    licenseUrl:
      "https://github.com/vinceliuice/Colloid-icon-theme/blob/main/LICENSE",
    author: "Vince Liuice (vinceliuice)",
    accentColor: "#a855f7",
    nativeThemeId: "Colloid",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["colloid", "github", "xcursor", "catalogued"],
  }),
  createEntry({
    id: "bibata",
    family: "Bibata",
    name: "Bibata",
    variant: "Default",
    sourceUrl: "https://github.com/ful1e5/Bibata_Cursor",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/ful1e5/Bibata_Cursor/blob/master/LICENSE",
    author: "Abdulkaiz Khatri (ful1e5)",
    accentColor: "#f59e0b",
    nativeThemeId: "Bibata",
    bundled: false,
    cursorCountEstimated: true,
    tags: ["bibata", "github", "xcursor", "catalogued"],
  }),
];

/** All 19 bundled Oreo variants followed by the requested upstream packs. */
export const CURSOR_CATALOG = Object.freeze([
  ...OREO_CATALOG,
  ...EXTERNAL_CATALOG,
]);

/**
 * Native identifiers are intentionally exported separately from the display
 * catalogue.  The native converter owns the manifest and can add a variant
 * without requiring a renderer release; this map lets both sides resolve the
 * stable ID when that happens.
 */
export const CURSOR_NATIVE_THEME_IDS = Object.freeze(
  CURSOR_CATALOG.flatMap((entry) => entry.nativeThemeIds ?? [])
    .filter(Boolean)
    .filter(
      (identifier, index, identifiers) =>
        identifiers.indexOf(identifier) === index,
    ),
);

function firstThemeValue(theme, keys) {
  for (const key of keys) {
    const value = theme?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function slugifyThemeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase();
}

function themeBoolean(theme, keys) {
  const value = firstThemeValue(theme, keys);
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return !["", "0", "false", "no", "off"].includes(
      value.trim().toLocaleLowerCase(),
    );
  }
  return Boolean(value);
}

/**
 * Normalize the converter/native manifest shape into renderer metadata.
 *
 * The Objective-C CLI historically emitted capitalized keys (Identifier,
 * ThemeName, Group), while the build manifest uses the same names.  Accepting
 * both forms here keeps the renderer independent of which native executable
 * produced the response and makes fixture-driven tests straightforward.
 */
export function normalizeCursorTheme(theme = {}, catalog = CURSOR_CATALOG) {
  if (!theme || typeof theme !== "object") {
    return null;
  }

  const nativeThemeId = firstThemeValue(theme, [
    "nativeThemeId",
    "identifier",
    "Identifier",
    "nativeId",
    "NativeID",
    "themeIdentifier",
    "ThemeIdentifier",
    "id",
    "ID",
  ]);
  if (!nativeThemeId) {
    return null;
  }

  const normalizedNativeId = String(nativeThemeId);
  const requestedId = firstThemeValue(theme, [
    "catalogId",
    "catalogID",
    "packId",
    "packID",
    "slug",
    "id",
    "ID",
  ]);
  const directBase =
    getCursorCatalogEntry(requestedId, catalog) ??
    getCursorCatalogEntry(normalizedNativeId, catalog);
  const inferredBase =
    directBase ??
    [...catalog]
      .filter(
        (entry) =>
          entry.nativeThemeId &&
          normalizedNativeId.startsWith(entry.nativeThemeId),
      )
      .sort(
        (left, right) =>
          String(right.nativeThemeId).length -
          String(left.nativeThemeId).length,
      )[0] ??
    null;
  const base = directBase ?? inferredBase;
  const id =
    directBase?.id ?? String(requestedId ?? slugifyThemeId(normalizedNativeId));
  const explicitFamily = firstThemeValue(theme, [
    "family",
    "Family",
    "Group",
    "group",
  ]);
  const imported = theme.imported === true;
  const family = String(
    (explicitFamily && (explicitFamily !== "External" || imported)
      ? explicitFamily
      : (base?.family ?? explicitFamily)) ?? "Cursor pack",
  );
  const displayName = String(
    firstThemeValue(theme, [
      "displayName",
      "DisplayName",
      "ThemeName",
      "themeName",
      "name",
      "Name",
    ]) ??
      base?.displayName ??
      normalizedNativeId,
  );
  const explicitVariant = firstThemeValue(theme, ["variant", "Variant"]);
  const variant = String(
    explicitVariant ?? (directBase ? base?.variant : displayName),
  );
  const resourceFile = firstThemeValue(theme, [
    "resourceFile",
    "Resource",
    "resource",
    "filename",
    "fileName",
    "file",
  ]);
  const resourceAvailable =
    themeBoolean(theme, [
      "resourceAvailable",
      "resourceInstalled",
      "installed",
      "hasResource",
    ]) ?? themeBoolean(theme, ["available", "isAvailable"]);
  const canApply =
    themeBoolean(theme, ["canApply", "applyCapable", "applyable"]) ??
    resourceAvailable ??
    base?.canApply ??
    false;
  const available = resourceAvailable ?? base?.resourceAvailable ?? false;
  const status = String(
    firstThemeValue(theme, ["status", "Status"]) ??
      (available ? "available" : "unavailable"),
  );
  const rolePreviews = normalizeRolePreviews(
    firstThemeValue(theme, [
      "rolePreviews",
      "RolePreviews",
      "cursorPreviews",
      "CursorPreviews",
    ]) ?? base?.rolePreviews,
  );
  const cursorRoles =
    (rolePreviews.length ? rolePreviews : null) ??
    firstThemeValue(theme, ["cursorRoles", "roles", "Roles"]) ??
    base?.cursorRoles ??
    CURSOR_ROLES;
  const preview =
    normalizePreviewSource(
      firstThemeValue(theme, [
        "preview",
        "Preview",
        "arrowPreview",
        "ArrowPreview",
        "previewUrl",
        "PreviewURL",
      ]),
    ) ??
    rolePreviews.find(
      (role) =>
        role.role === "default" ||
        role.role === "arrow" ||
        role.macIdentifier === "com.apple.coregraphics.Arrow",
    )?.src ??
    normalizePreviewSource(base?.preview);
  const nativeThemeIds = [
    ...(Array.isArray(theme.nativeThemeIds) ? theme.nativeThemeIds : []),
    normalizedNativeId,
  ].filter(Boolean);
  const sourceUrl =
    firstThemeValue(theme, ["sourceUrl", "SourceURL", "SourceUrl", "Source"]) ??
    base?.sourceUrl ??
    "";
  const license =
    firstThemeValue(theme, ["license", "License"]) ?? base?.license ?? "";
  const licenseUrl =
    firstThemeValue(theme, ["licenseUrl", "LicenseURL", "LicenseUrl"]) ??
    base?.licenseUrl ??
    "";
  const author =
    firstThemeValue(theme, ["author", "Author", "creator", "Creator"]) ??
    base?.author ??
    "";
  const sha256 = firstThemeValue(theme, ["sha256", "SHA256", "hash"]);
  const uuid = firstThemeValue(theme, ["uuid", "UUID"]);
  const curatedFamilyIdValue = firstThemeValue(theme, [
    "curatedFamilyId",
    "CuratedFamilyId",
  ]);
  const sourceFormatValue = firstThemeValue(theme, [
    "sourceFormat",
    "SourceFormat",
  ]);
  const curatedCatalogSha256Value = firstThemeValue(theme, [
    "curatedCatalogSha256",
    "CuratedCatalogSHA256",
  ]);
  const curatedFamilyId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
    String(curatedFamilyIdValue ?? ""),
  )
    ? String(curatedFamilyIdValue)
    : null;
  const sourceFormat =
    sourceFormatValue === "curated-source" ? sourceFormatValue : null;
  const curatedCatalogSha256 = /^[a-f0-9]{64}$/.test(
    String(curatedCatalogSha256Value ?? ""),
  )
    ? String(curatedCatalogSha256Value)
    : null;

  return {
    schemaVersion: CURSOR_DTO_SCHEMA_VERSION,
    ...(base ?? {
      id,
      family,
      name: variant,
      variant,
      variantLabel: variant,
      displayName,
      author: String(firstThemeValue(theme, ["author", "Author"]) ?? ""),
      sourceUrl: String(
        firstThemeValue(theme, ["sourceUrl", "SourceURL", "SourceUrl"]) ?? "",
      ),
      license: String(firstThemeValue(theme, ["license", "License"]) ?? ""),
      platform: "macOS",
      cursorRoles: CURSOR_ROLES,
      cursorRoleCount: CURSOR_ROLES.length,
      cursorCount: NATIVE_CURSOR_COUNT,
      cursorCountEstimated: true,
      cursorAliasCount: NATIVE_CURSOR_ALIAS_COUNT,
      accentColor: "#64748b",
      resourceAvailable: false,
      preview: null,
      rolePreviews: Object.freeze([]),
      tags: Object.freeze(["generated", "macos"]),
    }),
    id,
    family,
    sourceUrl,
    license,
    licenseUrl,
    author,
    ...(sha256 ? { sha256 } : {}),
    ...(uuid ? { uuid } : {}),
    ...(curatedFamilyId ? { curatedFamilyId } : {}),
    ...(sourceFormat ? { sourceFormat } : {}),
    ...(curatedCatalogSha256 ? { curatedCatalogSha256 } : {}),
    name: String(
      firstThemeValue(theme, ["name", "Name"]) ?? base?.name ?? variant,
    ),
    variant,
    variantLabel: variant,
    displayName,
    nativeThemeId: normalizedNativeId,
    nativeThemeIds: Object.freeze([...new Set(nativeThemeIds)]),
    resourceFile: resourceFile ?? base?.resourceFile ?? null,
    resourceAvailable: Boolean(available),
    canApply: Boolean(canApply),
    availability: available ? "bundled" : "catalogued",
    status,
    preview,
    rolePreviews,
    cursorRoles: Array.isArray(cursorRoles) ? cursorRoles : CURSOR_ROLES,
    cursorCount: Number(
      firstThemeValue(theme, [
        "cursorCount",
        "CursorCount",
        "roleCount",
        "RoleCount",
      ]) ??
        (rolePreviews.length || null) ??
        base?.cursorCount ??
        NATIVE_CURSOR_COUNT,
    ),
    cursorCountEstimated: rolePreviews.length
      ? false
      : Boolean(base?.cursorCountEstimated),
  };
}

/**
 * Merge native manifest/list output into the static renderer catalogue.
 *
 * Existing rows retain attribution and previews from the checked-in
 * catalogue, while resource/checksum/availability details come from the
 * validated native manifest. Unknown generated variants are appended so a
 * native pack can ship a new variant without a renderer-only code change.
 */
export function mergeCursorCatalogWithNativeThemes(
  catalog = CURSOR_CATALOG,
  nativeThemes = [],
) {
  if (!Array.isArray(nativeThemes) || nativeThemes.length === 0) {
    return [...catalog];
  }

  const normalizedThemes = nativeThemes
    .map((rawTheme) => normalizeCursorTheme(rawTheme, catalog))
    .filter(Boolean);
  const merged = new Map(catalog.map((entry) => [entry.id, entry]));
  for (const normalized of normalizedThemes) {
    const existing = merged.get(normalized.id);
    merged.set(
      normalized.id,
      existing
        ? {
            ...existing,
            ...normalized,
            // A manifest should not erase curated attribution with an empty
            // optional value.
            author: normalized.author || existing.author,
            sourceUrl: normalized.sourceUrl || existing.sourceUrl,
            license: normalized.license || existing.license,
            licenseUrl: normalized.licenseUrl || existing.licenseUrl,
            preview: normalized.preview ?? existing.preview,
            tags: Object.freeze([
              ...new Set([
                ...(existing.tags ?? []),
                ...(normalized.tags ?? []),
              ]),
            ]),
          }
        : normalized,
    );
  }

  const representedIds = new Set(normalizedThemes.map((theme) => theme.id));
  for (const entry of catalog) {
    if (
      entry.availability !== "catalogued" ||
      representedIds.has(entry.id) ||
      !entry.nativeThemeId
    ) {
      continue;
    }
    const ownsGeneratedVariant = normalizedThemes.some((theme) => {
      if (!theme.nativeThemeId.startsWith(entry.nativeThemeId)) {
        return false;
      }
      const closestOwner = catalog
        .filter(
          (candidate) =>
            candidate.nativeThemeId &&
            theme.nativeThemeId.startsWith(candidate.nativeThemeId),
        )
        .sort(
          (left, right) =>
            right.nativeThemeId.length - left.nativeThemeId.length,
        )[0];
      return closestOwner?.id === entry.id;
    });
    if (ownsGeneratedVariant) {
      merged.delete(entry.id);
    }
  }
  return [...merged.values()];
}

function normalizeSearchQuery(query) {
  return String(query ?? "")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Return entries matching every whitespace-separated search term.  Search is
 * intentionally pure and searches metadata (including author, license,
 * source, tags, and cursor roles), not just the visible title.
 */
export function filterCursorCatalog(catalog = CURSOR_CATALOG, query = "") {
  // Also accept filterCursorCatalog(query) for callers that use the bundled
  // catalogue implicitly.
  if (!Array.isArray(catalog)) {
    query = catalog;
    catalog = CURSOR_CATALOG;
  }

  const normalizedQuery = normalizeSearchQuery(query);

  if (!normalizedQuery) {
    return [...catalog];
  }

  const terms = normalizedQuery.split(/\s+/);

  return catalog.filter((entry) => {
    const haystack = [
      entry.id,
      entry.family,
      entry.name,
      entry.variant,
      entry.author,
      entry.license,
      entry.sourceUrl,
      entry.nativeThemeId,
      ...(entry.nativeThemeIds ?? []),
      ...(entry.tags ?? []),
      ...(entry.cursorRoles ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function getCursorCatalogEntry(id, catalog = CURSOR_CATALOG) {
  const normalized = String(id ?? "");
  return (
    catalog.find(
      (entry) =>
        entry.id === id ||
        entry.nativeThemeId === id ||
        (entry.nativeThemeIds ?? []).includes(id) ||
        entry.id.toLocaleLowerCase() === normalized.toLocaleLowerCase() ||
        (entry.nativeThemeIds ?? []).some(
          (nativeId) =>
            String(nativeId).toLocaleLowerCase() ===
            normalized.toLocaleLowerCase(),
        ),
    ) ?? null
  );
}

export function groupCursorCatalog(catalog = CURSOR_CATALOG) {
  return catalog.reduce((groups, entry) => {
    const familyEntries = groups.get(entry.family) ?? [];
    familyEntries.push(entry);
    groups.set(entry.family, familyEntries);
    return groups;
  }, new Map());
}

export const CURSOR_CATALOG_COUNTS = Object.freeze({
  total: CURSOR_CATALOG.length,
  bundled: OREO_CATALOG.length,
  catalogueOnly: EXTERNAL_CATALOG.length,
  families: new Set(CURSOR_CATALOG.map((entry) => entry.family)).size,
});
