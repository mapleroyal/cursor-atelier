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

async function digestTree(tree) {
  const hash = crypto.createHash("sha256");
  for (const file of tree.files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await fs.promises.readFile(file.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function boundedText(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
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
    !boundedText(entry?.DisplayName, 256) ||
    !boundedText(entry?.ThemeName, 256) ||
    !boundedText(entry?.Group, 128) ||
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
    resourceBytes: resourceStat.size,
    tree,
    digest: await digestTree(tree),
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
  let packCount = 0;
  let cursorBytes = 0;
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
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
  }
  return { packCount, cursorBytes };
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
    !path.basename(canonicalStaging).startsWith(".import-")
  ) {
    fail(
      "UNSAFE_STORE",
      "The cursor staging directory is outside the private store.",
    );
  }

  const prepared = [];
  const seenPackNames = new Set();
  const seenIdentifiers = new Set();
  for (const artifact of artifacts) {
    const candidate = await validateArtifact(
      artifact?.directory,
      canonicalStaging,
    );
    if (
      seenPackNames.has(candidate.packName) ||
      seenIdentifiers.has(candidate.identifier)
    ) {
      fail(
        "IDENTIFIER_COLLISION",
        "The cursor import contains duplicate themes.",
      );
    }
    seenPackNames.add(candidate.packName);
    seenIdentifiers.add(candidate.identifier);
    await applyPrivatePermissions(candidate.tree);

    const destination = path.join(canonicalRoot, candidate.packName);
    if (!isWithin(canonicalRoot, destination)) {
      fail(
        "UNSAFE_ARTIFACT",
        "The cursor destination escaped the private store.",
      );
    }
    try {
      const existing = await validateArtifact(destination);
      if (
        existing.identifier !== candidate.identifier ||
        existing.digest !== candidate.digest
      ) {
        fail(
          "IDENTIFIER_COLLISION",
          `A different imported cursor already uses ${candidate.identifier}.`,
        );
      }
      prepared.push({ ...candidate, destination, duplicate: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        prepared.push({ ...candidate, destination, duplicate: false });
      } else {
        throw error;
      }
    }
  }

  const installed = await inspectInstalledStore(canonicalRoot);
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
  try {
    for (const candidate of prepared) {
      if (candidate.duplicate) {
        continue;
      }
      await fs.promises.rename(candidate.directory, candidate.destination);
      moved.push(candidate);
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
  } catch (error) {
    for (const candidate of moved.reverse()) {
      try {
        await fs.promises.rename(candidate.destination, candidate.directory);
      } catch {
        // Preserve the original error. Each destination remains a complete,
        // independently valid pack if rollback itself is interrupted.
      }
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
    !path.basename(staging).startsWith(".import-")
  ) {
    fail("UNSAFE_STORE", "Refusing to remove an unsafe cursor staging path.");
  }
  await fs.promises.rm(staging, { recursive: true, force: false });
}
