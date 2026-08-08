import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const inventoryLock = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "native", "cursor-packs", "inventory-lock.json"),
    "utf8",
  ),
);
const nativeApp = path.join(
  projectRoot,
  "native",
  "oreo",
  "build",
  "Release",
  "Oreo Cursor.app",
);
const nativeAppBundleId = "com.cursoratelier.CursorAtelier.NativeCursor";
const helperBundleId =
  "com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper";
const contents = path.join(nativeApp, "Contents");
const bridge = path.join(contents, "MacOS", "OreoCursor");
const helperInfo = path.join(
  contents,
  "Library",
  "LoginItems",
  "Oreo Cursor Login Helper.app",
  "Contents",
  "Info.plist",
);
const helperApp = path.resolve(helperInfo, "..", "..");
const appInfo = path.join(contents, "Info.plist");
const themesDirectory = path.join(contents, "Resources", "Themes");
const manifestPath = path.join(themesDirectory, "manifest.json");

function fail(message) {
  throw new Error(
    `${message}\nRun \`npm run native:packs\`, then \`OREO_SIGN_IDENTITY="<Apple Development identity>" npm run native:build\`.`,
  );
}

function plistValue(plist, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    { encoding: "utf8" },
  ).trim();
}

function safeManifestAsset(relativePath, extension) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    path.extname(relativePath).toLocaleLowerCase() !== extension
  ) {
    return null;
  }
  const resolved = path.resolve(themesDirectory, relativePath);
  const relative = path.relative(themesDirectory, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const canonicalRoot = fs.realpathSync(themesDirectory);
    const canonicalFile = fs.realpathSync(resolved);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    if (
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      return null;
    }
    return canonicalFile;
  } catch {
    return null;
  }
}

function identifierDigest(identifiers) {
  const payload = [...identifiers]
    .sort()
    .map((identifier) => `${identifier}\n`)
    .join("");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function withIsolatedNativeUserState(callback) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporaryHome = fs.mkdtempSync(
    path.join(temporaryRoot, "cursor-atelier-native-preflight-"),
  );
  const resolvedHome = fs.realpathSync(temporaryHome);
  if (
    path.dirname(resolvedHome) !== temporaryRoot ||
    !path.basename(resolvedHome).startsWith("cursor-atelier-native-preflight-")
  ) {
    throw new Error(`Refusing unexpected preflight home: ${resolvedHome}`);
  }
  try {
    return callback({
      ...process.env,
      HOME: resolvedHome,
      CFFIXED_USER_HOME: resolvedHome,
    });
  } finally {
    fs.rmSync(resolvedHome, { recursive: true, force: false });
  }
}

if (process.platform !== "darwin") {
  fail("Cursor Atelier packaging is supported on macOS only.");
}
if (!fs.existsSync(nativeApp) || !fs.statSync(nativeApp).isDirectory()) {
  fail("The signed native application bundle is missing.");
}
try {
  fs.accessSync(bridge, fs.constants.X_OK);
} catch {
  fail("The native cursor bridge is missing or is not executable.");
}
if (!fs.existsSync(manifestPath)) {
  fail("The generated cursor manifest is missing from the native bundle.");
}

for (const plist of [appInfo, helperInfo]) {
  if (plistValue(plist, "CFBundleShortVersionString") !== packageJson.version) {
    fail("The Electron, native app, and login-helper versions do not match.");
  }
  if (plistValue(plist, "LSMinimumSystemVersion") !== "13.0") {
    fail("The native minimum macOS version is inconsistent.");
  }
}
const nativeBuildVersion = plistValue(appInfo, "CFBundleVersion");
const helperBuildVersion = plistValue(helperInfo, "CFBundleVersion");
if (
  !/^\d+(?:\.\d+){0,2}$/.test(nativeBuildVersion) ||
  nativeBuildVersion === packageJson.version ||
  helperBuildVersion !== nativeBuildVersion
) {
  fail(
    "The native app and login helper require one matching, release-independent build identity.",
  );
}
if (plistValue(appInfo, "CFBundleIdentifier") !== nativeAppBundleId) {
  fail("The native application bundle identifier is inconsistent.");
}
if (plistValue(helperInfo, "CFBundleIdentifier") !== helperBundleId) {
  fail("The native login-helper bundle identifier is inconsistent.");
}
if (nativeAppBundleId === helperBundleId) {
  fail(
    "The native application and login helper require distinct bundle identifiers.",
  );
}

const signature = spawnSync(
  "/usr/bin/codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", nativeApp],
  { encoding: "utf8" },
);
if (signature.status !== 0) {
  fail(
    `The native application signature is invalid: ${signature.stderr.trim()}`,
  );
}
const signatureDetails = spawnSync(
  "/usr/bin/codesign",
  ["--display", "--verbose=2", nativeApp],
  { encoding: "utf8" },
);
const nativeTeamIdentifier =
  signatureDetails.stderr.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1] ?? null;
if (
  signatureDetails.status !== 0 ||
  !signatureDetails.stderr.includes(`Identifier=${nativeAppBundleId}`) ||
  !nativeTeamIdentifier
) {
  fail("The native application requires a stable local signing identity.");
}
const helperSignatureDetails = spawnSync(
  "/usr/bin/codesign",
  ["--display", "--verbose=2", helperApp],
  { encoding: "utf8" },
);
const helperTeamIdentifier =
  helperSignatureDetails.stderr.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1] ??
  null;
if (
  helperSignatureDetails.status !== 0 ||
  !helperSignatureDetails.stderr.includes(`Identifier=${helperBundleId}`) ||
  helperTeamIdentifier !== nativeTeamIdentifier
) {
  fail(
    "The native login helper requires the expected stable signing identity.",
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (Number(manifest.schemaVersion) < 2 || !Array.isArray(manifest.themes)) {
  fail("The native bundle requires a schema-v2 generated manifest.");
}
if (
  inventoryLock.schemaVersion !== 1 ||
  inventoryLock.externalThemeCount !== 220 ||
  inventoryLock.builtInThemeCount !== 19 ||
  inventoryLock.unifiedThemeCount !== 239 ||
  inventoryLock.roleCount !== 47 ||
  !Array.isArray(inventoryLock.builtInIdentifiers)
) {
  fail("The checked-in cursor inventory lock is inconsistent.");
}
if (
  manifest.themes.length !== inventoryLock.unifiedThemeCount ||
  manifest.roleCount !== inventoryLock.roleCount
) {
  fail("The bundled cursor manifest does not match the locked corpus shape.");
}
const manifestIdentifiers = manifest.themes.map(
  (theme) => theme.Identifier ?? theme.identifier,
);
const builtInIdentifiers = manifest.themes
  .filter((theme) => (theme.Group ?? theme.group) === "Oreo")
  .map((theme) => theme.Identifier ?? theme.identifier);
const externalIdentifiers = manifest.themes
  .filter((theme) => (theme.Group ?? theme.group) !== "Oreo")
  .map((theme) => theme.Identifier ?? theme.identifier);
if (
  builtInIdentifiers.length !== inventoryLock.builtInThemeCount ||
  externalIdentifiers.length !== inventoryLock.externalThemeCount ||
  JSON.stringify([...builtInIdentifiers].sort()) !==
    JSON.stringify([...inventoryLock.builtInIdentifiers].sort()) ||
  identifierDigest(externalIdentifiers) !==
    inventoryLock.externalIdentifierSHA256 ||
  identifierDigest(manifestIdentifiers) !==
    inventoryLock.unifiedIdentifierSHA256
) {
  fail("The bundled cursor identifiers differ from the locked inventory.");
}
const identifiers = new Set();
const resources = new Set();
for (const theme of manifest.themes) {
  const identifier = theme.Identifier ?? theme.identifier;
  const resource = theme.Resource ?? theme.resource;
  if (!identifier || identifiers.has(identifier)) {
    fail("The generated manifest contains a missing or duplicate theme ID.");
  }
  if (!resource || resources.has(resource)) {
    fail("The generated manifest contains a missing or duplicate resource.");
  }
  identifiers.add(identifier);
  resources.add(resource);

  const resourcePath = safeManifestAsset(resource, ".cursor");
  if (!resourcePath || !fs.existsSync(resourcePath)) {
    fail(`The resource for ${identifier} is missing or escapes the bundle.`);
  }
  const actualDigest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(resourcePath))
    .digest("hex");
  if (
    actualDigest !== String(theme.SHA256 ?? theme.sha256 ?? "").toLowerCase()
  ) {
    fail(`The resource digest for ${identifier} is stale.`);
  }

  if (
    !Array.isArray(theme.rolePreviews) ||
    theme.rolePreviews.length !== inventoryLock.roleCount
  ) {
    fail(`${identifier} does not have the required role previews.`);
  }
  const previewAssets = [
    theme.preview,
    ...theme.rolePreviews.map((preview) => preview.asset ?? preview.src),
  ];
  for (const preview of previewAssets) {
    const previewPath = safeManifestAsset(preview, ".png");
    if (!previewPath || !fs.existsSync(previewPath)) {
      fail(`A preview asset for ${identifier} is missing or unsafe.`);
    }
  }
}

const bundledCursorCount = fs
  .readdirSync(themesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".cursor")).length;
const nativeValidation = withIsolatedNativeUserState((environment) => ({
  listedThemes: JSON.parse(
    execFileSync(bridge, ["--list-themes"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      env: environment,
    }),
  ),
  validation: JSON.parse(
    execFileSync(bridge, ["--validate-themes"], {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      env: environment,
    }),
  ),
  fallbackValidation: JSON.parse(
    execFileSync(bridge, ["--validate-system-fallbacks"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: environment,
    }),
  ),
}));
const { listedThemes, validation, fallbackValidation } = nativeValidation;
if (
  !Array.isArray(listedThemes) ||
  listedThemes.length !== bundledCursorCount ||
  listedThemes.length !== manifest.themes.length
) {
  fail(
    "The native allowlist, manifest, and bundled resources are inconsistent.",
  );
}

if (
  !validation.valid ||
  validation.invalidCount !== 0 ||
  validation.themeCount !== listedThemes.length
) {
  fail("Native cursor resource validation failed.");
}

if (!fallbackValidation.valid) {
  fail("Apple cursor fallback validation failed.");
}

console.warn(
  `Native preflight passed: ${listedThemes.length} manifest themes, signed bridge ${packageJson.version} (${nativeBuildVersion}).`,
);
