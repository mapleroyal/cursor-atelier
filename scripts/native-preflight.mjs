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
const brandMarkSource = path.join(projectRoot, "assets", "BrandMark.svg");
const bundledBrandMark = path.join(contents, "Resources", "BrandMark.svg");
const themesDirectory = path.join(contents, "Resources", "Themes");
const sourceThemesDirectory = path.join(
  projectRoot,
  "native",
  "oreo",
  "Resources",
  "Themes",
);
const sourceCatalogPath = path.join(sourceThemesDirectory, "catalog.json");

function fail(message) {
  throw new Error(
    `${message}\nRun \`OREO_SIGN_IDENTITY="<Apple Development identity>" npm run native:build\`.`,
  );
}

function plistValue(plist, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    { encoding: "utf8" },
  ).trim();
}

function regularFilesWithin(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...regularFilesWithin(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
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

if (process.platform === "linux") {
  await import("./linux-preflight.mjs");
  process.exit(0);
}
if (process.platform !== "darwin") {
  fail("Cursor Atelier supports macOS and Linux.");
}
if (!fs.existsSync(nativeApp) || !fs.statSync(nativeApp).isDirectory()) {
  fail("The signed native application bundle is missing.");
}
try {
  fs.accessSync(bridge, fs.constants.X_OK);
} catch {
  fail("The native cursor bridge is missing or is not executable.");
}
if (
  !fs.existsSync(brandMarkSource) ||
  !fs.statSync(brandMarkSource).isFile() ||
  !fs.existsSync(bundledBrandMark) ||
  !fs.statSync(bundledBrandMark).isFile() ||
  !crypto.timingSafeEqual(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(brandMarkSource))
      .digest(),
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(bundledBrandMark))
      .digest(),
  )
) {
  fail("The native application brand mark is missing or stale.");
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

const nativePayloadFiles = regularFilesWithin(nativeApp).filter(
  (filePath) => path.extname(filePath).toLowerCase() === ".cursor",
);
if (fs.existsSync(themesDirectory) || nativePayloadFiles.length > 0) {
  fail("The signed native app contains bundled cursor or preview payloads.");
}

function runBridge(arguments_, environment, timeout = 30_000) {
  return JSON.parse(
    execFileSync(bridge, arguments_, {
      encoding: "utf8",
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: environment,
    }),
  );
}

const cleanValidation = withIsolatedNativeUserState((environment) => ({
  listedThemes: runBridge(["--list-themes"], environment, 15_000),
  validation: runBridge(["--validate-themes"], environment, 30_000),
  fallbackValidation: runBridge(
    ["--validate-system-fallbacks"],
    environment,
    30_000,
  ),
}));
if (
  !Array.isArray(cleanValidation.listedThemes) ||
  cleanValidation.listedThemes.length !== 0 ||
  !cleanValidation.validation.valid ||
  cleanValidation.validation.invalidCount !== 0 ||
  cleanValidation.validation.themeCount !== 0
) {
  fail("A clean native installation must expose a valid empty theme library.");
}
if (!cleanValidation.fallbackValidation.valid) {
  fail("Apple cursor fallback validation failed.");
}

const sourceCatalog = JSON.parse(fs.readFileSync(sourceCatalogPath, "utf8"));
const sourceFixture = sourceCatalog.themes?.find(
  (theme) => theme.nativeThemeId === sourceCatalog.defaultThemeId,
);
const sourceFixturePath = sourceFixture
  ? path.join(sourceThemesDirectory, sourceFixture.resourceFile)
  : null;
if (
  !sourceFixture ||
  !sourceFixturePath ||
  !fs.existsSync(sourceFixturePath) ||
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(sourceFixturePath))
    .digest("hex") !== sourceFixture.sha256
) {
  fail("The native import preflight fixture is missing or stale.");
}

const importedValidation = withIsolatedNativeUserState((environment) => {
  const dataDirectory = path.join(
    environment.HOME,
    "Library",
    "Application Support",
    "Cursor Atelier",
  );
  const importedDirectory = path.join(dataDirectory, "ImportedPacks");
  const packDirectory = path.join(importedDirectory, "native-preflight");
  fs.mkdirSync(packDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [dataDirectory, importedDirectory, packDirectory]) {
    fs.chmodSync(directory, 0o700);
  }
  const resourcePath = path.join(packDirectory, sourceFixture.resourceFile);
  fs.copyFileSync(sourceFixturePath, resourcePath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(resourcePath, 0o600);
  const manifestPath = path.join(packDirectory, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      themes: [
        {
          Identifier: sourceFixture.nativeThemeId,
          DisplayName: sourceFixture.name,
          Resource: sourceFixture.resourceFile,
          SHA256: sourceFixture.sha256,
          UUID: sourceFixture.uuid,
          ThemeName: sourceFixture.plistName,
          Group: "Preflight",
        },
      ],
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    listedThemes: runBridge(["--list-themes"], environment, 30_000),
    validation: runBridge(["--validate-themes"], environment, 90_000),
    directValidation: runBridge(
      ["--validate-theme", sourceFixture.nativeThemeId],
      environment,
      90_000,
    ),
  };
});
if (
  !Array.isArray(importedValidation.listedThemes) ||
  importedValidation.listedThemes.length !== 1 ||
  importedValidation.listedThemes[0].Identifier !==
    sourceFixture.nativeThemeId ||
  importedValidation.listedThemes[0].ImportedPackIdentifier !==
    "native-preflight" ||
  !importedValidation.validation.valid ||
  importedValidation.validation.invalidCount !== 0 ||
  importedValidation.validation.themeCount !== 1 ||
  !importedValidation.directValidation.valid
) {
  fail("An installed theme did not enumerate and fully validate on demand.");
}

console.warn(
  `Native preflight passed: zero bundled themes, imported-theme validation, signed bridge ${packageJson.version} (${nativeBuildVersion}).`,
);
