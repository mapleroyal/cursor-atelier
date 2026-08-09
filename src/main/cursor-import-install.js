import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMPORTED_ROLE_COUNT = 47;
const MAX_IMPORTED_DIRECTORY_ENTRIES = 512;
const MAX_ARTIFACT_FILES = 256;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_IMPORTED_PACKS = 256;
const MAX_IMPORTED_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IMPORTED_CURSOR_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTED_CURSOR_BYTES_TOTAL = 512 * 1024 * 1024;
const MAX_IMPORTED_PREVIEW_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;
export const CURSOR_IMPORT_TRANSACTION_PREFIXES = Object.freeze([
  ".import-",
  ".metadata-",
  ".delete-",
]);
export const CURSOR_IMPORT_TRANSACTION_SUFFIX_PATTERN = "[A-Za-z0-9]{6}";
const PRIVATE_TRANSACTION_NAME = new RegExp(
  `^(?:${CURSOR_IMPORT_TRANSACTION_PREFIXES.map((prefix) =>
    prefix.replace(".", "\\."),
  ).join("|")})${CURSOR_IMPORT_TRANSACTION_SUFFIX_PATTERN}$`,
);
export const DELETE_TRANSACTION_MANIFEST = ".transaction.json";
export const DELETE_TRANSACTION_NATIVE_STARTED = ".native-started.json";
export const DELETE_TRANSACTION_COMMIT = ".committed.json";
export const IMPORT_PROMOTION_MANIFEST = ".promotion.json";
export const IMPORT_PROMOTION_COMMIT = ".promotion-committed.json";
const TRANSACTION_MARKER_PUBLISHING_SUFFIX = ".publishing";
const DELETE_TRANSACTION_SCHEMA_VERSION = 1;
// A phase marker can contain the maximum 256 records, each with two bounded
// 128-byte names, a SHA-256 digest, and JSON framing.
const MAX_TRANSACTION_MARKER_BYTES = MAX_IMPORTED_PACKS * 1024 + 4 * 1024;

export function isCursorImportTransactionEntry(name) {
  return typeof name === "string" && PRIVATE_TRANSACTION_NAME.test(name);
}

export class CursorImportInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CursorImportInstallError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CursorImportInstallError(code, message);
}

async function syncDirectory(directory) {
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableJson(filePath, value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_TRANSACTION_MARKER_BYTES) {
    fail("LIMIT_EXCEEDED", "The cursor transaction metadata is too large.");
  }
  const publishingPath = `${filePath}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`;
  if (await pathExistsNoFollow(filePath)) {
    fail("UNSAFE_STORE", "Transaction phase metadata already exists.");
  }
  const handle = await fs.promises.open(publishingPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(publishingPath, filePath);
  await syncDirectory(path.dirname(filePath));
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

async function unlinkIfPresent(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function unlinkAndSyncIfPresent(filePath) {
  const existed = await pathExistsNoFollow(filePath);
  await unlinkIfPresent(filePath);
  if (existed) {
    await syncDirectory(path.dirname(filePath));
  }
}

async function removeUnpublishedMarkerFiles(directory, markerNames) {
  for (const markerName of markerNames) {
    const publishingPath = path.join(
      directory,
      `${markerName}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
    );
    if (!(await pathExistsNoFollow(publishingPath))) {
      continue;
    }
    await regularFile(publishingPath);
    await unlinkAndSyncIfPresent(publishingPath);
  }
}

function normalizeDeletionTransactionPacks(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_IMPORTED_PACKS
  ) {
    fail("UNSAFE_STORE", "Deletion transaction metadata is incomplete.");
  }
  const packNames = new Set();
  const identifiers = new Set();
  return value.map((pack) => {
    const packName = pack?.packName;
    const identifier = pack?.identifier;
    const digest = pack?.digest;
    if (
      !SAFE_NAME.test(packName ?? "") ||
      !SAFE_NAME.test(identifier ?? "") ||
      typeof digest !== "string" ||
      !SHA256.test(digest)
    ) {
      fail("UNSAFE_STORE", "Deletion transaction metadata is invalid.");
    }
    const packNameKey = packName.toLowerCase();
    const identifierKey = identifier.toLowerCase();
    if (packNames.has(packNameKey) || identifiers.has(identifierKey)) {
      fail("UNSAFE_STORE", "Deletion transaction metadata is ambiguous.");
    }
    packNames.add(packNameKey);
    identifiers.add(identifierKey);
    return { packName, identifier, digest };
  });
}

function preparedDeletionTransaction(packs) {
  return {
    schemaVersion: DELETE_TRANSACTION_SCHEMA_VERSION,
    kind: "cursor-import-deletion",
    phase: "prepared",
    packs,
  };
}

function committedDeletionTransaction(packs, preparedSha256) {
  return {
    schemaVersion: DELETE_TRANSACTION_SCHEMA_VERSION,
    kind: "cursor-import-deletion",
    phase: "committed",
    preparedSha256,
    packs,
  };
}

function normalizeDeletionNativeRecovery(value) {
  const normalizeIdentifier = (identifier) => {
    if (identifier === null || identifier === undefined) {
      return null;
    }
    if (typeof identifier !== "string" || !SAFE_NAME.test(identifier)) {
      fail("UNSAFE_STORE", "Deletion native recovery metadata is invalid.");
    }
    return identifier;
  };
  const booleanKeys = [
    "previousCursorWasLive",
    "previousDesiredEnabled",
    "previousLaunchAtLoginDesired",
    "previousLoginItemRegistrationCurrent",
    "previousTransactionPending",
    "teardownPlanned",
  ];
  if (booleanKeys.some((key) => typeof value?.[key] !== "boolean")) {
    fail("UNSAFE_STORE", "Deletion native recovery metadata is invalid.");
  }
  const normalized = {
    previousSelectedIdentifier: normalizeIdentifier(
      value.previousSelectedIdentifier,
    ),
    previousEffectiveIdentifier: normalizeIdentifier(
      value.previousEffectiveIdentifier,
    ),
    previousCursorWasLive: value.previousCursorWasLive,
    previousDesiredEnabled: value.previousDesiredEnabled,
    previousLaunchAtLoginDesired: value.previousLaunchAtLoginDesired,
    previousLoginItemRegistrationCurrent:
      value.previousLoginItemRegistrationCurrent,
    previousTransactionPending: value.previousTransactionPending,
    teardownPlanned: value.teardownPlanned,
  };
  const requiresCursorIdentifier = booleanKeys.some(
    (key) => normalized[key] === true,
  );
  if (
    requiresCursorIdentifier &&
    !normalized.previousEffectiveIdentifier &&
    !normalized.previousSelectedIdentifier
  ) {
    fail(
      "UNSAFE_STORE",
      "Cursor deletion recovery requires a prior cursor identifier.",
    );
  }
  if (
    normalized.previousCursorWasLive &&
    !normalized.previousEffectiveIdentifier
  ) {
    fail(
      "UNSAFE_STORE",
      "Live cursor deletion recovery requires an exact effective identifier.",
    );
  }
  return normalized;
}

function nativeStartedDeletionTransaction(
  packs,
  preparedSha256,
  nativeRecovery,
) {
  return {
    schemaVersion: DELETE_TRANSACTION_SCHEMA_VERSION,
    kind: "cursor-import-deletion",
    phase: "native-started",
    preparedSha256,
    packs,
    nativeRecovery: normalizeDeletionNativeRecovery(nativeRecovery),
  };
}

function normalizeImportPromotions(value) {
  return normalizeDeletionTransactionPacks(value).map((promotion) => ({
    packName: promotion.packName,
    identifier: promotion.identifier,
    digest: promotion.digest,
  }));
}

function preparedImportPromotion(promotions) {
  return {
    schemaVersion: DELETE_TRANSACTION_SCHEMA_VERSION,
    kind: "cursor-import-promotion",
    phase: "prepared",
    promotions,
  };
}

function committedImportPromotion(promotions, preparedSha256) {
  return {
    schemaVersion: DELETE_TRANSACTION_SCHEMA_VERSION,
    kind: "cursor-import-promotion",
    phase: "committed",
    preparedSha256,
    promotions,
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isOwnedByCurrentUser(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function hasPrivateMode(stat) {
  return (stat.mode & 0o077) === 0;
}

async function regularDirectory(filePath, { requirePrivate = true } = {}) {
  const stat = await fs.promises.lstat(filePath);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwnedByCurrentUser(stat) ||
    (requirePrivate && !hasPrivateMode(stat))
  ) {
    fail(
      "UNSAFE_ARTIFACT",
      "The imported cursor contains an unsafe directory.",
    );
  }
  return stat;
}

async function regularFile(filePath, { requirePrivate = true } = {}) {
  const stat = await fs.promises.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !isOwnedByCurrentUser(stat) ||
    (requirePrivate && !hasPrivateMode(stat))
  ) {
    fail("UNSAFE_ARTIFACT", "The imported cursor contains an unsafe file.");
  }
  return stat;
}

async function inspectTree(root, { requirePrivate = true } = {}) {
  const files = [];
  const directories = [root];
  let totalBytes = 0;

  const visit = async (directory) => {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).includes("..") ||
        entry.isSymbolicLink()
      ) {
        fail("UNSAFE_ARTIFACT", "The imported cursor contains an unsafe path.");
      }
      if (entry.isDirectory()) {
        await regularDirectory(entryPath, { requirePrivate });
        if (
          relative !== "previews" &&
          !relative.startsWith(`previews${path.sep}`)
        ) {
          fail(
            "UNSAFE_ARTIFACT",
            "The imported cursor contains an unexpected directory.",
          );
        }
        directories.push(entryPath);
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        fail("UNSAFE_ARTIFACT", "The imported cursor contains a special file.");
      }
      const atRoot = path.dirname(relative) === ".";
      const allowed = atRoot
        ? relative === "manifest.json" || relative.endsWith(".cursor")
        : relative.startsWith(`previews${path.sep}`) &&
          relative.endsWith(".png");
      if (!allowed) {
        fail(
          "UNSAFE_ARTIFACT",
          "The imported cursor contains an unexpected file.",
        );
      }
      const stat = await regularFile(entryPath, { requirePrivate });
      totalBytes += stat.size;
      files.push({ path: entryPath, relative, size: stat.size });
      if (
        files.length > MAX_ARTIFACT_FILES ||
        totalBytes > MAX_ARTIFACT_BYTES
      ) {
        fail(
          "LIMIT_EXCEEDED",
          "The imported cursor is too large to install safely.",
        );
      }
    }
  };

  await visit(root);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return { files, directories };
}

async function digestTree(tree, manifest = null) {
  const hash = crypto.createHash("sha256");
  for (const file of tree.files) {
    hash.update(file.relative);
    hash.update("\0");
    if (manifest && file.relative === "manifest.json") {
      const identityManifest = structuredClone(manifest);
      for (const theme of identityManifest.themes ?? []) {
        // Family is user-editable library metadata. Excluding only that field
        // from duplicate identity lets a re-import converge on the same
        // content-derived pack after the user organizes it, while every cursor,
        // preview, and immutable manifest field remains part of the comparison.
        theme.Group = "Imported";
      }
      hash.update(JSON.stringify(identityManifest));
    } else {
      hash.update(await fs.promises.readFile(file.path));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isBoundedCursorManifestText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

export function normalizeImportedCursorFamily(value) {
  if (typeof value !== "string") {
    fail("INVALID_FAMILY", "A cursor family name is required.");
  }
  const family = value.trim();
  if (!isBoundedCursorManifestText(family, 128)) {
    fail(
      "INVALID_FAMILY",
      "Cursor family names must contain between 1 and 128 characters.",
    );
  }
  return family;
}

function normalizeImportedIdentifiers(identifiers) {
  if (
    !Array.isArray(identifiers) ||
    identifiers.length === 0 ||
    identifiers.length > MAX_IMPORTED_PACKS
  ) {
    fail("INVALID_OPTIONS", "At least one imported cursor is required.");
  }
  const normalized = [];
  const seen = new Set();
  for (const identifier of identifiers) {
    if (typeof identifier !== "string" || !SAFE_NAME.test(identifier)) {
      fail("INVALID_OPTIONS", "An imported cursor identifier is invalid.");
    }
    const key = identifier.toLowerCase();
    if (!seen.has(key)) {
      normalized.push(identifier);
      seen.add(key);
    }
  }
  return normalized;
}

async function validatePreviewAsset(
  directory,
  identifier,
  value,
  { requirePrivate = true } = {},
) {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    path.isAbsolute(value)
  ) {
    fail("INVALID_ARTIFACT", "The imported cursor preview path is invalid.");
  }
  const components = value.split("/");
  if (
    components.length < 3 ||
    components[0] !== "previews" ||
    components[1] !== identifier ||
    components.some(
      (component) =>
        !SAFE_NAME.test(component) || component === "." || component === "..",
    ) ||
    path.extname(components.at(-1)).toLowerCase() !== ".png"
  ) {
    fail("INVALID_ARTIFACT", "The imported cursor preview path is invalid.");
  }
  const previewPath = path.join(directory, ...components);
  const stat = await regularFile(previewPath, { requirePrivate });
  if (stat.size > MAX_IMPORTED_PREVIEW_BYTES) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor preview is too large to install safely.",
    );
  }
  if (stat.size < PNG_SIGNATURE.length) {
    fail("INVALID_ARTIFACT", "The imported cursor preview is not a PNG.");
  }
  const handle = await fs.promises.open(previewPath, "r");
  try {
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)) {
      fail("INVALID_ARTIFACT", "The imported cursor preview is not a PNG.");
    }
  } finally {
    await handle.close();
  }
}

async function validateArtifact(directory, expectedStagingRoot = null) {
  const requirePrivate = expectedStagingRoot === null;
  await regularDirectory(directory, { requirePrivate });
  const canonicalDirectory = await fs.promises.realpath(directory);
  if (
    expectedStagingRoot &&
    path.dirname(canonicalDirectory) !== expectedStagingRoot
  ) {
    fail("UNSAFE_ARTIFACT", "The cursor import escaped its staging directory.");
  }

  const packName = path.basename(canonicalDirectory);
  if (!SAFE_NAME.test(packName)) {
    fail("UNSAFE_ARTIFACT", "The cursor import produced an unsafe pack name.");
  }
  const tree = await inspectTree(canonicalDirectory, { requirePrivate });
  const manifestFile = path.join(canonicalDirectory, "manifest.json");
  const manifestStat = await regularFile(manifestFile, { requirePrivate });
  if (
    manifestStat.size <= 0 ||
    manifestStat.size > MAX_IMPORTED_MANIFEST_BYTES
  ) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor manifest is too large to install safely.",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestFile, "utf8"));
  } catch {
    fail("INVALID_ARTIFACT", "The imported cursor manifest is invalid.");
  }
  if (
    manifest?.schemaVersion !== 2 ||
    manifest?.roleCount !== IMPORTED_ROLE_COUNT ||
    !Array.isArray(manifest.themes) ||
    manifest.themes.length !== 1
  ) {
    fail(
      "INVALID_ARTIFACT",
      "The imported cursor manifest has an unsupported schema.",
    );
  }
  const entry = manifest.themes[0];
  const identifier = entry?.Identifier;
  const resource = entry?.Resource;
  const expectedHash = String(entry?.SHA256 ?? "").toLowerCase();
  if (
    !SAFE_NAME.test(String(identifier ?? "")) ||
    !SAFE_NAME.test(String(resource ?? "")) ||
    path.extname(resource).toLowerCase() !== ".cursor" ||
    !SHA256.test(expectedHash) ||
    !isBoundedCursorManifestText(entry?.DisplayName, 256) ||
    !isBoundedCursorManifestText(entry?.ThemeName, 256) ||
    !isBoundedCursorManifestText(entry?.Group, 128) ||
    typeof entry?.UUID !== "string" ||
    !UUID.test(entry.UUID) ||
    typeof entry?.preview !== "string" ||
    !Array.isArray(entry?.rolePreviews) ||
    entry.rolePreviews.length !== IMPORTED_ROLE_COUNT
  ) {
    fail("INVALID_ARTIFACT", "The imported cursor metadata is incomplete.");
  }
  const resourcePath = path.join(canonicalDirectory, resource);
  const resourceStat = await regularFile(resourcePath, { requirePrivate });
  if (resourceStat.size <= 0 || resourceStat.size > MAX_IMPORTED_CURSOR_BYTES) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor resource is too large to install safely.",
    );
  }
  if (
    path.dirname(await fs.promises.realpath(resourcePath)) !==
    canonicalDirectory
  ) {
    fail("UNSAFE_ARTIFACT", "The imported cursor resource escaped its pack.");
  }
  const actualHash = crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(resourcePath))
    .digest("hex");
  if (actualHash !== expectedHash) {
    fail("INVALID_ARTIFACT", "The imported cursor failed its integrity check.");
  }
  await validatePreviewAsset(canonicalDirectory, identifier, entry.preview, {
    requirePrivate,
  });
  for (const role of entry.rolePreviews) {
    const source = role?.src ?? role?.asset ?? role?.preview;
    await validatePreviewAsset(canonicalDirectory, identifier, source, {
      requirePrivate,
    });
  }

  return {
    directory: canonicalDirectory,
    packName,
    identifier,
    entry,
    family: entry.Group,
    displayName: entry.DisplayName,
    manifest,
    manifestFile,
    resourceBytes: resourceStat.size,
    tree,
    digest: await digestTree(tree),
    identityDigest: await digestTree(tree, manifest),
  };
}

async function applyPrivatePermissions(tree) {
  for (const directory of tree.directories) {
    await fs.promises.chmod(directory, 0o700);
  }
  for (const file of tree.files) {
    await fs.promises.chmod(file.path, 0o600);
  }
}

async function syncArtifactTree(tree) {
  for (const file of tree.files) {
    const handle = await fs.promises.open(file.path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const directories = [...tree.directories].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length,
  );
  for (const directory of directories) {
    await syncDirectory(directory);
  }
}

async function privateStoreRoot(importedPacksRoot) {
  await fs.promises.mkdir(importedPacksRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.promises.lstat(importedPacksRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !isOwnedByCurrentUser(rootStat)
  ) {
    fail("UNSAFE_STORE", "The imported cursor store is not a safe directory.");
  }
  await fs.promises.chmod(importedPacksRoot, 0o700);
  return fs.promises.realpath(importedPacksRoot);
}

async function inspectInstalledStore(root) {
  const artifacts = [];
  const byIdentifier = new Map();
  const byPackName = new Map();
  let packCount = 0;
  let cursorBytes = 0;
  const allEntries = await fs.promises.readdir(root, { withFileTypes: true });
  const entries = allEntries.filter(
    (entry) => !isCursorImportTransactionEntry(entry.name),
  );
  if (entries.length > MAX_IMPORTED_DIRECTORY_ENTRIES) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor store contains too many entries.",
    );
  }
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) {
      continue;
    }
    const packPath = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      fail(
        "UNSAFE_STORE",
        "The imported cursor store contains an unsafe pack.",
      );
    }
    await regularDirectory(packPath);
    packCount += 1;
    const tree = await inspectTree(packPath);
    for (const file of tree.files) {
      if (
        path.dirname(file.relative) === "." &&
        path.extname(file.relative).toLowerCase() === ".cursor"
      ) {
        cursorBytes += file.size;
      }
    }

    let artifact;
    try {
      artifact = await validateArtifact(packPath);
    } catch (error) {
      // Preserve the store accounting behavior for an incomplete/corrupt pack:
      // it still consumes quota, but native ignores it and it has no identity
      // that a new valid import could collide with.
      if (
        error?.code === "ENOENT" ||
        error instanceof CursorImportInstallError
      ) {
        continue;
      }
      throw error;
    }
    const identifierKey = artifact.identifier.toLowerCase();
    const packNameKey = artifact.packName.toLowerCase();
    if (byIdentifier.has(identifierKey) || byPackName.has(packNameKey)) {
      fail(
        "IDENTIFIER_COLLISION",
        "The imported cursor store contains duplicate themes.",
      );
    }
    artifacts.push(artifact);
    byIdentifier.set(identifierKey, artifact);
    byPackName.set(packNameKey, artifact);
  }
  return {
    artifacts,
    byIdentifier,
    byPackName,
    packCount,
    cursorBytes,
  };
}

async function resolveInstalledArtifacts(root, identifiers) {
  const requested = new Map(
    normalizeImportedIdentifiers(identifiers).map((identifier) => [
      identifier.toLowerCase(),
      identifier,
    ]),
  );
  const resolved = new Map();
  const allEntries = await fs.promises.readdir(root, { withFileTypes: true });
  const entries = allEntries.filter(
    (entry) => !isCursorImportTransactionEntry(entry.name),
  );
  if (entries.length > MAX_IMPORTED_DIRECTORY_ENTRIES) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor store contains too many entries.",
    );
  }

  for (const entry of entries) {
    if (!SAFE_NAME.test(entry.name)) {
      continue;
    }
    const packPath = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      fail(
        "UNSAFE_STORE",
        "The imported cursor store contains an unsafe pack.",
      );
    }
    const artifact = await validateArtifact(packPath);
    if (path.dirname(artifact.directory) !== root) {
      fail("UNSAFE_STORE", "An imported cursor escaped its private store.");
    }
    const key = artifact.identifier.toLowerCase();
    if (!requested.has(key)) {
      continue;
    }
    if (resolved.has(key)) {
      fail(
        "IDENTIFIER_COLLISION",
        `More than one imported cursor uses ${artifact.identifier}.`,
      );
    }
    resolved.set(key, artifact);
  }

  const missing = [...requested].filter(([key]) => !resolved.has(key));
  if (missing.length) {
    fail(
      "CURSOR_NOT_FOUND",
      `The imported cursor ${missing[0][1]} is no longer available.`,
    );
  }
  return [...requested.keys()].map((key) => resolved.get(key));
}

async function replacePrivateManifest(root, artifact, manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_IMPORTED_MANIFEST_BYTES) {
    fail("LIMIT_EXCEEDED", "The imported cursor manifest is too large.");
  }
  await regularFile(artifact.manifestFile);
  if (
    path.dirname(artifact.directory) !== root ||
    path.dirname(artifact.manifestFile) !== artifact.directory
  ) {
    fail("UNSAFE_STORE", "The imported cursor manifest escaped its pack.");
  }

  const editDirectory = await fs.promises.mkdtemp(
    path.join(root, ".metadata-"),
  );
  await fs.promises.chmod(editDirectory, 0o700);
  const temporaryManifest = path.join(editDirectory, "manifest.json");
  let operationError = null;
  try {
    const handle = await fs.promises.open(temporaryManifest, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(editDirectory);
    await regularFile(temporaryManifest);
    await fs.promises.rename(temporaryManifest, artifact.manifestFile);
    await syncDirectory(artifact.directory);
  } catch (error) {
    operationError = error;
  }

  // These private edit directories are ignored by every store scanner. A
  // cleanup failure must not hide the manifest write/rename result; a stale
  // directory is inert and can be cleaned up by a later maintenance pass.
  try {
    await fs.promises.unlink(temporaryManifest);
    await syncDirectory(editDirectory);
  } catch {
    // The rename normally consumes this file.
  }
  try {
    await fs.promises.rmdir(editDirectory);
    await syncDirectory(root);
  } catch {
    // Keep the ignored private directory if the filesystem rejects cleanup.
  }
  if (operationError) {
    throw operationError;
  }
}

export async function assignImportedCursorFamily({
  identifiers,
  family,
  importedPacksRoot,
}) {
  const normalizedFamily = normalizeImportedCursorFamily(family);
  const root = await privateStoreRoot(importedPacksRoot);
  const artifacts = await resolveInstalledArtifacts(root, identifiers);
  const originals = await Promise.all(
    artifacts.map((artifact) =>
      fs.promises.readFile(artifact.manifestFile, "utf8"),
    ),
  );
  const changed = [];

  try {
    for (const artifact of artifacts) {
      if (artifact.family === normalizedFamily) {
        continue;
      }
      const manifest = structuredClone(artifact.manifest);
      manifest.themes[0].Group = normalizedFamily;
      await replacePrivateManifest(root, artifact, manifest);
      changed.push(artifact);
      const validated = await validateArtifact(artifact.directory);
      if (validated.family !== normalizedFamily) {
        fail("INVALID_ARTIFACT", "The cursor family change was not persisted.");
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of changed.reverse()) {
      const index = artifacts.indexOf(artifact);
      try {
        await replacePrivateManifest(
          root,
          artifact,
          JSON.parse(originals[index]),
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      const aggregate = new AggregateError(
        [error, ...rollbackErrors],
        `${error.message} The cursor family change could not be fully rolled back.`,
        { cause: error },
      );
      aggregate.code = "FAMILY_ASSIGNMENT_ROLLBACK_FAILED";
      throw aggregate;
    }
    throw error;
  }

  return {
    identifiers: artifacts.map((artifact) => artifact.identifier),
    family: normalizedFamily,
    updatedCount: changed.length,
  };
}

export async function prepareImportedCursorArtifactRemoval({
  identifiers,
  importedPacksRoot,
  disposeArtifact,
  nativeRecovery,
  recoverNativeState,
}) {
  if (disposeArtifact !== undefined && typeof disposeArtifact !== "function") {
    fail("INVALID_OPTIONS", "The imported cursor disposal handler is invalid.");
  }
  if (
    (nativeRecovery !== undefined &&
      typeof recoverNativeState !== "function") ||
    (nativeRecovery === undefined && recoverNativeState !== undefined)
  ) {
    fail(
      "INVALID_OPTIONS",
      "Native cursor recovery state and its compensation handler must be provided together.",
    );
  }
  const normalizedNativeRecovery =
    nativeRecovery === undefined
      ? null
      : normalizeDeletionNativeRecovery(nativeRecovery);
  const root = await privateStoreRoot(importedPacksRoot);
  const artifacts = await resolveInstalledArtifacts(root, identifiers);
  const deletionDirectory = await fs.promises.mkdtemp(
    path.join(root, ".delete-"),
  );
  await fs.promises.chmod(deletionDirectory, 0o700);
  const moved = [];
  const packs = artifacts.map((artifact) => ({
    packName: artifact.packName,
    identifier: artifact.identifier,
    digest: artifact.digest,
  }));
  const transactionManifest = path.join(
    deletionDirectory,
    DELETE_TRANSACTION_MANIFEST,
  );
  const transactionCommit = path.join(
    deletionDirectory,
    DELETE_TRANSACTION_COMMIT,
  );
  const transactionNativeStarted = path.join(
    deletionDirectory,
    DELETE_TRANSACTION_NATIVE_STARTED,
  );
  let preparedSha256 = null;

  const restoreMovedArtifacts = async () => {
    const rollbackErrors = [];
    for (const { artifact, destination } of moved.slice().reverse()) {
      try {
        const destinationExists = await pathExistsNoFollow(destination);
        const installedExists = await pathExistsNoFollow(artifact.directory);
        if (destinationExists === installedExists) {
          fail(
            "UNSAFE_STORE",
            "The imported cursor removal rollback is ambiguous.",
          );
        }
        if (destinationExists) {
          await validateTransactionArtifact(
            destination,
            deletionDirectory,
            artifact,
          );
          await fs.promises.rename(destination, artifact.directory);
        } else {
          await validateTransactionArtifact(artifact.directory, root, artifact);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length) {
      const error = new AggregateError(
        rollbackErrors,
        "The imported cursor removal could not be rolled back completely.",
      );
      error.code = "DELETE_ROLLBACK_FAILED";
      throw error;
    }
    await syncDirectory(root);
    await syncDirectory(deletionDirectory);
  };

  const cleanRollbackMetadata = async () => {
    try {
      for (const marker of [
        transactionCommit,
        `${transactionCommit}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
        transactionNativeStarted,
        `${transactionNativeStarted}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
        transactionManifest,
        `${transactionManifest}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
      ]) {
        await unlinkAndSyncIfPresent(marker);
      }
      await fs.promises.rmdir(deletionDirectory);
      await syncDirectory(root);
    } catch (error) {
      const aggregate = new AggregateError(
        [error],
        "The imported cursor removal metadata could not be cleaned up.",
      );
      aggregate.code = "DELETE_ROLLBACK_FAILED";
      throw aggregate;
    }
  };

  const rollbackMovedArtifacts = async () => {
    await restoreMovedArtifacts();
    if (normalizedNativeRecovery && moved.length > 0) {
      await recoverNativeState(normalizedNativeRecovery);
    }
    await cleanRollbackMetadata();
  };

  try {
    // Persist the transaction directory itself before publishing phase state or
    // moving an installed pack beneath it.
    await syncDirectory(root);
    preparedSha256 = await writeDurableJson(
      transactionManifest,
      preparedDeletionTransaction(packs),
    );
    if (normalizedNativeRecovery) {
      await writeDurableJson(
        transactionNativeStarted,
        nativeStartedDeletionTransaction(
          packs,
          preparedSha256,
          normalizedNativeRecovery,
        ),
      );
    }
    for (const artifact of artifacts) {
      const destination = path.join(deletionDirectory, artifact.packName);
      if (
        path.dirname(destination) !== deletionDirectory ||
        path.dirname(artifact.directory) !== root
      ) {
        fail("UNSAFE_STORE", "An imported cursor deletion path is unsafe.");
      }
      await fs.promises.rename(artifact.directory, destination);
      moved.push({ artifact, destination });
      await validateTransactionArtifact(
        destination,
        deletionDirectory,
        artifact,
      );
    }
    await syncDirectory(deletionDirectory);
    await syncDirectory(root);
  } catch (error) {
    try {
      await rollbackMovedArtifacts();
    } catch (rollbackError) {
      const aggregate = new AggregateError(
        [error, rollbackError],
        `${error.message} The imported cursor removal also failed to roll back.`,
        { cause: error },
      );
      aggregate.code = "DELETE_ROLLBACK_FAILED";
      throw aggregate;
    }
    throw error;
  }

  const result = {
    identifiers: artifacts.map((artifact) => artifact.identifier),
    removed: artifacts.map((artifact) => ({
      identifier: artifact.identifier,
      displayName: artifact.displayName,
      family: artifact.family,
    })),
    removedCount: artifacts.length,
    recoverable: Boolean(disposeArtifact),
    transactionName: path.basename(deletionDirectory),
  };
  let state = normalizedNativeRecovery ? "native-started" : "prepared";

  const finalizeCommittedMetadata = async () => {
    await syncDirectory(deletionDirectory);
    for (const marker of [
      transactionManifest,
      transactionNativeStarted,
      transactionCommit,
    ]) {
      await unlinkAndSyncIfPresent(marker);
    }
    await fs.promises.rmdir(deletionDirectory);
    await syncDirectory(root);
  };

  return {
    ...result,
    async markCommitted() {
      if (state !== "prepared" && state !== "native-started") {
        throw new Error("The imported cursor removal is no longer pending.");
      }
      await writeDurableJson(
        transactionCommit,
        committedDeletionTransaction(packs, preparedSha256),
      );
      state = "committed";
    },
    async rollback() {
      if (state === "rolled-back") {
        return;
      }
      if (
        state !== "prepared" &&
        state !== "native-started" &&
        state !== "native-recovery-pending"
      ) {
        throw new Error(
          "A committed imported cursor removal cannot roll back.",
        );
      }
      if (state !== "native-recovery-pending") {
        await restoreMovedArtifacts();
      }
      if (normalizedNativeRecovery) {
        state = "native-recovery-pending";
        await recoverNativeState(normalizedNativeRecovery);
      }
      await cleanRollbackMetadata();
      state = "rolled-back";
      return { nativeRecoveryPending: false };
    },
    async commit() {
      if (state !== "committed") {
        throw new Error("The imported cursor removal is not committed.");
      }
      state = "disposing";
      let cleanupPending = false;
      for (const { artifact, destination } of moved) {
        try {
          await validateTransactionArtifact(
            destination,
            deletionDirectory,
            artifact,
          );
          if (disposeArtifact) {
            await disposeArtifact(destination);
          } else {
            await fs.promises.rm(destination, {
              recursive: true,
              force: false,
            });
          }
          await syncDirectory(deletionDirectory);
        } catch {
          cleanupPending = true;
        }
      }
      if (!cleanupPending) {
        try {
          await syncDirectory(deletionDirectory);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            cleanupPending = true;
          }
        }
      }
      state = cleanupPending ? "cleanup-pending" : "disposed";
      return { ...result, cleanupPending };
    },
    async finalizeCommit() {
      if (state === "finalized") {
        return;
      }
      if (state !== "disposed") {
        throw new Error(
          "The imported cursor removal is not ready to finalize.",
        );
      }
      await finalizeCommittedMetadata();
      state = "finalized";
    },
  };
}

export async function removeImportedCursorArtifacts(options) {
  const transaction = await prepareImportedCursorArtifactRemoval(options);
  await transaction.markCommitted();
  const result = await transaction.commit();
  if (!result.cleanupPending) {
    await transaction.finalizeCommit();
  }
  return result;
}

async function pathExistsNoFollow(filePath) {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readTransactionMarker(filePath) {
  const stat = await regularFile(filePath);
  if (stat.size <= 0 || stat.size > MAX_TRANSACTION_MARKER_BYTES) {
    fail("UNSAFE_STORE", "Deletion transaction metadata has an invalid size.");
  }
  const serialized = await fs.promises.readFile(filePath, "utf8");
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("UNSAFE_STORE", "Deletion transaction metadata is malformed.");
  }
  return {
    value,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  };
}

function validateDeletionTransactionRecord(value, phase) {
  if (
    value?.schemaVersion !== DELETE_TRANSACTION_SCHEMA_VERSION ||
    value?.kind !== "cursor-import-deletion" ||
    value?.phase !== phase
  ) {
    fail("UNSAFE_STORE", "Deletion transaction metadata is invalid.");
  }
  const packs = normalizeDeletionTransactionPacks(value.packs);
  if (
    (phase === "native-started" || phase === "committed") &&
    (typeof value.preparedSha256 !== "string" ||
      !SHA256.test(value.preparedSha256))
  ) {
    fail("UNSAFE_STORE", "Deletion commit metadata is invalid.");
  }
  return {
    packs,
    preparedSha256: value.preparedSha256 ?? null,
    nativeRecovery:
      phase === "native-started"
        ? normalizeDeletionNativeRecovery(value.nativeRecovery)
        : null,
  };
}

function sameDeletionTransactionPacks(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadDeletionTransaction(transactionPath) {
  await removeUnpublishedMarkerFiles(transactionPath, [
    DELETE_TRANSACTION_MANIFEST,
    DELETE_TRANSACTION_NATIVE_STARTED,
    DELETE_TRANSACTION_COMMIT,
  ]);
  const entries = await fs.promises.readdir(transactionPath, {
    withFileTypes: true,
  });
  if (entries.length === 0) {
    return { phase: "empty", packs: [] };
  }
  const names = new Set(entries.map((entry) => entry.name));
  const manifestPath = path.join(transactionPath, DELETE_TRANSACTION_MANIFEST);
  const nativeStartedPath = path.join(
    transactionPath,
    DELETE_TRANSACTION_NATIVE_STARTED,
  );
  const commitPath = path.join(transactionPath, DELETE_TRANSACTION_COMMIT);
  let prepared = null;
  let nativeStarted = null;
  let committed = null;
  if (names.has(DELETE_TRANSACTION_MANIFEST)) {
    const marker = await readTransactionMarker(manifestPath);
    prepared = {
      ...validateDeletionTransactionRecord(marker.value, "prepared"),
      sha256: marker.sha256,
    };
  }
  if (names.has(DELETE_TRANSACTION_NATIVE_STARTED)) {
    const marker = await readTransactionMarker(nativeStartedPath);
    nativeStarted = validateDeletionTransactionRecord(
      marker.value,
      "native-started",
    );
  }
  if (names.has(DELETE_TRANSACTION_COMMIT)) {
    const marker = await readTransactionMarker(commitPath);
    committed = validateDeletionTransactionRecord(marker.value, "committed");
  }
  if (!prepared && !nativeStarted && !committed) {
    fail("UNSAFE_STORE", "A deletion transaction has no valid phase marker.");
  }
  if (nativeStarted && !prepared && !committed) {
    fail("UNSAFE_STORE", "Deletion transaction phase metadata is incomplete.");
  }
  if (
    nativeStarted &&
    prepared &&
    (prepared.sha256 !== nativeStarted.preparedSha256 ||
      !sameDeletionTransactionPacks(prepared.packs, nativeStarted.packs))
  ) {
    fail("UNSAFE_STORE", "Deletion transaction phase markers disagree.");
  }
  for (const earlierPhase of [prepared, nativeStarted].filter(Boolean)) {
    if (
      committed &&
      ((earlierPhase.sha256 &&
        earlierPhase.sha256 !== committed.preparedSha256) ||
        (earlierPhase.preparedSha256 &&
          earlierPhase.preparedSha256 !== committed.preparedSha256) ||
        !sameDeletionTransactionPacks(earlierPhase.packs, committed.packs))
    ) {
      fail("UNSAFE_STORE", "Deletion transaction phase markers disagree.");
    }
  }
  const record = committed ?? nativeStarted ?? prepared;
  const allowedNames = new Set([
    ...(prepared ? [DELETE_TRANSACTION_MANIFEST] : []),
    ...(nativeStarted ? [DELETE_TRANSACTION_NATIVE_STARTED] : []),
    ...(committed ? [DELETE_TRANSACTION_COMMIT] : []),
    ...record.packs.map((pack) => pack.packName),
  ]);
  if (entries.some((entry) => !allowedNames.has(entry.name))) {
    fail("UNSAFE_STORE", "A deletion transaction contains untracked data.");
  }
  return {
    phase: committed
      ? "committed"
      : nativeStarted
        ? "native-started"
        : "prepared",
    packs: record.packs,
    nativeRecovery: nativeStarted?.nativeRecovery ?? null,
    manifestPath: prepared ? manifestPath : null,
    nativeStartedPath: nativeStarted ? nativeStartedPath : null,
    commitPath: committed ? commitPath : null,
  };
}

async function validateTransactionArtifact(filePath, parent, expected) {
  const artifact = await validateArtifact(filePath);
  if (
    path.dirname(artifact.directory) !== parent ||
    artifact.packName !== expected.packName ||
    artifact.identifier !== expected.identifier ||
    artifact.digest !== expected.digest
  ) {
    fail("UNSAFE_STORE", "A deletion transaction artifact is ambiguous.");
  }
}

async function restorePreparedDeletionArtifacts(
  root,
  transactionPath,
  transaction,
) {
  for (const pack of transaction.packs) {
    const quarantined = path.join(transactionPath, pack.packName);
    const installed = path.join(root, pack.packName);
    const quarantinedExists = await pathExistsNoFollow(quarantined);
    const installedExists = await pathExistsNoFollow(installed);
    if (quarantinedExists === installedExists) {
      fail("UNSAFE_STORE", "A prepared deletion transaction is ambiguous.");
    }
    if (quarantinedExists) {
      await validateTransactionArtifact(quarantined, transactionPath, pack);
      await fs.promises.rename(quarantined, installed);
    } else {
      await validateTransactionArtifact(installed, root, pack);
    }
  }
  await syncDirectory(root);
  await syncDirectory(transactionPath);
}

async function removeDeletionRollbackMetadata(
  root,
  transactionPath,
  transaction,
) {
  if (transaction.nativeStartedPath) {
    await unlinkAndSyncIfPresent(transaction.nativeStartedPath);
  }
  if (transaction.manifestPath) {
    await unlinkAndSyncIfPresent(transaction.manifestPath);
  }
  await fs.promises.rmdir(transactionPath);
  await syncDirectory(root);
}

async function rollbackPreparedDeletion(root, transactionPath, transaction) {
  await restorePreparedDeletionArtifacts(root, transactionPath, transaction);
  await removeDeletionRollbackMetadata(root, transactionPath, transaction);
}

async function recoverStartedDeletion(
  root,
  transactionPath,
  transaction,
  recoverDeletionNativeState,
) {
  await restorePreparedDeletionArtifacts(root, transactionPath, transaction);
  if (typeof recoverDeletionNativeState !== "function") {
    fail(
      "NATIVE_RECOVERY_PENDING",
      "Interrupted cursor deletion still requires native recovery.",
    );
  }
  await recoverDeletionNativeState(transaction.nativeRecovery);
  await removeDeletionRollbackMetadata(root, transactionPath, transaction);
}

async function finishCommittedDeletion(
  root,
  transactionPath,
  transaction,
  disposeArtifact,
  persistPendingThemeSizeCleanup,
) {
  if (typeof disposeArtifact !== "function") {
    fail("INVALID_OPTIONS", "Committed deletion cleanup requires disposal.");
  }
  for (const pack of transaction.packs) {
    const quarantined = path.join(transactionPath, pack.packName);
    const installed = path.join(root, pack.packName);
    const quarantinedExists = await pathExistsNoFollow(quarantined);
    const installedExists = await pathExistsNoFollow(installed);
    if (installedExists) {
      fail("UNSAFE_STORE", "A committed deletion transaction is ambiguous.");
    }
    if (quarantinedExists) {
      await validateTransactionArtifact(quarantined, transactionPath, pack);
      await disposeArtifact(quarantined);
      await syncDirectory(transactionPath);
    }
  }
  await syncDirectory(transactionPath);
  if (typeof persistPendingThemeSizeCleanup !== "function") {
    fail(
      "SIZE_CLEANUP_PERSISTENCE_PENDING",
      "Committed deletion cleanup IDs still require durable persistence.",
    );
  }
  await persistPendingThemeSizeCleanup(
    transaction.packs.map((pack) => pack.identifier),
  );
  if (transaction.manifestPath) {
    await unlinkAndSyncIfPresent(transaction.manifestPath);
  }
  if (transaction.nativeStartedPath) {
    await unlinkAndSyncIfPresent(transaction.nativeStartedPath);
  }
  await unlinkAndSyncIfPresent(transaction.commitPath);
  await fs.promises.rmdir(transactionPath);
  await syncDirectory(root);
}

function validateImportPromotionRecord(value, phase) {
  if (
    value?.schemaVersion !== DELETE_TRANSACTION_SCHEMA_VERSION ||
    value?.kind !== "cursor-import-promotion" ||
    value?.phase !== phase
  ) {
    fail("UNSAFE_STORE", "Import promotion metadata is invalid.");
  }
  const promotions = normalizeImportPromotions(value.promotions);
  if (
    phase === "committed" &&
    (typeof value.preparedSha256 !== "string" ||
      !SHA256.test(value.preparedSha256))
  ) {
    fail("UNSAFE_STORE", "Import promotion commit metadata is invalid.");
  }
  return { promotions, preparedSha256: value.preparedSha256 ?? null };
}

async function loadImportPromotion(stagingPath) {
  await removeUnpublishedMarkerFiles(stagingPath, [
    IMPORT_PROMOTION_MANIFEST,
    IMPORT_PROMOTION_COMMIT,
  ]);
  const manifestPath = path.join(stagingPath, IMPORT_PROMOTION_MANIFEST);
  const commitPath = path.join(stagingPath, IMPORT_PROMOTION_COMMIT);
  const manifestExists = await pathExistsNoFollow(manifestPath);
  const commitExists = await pathExistsNoFollow(commitPath);
  if (!manifestExists && !commitExists) {
    return { phase: "none", promotions: [] };
  }
  let prepared = null;
  let committed = null;
  if (manifestExists) {
    const marker = await readTransactionMarker(manifestPath);
    prepared = {
      ...validateImportPromotionRecord(marker.value, "prepared"),
      sha256: marker.sha256,
    };
  }
  if (commitExists) {
    const marker = await readTransactionMarker(commitPath);
    committed = validateImportPromotionRecord(marker.value, "committed");
  }
  if (
    prepared &&
    committed &&
    (prepared.sha256 !== committed.preparedSha256 ||
      !sameDeletionTransactionPacks(prepared.promotions, committed.promotions))
  ) {
    fail("UNSAFE_STORE", "Import promotion phase markers disagree.");
  }
  const record = committed ?? prepared;
  return {
    phase: committed ? "committed" : "prepared",
    promotions: record.promotions,
  };
}

async function reconcileImportPromotion(root, stagingPath) {
  const transaction = await loadImportPromotion(stagingPath);
  if (transaction.phase === "none") {
    await removePrivateTransactionDirectory(root, stagingPath);
    return;
  }
  for (const promotion of transaction.promotions) {
    const staged = path.join(stagingPath, promotion.packName);
    const installed = path.join(root, promotion.packName);
    const stagedExists = await pathExistsNoFollow(staged);
    const installedExists = await pathExistsNoFollow(installed);
    if (stagedExists === installedExists) {
      fail("UNSAFE_STORE", "An import promotion transaction is ambiguous.");
    }
    if (transaction.phase === "prepared" && installedExists) {
      await validateTransactionArtifact(installed, root, promotion);
      await fs.promises.rename(installed, staged);
    } else if (transaction.phase === "prepared") {
      await validateTransactionArtifact(staged, stagingPath, promotion);
    } else if (installedExists) {
      await validateTransactionArtifact(installed, root, promotion);
    } else {
      fail("UNSAFE_STORE", "A committed import promotion is incomplete.");
    }
  }
  await syncDirectory(stagingPath);
  await syncDirectory(root);
  // Once the prepared marker is durably absent, every remaining crash prefix
  // is either commit-authoritative or marker-free cleanup. A partially removed
  // staging tree can no longer be mistaken for a complete rollback source.
  await unlinkAndSyncIfPresent(
    path.join(stagingPath, IMPORT_PROMOTION_MANIFEST),
  );
  await removePrivateTransactionDirectory(root, stagingPath);
  await syncDirectory(root);
}

async function removePrivateTransactionDirectory(root, directory) {
  const stat = await fs.promises.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwnedByCurrentUser(stat) ||
    !hasPrivateMode(stat) ||
    path.dirname(directory) !== root ||
    !isCursorImportTransactionEntry(path.basename(directory))
  ) {
    fail("UNSAFE_STORE", "Refusing to remove unsafe import transaction data.");
  }

  const inspected = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const relative = path.relative(directory, current);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("UNSAFE_STORE", "An import cleanup path escaped its transaction.");
    }
    const currentStat = await fs.promises.lstat(current);
    if (!isOwnedByCurrentUser(currentStat)) {
      fail(
        "UNSAFE_STORE",
        "An import transaction contains foreign-owned data.",
      );
    }
    if (currentStat.isSymbolicLink()) {
      inspected.push({ path: current, type: "link" });
      continue;
    }
    if (currentStat.isDirectory()) {
      if (current === directory && !hasPrivateMode(currentStat)) {
        fail("UNSAFE_STORE", "An import transaction root is not private.");
      }
      inspected.push({ path: current, type: "directory" });
      const children = await fs.promises.readdir(current);
      for (const name of children) {
        pending.push(path.join(current, name));
      }
      continue;
    }
    if (currentStat.isFile() && currentStat.nlink === 1) {
      inspected.push({ path: current, type: "file" });
      continue;
    }
    fail(
      "UNSAFE_STORE",
      "An import transaction contains unsafe filesystem data.",
    );
  }

  inspected.sort(
    (left, right) =>
      right.path.split(path.sep).length - left.path.split(path.sep).length,
  );
  for (const entry of inspected) {
    if (entry.type === "directory") {
      await fs.promises.rmdir(entry.path);
    } else {
      await fs.promises.unlink(entry.path);
    }
  }
}

export async function reconcileCursorImportTransactions({
  importedPacksRoot,
  disposeArtifact,
  recoverDeletionNativeState,
  persistPendingThemeSizeCleanup,
} = {}) {
  if (disposeArtifact !== undefined && typeof disposeArtifact !== "function") {
    fail("INVALID_OPTIONS", "The imported cursor disposal handler is invalid.");
  }
  if (
    recoverDeletionNativeState !== undefined &&
    typeof recoverDeletionNativeState !== "function"
  ) {
    fail("INVALID_OPTIONS", "The deletion recovery handler is invalid.");
  }
  if (
    persistPendingThemeSizeCleanup !== undefined &&
    typeof persistPendingThemeSizeCleanup !== "function"
  ) {
    fail("INVALID_OPTIONS", "The native size cleanup recorder is invalid.");
  }
  const root = await privateStoreRoot(importedPacksRoot);
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const removed = [];
  const pending = [];

  for (const entry of entries) {
    if (!isCursorImportTransactionEntry(entry.name)) {
      continue;
    }
    const transactionPath = path.join(root, entry.name);
    try {
      await regularDirectory(transactionPath);
      if (entry.name.startsWith(".delete-")) {
        const transaction = await loadDeletionTransaction(transactionPath);
        if (transaction.phase === "empty") {
          await fs.promises.rmdir(transactionPath);
        } else if (transaction.phase === "prepared") {
          await rollbackPreparedDeletion(root, transactionPath, transaction);
        } else if (transaction.phase === "native-started") {
          await recoverStartedDeletion(
            root,
            transactionPath,
            transaction,
            recoverDeletionNativeState,
          );
        } else {
          await finishCommittedDeletion(
            root,
            transactionPath,
            transaction,
            disposeArtifact,
            persistPendingThemeSizeCleanup,
          );
        }
        removed.push(entry.name);
        continue;
      }
      if (entry.name.startsWith(".import-")) {
        await reconcileImportPromotion(root, transactionPath);
        removed.push(entry.name);
        continue;
      }

      await removePrivateTransactionDirectory(root, transactionPath);
      removed.push(entry.name);
    } catch {
      pending.push(entry.name);
    }
  }

  return { removed, pending, cleanupPending: pending.length > 0 };
}

export async function createCursorImportStaging(importedPacksRoot) {
  const root = await privateStoreRoot(importedPacksRoot);
  const staging = await fs.promises.mkdtemp(path.join(root, ".import-"));
  await fs.promises.chmod(staging, 0o700);
  return staging;
}

export async function installImportedArtifacts({
  artifacts,
  stagingDirectory,
  importedPacksRoot,
  validateInstalled,
}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    fail("NO_THEMES", "No installable cursor themes were found.");
  }
  const canonicalRoot = await privateStoreRoot(importedPacksRoot);
  const canonicalStaging = await fs.promises.realpath(stagingDirectory);
  if (
    path.dirname(canonicalStaging) !== canonicalRoot ||
    !isCursorImportTransactionEntry(path.basename(canonicalStaging)) ||
    !path.basename(canonicalStaging).startsWith(".import-")
  ) {
    fail(
      "UNSAFE_STORE",
      "The cursor staging directory is outside the private store.",
    );
  }

  const installed = await inspectInstalledStore(canonicalRoot);
  const prepared = [];
  const seenPackNames = new Set();
  const seenIdentifiers = new Set();
  for (const artifact of artifacts) {
    const candidate = await validateArtifact(
      artifact?.directory,
      canonicalStaging,
    );
    const packNameKey = candidate.packName.toLowerCase();
    const identifierKey = candidate.identifier.toLowerCase();
    if (seenPackNames.has(packNameKey) || seenIdentifiers.has(identifierKey)) {
      fail(
        "IDENTIFIER_COLLISION",
        "The cursor import contains duplicate themes.",
      );
    }
    seenPackNames.add(packNameKey);
    seenIdentifiers.add(identifierKey);
    await applyPrivatePermissions(candidate.tree);

    const existingByPackName = installed.byPackName.get(packNameKey);
    const existingByIdentifier = installed.byIdentifier.get(identifierKey);
    if (
      existingByPackName &&
      existingByIdentifier &&
      existingByPackName !== existingByIdentifier
    ) {
      fail(
        "IDENTIFIER_COLLISION",
        `A different imported cursor already uses ${candidate.identifier}.`,
      );
    }
    const existing = existingByPackName ?? existingByIdentifier ?? null;
    const destination =
      existing?.directory ?? path.join(canonicalRoot, candidate.packName);
    if (!isWithin(canonicalRoot, destination)) {
      fail(
        "UNSAFE_ARTIFACT",
        "The cursor destination escaped the private store.",
      );
    }
    if (existing) {
      if (existing.identityDigest !== candidate.identityDigest) {
        fail(
          "IDENTIFIER_COLLISION",
          `A different imported cursor already uses ${candidate.identifier}.`,
        );
      }
      prepared.push({ ...candidate, destination, duplicate: true });
    } else {
      prepared.push({ ...candidate, destination, duplicate: false });
    }
  }

  const newPacks = prepared.filter((candidate) => !candidate.duplicate);
  const newCursorBytes = newPacks.reduce(
    (total, candidate) => total + candidate.resourceBytes,
    0,
  );
  if (installed.packCount + newPacks.length > MAX_IMPORTED_PACKS) {
    fail(
      "LIMIT_EXCEEDED",
      `Cursor Atelier can store at most ${MAX_IMPORTED_PACKS} imported cursor packs.`,
    );
  }
  if (
    installed.cursorBytes >
    MAX_IMPORTED_CURSOR_BYTES_TOTAL - newCursorBytes
  ) {
    fail(
      "LIMIT_EXCEEDED",
      "The imported cursor store would exceed its 512 MiB resource limit.",
    );
  }

  const moved = [];
  const promotions = newPacks.map((candidate) => ({
    packName: candidate.packName,
    identifier: candidate.identifier,
    digest: candidate.digest,
  }));
  const promotionManifest = path.join(
    canonicalStaging,
    IMPORT_PROMOTION_MANIFEST,
  );
  const promotionCommit = path.join(canonicalStaging, IMPORT_PROMOTION_COMMIT);
  let promotionPreparedSha256 = null;
  try {
    if (promotions.length) {
      for (const candidate of newPacks) {
        await syncArtifactTree(candidate.tree);
      }
      await syncDirectory(canonicalStaging);
      promotionPreparedSha256 = await writeDurableJson(
        promotionManifest,
        preparedImportPromotion(promotions),
      );
    }
    for (const candidate of prepared) {
      if (candidate.duplicate) {
        continue;
      }
      await fs.promises.rename(candidate.directory, candidate.destination);
      moved.push(candidate);
    }
    if (moved.length) {
      await syncDirectory(canonicalRoot);
      await syncDirectory(canonicalStaging);
    }
    if (validateInstalled) {
      if (typeof validateInstalled !== "function") {
        fail("INVALID_OPTIONS", "The cursor validator is invalid.");
      }
      await validateInstalled({
        identifiers: prepared.map((candidate) => candidate.identifier),
        installedDirectories: prepared.map(
          (candidate) => candidate.destination,
        ),
      });
    }
    if (promotions.length) {
      await writeDurableJson(
        promotionCommit,
        committedImportPromotion(promotions, promotionPreparedSha256),
      );
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const candidate of moved.slice().reverse()) {
      try {
        await fs.promises.rename(candidate.destination, candidate.directory);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (!rollbackErrors.length && moved.length) {
      try {
        await syncDirectory(canonicalStaging);
        await syncDirectory(canonicalRoot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (!rollbackErrors.length) {
      try {
        for (const marker of [
          promotionCommit,
          `${promotionCommit}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
          promotionManifest,
          `${promotionManifest}${TRANSACTION_MARKER_PUBLISHING_SUFFIX}`,
        ]) {
          await unlinkAndSyncIfPresent(marker);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      const aggregate = new AggregateError(
        [error, ...rollbackErrors],
        `${error.message} The imported cursor promotion could not be fully rolled back.`,
        { cause: error },
      );
      aggregate.code = "IMPORT_ROLLBACK_FAILED";
      throw aggregate;
    }
    throw error;
  }

  return {
    identifiers: prepared.map((candidate) => candidate.identifier),
    importedCount: prepared.filter((candidate) => !candidate.duplicate).length,
    duplicateCount: prepared.filter((candidate) => candidate.duplicate).length,
    installedDirectories: prepared.map((candidate) => candidate.destination),
  };
}

export async function removeCursorImportStaging({
  stagingDirectory,
  importedPacksRoot,
}) {
  let root;
  let staging;
  try {
    const rootStat = await fs.promises.lstat(importedPacksRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !isOwnedByCurrentUser(rootStat) ||
      !hasPrivateMode(rootStat)
    ) {
      fail("UNSAFE_STORE", "Refusing to use an unsafe imported cursor store.");
    }
    root = await fs.promises.realpath(importedPacksRoot);
    staging = await fs.promises.realpath(stagingDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const stat = await fs.promises.lstat(staging);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwnedByCurrentUser(stat) ||
    !hasPrivateMode(stat) ||
    path.dirname(staging) !== root ||
    !isCursorImportTransactionEntry(path.basename(staging)) ||
    !path.basename(staging).startsWith(".import-")
  ) {
    fail("UNSAFE_STORE", "Refusing to remove an unsafe cursor staging path.");
  }
  await reconcileImportPromotion(root, staging);
}
