import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import {
  CURSOR_CATALOG,
  getCursorCatalogEntry,
  normalizeCursorTheme,
} from "../lib/cursor-catalog.js";
import {
  assignImportedCursorFamily,
  isBoundedCursorManifestText,
  normalizeImportedCursorFamily,
  removeImportedCursorArtifacts,
} from "./cursor-import-install.js";

const execFileAsync = promisify(execFile);
const MAX_NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;
const PACKAGED_NATIVE_APP = "Oreo Cursor.app";
const PACKAGED_LOGIN_HELPER_APP = "Oreo Cursor Login Helper.app";
const NATIVE_APP_BUNDLE_ID = "com.cursoratelier.CursorAtelier.NativeCursor";
const NATIVE_HELPER_BUNDLE_ID =
  "com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper";
const PREVIEW_SCHEME = "cursor-preview";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAFE_RESOURCE_PATTERN = /^[A-Za-z0-9._-]{7,192}$/;
const SAFE_PATH_COMPONENT_PATTERN = /^[A-Za-z0-9._-]{1,192}$/;
// Keep the shared artifact boundary in lockstep with OreoCursorEngine.m.
const MAX_IMPORTED_DIRECTORY_ENTRIES = 512;
const MAX_IMPORTED_PACKS = 256;
const MAX_IMPORTED_THEMES_PER_PACK = 64;
const MAX_IMPORTED_THEMES = 512;
const MAX_IMPORTED_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IMPORTED_CURSOR_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTED_PACK_CURSOR_BYTES = 128 * 1024 * 1024;
const MAX_IMPORTED_CURSOR_BYTES_TOTAL = 512 * 1024 * 1024;
const MAX_IMPORTED_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_IMPORTED_ROLE_PREVIEWS = 128;
const DEFAULT_THEME_SIZE_PERCENTAGE = 100;
const MIN_THEME_SIZE_PERCENTAGE = 50;
const MAX_THEME_SIZE_PERCENTAGE = 200;

function isSafeIdentifier(value) {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value) &&
    /^[A-Za-z0-9]/.test(value)
  );
}

function normalizedThemeSizePercentage(value, fallback = null) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_THEME_SIZE_PERCENTAGE &&
    value <= MAX_THEME_SIZE_PERCENTAGE
    ? value
    : fallback;
}

function isSafeResourceName(value) {
  return (
    typeof value === "string" &&
    SAFE_RESOURCE_PATTERN.test(value) &&
    path.extname(value).toLowerCase() === ".cursor"
  );
}

const COMMAND_TIMEOUTS = Object.freeze({
  "--status": 8_000,
  "--list-themes": 12_000,
  "--reconcile-login-items": 30_000,
  "--open-login-settings": 8_000,
  "--validate-theme": 45_000,
  "--validate-themes": 90_000,
  "--apply-theme": 45_000,
  "--set-theme-size": 12_000,
  "--forget-theme-size": 12_000,
  "--select-theme": 45_000,
  "--disable": 45_000,
  "--setup": 45_000,
  "--teardown": 45_000,
});

const BASE_NATIVE_TO_CATALOG_ID = new Map();
const BASE_CATALOG_TO_NATIVE_ID = new Map();
for (const entry of CURSOR_CATALOG) {
  for (const nativeId of entry.nativeThemeIds ?? []) {
    BASE_NATIVE_TO_CATALOG_ID.set(String(nativeId), entry.id);
    BASE_NATIVE_TO_CATALOG_ID.set(String(nativeId).toLowerCase(), entry.id);
  }
  if (entry.nativeThemeId) {
    BASE_CATALOG_TO_NATIVE_ID.set(entry.id, entry.nativeThemeId);
    BASE_CATALOG_TO_NATIVE_ID.set(entry.id.toLowerCase(), entry.nativeThemeId);
  }
}

function firstThemeValue(theme, keys) {
  for (const key of keys) {
    const value = theme?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function firstBoolean(object, keys, fallback = false) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "boolean") {
      return value;
    }
    // Objective-C NSNumber values produced from BOOLs are not guaranteed to
    // retain a JSON boolean type across every CLI construction path.
    if (value === 0 || value === 1) {
      return Boolean(value);
    }
  }
  return fallback;
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function packagedNativeAppPath(resourcesPath) {
  return path.join(resourcesPath, PACKAGED_NATIVE_APP);
}

function packagedBridgePath(resourcesPath) {
  return path.join(
    packagedNativeAppPath(resourcesPath),
    "Contents",
    "MacOS",
    "OreoCursor",
  );
}

function packagedManifestPath(resourcesPath) {
  return path.join(
    packagedNativeAppPath(resourcesPath),
    "Contents",
    "Resources",
    "Themes",
    "manifest.json",
  );
}

function plistValue(plistPath, key) {
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plistPath],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
  } catch {
    return null;
  }
}

function signatureDetails(appPath) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=2", appPath],
    { encoding: "utf8", timeout: 10_000 },
  );
  return result.status === 0 ? String(result.stderr) : null;
}

function signatureTeamIdentifier(details) {
  return details?.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1] ?? null;
}

function verifyPackagedNativeApp(resourcesPath, bridgePath) {
  let canonicalResources;
  let expectedBridge;
  let canonicalBridge;
  let nativeApp;
  let loginHelperApp;
  try {
    canonicalResources = fs.realpathSync(resourcesPath);
    expectedBridge = fs.realpathSync(packagedBridgePath(resourcesPath));
    canonicalBridge = fs.realpathSync(bridgePath);
    nativeApp = fs.realpathSync(packagedNativeAppPath(resourcesPath));
    loginHelperApp = fs.realpathSync(
      path.join(
        nativeApp,
        "Contents",
        "Library",
        "LoginItems",
        PACKAGED_LOGIN_HELPER_APP,
      ),
    );
  } catch {
    return false;
  }
  if (
    canonicalBridge !== expectedBridge ||
    !isPathWithin(canonicalResources, nativeApp) ||
    !isPathWithin(nativeApp, loginHelperApp) ||
    !isExecutableFile(canonicalBridge)
  ) {
    return false;
  }
  try {
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", nativeApp],
      { stdio: "ignore", timeout: 10_000 },
    );
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", loginHelperApp],
      { stdio: "ignore", timeout: 10_000 },
    );
    const nativeDetails = signatureDetails(nativeApp);
    const helperDetails = signatureDetails(loginHelperApp);
    const nativeTeamIdentifier = signatureTeamIdentifier(nativeDetails);
    const helperTeamIdentifier = signatureTeamIdentifier(helperDetails);
    return (
      plistValue(
        path.join(nativeApp, "Contents", "Info.plist"),
        "CFBundleIdentifier",
      ) === NATIVE_APP_BUNDLE_ID &&
      plistValue(
        path.join(loginHelperApp, "Contents", "Info.plist"),
        "CFBundleIdentifier",
      ) === NATIVE_HELPER_BUNDLE_ID &&
      nativeDetails?.includes(`Identifier=${NATIVE_APP_BUNDLE_ID}`) &&
      helperDetails?.includes(`Identifier=${NATIVE_HELPER_BUNDLE_ID}`) &&
      nativeTeamIdentifier !== null &&
      nativeTeamIdentifier === helperTeamIdentifier
    );
  } catch {
    return false;
  }
}

function getDevelopmentBridgeCandidates(appPath) {
  const candidates = [];
  if (process.env.CURSOR_NATIVE_BRIDGE) {
    candidates.push(path.resolve(process.env.CURSOR_NATIVE_BRIDGE));
  }
  candidates.push(
    path.join(
      appPath,
      "native",
      "oreo",
      "build",
      "Release",
      PACKAGED_NATIVE_APP,
      "Contents",
      "MacOS",
      "OreoCursor",
    ),
  );
  return [...new Set(candidates)];
}

function resolveNativeBridge({
  isPackaged,
  resourcesPath,
  appPath,
  verifySignature,
}) {
  if (process.platform !== "darwin") {
    return null;
  }

  if (isPackaged) {
    const candidate = packagedBridgePath(resourcesPath);
    if (!isExecutableFile(candidate)) {
      return null;
    }
    return !verifySignature || verifyPackagedNativeApp(resourcesPath, candidate)
      ? candidate
      : null;
  }

  return getDevelopmentBridgeCandidates(appPath).find(isExecutableFile) ?? null;
}

function getDevelopmentManifestCandidates(appPath, bridgePath) {
  const candidates = [];
  if (process.env.CURSOR_PACK_MANIFEST) {
    candidates.push(path.resolve(process.env.CURSOR_PACK_MANIFEST));
  }
  if (bridgePath) {
    candidates.push(
      path.resolve(
        path.dirname(bridgePath),
        "..",
        "Resources",
        "Themes",
        "manifest.json",
      ),
    );
  }
  // A bridge must use the manifest staged beside that exact executable. The
  // generated source manifest intentionally has no bundled Oreo resources and
  // is suitable only for preview mode when no native bridge was discovered.
  candidates.push(
    path.join(appPath, "native", "cursor-packs", "generated", "manifest.json"),
  );
  return [...new Set(candidates)];
}

function readManifestFile(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const themes =
      parsed?.themes ?? parsed?.Themes ?? parsed?.packs ?? parsed?.Packs;
    if (!Array.isArray(themes)) {
      return null;
    }
    return {
      path: path.resolve(manifestPath),
      root: path.dirname(path.resolve(manifestPath)),
      schemaVersion: parsed.schemaVersion ?? parsed.SchemaVersion ?? null,
      themes,
    };
  } catch {
    return null;
  }
}

function findManifest({
  manifestPath,
  isPackaged,
  resourcesPath,
  appPath,
  bridgePath,
}) {
  const readPackagedManifest = (candidate) => {
    try {
      const canonicalResources = fs.realpathSync(resourcesPath);
      const canonicalManifest = fs.realpathSync(candidate);
      if (!isPathWithin(canonicalResources, canonicalManifest)) {
        return null;
      }
      return readManifestFile(canonicalManifest);
    } catch {
      return null;
    }
  };
  if (manifestPath) {
    const explicit = path.resolve(manifestPath);
    if (
      isPackaged &&
      explicit !== path.resolve(packagedManifestPath(resourcesPath))
    ) {
      return null;
    }
    return isPackaged
      ? readPackagedManifest(explicit)
      : readManifestFile(explicit);
  }

  if (isPackaged) {
    return readPackagedManifest(packagedManifestPath(resourcesPath));
  }

  for (const candidate of getDevelopmentManifestCandidates(
    appPath,
    bridgePath,
  )) {
    const manifest = readManifestFile(candidate);
    if (manifest) {
      return manifest;
    }
  }
  return null;
}

function safeManifestFile(manifest, relativePath, extensions) {
  if (!manifest?.root || typeof relativePath !== "string") {
    return null;
  }
  const trimmed = relativePath.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes("\0")) {
    return null;
  }
  try {
    const canonicalRoot = fs.realpathSync(manifest.root);
    const resolved = path.resolve(canonicalRoot, trimmed);
    const canonicalFile = fs.realpathSync(resolved);
    if (!isPathWithin(canonicalRoot, canonicalFile)) {
      return null;
    }
    if (
      extensions &&
      !extensions.has(path.extname(canonicalFile).toLowerCase())
    ) {
      return null;
    }
    return fs.statSync(canonicalFile).isFile() ? canonicalFile : null;
  } catch {
    return null;
  }
}

function isPrivateImportedEntry(stat, { file = false } = {}) {
  return (
    (typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
    (stat.mode & 0o077) === 0 &&
    (!file || stat.nlink === 1)
  );
}

function safeImportedFile(
  manifest,
  relativePath,
  { extensions, maxBytes, direct = false, preview = false },
) {
  if (!manifest?.root || typeof relativePath !== "string") {
    return null;
  }
  const trimmed = relativePath.trim();
  if (
    !trimmed ||
    trimmed !== relativePath ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    path.isAbsolute(trimmed)
  ) {
    return null;
  }
  const components = trimmed.split("/");
  if (
    components.some(
      (component) =>
        !SAFE_PATH_COMPONENT_PATTERN.test(component) ||
        component === "." ||
        component === "..",
    ) ||
    (direct && components.length !== 1) ||
    (preview && (components.length < 2 || components[0] !== "previews"))
  ) {
    return null;
  }

  try {
    const canonicalRoot = fs.realpathSync(manifest.root);
    const rootStat = fs.lstatSync(canonicalRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !isPrivateImportedEntry(rootStat)
    ) {
      return null;
    }
    let candidate = canonicalRoot;
    for (const [index, component] of components.entries()) {
      candidate = path.join(candidate, component);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        return null;
      }
      const isLast = index === components.length - 1;
      if (
        (isLast &&
          (!stat.isFile() || !isPrivateImportedEntry(stat, { file: true }))) ||
        (!isLast && (!stat.isDirectory() || !isPrivateImportedEntry(stat)))
      ) {
        return null;
      }
    }
    const canonicalFile = fs.realpathSync(candidate);
    const stat = fs.statSync(canonicalFile);
    if (
      !isPathWithin(canonicalRoot, canonicalFile) ||
      !stat.isFile() ||
      !isPrivateImportedEntry(stat, { file: true }) ||
      stat.size <= 0 ||
      stat.size > maxBytes ||
      (extensions && !extensions.has(path.extname(canonicalFile).toLowerCase()))
    ) {
      return null;
    }
    return canonicalFile;
  } catch {
    return null;
  }
}

function sha256File(filePath, prefix = null) {
  const hash = crypto.createHash("sha256");
  if (prefix !== null) {
    hash.update(prefix);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function hasPngSignature(filePath) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const signature = Buffer.alloc(PNG_SIGNATURE.length);
  try {
    return (
      fs.readSync(descriptor, signature, 0, signature.length, 0) ===
        signature.length && signature.equals(PNG_SIGNATURE)
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateImportedManifestTheme(manifest, rawTheme) {
  if (!rawTheme || typeof rawTheme !== "object" || Array.isArray(rawTheme)) {
    return null;
  }
  const normalized = normalizeCursorTheme(
    { ...rawTheme, imported: true },
    CURSOR_CATALOG,
  );
  if (
    !normalized ||
    rawTheme.Identifier !== normalized.nativeThemeId ||
    !isSafeIdentifier(normalized.nativeThemeId) ||
    !isSafeIdentifier(normalized.id) ||
    !isBoundedCursorManifestText(rawTheme.DisplayName, 256) ||
    !isBoundedCursorManifestText(rawTheme.ThemeName, 256) ||
    !isBoundedCursorManifestText(rawTheme.Group, 128) ||
    typeof rawTheme.UUID !== "string" ||
    !UUID_PATTERN.test(rawTheme.UUID)
  ) {
    return null;
  }

  const resourceFile = rawTheme.Resource;
  if (!isSafeResourceName(resourceFile)) {
    return null;
  }
  const resourcePath = safeImportedFile(manifest, resourceFile, {
    extensions: new Set([".cursor"]),
    maxBytes: MAX_IMPORTED_CURSOR_BYTES,
    direct: true,
  });
  const expectedHash = rawTheme.SHA256;
  if (
    !resourcePath ||
    typeof expectedHash !== "string" ||
    !SHA256_PATTERN.test(expectedHash) ||
    sha256File(resourcePath) !== expectedHash.toLowerCase()
  ) {
    return null;
  }

  const preview = firstThemeValue(rawTheme, [
    "preview",
    "Preview",
    "arrowPreview",
    "ArrowPreview",
  ]);
  const rolePreviews = firstThemeValue(rawTheme, [
    "rolePreviews",
    "RolePreviews",
    "cursorPreviews",
    "CursorPreviews",
  ]);
  if (
    typeof preview !== "string" ||
    !Array.isArray(rolePreviews) ||
    rolePreviews.length === 0 ||
    rolePreviews.length > MAX_IMPORTED_ROLE_PREVIEWS
  ) {
    return null;
  }
  const previewSources = [
    preview,
    ...rolePreviews.map((role) =>
      firstThemeValue(role, ["src", "asset", "preview"]),
    ),
  ];
  for (const source of previewSources) {
    const previewPath = safeImportedFile(manifest, source, {
      extensions: new Set([".png"]),
      maxBytes: MAX_IMPORTED_PREVIEW_BYTES,
      preview: true,
    });
    if (!previewPath || !hasPngSignature(previewPath)) {
      return null;
    }
  }
  return {
    nativeThemeId: normalized.nativeThemeId,
    catalogId: normalized.id,
    resourceFile,
    resourceBytes: fs.statSync(resourcePath).size,
  };
}

function readImportedManifest(packRoot) {
  const manifestPath = path.join(packRoot, "manifest.json");
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      !isPrivateImportedEntry(manifestStat, { file: true }) ||
      manifestStat.size <= 0 ||
      manifestStat.size > MAX_IMPORTED_MANIFEST_BYTES
    ) {
      return null;
    }
    const canonicalPackRoot = fs.realpathSync(packRoot);
    const canonicalManifest = fs.realpathSync(manifestPath);
    if (!isPathWithin(canonicalPackRoot, canonicalManifest)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(canonicalManifest, "utf8"));
    if (
      parsed?.schemaVersion !== 2 ||
      !Array.isArray(parsed.themes) ||
      parsed.themes.length === 0 ||
      parsed.themes.length > MAX_IMPORTED_THEMES_PER_PACK
    ) {
      return null;
    }
    const manifest = {
      path: canonicalManifest,
      root: canonicalPackRoot,
      packIdentifier: path.basename(canonicalPackRoot),
      schemaVersion: 2,
      imported: true,
      themes: parsed.themes,
    };
    const validatedThemes = parsed.themes.map((theme) =>
      validateImportedManifestTheme(manifest, theme),
    );
    if (validatedThemes.some((theme) => !theme)) {
      return null;
    }
    const nativeIds = new Set();
    const catalogIds = new Set();
    const resourceFiles = new Set();
    let resourceBytes = 0;
    for (const theme of validatedThemes) {
      const nativeId = theme.nativeThemeId.toLowerCase();
      const catalogId = theme.catalogId.toLowerCase();
      const resourceFile = theme.resourceFile.toLowerCase();
      if (
        nativeIds.has(nativeId) ||
        catalogIds.has(catalogId) ||
        resourceFiles.has(resourceFile) ||
        resourceBytes > MAX_IMPORTED_PACK_CURSOR_BYTES - theme.resourceBytes
      ) {
        return null;
      }
      nativeIds.add(nativeId);
      catalogIds.add(catalogId);
      resourceFiles.add(resourceFile);
      resourceBytes += theme.resourceBytes;
    }
    manifest.resourceBytes = resourceBytes;
    return manifest;
  } catch {
    return null;
  }
}

function scanImportedManifests(importedPacksRoot) {
  if (
    typeof importedPacksRoot !== "string" ||
    !path.isAbsolute(importedPacksRoot)
  ) {
    return [];
  }
  try {
    const rootStat = fs.lstatSync(importedPacksRoot);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      !isPrivateImportedEntry(rootStat)
    ) {
      return [];
    }
    const canonicalRoot = fs.realpathSync(importedPacksRoot);
    const packRoots = [];
    const entries = fs.readdirSync(canonicalRoot, {
      withFileTypes: true,
    });
    if (entries.length > MAX_IMPORTED_DIRECTORY_ENTRIES) {
      return [];
    }
    for (const entry of entries) {
      if (!isSafeIdentifier(entry.name) || !entry.isDirectory()) {
        continue;
      }
      const packRoot = path.join(canonicalRoot, entry.name);
      const packStat = fs.lstatSync(packRoot);
      if (
        packStat.isSymbolicLink() ||
        !packStat.isDirectory() ||
        !isPrivateImportedEntry(packStat)
      ) {
        continue;
      }
      try {
        const manifestStat = fs.lstatSync(path.join(packRoot, "manifest.json"));
        if (!manifestStat.isSymbolicLink() && manifestStat.isFile()) {
          packRoots.push(packRoot);
        }
      } catch {
        // Non-pack directories are ignored.
      }
    }
    if (packRoots.length > MAX_IMPORTED_PACKS) {
      return [];
    }

    const manifests = [];
    let themeCount = 0;
    let resourceBytes = 0;
    for (const packRoot of packRoots.sort((left, right) =>
      left === right ? 0 : left < right ? -1 : 1,
    )) {
      const manifest = readImportedManifest(packRoot);
      if (!manifest) {
        continue;
      }
      themeCount += manifest.themes.length;
      if (
        themeCount > MAX_IMPORTED_THEMES ||
        resourceBytes > MAX_IMPORTED_CURSOR_BYTES_TOTAL - manifest.resourceBytes
      ) {
        return [];
      }
      resourceBytes += manifest.resourceBytes;
      manifests.push(manifest);
    }
    return manifests;
  } catch {
    return [];
  }
}

function hasResource(manifest, theme, resourceFile) {
  const explicit = firstThemeValue(theme, [
    "resourceAvailable",
    "resourceInstalled",
    "installed",
    "hasResource",
  ]);
  if (explicit !== null && !explicit) {
    return false;
  }
  if (manifest.imported) {
    const resourcePath = safeImportedFile(manifest, resourceFile, {
      extensions: new Set([".cursor"]),
      maxBytes: MAX_IMPORTED_CURSOR_BYTES,
      direct: true,
    });
    const expectedHash = firstThemeValue(theme, ["SHA256", "sha256"]);
    return Boolean(
      resourcePath &&
      typeof expectedHash === "string" &&
      SHA256_PATTERN.test(expectedHash) &&
      sha256File(resourcePath) === expectedHash.toLowerCase(),
    );
  }
  return Boolean(
    safeManifestFile(
      manifest,
      String(resourceFile ?? ""),
      new Set([".cursor"]),
    ),
  );
}

function createUnavailableState(reason) {
  return {
    supported: process.platform === "darwin",
    available: false,
    bridgeAvailable: false,
    statusAvailable: true,
    previewMode: true,
    reason,
    selectedVariantId: null,
    requestedVariantId: null,
    effectiveVariantId: null,
    selectedNativeThemeId: null,
    effectiveNativeThemeId: null,
    themeIdentifier: null,
    themeSizePercentage: DEFAULT_THEME_SIZE_PERCENTAGE,
    resourceAvailable: false,
    canApply: false,
    isEnabled: false,
    desiredEnabled: false,
    effectiveApplied: false,
    persistedEffectiveApplied: false,
    currentSentinelsMatchTheme: false,
    launchAtLoginDesired: false,
    loginApprovalRequired: false,
    loginItemRegistrationCurrent: false,
    liveVerified: false,
    liveStatusVerified: false,
    stateDrifted: false,
    lastError: null,
  };
}

function parseNativeJSON(value) {
  const source = String(value ?? "").trim();
  if (!source) {
    return null;
  }
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function nativeErrorFromProcess(error, command) {
  const details = parseNativeJSON(error?.stdout);
  const timedOut = Boolean(error?.killed || error?.signal === "SIGTERM");
  const message =
    firstThemeValue(details, [
      "actionError",
      "ActionError",
      "lastError",
      "LastError",
    ]) ??
    (timedOut
      ? `The native cursor operation timed out (${command}).`
      : "The native cursor operation could not be completed.");
  const nativeError = new Error(String(message));
  nativeError.name = "NativeCursorError";
  nativeError.code = error?.code ?? "NATIVE_BRIDGE_ERROR";
  nativeError.command = command;
  nativeError.details = details;
  nativeError.cause = error;
  return nativeError;
}

export function createCursorBridge({
  nativePath,
  discover = true,
  manifestPath = null,
  manifestData = null,
  manifestRoot = null,
  importedPacksRoot = null,
  isPackaged = false,
  resourcesPath = process.resourcesPath ?? process.cwd(),
  appPath = process.cwd(),
  verifySignature = isPackaged,
  commandRunner = null,
  trashImportedArtifact = null,
} = {}) {
  const resolution = { isPackaged, resourcesPath, appPath, verifySignature };
  let bridgePath = null;
  if (nativePath && isExecutableFile(nativePath)) {
    bridgePath =
      !isPackaged ||
      !verifySignature ||
      verifyPackagedNativeApp(resourcesPath, nativePath)
        ? path.resolve(nativePath)
        : null;
  } else if (commandRunner) {
    bridgePath = nativePath ?? "injected-native-bridge";
  } else if (discover) {
    bridgePath = resolveNativeBridge(resolution);
  }

  let fallbackState = createUnavailableState(
    process.platform === "darwin"
      ? "The native cursor component is unavailable."
      : "Cursor changes require macOS.",
  );
  let mutationQueue = Promise.resolve();
  let loadedManifest;
  let loadedImportedManifests;
  const nativeToCatalogId = new Map(BASE_NATIVE_TO_CATALOG_ID);
  const catalogToNativeId = new Map(BASE_CATALOG_TO_NATIVE_ID);
  const manifestByNativeId = new Map();
  const manifestByCatalogId = new Map();
  const previewAssets = new Map();
  const previewTokensByPath = new Map();
  let indexedManifestThemes;
  let previewGeneration = 0;

  const registerPreviewAsset = (manifest, asset) => {
    const assetPath = manifest.imported
      ? safeImportedFile(manifest, asset, {
          extensions: new Set([".png"]),
          maxBytes: MAX_IMPORTED_PREVIEW_BYTES,
          preview: true,
        })
      : safeManifestFile(manifest, asset, new Set([".png"]));
    if (!assetPath || (manifest.imported && !hasPngSignature(assetPath))) {
      return null;
    }
    let token = previewTokensByPath.get(assetPath);
    if (!token) {
      token = sha256File(
        assetPath,
        `${previewGeneration}\0${manifest.path ?? manifest.root}\0${asset}\0`,
      );
      previewTokensByPath.set(assetPath, token);
    }
    previewAssets.set(token, assetPath);
    return `${PREVIEW_SCHEME}://asset/${token}.png`;
  };

  const exposePreviews = (theme, manifest) => {
    const rolePreviews = Array.isArray(theme.rolePreviews)
      ? theme.rolePreviews.map((role) => {
          const source = role.src ?? role.asset ?? role.preview;
          const src = registerPreviewAsset(manifest, source);
          return { ...role, src, asset: src };
        })
      : [];
    const preview =
      registerPreviewAsset(manifest, theme.preview) ??
      rolePreviews.find(
        (role) =>
          role.macIdentifier === "com.apple.coregraphics.Arrow" ||
          role.role === "default" ||
          role.role === "arrow",
      )?.src ??
      null;
    return { ...theme, preview, previewUrl: preview, rolePreviews };
  };

  const getManifest = () => {
    if (loadedManifest !== undefined) {
      return loadedManifest;
    }
    if (manifestData && typeof manifestData === "object") {
      const themes =
        manifestData.themes ??
        manifestData.Themes ??
        manifestData.packs ??
        manifestData.Packs;
      loadedManifest = Array.isArray(themes)
        ? {
            path: null,
            root: path.resolve(manifestRoot ?? appPath),
            schemaVersion:
              manifestData.schemaVersion ?? manifestData.SchemaVersion ?? null,
            themes,
          }
        : null;
    } else if (!discover && !manifestPath) {
      loadedManifest = null;
    } else {
      loadedManifest = findManifest({
        manifestPath,
        isPackaged,
        resourcesPath,
        appPath,
        bridgePath,
      });
    }
    return loadedManifest;
  };

  const getImportedManifests = () => {
    if (loadedImportedManifests === undefined) {
      loadedImportedManifests = scanImportedManifests(importedPacksRoot);
    }
    return loadedImportedManifests;
  };

  const resetManifestIndex = () => {
    loadedManifest = undefined;
    loadedImportedManifests = undefined;
    indexedManifestThemes = undefined;
    manifestByNativeId.clear();
    manifestByCatalogId.clear();
    nativeToCatalogId.clear();
    catalogToNativeId.clear();
    for (const [key, value] of BASE_NATIVE_TO_CATALOG_ID) {
      nativeToCatalogId.set(key, value);
    }
    for (const [key, value] of BASE_CATALOG_TO_NATIVE_ID) {
      catalogToNativeId.set(key, value);
    }
    previewAssets.clear();
    previewTokensByPath.clear();
    previewGeneration += 1;
  };

  const ensureManifestIndex = () => {
    if (indexedManifestThemes !== undefined) {
      return indexedManifestThemes;
    }
    const manifests = [getManifest(), ...getImportedManifests()].filter(
      Boolean,
    );
    if (!manifests.length) {
      indexedManifestThemes = [];
      return indexedManifestThemes;
    }
    const themes = [];
    const claimedNativeIds = new Set();
    const claimedCatalogIds = new Set();
    for (const manifest of manifests) {
      const candidates = manifest.themes
        .map((rawTheme) => {
          const normalized = normalizeCursorTheme(
            manifest.imported ? { ...rawTheme, imported: true } : rawTheme,
            CURSOR_CATALOG,
          );
          if (!normalized) {
            return null;
          }
          const resourceFile =
            normalized.resourceFile ??
            firstThemeValue(rawTheme, ["Resource", "resource", "resourceFile"]);
          const resourceInstalled = hasResource(
            manifest,
            rawTheme,
            resourceFile,
          );
          return exposePreviews(
            {
              ...normalized,
              ...(manifest.imported
                ? {
                    imported: true,
                    importedPackIdentifier: manifest.packIdentifier,
                  }
                : {}),
              resourceFile,
              resourceInstalled,
              resourceAvailable: resourceInstalled,
              available: resourceInstalled,
              isAvailable: resourceInstalled,
              canApply: false,
              availability: resourceInstalled
                ? manifest.imported
                  ? "imported"
                  : "bundled"
                : "catalogued",
              imported: Boolean(manifest.imported),
              status: resourceInstalled ? "preview" : "unavailable",
            },
            manifest,
          );
        })
        .filter(Boolean);

      if (manifest.imported) {
        const localNativeIds = new Set();
        const localCatalogIds = new Set();
        const collides = candidates.some((theme) => {
          const nativeId = theme.nativeThemeId.toLowerCase();
          const catalogId = theme.id.toLowerCase();
          const duplicate =
            !theme.resourceInstalled ||
            !theme.preview ||
            localNativeIds.has(nativeId) ||
            localCatalogIds.has(catalogId) ||
            claimedNativeIds.has(nativeId) ||
            claimedCatalogIds.has(catalogId);
          localNativeIds.add(nativeId);
          localCatalogIds.add(catalogId);
          return duplicate;
        });
        if (collides) {
          continue;
        }
      }
      for (const theme of candidates) {
        const nativeId = theme.nativeThemeId.toLowerCase();
        const catalogId = theme.id.toLowerCase();
        if (
          !manifest.imported &&
          (claimedNativeIds.has(nativeId) || claimedCatalogIds.has(catalogId))
        ) {
          continue;
        }
        claimedNativeIds.add(nativeId);
        claimedCatalogIds.add(catalogId);
        themes.push(theme);
      }
    }

    for (const theme of themes) {
      const nativeId = theme.nativeThemeId;
      manifestByNativeId.set(nativeId, theme);
      manifestByNativeId.set(nativeId.toLowerCase(), theme);
      manifestByCatalogId.set(theme.id, theme);
      manifestByCatalogId.set(theme.id.toLowerCase(), theme);
      nativeToCatalogId.set(nativeId, theme.id);
      nativeToCatalogId.set(nativeId.toLowerCase(), theme.id);
      catalogToNativeId.set(theme.id, nativeId);
      catalogToNativeId.set(theme.id.toLowerCase(), nativeId);
    }
    indexedManifestThemes = themes;
    return indexedManifestThemes;
  };

  const manifestTheme = (identifier) => {
    ensureManifestIndex();
    const value = String(identifier ?? "");
    return (
      manifestByNativeId.get(value) ??
      manifestByNativeId.get(value.toLowerCase()) ??
      manifestByCatalogId.get(value) ??
      manifestByCatalogId.get(value.toLowerCase()) ??
      null
    );
  };

  const catalogIdentifier = (identifier) => {
    const value = String(identifier ?? "");
    return (
      nativeToCatalogId.get(value) ??
      nativeToCatalogId.get(value.toLowerCase()) ??
      getCursorCatalogEntry(value)?.id ??
      (value || null)
    );
  };

  const resolveTheme = (identifier) => {
    const value = String(identifier ?? "");
    const generated = manifestTheme(value);
    if (generated) {
      return generated.resourceInstalled ? generated : null;
    }
    const entry = getCursorCatalogEntry(value);
    return entry?.availability === "bundled" && entry?.nativeThemeId
      ? entry
      : null;
  };

  const runNative = async (
    command,
    commandArguments = [],
    acceptableCodes = [],
  ) => {
    if (!bridgePath && discover) {
      bridgePath = resolveNativeBridge(resolution);
    }
    if (!bridgePath) {
      throw new Error("The native cursor component is unavailable.");
    }

    if (commandRunner) {
      try {
        return await commandRunner({
          bridgePath,
          command,
          arguments: commandArguments,
          timeout: COMMAND_TIMEOUTS[command] ?? 15_000,
        });
      } catch (error) {
        throw error?.details ? error : nativeErrorFromProcess(error, command);
      }
    }

    try {
      const { stdout } = await execFileAsync(
        bridgePath,
        [command, ...commandArguments],
        {
          timeout: COMMAND_TIMEOUTS[command] ?? 15_000,
          maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
      );
      const parsed = parseNativeJSON(stdout);
      if (!parsed) {
        throw new Error("The native cursor component returned invalid data.");
      }
      return parsed;
    } catch (error) {
      const parsed = parseNativeJSON(error?.stdout);
      if (parsed && acceptableCodes.includes(Number(error?.code))) {
        return parsed;
      }
      if (
        error?.message === "The native cursor component returned invalid data."
      ) {
        throw error;
      }
      throw nativeErrorFromProcess(error, command);
    }
  };

  const normalizeStatus = (raw) => {
    if (!raw || typeof raw !== "object") {
      return { ...fallbackState };
    }
    ensureManifestIndex();
    const selectedNativeThemeId = firstThemeValue(raw, [
      "selectedThemeIdentifier",
      "SelectedThemeIdentifier",
      "themeIdentifier",
      "ThemeIdentifier",
      "nativeThemeId",
      "NativeThemeID",
    ]);
    const selectedVariantId = selectedNativeThemeId
      ? catalogIdentifier(selectedNativeThemeId)
      : fallbackState.selectedVariantId;
    const desiredEnabled = firstBoolean(
      raw,
      ["desiredEnabled", "DesiredEnabled"],
      false,
    );
    const persistedEffectiveApplied = firstBoolean(
      raw,
      ["effectiveApplied", "EffectiveApplied"],
      false,
    );
    const currentSentinelsMatchTheme = firstBoolean(
      raw,
      ["currentSentinelsMatchTheme", "CurrentSentinelsMatchTheme"],
      false,
    );
    const liveApplied = Boolean(
      desiredEnabled && persistedEffectiveApplied && currentSentinelsMatchTheme,
    );
    const supported = firstBoolean(raw, ["supported", "Supported"], true);
    const themeValid = firstBoolean(raw, ["themeValid", "ThemeValid"], true);
    const launchAtLoginDesired = firstBoolean(
      raw,
      ["launchAtLoginDesired", "LaunchAtLoginDesired"],
      false,
    );
    const loginApprovalRequired = firstBoolean(
      raw,
      ["loginApprovalRequired", "LoginApprovalRequired"],
      false,
    );
    const loginItemRegistrationCurrent = firstBoolean(
      raw,
      ["loginItemRegistrationCurrent", "LoginItemRegistrationCurrent"],
      false,
    );
    const selectedTheme = selectedNativeThemeId
      ? (manifestTheme(selectedNativeThemeId) ??
        getCursorCatalogEntry(selectedNativeThemeId))
      : null;
    const resourceAvailable = Boolean(
      selectedTheme?.resourceAvailable ??
      selectedTheme?.available ??
      themeValid,
    );
    const actionError = firstThemeValue(raw, [
      "actionError",
      "ActionError",
      "lastError",
      "LastError",
    ]);
    const themeSizePercentage = normalizedThemeSizePercentage(
      firstThemeValue(raw, ["themeSizePercentage", "ThemeSizePercentage"]),
      DEFAULT_THEME_SIZE_PERCENTAGE,
    );

    fallbackState = {
      ...fallbackState,
      ...raw,
      supported,
      themeValid,
      available: true,
      bridgeAvailable: true,
      statusAvailable: true,
      previewMode: false,
      reason:
        desiredEnabled && !liveApplied
          ? "The selected cursor is not currently active in macOS."
          : null,
      selectedVariantId,
      requestedVariantId: desiredEnabled ? selectedVariantId : null,
      effectiveVariantId: liveApplied ? selectedVariantId : null,
      selectedNativeThemeId,
      effectiveNativeThemeId: liveApplied ? selectedNativeThemeId : null,
      nativeThemeId: selectedNativeThemeId,
      themeIdentifier: selectedNativeThemeId,
      themeSizePercentage,
      resourceAvailable,
      canApply: Boolean(
        bridgePath && supported && themeValid && resourceAvailable,
      ),
      isEnabled: liveApplied,
      desiredEnabled,
      effectiveApplied: liveApplied,
      persistedEffectiveApplied,
      currentSentinelsMatchTheme,
      launchAtLoginDesired,
      loginApprovalRequired,
      loginItemRegistrationCurrent,
      liveVerified: currentSentinelsMatchTheme,
      liveStatusVerified: true,
      stateDrifted:
        desiredEnabled !== liveApplied ||
        persistedEffectiveApplied !== liveApplied,
      lastError: actionError ? String(actionError) : null,
    };
    return { ...fallbackState };
  };

  const status = async () => {
    if (!bridgePath && !discover) {
      return { ...fallbackState };
    }
    try {
      return normalizeStatus(await runNative("--status"));
    } catch (error) {
      if (error?.details) {
        const result = normalizeStatus(error.details);
        fallbackState = {
          ...result,
          lastError: error.message,
          reason: error.message,
        };
        return { ...fallbackState };
      }
      fallbackState = {
        ...fallbackState,
        available: Boolean(bridgePath),
        bridgeAvailable: Boolean(bridgePath),
        statusAvailable: false,
        previewMode: !bridgePath,
        effectiveVariantId: null,
        effectiveNativeThemeId: null,
        isEnabled: false,
        effectiveApplied: false,
        liveVerified: false,
        liveStatusVerified: false,
        canApply: false,
        reason: error.message,
        lastError: error.message,
      };
      return { ...fallbackState };
    }
  };

  const listThemes = async () => {
    let rawThemes;
    try {
      const raw = await runNative("--list-themes");
      rawThemes = Array.isArray(raw) ? raw : (raw?.themes ?? raw?.Themes ?? []);
    } catch (error) {
      // Once an installed bridge is authoritative, do not turn a native
      // inventory failure into a successful-looking static catalogue. Let the
      // renderer expose its concise retry state. Static fallback is reserved
      // for genuine preview mode where no bridge was discovered.
      if (bridgePath) {
        throw error;
      }
      rawThemes = [];
    }

    const manifestThemes = ensureManifestIndex();
    const listedNativeIds = new Set(
      rawThemes
        .map((theme) =>
          firstThemeValue(theme, ["nativeThemeId", "identifier", "Identifier"]),
        )
        .filter(Boolean)
        .map((identifier) => String(identifier).toLowerCase()),
    );
    const result = [];

    for (const rawTheme of rawThemes) {
      const nativeThemeId = String(
        firstThemeValue(rawTheme, [
          "nativeThemeId",
          "identifier",
          "Identifier",
        ]) ?? "",
      );
      if (!nativeThemeId) {
        continue;
      }
      const manifestEntry = manifestTheme(nativeThemeId);
      const normalized = normalizeCursorTheme(
        manifestEntry ? { ...manifestEntry, ...rawTheme } : rawTheme,
        CURSOR_CATALOG,
      );
      if (!normalized) {
        continue;
      }
      const catalogEntry = getCursorCatalogEntry(normalized.id);
      const resourceInstalled = manifestEntry
        ? manifestEntry.resourceInstalled
        : catalogEntry?.availability === "bundled";
      const canApply = Boolean(bridgePath && resourceInstalled);
      const sizePercentage = normalizedThemeSizePercentage(
        firstThemeValue(rawTheme, ["sizePercentage", "SizePercentage"]),
        DEFAULT_THEME_SIZE_PERCENTAGE,
      );
      const availability = resourceInstalled
        ? manifestEntry?.imported
          ? "imported"
          : "bundled"
        : "catalogued";
      result.push({
        ...(catalogEntry ?? {}),
        ...(manifestEntry ?? {}),
        ...normalized,
        id: catalogIdentifier(nativeThemeId),
        nativeThemeId,
        identifier: nativeThemeId,
        sizePercentage,
        resourceInstalled,
        resourceAvailable: resourceInstalled,
        available: resourceInstalled,
        isAvailable: resourceInstalled,
        canApply,
        nativeListed: true,
        availability,
        imported: Boolean(manifestEntry?.imported),
        status: canApply
          ? "available"
          : resourceInstalled
            ? "preview"
            : "unavailable",
      });
    }

    const returned = new Set(
      result.map((theme) => theme.nativeThemeId.toLowerCase()),
    );
    for (const theme of manifestThemes) {
      if (returned.has(theme.nativeThemeId.toLowerCase())) {
        continue;
      }
      result.push({
        ...theme,
        sizePercentage: DEFAULT_THEME_SIZE_PERCENTAGE,
        canApply: false,
        nativeListed: listedNativeIds.has(theme.nativeThemeId.toLowerCase()),
        status: theme.resourceInstalled ? "preview" : "unavailable",
      });
    }

    if (result.length) {
      return result;
    }

    return CURSOR_CATALOG.map((theme) => ({
      ...theme,
      sizePercentage: DEFAULT_THEME_SIZE_PERCENTAGE,
      available: Boolean(theme.availability === "bundled"),
      isAvailable: Boolean(theme.availability === "bundled"),
      resourceAvailable: Boolean(theme.availability === "bundled"),
      resourceInstalled: Boolean(theme.availability === "bundled"),
      canApply: false,
      nativeListed: false,
      status: theme.availability === "bundled" ? "preview" : "unavailable",
    }));
  };

  const serializeMutation = (operation) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => undefined);
    return result;
  };

  const importedThemesForIdentifiers = (identifiers) => {
    if (
      !Array.isArray(identifiers) ||
      identifiers.length === 0 ||
      identifiers.length > MAX_IMPORTED_PACKS
    ) {
      throw new TypeError("At least one imported cursor is required.");
    }
    const themes = [];
    const seen = new Set();
    for (const identifier of identifiers) {
      if (
        typeof identifier !== "string" ||
        !IDENTIFIER_PATTERN.test(identifier)
      ) {
        throw new TypeError("A valid imported cursor identifier is required.");
      }
      const theme = manifestTheme(identifier);
      if (!theme?.imported) {
        const error = new Error("Only imported cursor packs can be changed.");
        error.code = "NOT_IMPORTED";
        throw error;
      }
      const key = theme.nativeThemeId.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        themes.push(theme);
      }
    }
    return themes;
  };

  const hasRestorableCursorState = (currentStatus) =>
    [
      "desiredEnabled",
      "persistedEffectiveApplied",
      "effectiveApplied",
      "launchAtLoginDesired",
      "loginItemRegistrationCurrent",
      "transactionPending",
    ].some(
      (key) => currentStatus?.[key] === true || currentStatus?.[key] === 1,
    );

  const deleteImportedThemeRecords = async (themes) => {
    const identifiers = themes.map((theme) => theme.nativeThemeId);
    const targets = new Set(
      themes
        .flatMap((theme) => [theme.nativeThemeId, theme.id])
        .map((identifier) => identifier.toLowerCase()),
    );
    let restoredToMacOS = false;
    let selectionReassigned = false;

    if (bridgePath) {
      const currentStatus = await status();
      if (currentStatus.statusAvailable === false) {
        const error = new Error(
          "Cursor status must be available before an imported cursor can be deleted.",
        );
        error.code = "STATUS_UNAVAILABLE";
        throw error;
      }
      const selectedIdentifier = String(
        currentStatus.selectedNativeThemeId ??
          currentStatus.themeIdentifier ??
          "",
      ).toLowerCase();
      const selectedIsTarget =
        Boolean(selectedIdentifier) && targets.has(selectedIdentifier);
      const effectiveIdentifiers = [
        currentStatus.effectiveNativeThemeId,
        currentStatus.effectiveVariantId,
      ]
        .filter(Boolean)
        .map((identifier) => String(identifier).toLowerCase());
      const effectiveIsTarget = effectiveIdentifiers.some((identifier) =>
        targets.has(identifier),
      );
      // When a lower-level theme selection changes while a cursor remains
      // registered, native status can verify that the persisted cursor is
      // still applied without being able to name it. Treat a drifted live
      // registration as a possible target rather than deleting its files
      // while macOS still references them.
      const unidentifiedLiveCursor =
        currentStatus.persistedEffectiveApplied === true &&
        currentStatus.currentSentinelsMatchTheme !== true;
      if (
        hasRestorableCursorState(currentStatus) &&
        (selectedIsTarget || effectiveIsTarget || unidentifiedLiveCursor)
      ) {
        await runNative("--teardown");
        restoredToMacOS = true;
      }
      if (selectedIsTarget) {
        // Teardown intentionally leaves SelectedThemeIdentifier untouched. A
        // valid bundled fallback must be persisted before the imported files
        // disappear or every subsequent native status invocation would start
        // from a missing theme.
        await runNative("--select-theme", ["OreoWhite"]);
        selectionReassigned = true;
      }
    }

    const removed = await removeImportedCursorArtifacts({
      identifiers,
      importedPacksRoot,
      ...(typeof trashImportedArtifact === "function"
        ? { disposeArtifact: trashImportedArtifact }
        : {}),
    });
    let sizePreferenceCleanupPending = false;
    if (bridgePath) {
      for (const identifier of identifiers) {
        try {
          await runNative("--forget-theme-size", [identifier]);
        } catch {
          // Artifact deletion is already complete (and may have moved the pack
          // to Trash), so preference cleanup failure cannot honestly turn the
          // deletion into a failed operation. Continue through family members
          // and expose the remaining cleanup state to the caller.
          sizePreferenceCleanupPending = true;
        }
      }
    }
    resetManifestIndex();
    const nextStatus = bridgePath ? await status() : { ...fallbackState };
    return {
      ...removed,
      restoredToMacOS,
      selectionReassigned,
      sizePreferenceCleanupPending,
      status: nextStatus,
    };
  };

  const assignImportedFamily = (identifiers, family) =>
    serializeMutation(async () => {
      const themes = importedThemesForIdentifiers(identifiers);
      const requestedFamily = normalizeImportedCursorFamily(family);
      const currentFamilies = (await listThemes())
        .map((theme) => theme.family)
        .filter(Boolean);
      const normalizedFamily =
        currentFamilies.find(
          (currentFamily) => currentFamily === requestedFamily,
        ) ??
        currentFamilies.find(
          (currentFamily) =>
            currentFamily.toLocaleLowerCase() ===
            requestedFamily.toLocaleLowerCase(),
        ) ??
        requestedFamily;
      const result = await assignImportedCursorFamily({
        identifiers: themes.map((theme) => theme.nativeThemeId),
        family: normalizedFamily,
        importedPacksRoot,
      });
      resetManifestIndex();
      return result;
    });

  const deleteImportedThemes = (identifiers) =>
    serializeMutation(() =>
      deleteImportedThemeRecords(importedThemesForIdentifiers(identifiers)),
    );

  const deleteImportedFamily = (family) =>
    serializeMutation(async () => {
      const normalizedFamily = normalizeImportedCursorFamily(family);
      const members = (await listThemes()).filter(
        (theme) => theme.family === normalizedFamily,
      );
      if (!members.length) {
        const error = new Error("That cursor family is no longer available.");
        error.code = "FAMILY_NOT_FOUND";
        throw error;
      }
      if (members.some((theme) => !theme.imported)) {
        const error = new Error(
          "A family containing built-in cursor packs cannot be deleted.",
        );
        error.code = "MIXED_FAMILY";
        throw error;
      }
      return deleteImportedThemeRecords(
        importedThemesForIdentifiers(
          members.map((theme) => theme.nativeThemeId),
        ),
      );
    });

  const invalidateManifests = () =>
    serializeMutation(() => {
      resetManifestIndex();
    });

  const validateImportedThemes = (identifiers) =>
    serializeMutation(async () => {
      if (
        !Array.isArray(identifiers) ||
        identifiers.length === 0 ||
        identifiers.some(
          (identifier) =>
            typeof identifier !== "string" ||
            !IDENTIFIER_PATTERN.test(identifier),
        )
      ) {
        throw new TypeError("Valid imported cursor identifiers are required.");
      }
      for (const identifier of identifiers) {
        const validation = await runNative(
          "--validate-theme",
          [identifier],
          [2],
        );
        if (!firstBoolean(validation, ["valid", "Valid"], false)) {
          const error = new Error(
            String(
              firstThemeValue(validation, ["actionError", "ActionError"]) ??
                `The imported cursor ${identifier} failed native validation.`,
            ),
          );
          error.name = "NativeCursorError";
          error.code = "INVALID_IMPORTED_CURSOR";
          error.command = "--validate-theme";
          error.details = validation;
          throw error;
        }
      }
    });

  const refreshAfterMutation = async (operation) => {
    try {
      await operation();
    } catch (error) {
      const refreshed = await status();
      error.status = refreshed;
      throw error;
    }
    return status();
  };

  const applyTheme = (identifier) =>
    serializeMutation(async () => {
      if (
        typeof identifier !== "string" ||
        !IDENTIFIER_PATTERN.test(identifier)
      ) {
        throw new TypeError("A valid cursor theme identifier is required.");
      }
      const theme = resolveTheme(identifier);
      if (!theme?.nativeThemeId || !bridgePath) {
        throw new Error("That cursor theme is not available to apply.");
      }
      return refreshAfterMutation(() =>
        runNative("--apply-theme", [theme.nativeThemeId], [5]),
      );
    });

  const reconcileLoginItems = () =>
    serializeMutation(() => runNative("--reconcile-login-items", [], [5]));

  const setThemeSize = (identifier, sizePercentage) =>
    serializeMutation(async () => {
      if (
        typeof identifier !== "string" ||
        !IDENTIFIER_PATTERN.test(identifier)
      ) {
        throw new TypeError("A valid cursor theme identifier is required.");
      }
      const normalizedSize = normalizedThemeSizePercentage(sizePercentage);
      if (normalizedSize === null) {
        throw new TypeError(
          "Cursor size must be an integer between 50 and 200.",
        );
      }
      const theme = resolveTheme(identifier);
      if (!theme?.nativeThemeId || !bridgePath) {
        throw new Error("That cursor theme is not available to customize.");
      }
      await runNative("--set-theme-size", [
        theme.nativeThemeId,
        String(normalizedSize),
      ]);
      return {
        id: catalogIdentifier(theme.nativeThemeId),
        nativeThemeId: theme.nativeThemeId,
        sizePercentage: normalizedSize,
      };
    });

  const restore = () =>
    serializeMutation(() =>
      // Restoring from the Electron app also removes its internal login item;
      // the user asked to return fully to the macOS cursor, not merely hide it
      // until the next login.
      refreshAfterMutation(() => runNative("--teardown")),
    );

  const openLoginSettings = () =>
    serializeMutation(async () => {
      const currentStatus = await status();
      if (
        !currentStatus.statusAvailable ||
        !currentStatus.loginApprovalRequired
      ) {
        throw new Error("Login Items approval is not currently required.");
      }
      return normalizeStatus(await runNative("--open-login-settings"));
    });

  return {
    status,
    listThemes,
    applyTheme,
    reconcileLoginItems,
    setThemeSize,
    restore,
    openLoginSettings,
    assignImportedFamily,
    deleteImportedThemes,
    deleteImportedFamily,
    invalidateManifests,
    validateImportedThemes,
    resolvePreviewAsset(requestUrl) {
      try {
        const url = new URL(requestUrl);
        if (url.protocol !== `${PREVIEW_SCHEME}:` || url.hostname !== "asset") {
          return null;
        }
        const token = path.basename(url.pathname, ".png");
        return /^[a-f0-9]{64}$/.test(token)
          ? (previewAssets.get(token) ?? null)
          : null;
      } catch {
        return null;
      }
    },
    get nativePath() {
      return bridgePath;
    },
    get manifestPath() {
      return getManifest()?.path ?? null;
    },
  };
}

export function registerCursorIpc({ ipcMain, bridge, isTrustedSender } = {}) {
  if (!ipcMain) {
    throw new Error("ipcMain is required to register cursor handlers.");
  }
  if (!bridge) {
    throw new Error("A cursor bridge is required to register IPC handlers.");
  }
  if (typeof isTrustedSender !== "function") {
    throw new Error("A trusted IPC sender predicate is required.");
  }

  const register = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) {
        throw new Error("Cursor IPC is unavailable to this page.");
      }
      return handler(...args);
    });
  };

  register("cursor:status", () => bridge.status());
  register("cursor:list-themes", () => bridge.listThemes());
  register("cursor:apply-theme", (identifier) => bridge.applyTheme(identifier));
  register("cursor:set-theme-size", (identifier, sizePercentage) =>
    bridge.setThemeSize(identifier, sizePercentage),
  );
  register("cursor:restore", () => bridge.restore());
  register("cursor:open-login-settings", () => bridge.openLoginSettings());

  return bridge;
}
