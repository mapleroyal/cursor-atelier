import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";

const fsPromises = fs.promises;
const MANIFEST_NAME = "manifest.json";
const LIBRARY_NAME = "ImportedPacks";
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 768 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_PATH_DEPTH = 8;
const SAFE_COMPONENT = /^[A-Za-z0-9._ -]{1,192}$/;

function dataError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertAbsoluteDirectory(directory, label) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new TypeError(`${label} must be an absolute directory.`);
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function removeTemporaryDirectory(parent, candidate) {
  if (!isPathWithin(parent, candidate)) {
    throw new Error("Refusing to remove an unexpected temporary directory.");
  }
  const stat = await fsPromises
    .lstat(candidate)
    .catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
  if (!stat) {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The temporary data path is not a directory.");
  }
  await fsPromises.rm(candidate, { recursive: true });
}

function normalizeArchivePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    throw dataError(
      "INVALID_DATA_ARCHIVE",
      "The data archive has an unsafe path.",
    );
  }
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  const components = normalized.split("/");
  if (
    !normalized ||
    components.length > MAX_PATH_DEPTH ||
    components.some(
      (component) =>
        component === "." ||
        component === ".." ||
        !SAFE_COMPONENT.test(component),
    ) ||
    (normalized !== MANIFEST_NAME &&
      normalized !== LIBRARY_NAME &&
      !normalized.startsWith(`${LIBRARY_NAME}/`))
  ) {
    throw dataError(
      "INVALID_DATA_ARCHIVE",
      "The data archive has an unsafe path.",
    );
  }
  return normalized;
}

async function inspectDataArchive(archivePath) {
  const archiveStat = await fsPromises.lstat(archivePath);
  if (
    archiveStat.isSymbolicLink() ||
    !archiveStat.isFile() ||
    archiveStat.size <= 0 ||
    archiveStat.size > MAX_ARCHIVE_BYTES
  ) {
    throw dataError(
      "INVALID_DATA_ARCHIVE",
      "The selected data archive is invalid.",
    );
  }
  const records = new Map();
  let totalBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const parser = new tar.Parser({
        strict: true,
        maxMetaEntrySize: MAX_ENTRY_BYTES,
        maxDecompressionRatio: 100,
      });
      const input = fs.createReadStream(archivePath);
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      input.on("error", finish);
      parser.on("error", finish);
      parser.on("end", () => finish());
      parser.on("entry", (entry) => {
        try {
          const entryPath = normalizeArchivePath(entry.path);
          const type = entry.type;
          if (
            !["File", "Directory"].includes(type) ||
            records.has(entryPath) ||
            records.size >= MAX_ENTRIES
          ) {
            throw dataError(
              "INVALID_DATA_ARCHIVE",
              "The data archive contains unsupported entries.",
            );
          }
          const size = Number(entry.size);
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            (type === "File" && size > MAX_ENTRY_BYTES) ||
            (entryPath === MANIFEST_NAME && size > MAX_MANIFEST_BYTES) ||
            totalBytes > MAX_EXTRACTED_BYTES - size
          ) {
            throw dataError(
              "DATA_ARCHIVE_TOO_LARGE",
              "The data archive is too large.",
            );
          }
          totalBytes += size;
          records.set(entryPath, { size, type });
        } catch (error) {
          entry.resume();
          input.destroy();
          parser.abort(error);
          finish(error);
          return;
        }
        entry.resume();
      });
      input.pipe(parser);
    });
  } catch (error) {
    if (
      error?.code === "INVALID_DATA_ARCHIVE" ||
      error?.code === "DATA_ARCHIVE_TOO_LARGE"
    ) {
      throw error;
    }
    throw dataError(
      "INVALID_DATA_ARCHIVE",
      "The selected data archive could not be read.",
      error,
    );
  }
  if (
    records.get(MANIFEST_NAME)?.type !== "File" ||
    records.get(LIBRARY_NAME)?.type !== "Directory"
  ) {
    throw dataError("INVALID_DATA_ARCHIVE", "The data archive is incomplete.");
  }
  return records;
}

async function syncFile(filePath) {
  const handle = await fsPromises.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createAppDataArchive({
  destination,
  importedPacksRoot,
  document,
  validateImportedPacksRoot,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (typeof destination !== "string" || !path.isAbsolute(destination)) {
    throw new TypeError("An absolute export destination is required.");
  }
  assertAbsoluteDirectory(importedPacksRoot, "The imported cursor path");
  assertAbsoluteDirectory(temporaryRoot, "The temporary path");
  if (typeof validateImportedPacksRoot !== "function") {
    throw new TypeError("An imported cursor validator is required.");
  }
  validateImportedPacksRoot(importedPacksRoot);
  const canonicalImportedPacksRoot =
    await fsPromises.realpath(importedPacksRoot);
  const destinationDirectory = await fsPromises.realpath(
    path.dirname(destination),
  );
  const destinationPath = path.join(
    destinationDirectory,
    path.basename(destination),
  );
  if (
    destinationPath === canonicalImportedPacksRoot ||
    isPathWithin(canonicalImportedPacksRoot, destinationPath)
  ) {
    throw dataError(
      "INVALID_EXPORT_PATH",
      "Choose an export location outside the live cursor library.",
    );
  }
  const existing = await fsPromises
    .lstat(destinationPath)
    .catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
  if (existing?.isSymbolicLink() || existing?.isDirectory()) {
    throw dataError(
      "INVALID_EXPORT_PATH",
      "The export destination is invalid.",
    );
  }
  const stage = await fsPromises.mkdtemp(
    path.join(temporaryRoot, "cursor-atelier-export-"),
  );
  await fsPromises.chmod(stage, 0o700);
  const temporaryArchive = path.join(
    destinationDirectory,
    `.${path.basename(destinationPath)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fsPromises.writeFile(
      path.join(stage, MANIFEST_NAME),
      `${JSON.stringify(document)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fsPromises.cp(importedPacksRoot, path.join(stage, LIBRARY_NAME), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    await tar.c(
      {
        cwd: stage,
        file: temporaryArchive,
        gzip: true,
        portable: true,
        noMtime: true,
        strict: true,
      },
      [MANIFEST_NAME, LIBRARY_NAME],
    );
    await fsPromises.chmod(temporaryArchive, 0o600);
    await syncFile(temporaryArchive);
    await inspectDataArchive(temporaryArchive);
    await fsPromises.rename(temporaryArchive, destinationPath);
    return destinationPath;
  } finally {
    await fsPromises.unlink(temporaryArchive).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
    await removeTemporaryDirectory(temporaryRoot, stage);
  }
}

export async function extractAppDataArchive({
  archivePath,
  stagingRoot,
  validateImportedPacksRoot,
} = {}) {
  if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) {
    throw new TypeError("An absolute data archive path is required.");
  }
  assertAbsoluteDirectory(stagingRoot, "The staging path");
  if (typeof validateImportedPacksRoot !== "function") {
    throw new TypeError("An imported cursor validator is required.");
  }
  const records = await inspectDataArchive(archivePath);
  const stage = await fsPromises.mkdtemp(
    path.join(stagingRoot, ".data-import-"),
  );
  await fsPromises.chmod(stage, 0o700);
  try {
    await tar.x({
      cwd: stage,
      file: archivePath,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      noMtime: true,
      chmod: false,
      keep: true,
      maxDepth: MAX_PATH_DEPTH,
      maxReadSize: MAX_ENTRY_BYTES,
      maxMetaEntrySize: MAX_ENTRY_BYTES,
      maxDecompressionRatio: 100,
      dmode: 0o700,
      fmode: 0o600,
      umask: 0o077,
      filter(entryPath, entry) {
        const normalized = normalizeArchivePath(entryPath);
        const record = records.get(normalized);
        return Boolean(
          record &&
          record.type === entry.type &&
          record.size === Number(entry.size),
        );
      },
    });
    const manifestPath = path.join(stage, MANIFEST_NAME);
    const document = JSON.parse(
      await fsPromises.readFile(manifestPath, "utf8"),
    );
    const importedPacksRoot = path.join(stage, LIBRARY_NAME);
    const library = validateImportedPacksRoot(importedPacksRoot);
    return {
      document,
      importedPacksRoot,
      library,
      stage,
      async cleanup() {
        await removeTemporaryDirectory(stagingRoot, stage);
      },
    };
  } catch (error) {
    await removeTemporaryDirectory(stagingRoot, stage);
    if (error?.code) {
      throw error;
    }
    throw dataError(
      "INVALID_DATA_ARCHIVE",
      "The data archive is invalid.",
      error,
    );
  }
}
