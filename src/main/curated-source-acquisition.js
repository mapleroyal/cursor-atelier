import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import * as tar from "tar";
import yauzl from "yauzl";

import catalogDocument from "../../native/cursor-packs/sources/curated-source-catalog.json";

const openZip = promisify(yauzl.open);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION = /^[a-f0-9]{40}$/;
const MARKER = ".cursor-atelier-source.json";
const ACQUISITION_SUFFIX = /^[A-Za-z0-9]{6}$/;
const REPLACEMENT_SUFFIX =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 75_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 250,
  maxPathLength: 1_024,
  maxPathDepth: 32,
});

export const CURATED_FAMILY_IDS = Object.freeze([
  "oreo",
  "remus",
  "drop",
  "moga",
  "volantes",
  "vimix",
  "qogir",
  "bibata-extra",
  "google",
  "simp1e",
  "capitaine",
  "future",
  "nordzy",
  "colloid",
  "bibata",
]);

const inFlight = new Map();

export class CuratedSourceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CuratedSourceError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new CuratedSourceError(code, message, cause ? { cause } : undefined);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    fail("ABORTED", "Curated source acquisition was cancelled.", signal.reason);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateHttps(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    fail("INVALID_CATALOG", `${label} is not a valid URL.`, error);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("INVALID_CATALOG", `${label} must be an HTTPS URL.`);
  }
  return url.href;
}

function validateRelativePath(value, label, { allowRoot = false } = {}) {
  if (allowRoot && value === ".") {
    return value;
  }
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail("INVALID_CATALOG", `${label} is not a safe relative path.`);
  }
  const trimmed = value.replace(/\/$/, "");
  if (
    trimmed.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(trimmed) !== trimmed
  ) {
    fail("INVALID_CATALOG", `${label} is not normalized.`);
  }
  return trimmed;
}

function validateLimits(value) {
  const result = { ...DEFAULT_LIMITS, ...(value ?? {}) };
  for (const [name, number] of Object.entries(result)) {
    if (!Number.isSafeInteger(number) || number < 1) {
      fail("INVALID_CATALOG", `Invalid source limit: ${name}.`);
    }
  }
  return Object.freeze(result);
}

function validateTreeLock(candidate, label) {
  if (
    !SHA256.test(candidate.treeSha256) ||
    /^0+$/.test(candidate.treeSha256) ||
    !Number.isSafeInteger(candidate.treeEntries) ||
    candidate.treeEntries < 1
  ) {
    fail("INVALID_CATALOG", `${label} has an invalid source-tree lock.`);
  }
}

export function validateCuratedSourceCatalog(
  document,
  { requireCanonicalFamilies = false } = {},
) {
  if (
    document?.schemaVersion !== 1 ||
    !Number.isSafeInteger(document?.cacheVersion) ||
    document.cacheVersion < 1 ||
    !Array.isArray(document?.families) ||
    !Array.isArray(document?.sources)
  ) {
    fail("INVALID_CATALOG", "The curated source catalog is invalid.");
  }
  const sourceIds = new Set();
  const directories = new Set();
  const sources = document.sources.map((candidate) => {
    if (
      !SAFE_ID.test(candidate?.id) ||
      sourceIds.has(candidate.id) ||
      typeof candidate.directory !== "string" ||
      path.basename(candidate.directory) !== candidate.directory ||
      !/^[A-Za-z0-9._-]+$/.test(candidate.directory) ||
      directories.has(candidate.directory)
    ) {
      fail("INVALID_CATALOG", "The catalog contains an invalid source.");
    }
    sourceIds.add(candidate.id);
    directories.add(candidate.directory);
    const limits = validateLimits(candidate.limits);
    if (candidate.type === "repository") {
      if (!REVISION.test(candidate.revision)) {
        fail("INVALID_CATALOG", `${candidate.id} has an invalid revision.`);
      }
      const inputRoots = candidate.inputRoots?.map((root, index) =>
        validateRelativePath(root, `${candidate.id} input root ${index}`),
      );
      if (
        !inputRoots?.length ||
        new Set(inputRoots).size !== inputRoots.length
      ) {
        fail("INVALID_CATALOG", `${candidate.id} has invalid input roots.`);
      }
      validateTreeLock(candidate, candidate.id);
      return Object.freeze({
        id: candidate.id,
        type: candidate.type,
        directory: candidate.directory,
        revision: candidate.revision,
        archiveUrl: validateHttps(candidate.archiveUrl, `${candidate.id} URL`),
        inputRoots: Object.freeze(inputRoots),
        treeSha256: candidate.treeSha256,
        treeEntries: candidate.treeEntries,
        limits,
      });
    }
    if (candidate.type !== "gnome-look") {
      fail("INVALID_CATALOG", `${candidate.id} has an invalid source type.`);
    }
    if (!Number.isSafeInteger(candidate.productId) || candidate.productId < 1) {
      fail("INVALID_CATALOG", `${candidate.id} has an invalid product ID.`);
    }
    const archives = candidate.archives?.map((archive, index) => {
      if (
        typeof archive.name !== "string" ||
        !archive.name.endsWith(".zip") ||
        path.basename(archive.name) !== archive.name ||
        !SHA256.test(archive.sha256)
      ) {
        fail("INVALID_CATALOG", `${candidate.id} archive ${index} is invalid.`);
      }
      validateTreeLock(archive, `${candidate.id}/${archive.name}`);
      return Object.freeze({ ...archive });
    });
    if (
      !archives?.length ||
      new Set(archives.map((row) => row.name)).size !== archives.length
    ) {
      fail("INVALID_CATALOG", `${candidate.id} has invalid archives.`);
    }
    return Object.freeze({
      id: candidate.id,
      type: candidate.type,
      directory: candidate.directory,
      productId: candidate.productId,
      metadataUrl: validateHttps(candidate.metadataUrl, `${candidate.id} URL`),
      archives: Object.freeze(archives),
      limits,
    });
  });
  const families = document.families.map((candidate) => {
    if (
      !SAFE_ID.test(candidate?.id) ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      candidate.name.length > 96 ||
      !Number.isSafeInteger(candidate.variantCount) ||
      candidate.variantCount < 1 ||
      !Array.isArray(candidate.sourceIds) ||
      !candidate.sourceIds.length ||
      new Set(candidate.sourceIds).size !== candidate.sourceIds.length ||
      candidate.sourceIds.some((id) => !sourceIds.has(id))
    ) {
      fail("INVALID_CATALOG", "The catalog contains an invalid family.");
    }
    return Object.freeze({
      id: candidate.id,
      name: candidate.name,
      variantCount: candidate.variantCount,
      sourceIds: Object.freeze([...candidate.sourceIds]),
    });
  });
  if (new Set(families.map((row) => row.id)).size !== families.length) {
    fail("INVALID_CATALOG", "The catalog repeats a family ID.");
  }
  if (
    requireCanonicalFamilies &&
    (families.length !== CURATED_FAMILY_IDS.length ||
      CURATED_FAMILY_IDS.some((id) => !families.some((row) => row.id === id)))
  ) {
    fail("INVALID_CATALOG", "The catalog does not cover every curated family.");
  }
  const referenced = new Set(families.flatMap((row) => row.sourceIds));
  if (sources.some((source) => !referenced.has(source.id))) {
    fail("INVALID_CATALOG", "The catalog contains an unreferenced source.");
  }
  return Object.freeze({
    schemaVersion: document.schemaVersion,
    cacheVersion: document.cacheVersion,
    families: Object.freeze(families),
    sources: Object.freeze(sources),
  });
}

export const CURATED_SOURCE_CATALOG = validateCuratedSourceCatalog(
  catalogDocument,
  { requireCanonicalFamilies: true },
);

function validateArchivePath(value, limits) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    Buffer.byteLength(value, "utf8") > limits.maxPathLength
  ) {
    fail("UNSAFE_ARCHIVE", `The source archive has an unsafe path: ${value}.`);
  }
  const trimmed = value.replace(/\/$/, "");
  const parts = trimmed.split("/");
  if (
    !trimmed ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.length > limits.maxPathDepth ||
    path.posix.normalize(trimmed) !== trimmed
  ) {
    fail("UNSAFE_ARCHIVE", `The source archive has an unsafe path: ${value}.`);
  }
  return trimmed;
}

function checkRecords(records, limits, archiveBytes) {
  if (!records.length || records.length > limits.maxEntries) {
    fail("LIMIT_EXCEEDED", "The source archive has an unsafe entry count.");
  }
  const seen = new Set();
  let expandedBytes = 0;
  for (const record of records) {
    const key = record.raw.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      fail(
        "UNSAFE_ARCHIVE",
        `The source archive has colliding paths: ${record.raw}.`,
      );
    }
    seen.add(key);
    if (record.type === "file") {
      if (
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        record.size > limits.maxEntryBytes
      ) {
        fail(
          "LIMIT_EXCEEDED",
          `A source entry is unexpectedly large: ${record.raw}.`,
        );
      }
      expandedBytes += record.size;
      if (expandedBytes > limits.maxExpandedBytes) {
        fail("LIMIT_EXCEEDED", "The source archive expands beyond its limit.");
      }
    }
  }
  if (expandedBytes / Math.max(1, archiveBytes) > limits.maxCompressionRatio) {
    fail(
      "LIMIT_EXCEEDED",
      "The source archive has an unsafe compression ratio.",
    );
  }
}

function stripRepositoryWrapper(records) {
  const roots = new Set(records.map((record) => record.raw.split("/")[0]));
  if (roots.size !== 1) {
    fail("UNSAFE_ARCHIVE", "The repository archive has no single root.");
  }
  const wrapper = [...roots][0];
  for (const record of records) {
    record.relative =
      record.raw === wrapper ? "" : record.raw.slice(wrapper.length + 1);
  }
}

function isAtOrBelow(candidate, root) {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function addParents(selected, relative) {
  let current = path.posix.dirname(relative);
  while (current && current !== ".") {
    selected.add(current);
    current = path.posix.dirname(current);
  }
}

function selectRecords(records, roots) {
  const byPath = new Map(
    records.filter((row) => row.relative).map((row) => [row.relative, row]),
  );
  const selected = new Set();
  for (const record of byPath.values()) {
    if (roots.some((root) => isAtOrBelow(record.relative, root))) {
      selected.add(record.relative);
      addParents(selected, record.relative);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const relative of [...selected]) {
      const record = byPath.get(relative);
      if (record?.type !== "symlink") {
        continue;
      }
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(relative), record.linkTarget),
      );
      if (
        !record.linkTarget ||
        record.linkTarget.includes("\0") ||
        record.linkTarget.includes("\\") ||
        path.posix.isAbsolute(record.linkTarget) ||
        target === ".." ||
        target.startsWith("../") ||
        !byPath.has(target)
      ) {
        fail(
          "UNSAFE_ARCHIVE",
          `A source symlink escapes its archive: ${relative}.`,
        );
      }
      for (const candidate of byPath.keys()) {
        if (isAtOrBelow(candidate, target) && !selected.has(candidate)) {
          selected.add(candidate);
          addParents(selected, candidate);
          changed = true;
        }
      }
    }
  }
  for (const relative of selected) {
    let parent = path.posix.dirname(relative);
    while (parent && parent !== ".") {
      if (byPath.get(parent)?.type === "symlink") {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive member traverses a symlink: ${relative}.`,
        );
      }
      parent = path.posix.dirname(parent);
    }
  }
  return selected;
}

async function inspectTar(archivePath, limits, signal) {
  throwIfAborted(signal);
  const records = [];
  try {
    await new Promise((resolve, reject) => {
      const parser = new tar.Parser({ strict: true });
      const input = fs.createReadStream(archivePath);
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const abort = () => {
        const error = new CuratedSourceError(
          "ABORTED",
          "Curated source acquisition was cancelled.",
          signal?.reason ? { cause: signal.reason } : undefined,
        );
        input.destroy();
        parser.abort(error);
        finish(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      input.on("error", finish);
      parser.on("error", finish);
      parser.on("end", () => finish());
      parser.on("entry", (entry) => {
        try {
          const raw = validateArchivePath(entry.path, limits);
          const type = ["File", "OldFile", "ContiguousFile"].includes(
            entry.type,
          )
            ? "file"
            : entry.type === "Directory"
              ? "directory"
              : entry.type === "SymbolicLink"
                ? "symlink"
                : null;
          if (!type) {
            fail(
              "UNSAFE_ARCHIVE",
              `The source archive has a ${entry.type || "special"} entry.`,
            );
          }
          records.push({
            raw,
            type,
            size: Number(entry.size),
            linkTarget: entry.linkpath,
            archiveType: entry.type,
          });
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
    if (error instanceof CuratedSourceError) {
      throw error;
    }
    fail("INVALID_ARCHIVE", "The repository source archive is invalid.", error);
  }
  checkRecords(records, limits, (await fsPromises.stat(archivePath)).size);
  stripRepositoryWrapper(records);
  return records;
}

async function createSymlinks(destination, records, selected, signal) {
  const canonicalRoot = await fsPromises.realpath(destination);
  for (const record of records
    .filter((row) => row.type === "symlink" && selected.has(row.relative))
    .sort((left, right) => (left.relative < right.relative ? -1 : 1))) {
    throwIfAborted(signal);
    const targetPath = path.resolve(
      canonicalRoot,
      ...record.relative.split("/"),
    );
    const parent = path.dirname(targetPath);
    const parentStat = await fsPromises.lstat(parent);
    const canonicalParent = await fsPromises.realpath(parent);
    const resolvedLink = path.resolve(parent, record.linkTarget);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      !isWithin(canonicalRoot, targetPath) ||
      !isWithin(canonicalRoot, resolvedLink) ||
      !isWithin(canonicalRoot, canonicalParent)
    ) {
      fail(
        "UNSAFE_ARCHIVE",
        `A source symlink has an unsafe target: ${record.relative}.`,
      );
    }
    await fsPromises.symlink(record.linkTarget, targetPath);
  }
}

async function extractRepositoryTar(
  archivePath,
  destination,
  roots,
  limits,
  signal,
) {
  const records = await inspectTar(archivePath, limits, signal);
  const selected = selectRecords(records, roots);
  if (!selected.size) {
    fail("INTEGRITY_FAILED", "The repository archive lacks its pinned inputs.");
  }
  const byRaw = new Map(records.map((record) => [record.raw, record]));
  await fsPromises.mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    const options = {
      cwd: destination,
      strip: 1,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      noMtime: true,
      chmod: false,
      keep: true,
      dmode: 0o700,
      fmode: 0o600,
      umask: 0o077,
      filter(entryPath, entry) {
        const raw = validateArchivePath(entryPath, limits);
        const record = byRaw.get(raw);
        return Boolean(
          record &&
          record.archiveType === entry.type &&
          record.relative &&
          selected.has(record.relative) &&
          record.type !== "symlink",
        );
      },
    };
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(archivePath);
      const unpacker = tar.extract(options);
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const abort = () => {
        const error = new CuratedSourceError(
          "ABORTED",
          "Curated source acquisition was cancelled.",
          signal?.reason ? { cause: signal.reason } : undefined,
        );
        input.destroy();
        unpacker.abort(error);
        finish(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      input.on("error", finish);
      unpacker.on("error", finish);
      unpacker.on("finish", () => finish());
      input.pipe(unpacker);
    });
    throwIfAborted(signal);
    await createSymlinks(destination, records, selected, signal);
  } catch (error) {
    if (error instanceof CuratedSourceError) {
      throw error;
    }
    fail(
      "INVALID_ARCHIVE",
      "The repository source could not be extracted safely.",
      error,
    );
  }
}

function readZipEntry(zip, entry, maximumBytes, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        return reject(error);
      }
      const chunks = [];
      let received = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const abort = () => {
        stream.destroy();
        finish(
          new CuratedSourceError(
            "ABORTED",
            "Curated source acquisition was cancelled.",
            signal?.reason ? { cause: signal.reason } : undefined,
          ),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("data", (chunk) => {
        received += chunk.length;
        if (received > maximumBytes) {
          stream.destroy(
            new CuratedSourceError(
              "LIMIT_EXCEEDED",
              "A source ZIP entry is unexpectedly large.",
            ),
          );
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("error", (streamError) => finish(streamError));
      stream.on("end", () => finish(null, Buffer.concat(chunks, received)));
    });
  });
}

async function inspectZip(archivePath, limits, signal) {
  throwIfAborted(signal);
  let zip;
  try {
    zip = await openZip(archivePath, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    fail("INVALID_ARCHIVE", "The GNOME-Look source archive is invalid.", error);
  }
  const records = [];
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const abort = () => {
        zip.close();
        finish(
          new CuratedSourceError(
            "ABORTED",
            "Curated source acquisition was cancelled.",
            signal?.reason ? { cause: signal.reason } : undefined,
          ),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      zip.on("error", finish);
      zip.on("end", () => finish());
      zip.on("entry", (entry) => {
        try {
          const raw = validateArchivePath(entry.fileName, limits);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          const directory = entry.fileName.endsWith("/");
          const type =
            directory || fileType === 0o040000
              ? "directory"
              : fileType === 0o120000
                ? "symlink"
                : fileType === 0 || fileType === 0o100000
                  ? "file"
                  : null;
          if (!type) {
            fail(
              "UNSAFE_ARCHIVE",
              `The source ZIP has a special entry: ${raw}.`,
            );
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            fail(
              "UNSUPPORTED_ARCHIVE",
              "Encrypted source archives are unsupported.",
            );
          }
          records.push({
            raw,
            relative: raw,
            type,
            size: Number(entry.uncompressedSize),
            entry,
            linkTarget: null,
          });
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
    checkRecords(records, limits, (await fsPromises.stat(archivePath)).size);
    for (const record of records) {
      if (record.type === "symlink") {
        record.linkTarget = (
          await readZipEntry(zip, record.entry, 4_096, signal)
        ).toString("utf8");
      }
    }
    return { zip, records };
  } catch (error) {
    zip.close();
    if (error instanceof CuratedSourceError) {
      throw error;
    }
    fail("INVALID_ARCHIVE", "The GNOME-Look source archive is invalid.", error);
  }
}

async function extractZipFile(zip, entry, destination, signal) {
  throwIfAborted(signal);
  await fsPromises.mkdir(path.dirname(destination), {
    recursive: true,
    mode: 0o700,
  });
  await new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, input) => {
      if (error) {
        return reject(error);
      }
      const output = fs.createWriteStream(destination, {
        flags: "wx",
        mode: 0o600,
      });
      let settled = false;
      const finish = (streamError) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (streamError) {
          reject(streamError);
        } else {
          resolve();
        }
      };
      const abort = () => {
        input.destroy();
        output.destroy();
        finish(
          new CuratedSourceError(
            "ABORTED",
            "Curated source acquisition was cancelled.",
            signal?.reason ? { cause: signal.reason } : undefined,
          ),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      input.on("error", finish);
      output.on("error", finish);
      output.on("finish", () => finish());
      input.pipe(output);
    });
  });
}

async function extractGnomeZip(archivePath, destination, limits, signal) {
  const { zip, records } = await inspectZip(archivePath, limits, signal);
  try {
    const cursorRoots = records
      .filter(
        (record) =>
          record.type === "directory" &&
          path.posix.basename(record.relative) === "cursors",
      )
      .map((record) => record.relative);
    if (!cursorRoots.length) {
      fail("INTEGRITY_FAILED", "The GNOME-Look archive has no cursor tree.");
    }
    const selected = selectRecords(records, cursorRoots);
    await fsPromises.mkdir(destination, { recursive: true, mode: 0o700 });
    const canonicalDestination = path.resolve(destination);
    for (const record of records) {
      throwIfAborted(signal);
      if (!selected.has(record.relative) || record.type === "symlink") {
        continue;
      }
      const target = path.resolve(
        canonicalDestination,
        ...record.relative.split("/"),
      );
      if (!isWithin(canonicalDestination, target)) {
        fail(
          "UNSAFE_ARCHIVE",
          `A source ZIP entry escaped: ${record.relative}.`,
        );
      }
      if (record.type === "directory") {
        await fsPromises.mkdir(target, { recursive: true, mode: 0o700 });
      } else {
        await extractZipFile(zip, record.entry, target, signal);
      }
    }
    await createSymlinks(destination, records, selected, signal);
  } finally {
    zip.close();
  }
}

function updateDigest(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function collectTreeEntries(root, inputRoots, signal) {
  throwIfAborted(signal);
  const canonicalRoot = await fsPromises.realpath(root);
  const entries = new Map();
  const pending = [...inputRoots];
  const visited = new Set();
  while (pending.length) {
    throwIfAborted(signal);
    const relative = pending.shift();
    if (visited.has(relative)) {
      continue;
    }
    visited.add(relative);
    const target =
      relative === "."
        ? canonicalRoot
        : path.resolve(canonicalRoot, ...relative.split("/"));
    if (!isWithin(canonicalRoot, target)) {
      fail("UNSAFE_CACHE", `A cached source path escaped: ${relative}.`);
    }
    let stat;
    try {
      stat = await fsPromises.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail(
          "INTEGRITY_FAILED",
          `A source input is missing: ${relative}.`,
          error,
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const linkTarget = await fsPromises.readlink(target);
      const normalizedTarget = path.posix.normalize(
        path.posix.join(path.posix.dirname(relative), linkTarget),
      );
      if (
        !linkTarget ||
        linkTarget.includes("\0") ||
        linkTarget.includes("\\") ||
        path.posix.isAbsolute(linkTarget) ||
        normalizedTarget === ".." ||
        normalizedTarget.startsWith("../")
      ) {
        fail("UNSAFE_CACHE", `A cached source symlink escapes: ${relative}.`);
      }
      entries.set(relative, { type: "l", payload: Buffer.from(linkTarget) });
      pending.push(normalizedTarget);
    } else if (stat.isFile()) {
      entries.set(relative, {
        type: "f",
        path: target,
        size: stat.size,
      });
    } else if (stat.isDirectory()) {
      for (const child of (await fsPromises.readdir(target)).sort()) {
        const childRelative = relative === "." ? child : `${relative}/${child}`;
        if (childRelative !== MARKER) {
          pending.push(childRelative);
        }
      }
    } else {
      fail("UNSAFE_CACHE", `A cached source has a special file: ${relative}.`);
    }
  }
  return { canonicalRoot, entries };
}

export async function computeCuratedTreeDigest(
  root,
  inputRoots,
  { signal } = {},
) {
  const normalizedRoots = inputRoots.map((entry, index) =>
    validateRelativePath(entry, `tree root ${index}`, { allowRoot: true }),
  );
  const { entries } = await collectTreeEntries(root, normalizedRoots, signal);
  const hash = crypto.createHash("sha256");
  for (const [relative, entry] of [...entries.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    throwIfAborted(signal);
    updateDigest(hash, relative);
    hash.update(entry.type);
    if (entry.type === "l") {
      updateDigest(hash, entry.payload);
      continue;
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(entry.size));
    hash.update(length);
    let received = 0;
    for await (const chunk of fs.createReadStream(entry.path)) {
      throwIfAborted(signal);
      received += chunk.length;
      hash.update(chunk);
    }
    if (received !== entry.size) {
      fail(
        "INTEGRITY_FAILED",
        `A source input changed while verifying: ${relative}.`,
      );
    }
  }
  return Object.freeze({ sha256: hash.digest("hex"), entries: entries.size });
}

async function verifyNoUnexpectedEntries(root, inputRoots, signal) {
  const { canonicalRoot, entries } = await collectTreeEntries(
    root,
    inputRoots,
    signal,
  );
  const allowed = new Set(entries.keys());
  const visit = async (directory, relativeDirectory = "") => {
    for (const name of await fsPromises.readdir(directory)) {
      throwIfAborted(signal);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      if (relative === MARKER) {
        continue;
      }
      const target = path.join(directory, name);
      const stat = await fsPromises.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(target, relative);
      } else if (!allowed.has(relative)) {
        fail(
          "INTEGRITY_FAILED",
          `The source cache has an unexpected file: ${relative}.`,
        );
      }
    }
  };
  await visit(canonicalRoot);
}

async function sha256File(filePath, signal) {
  throwIfAborted(signal);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fetchHttps(url, fetchImpl, accept, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: accept,
        "User-Agent": "CursorAtelier-source-acquirer/1",
      },
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    fail(
      "DOWNLOAD_FAILED",
      "An upstream cursor source could not be downloaded.",
      error,
    );
  }
  if (!response?.ok) {
    fail(
      "DOWNLOAD_FAILED",
      "An upstream cursor source could not be downloaded.",
    );
  }
  if (response.url) {
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch (error) {
      fail(
        "DOWNLOAD_FAILED",
        "An upstream source returned an invalid URL.",
        error,
      );
    }
    if (finalUrl.protocol !== "https:") {
      fail("DOWNLOAD_FAILED", "An upstream source redirected insecurely.");
    }
  }
  return response;
}

async function responseBytes(response, maximumBytes, signal) {
  const chunks = [];
  let received = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("LIMIT_EXCEEDED", "An upstream source response is too large.");
      }
      chunks.push(chunk);
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length > maximumBytes) {
      fail("LIMIT_EXCEEDED", "An upstream source response is too large.");
    }
    chunks.push(chunk);
    received = chunk.length;
  }
  return Buffer.concat(chunks, received);
}

async function downloadToFile(
  url,
  destination,
  limits,
  fetchImpl,
  onBytes,
  signal,
) {
  throwIfAborted(signal);
  const response = await fetchHttps(
    url,
    fetchImpl,
    "application/octet-stream",
    signal,
  );
  const contentLength = response.headers?.get?.("content-length")?.trim();
  const declared = contentLength ? Number(contentLength) : null;
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > limits.maxArchiveBytes)
  ) {
    fail("LIMIT_EXCEEDED", "The upstream source archive is too large.");
  }
  const output = await fsPromises.open(destination, "wx", 0o600);
  let received = 0;
  try {
    const write = async (chunk) => {
      throwIfAborted(signal);
      received += chunk.length;
      if (received > limits.maxArchiveBytes) {
        fail("LIMIT_EXCEEDED", "The upstream source archive is too large.");
      }
      await output.write(chunk);
      onBytes?.(received, declared);
    };
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await write(Buffer.from(value));
      }
    } else {
      await write(Buffer.from(await response.arrayBuffer()));
    }
    if (!received) {
      fail("DOWNLOAD_FAILED", "The upstream source archive was empty.");
    }
  } catch (error) {
    await output.close().catch(() => undefined);
    await fsPromises.unlink(destination).catch(() => undefined);
    throwIfAborted(signal);
    throw error;
  }
  await output.close();
}

async function canonicalDirectory(directory, label) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    fail("UNSAFE_CACHE", `${label} must be an absolute directory.`);
  }
  const stat = await fsPromises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_CACHE", `${label} must be a regular directory.`);
  }
  return fsPromises.realpath(directory);
}

async function copyLocalArchive(localRoot, relative, destination, signal) {
  throwIfAborted(signal);
  const sourcePath = path.resolve(localRoot, ...relative.split("/"));
  if (!isWithin(localRoot, sourcePath)) {
    fail("UNSAFE_SOURCE", "A local source archive escaped its injected root.");
  }
  const stat = await fsPromises.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("UNSAFE_SOURCE", `The local source archive is unsafe: ${relative}.`);
  }
  const canonicalSource = await fsPromises.realpath(sourcePath);
  if (!isWithin(localRoot, canonicalSource)) {
    fail(
      "UNSAFE_SOURCE",
      `The local source archive escaped its root: ${relative}.`,
    );
  }
  const output = await fsPromises.open(destination, "wx", 0o600);
  try {
    for await (const chunk of fs.createReadStream(canonicalSource)) {
      throwIfAborted(signal);
      await output.write(chunk);
    }
  } catch (error) {
    await output.close().catch(() => undefined);
    await fsPromises.unlink(destination).catch(() => undefined);
    throw error;
  }
  await output.close();
}

async function stageArchive({
  source,
  destination,
  fetchImpl,
  localRoot,
  url,
  localRelative,
  onBytes,
  signal,
}) {
  if (localRoot) {
    await copyLocalArchive(localRoot, localRelative, destination, signal);
    const stat = await fsPromises.stat(destination);
    if (stat.size < 1 || stat.size > source.limits.maxArchiveBytes) {
      fail("LIMIT_EXCEEDED", "The local source archive is unexpectedly large.");
    }
    onBytes?.(stat.size, stat.size);
    return;
  }
  await downloadToFile(
    url,
    destination,
    source.limits,
    fetchImpl,
    onBytes,
    signal,
  );
}

function markerValue(catalog, source) {
  return {
    schemaVersion: 1,
    cacheVersion: catalog.cacheVersion,
    sourceId: source.id,
    sourceType: source.type,
    revision: source.revision ?? null,
  };
}

async function writeMarker(root, catalog, source) {
  await fsPromises.writeFile(
    path.join(root, MARKER),
    `${JSON.stringify(markerValue(catalog, source), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function readOwnershipMarker(root, source) {
  let marker;
  try {
    const markerStat = await fsPromises.lstat(path.join(root, MARKER));
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      fail("UNSAFE_CACHE", `The cached ${source.id} source marker is unsafe.`);
    }
    marker = JSON.parse(
      await fsPromises.readFile(path.join(root, MARKER), "utf8"),
    );
  } catch (error) {
    if (error instanceof CuratedSourceError) {
      throw error;
    }
    fail(
      "UNSAFE_CACHE",
      `The cached ${source.id} source is not owned by this catalog.`,
      error,
    );
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.sourceId !== source.id ||
    marker.sourceType !== source.type
  ) {
    fail(
      "UNSAFE_CACHE",
      `The cached ${source.id} source is not owned by this catalog.`,
    );
  }
  return marker;
}

async function verifyMarker(root, catalog, source) {
  const marker = await readOwnershipMarker(root, source);
  if (JSON.stringify(marker) !== JSON.stringify(markerValue(catalog, source))) {
    fail("INTEGRITY_FAILED", `The cached ${source.id} source marker is stale.`);
  }
}

async function verifyCachedSource(root, catalog, source, signal) {
  throwIfAborted(signal);
  const stat = await fsPromises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_CACHE", `The cached ${source.id} source is unsafe.`);
  }
  await verifyMarker(root, catalog, source);
  if (source.type === "repository") {
    const digest = await computeCuratedTreeDigest(root, source.inputRoots, {
      signal,
    });
    if (
      digest.sha256 !== source.treeSha256 ||
      digest.entries !== source.treeEntries
    ) {
      fail("INTEGRITY_FAILED", `The cached ${source.id} inputs are invalid.`);
    }
    await verifyNoUnexpectedEntries(root, source.inputRoots, signal);
    return;
  }
  const expandedRoot = path.join(root, "expanded");
  const expected = new Set(
    source.archives.map((archive) => path.parse(archive.name).name),
  );
  const actual = await fsPromises.readdir(expandedRoot);
  if (
    actual.length !== expected.size ||
    actual.some((name) => !expected.has(name))
  ) {
    fail("INTEGRITY_FAILED", `The cached ${source.id} archive set is invalid.`);
  }
  for (const archive of source.archives) {
    const expanded = path.join(expandedRoot, path.parse(archive.name).name);
    const digest = await computeCuratedTreeDigest(expanded, ["."], { signal });
    if (
      digest.sha256 !== archive.treeSha256 ||
      digest.entries !== archive.treeEntries
    ) {
      fail(
        "INTEGRITY_FAILED",
        `The cached ${source.id}/${archive.name} tree is invalid.`,
      );
    }
    await verifyNoUnexpectedEntries(expanded, ["."], signal);
  }
}

async function acquireRepositorySource({
  source,
  temporary,
  fetchImpl,
  localRoot,
  report,
  signal,
}) {
  const archive = path.join(temporary, ".upstream.tar.gz");
  report("downloading", 0);
  await stageArchive({
    source,
    destination: archive,
    fetchImpl,
    localRoot,
    url: source.archiveUrl,
    localRelative: `${source.id}.tar.gz`,
    onBytes(received, total) {
      report(
        "downloading",
        total > 0 ? Math.min(0.99, received / total) : null,
      );
    },
    signal,
  });
  const extraction = path.join(temporary, ".extracted");
  report("extracting", 0);
  await extractRepositoryTar(
    archive,
    extraction,
    source.inputRoots,
    source.limits,
    signal,
  );
  await fsPromises.unlink(archive);
  for (const name of await fsPromises.readdir(extraction)) {
    await fsPromises.rename(
      path.join(extraction, name),
      path.join(temporary, name),
    );
  }
  await fsPromises.rmdir(extraction);
  report("verifying", 0);
  const digest = await computeCuratedTreeDigest(temporary, source.inputRoots, {
    signal,
  });
  if (
    digest.sha256 !== source.treeSha256 ||
    digest.entries !== source.treeEntries
  ) {
    fail("INTEGRITY_FAILED", `The downloaded ${source.id} inputs are invalid.`);
  }
  await verifyNoUnexpectedEntries(temporary, source.inputRoots, signal);
}

async function gnomeDownloadUrls(source, fetchImpl, signal) {
  const response = await fetchHttps(
    source.metadataUrl,
    fetchImpl,
    "application/json",
    signal,
  );
  let payload;
  try {
    payload = JSON.parse(
      (await responseBytes(response, 5 * 1024 * 1024, signal)).toString("utf8"),
    );
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof CuratedSourceError) {
      throw error;
    }
    fail("DOWNLOAD_FAILED", "GNOME-Look returned invalid metadata.", error);
  }
  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  if (!data || Number(data.id) !== source.productId) {
    fail("INTEGRITY_FAILED", "GNOME-Look returned the wrong product metadata.");
  }
  const urls = new Map();
  for (let index = 1; index < 100; index += 1) {
    const name = data[`downloadname${index}`];
    const url = data[`downloadlink${index}`];
    if (name && url) {
      urls.set(
        String(name),
        validateHttps(String(url), `${source.id}/${name} download URL`),
      );
    }
  }
  return urls;
}

async function acquireGnomeSource({
  source,
  temporary,
  fetchImpl,
  localRoot,
  report,
  signal,
}) {
  const urls = localRoot
    ? null
    : await gnomeDownloadUrls(source, fetchImpl, signal);
  const expandedRoot = path.join(temporary, "expanded");
  await fsPromises.mkdir(expandedRoot, { mode: 0o700 });
  for (let index = 0; index < source.archives.length; index += 1) {
    throwIfAborted(signal);
    const archive = source.archives[index];
    const url = urls?.get(archive.name);
    if (!localRoot && !url) {
      fail("INTEGRITY_FAILED", `GNOME-Look no longer lists ${archive.name}.`);
    }
    const archivePath = path.join(temporary, `.archive-${index}.zip`);
    report("downloading", index / source.archives.length, archive.name);
    await stageArchive({
      source,
      destination: archivePath,
      fetchImpl,
      localRoot,
      url,
      localRelative: `${source.id}/${archive.name}`,
      signal,
    });
    if ((await sha256File(archivePath, signal)) !== archive.sha256) {
      fail(
        "INTEGRITY_FAILED",
        `${archive.name} differs from its pinned archive.`,
      );
    }
    const expanded = path.join(expandedRoot, path.parse(archive.name).name);
    report("extracting", index / source.archives.length, archive.name);
    await extractGnomeZip(archivePath, expanded, source.limits, signal);
    await fsPromises.unlink(archivePath);
    const digest = await computeCuratedTreeDigest(expanded, ["."], { signal });
    if (
      digest.sha256 !== archive.treeSha256 ||
      digest.entries !== archive.treeEntries
    ) {
      fail(
        "INTEGRITY_FAILED",
        `${archive.name} has an invalid extracted tree.`,
      );
    }
  }
  report("verifying", 0);
}

async function canonicalCacheRoot(cacheRoot) {
  if (typeof cacheRoot !== "string" || !path.isAbsolute(cacheRoot)) {
    fail("UNSAFE_CACHE", "The curated source cache root must be absolute.");
  }
  await fsPromises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const stat = await fsPromises.lstat(cacheRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_CACHE", "The curated source cache root is unsafe.");
  }
  return fsPromises.realpath(cacheRoot);
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function isPrivateDirectory(stat) {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    ownedByCurrentUser(stat) &&
    (stat.mode & 0o077) === 0
  );
}

function classifySourceTransaction(name, sources) {
  for (const source of sources) {
    for (const [kind, separator, suffixPattern] of [
      ["acquiring", "-acquiring-", ACQUISITION_SUFFIX],
      ["replaced", "-replaced-", REPLACEMENT_SUFFIX],
    ]) {
      const prefix = `.${source.directory}${separator}`;
      if (!name.startsWith(prefix)) {
        continue;
      }
      return {
        source,
        kind,
        validName: suffixPattern.test(name.slice(prefix.length)),
      };
    }
  }
  return null;
}

function sourceTransactionLimits(source) {
  const archiveCount = Math.max(1, source.archives?.length ?? 1);
  return {
    entries: source.limits.maxEntries * archiveCount + 1_024,
    bytes:
      source.limits.maxExpandedBytes * archiveCount +
      source.limits.maxArchiveBytes +
      64 * 1024,
  };
}

async function inspectSourceTransaction(root, transactionPath, source) {
  if (
    path.dirname(transactionPath) !== root ||
    !path.basename(transactionPath).startsWith(`.${source.directory}-`)
  ) {
    fail("UNSAFE_CACHE", "A curated source transaction escaped its cache.");
  }
  const limits = sourceTransactionLimits(source);
  const inspected = [];
  const pending = [transactionPath];
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    const relative = path.relative(transactionPath, current);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("UNSAFE_CACHE", "A curated source transaction path escaped.");
    }
    const stat = await fsPromises.lstat(current);
    if (!ownedByCurrentUser(stat)) {
      fail(
        "UNSAFE_CACHE",
        "A curated source transaction contains foreign-owned data.",
      );
    }
    if (current === transactionPath && !isPrivateDirectory(stat)) {
      fail("UNSAFE_CACHE", "A curated source transaction is not private.");
    }
    if (stat.isSymbolicLink()) {
      inspected.push({ path: current, stat, type: "link" });
    } else if (stat.isDirectory()) {
      inspected.push({ path: current, stat, type: "directory" });
      for (const name of await fsPromises.readdir(current)) {
        pending.push(path.join(current, name));
      }
    } else if (stat.isFile() && stat.nlink === 1) {
      bytes += stat.size;
      inspected.push({ path: current, stat, type: "file" });
    } else {
      fail(
        "UNSAFE_CACHE",
        "A curated source transaction contains unsafe filesystem data.",
      );
    }
    if (inspected.length > limits.entries || bytes > limits.bytes) {
      fail("UNSAFE_CACHE", "A curated source transaction exceeds its limits.");
    }
  }
  return inspected.sort(
    (left, right) =>
      right.path.split(path.sep).length - left.path.split(path.sep).length,
  );
}

async function removeInspectedSourceTransaction(inspected) {
  for (const entry of inspected) {
    const stat = await fsPromises.lstat(entry.path);
    if (
      stat.dev !== entry.stat.dev ||
      stat.ino !== entry.stat.ino ||
      !ownedByCurrentUser(stat) ||
      (entry.type === "directory" &&
        (!stat.isDirectory() || stat.isSymbolicLink())) ||
      (entry.type === "file" && (!stat.isFile() || stat.nlink !== 1)) ||
      (entry.type === "link" && !stat.isSymbolicLink())
    ) {
      fail(
        "UNSAFE_CACHE",
        "A curated source transaction changed during cleanup.",
      );
    }
    if (entry.type === "directory") {
      await fsPromises.rmdir(entry.path);
    } else {
      await fsPromises.unlink(entry.path);
    }
  }
}

function pathExistsNoFollow(target) {
  return fsPromises.lstat(target).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

/**
 * Reconcile source-cache transactions interrupted by process termination.
 * This is intended to run before any acquisition work starts.
 */
export async function reconcileCuratedSourceTransactions({
  cacheRoot,
  catalog = CURATED_SOURCE_CATALOG,
} = {}) {
  const trustedCatalog =
    catalog === CURATED_SOURCE_CATALOG
      ? catalog
      : validateCuratedSourceCatalog(catalog);
  const canonicalRoot = await canonicalCacheRoot(cacheRoot);
  const rootStat = await fsPromises.lstat(canonicalRoot);
  if (!ownedByCurrentUser(rootStat)) {
    fail("UNSAFE_CACHE", "The curated source cache is foreign-owned.");
  }

  const groups = new Map(
    trustedCatalog.sources.map((source) => [
      source.id,
      { source, acquiring: [], replaced: [] },
    ]),
  );
  const pending = new Set();
  for (const name of (await fsPromises.readdir(canonicalRoot)).sort()) {
    const transaction = classifySourceTransaction(name, trustedCatalog.sources);
    if (!transaction) {
      continue;
    }
    if (!transaction.validName) {
      pending.add(name);
      continue;
    }
    groups.get(transaction.source.id)[transaction.kind].push(name);
  }

  const restored = [];
  const removed = [];
  for (const { source, acquiring, replaced } of groups.values()) {
    const key = `${canonicalRoot}\0${source.id}`;
    if (inFlight.has(key)) {
      continue;
    }
    const destination = path.join(canonicalRoot, source.directory);
    let destinationValid = false;
    if (await pathExistsNoFollow(destination)) {
      try {
        const stat = await fsPromises.lstat(destination);
        if (!ownedByCurrentUser(stat)) {
          fail(
            "UNSAFE_CACHE",
            `The cached ${source.id} source is foreign-owned.`,
          );
        }
        await verifyCachedSource(destination, trustedCatalog, source);
        destinationValid = true;
      } catch {
        for (const name of replaced) {
          pending.add(name);
        }
      }
    } else if (replaced.length === 1) {
      const name = replaced[0];
      const backup = path.join(canonicalRoot, name);
      try {
        await inspectSourceTransaction(canonicalRoot, backup, source);
        await verifyCachedSource(backup, trustedCatalog, source);
        await fsPromises.rename(backup, destination);
        restored.push(source.id);
        destinationValid = true;
      } catch {
        pending.add(name);
      }
    } else if (replaced.length > 1) {
      for (const name of replaced) {
        pending.add(name);
      }
    }

    if (destinationValid) {
      for (const name of replaced) {
        const backup = path.join(canonicalRoot, name);
        if (!(await pathExistsNoFollow(backup))) {
          continue;
        }
        try {
          const inspected = await inspectSourceTransaction(
            canonicalRoot,
            backup,
            source,
          );
          await readOwnershipMarker(backup, source);
          await removeInspectedSourceTransaction(inspected);
          removed.push(name);
        } catch {
          pending.add(name);
        }
      }
    }

    for (const name of acquiring) {
      const temporary = path.join(canonicalRoot, name);
      try {
        const inspected = await inspectSourceTransaction(
          canonicalRoot,
          temporary,
          source,
        );
        await removeInspectedSourceTransaction(inspected);
        removed.push(name);
      } catch {
        pending.add(name);
      }
    }
  }

  return Object.freeze({
    restored: Object.freeze(restored),
    removed: Object.freeze(removed),
    pending: Object.freeze([...pending].sort()),
    cleanupPending: pending.size > 0,
  });
}

async function installTransactional(temporary, destination, cacheRoot, source) {
  let backup = null;
  try {
    const existing = await fsPromises.lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail(
        "UNSAFE_CACHE",
        `A curated cache destination is unsafe: ${destination}.`,
      );
    }
    await readOwnershipMarker(destination, source);
    backup = path.join(
      cacheRoot,
      `.${path.basename(destination)}-replaced-${crypto.randomUUID()}`,
    );
    await fsPromises.rename(destination, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fsPromises.rename(temporary, destination);
  } catch (error) {
    if (backup) {
      await fsPromises.rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
  if (backup) {
    await fsPromises.rm(backup, { recursive: true });
  }
}

async function acquireOneSource({
  catalog,
  source,
  cacheRoot,
  fetchImpl,
  localRoot,
  onProgress,
  familyIds,
  signal,
}) {
  throwIfAborted(signal);
  const destination = path.join(cacheRoot, source.directory);
  if (path.dirname(destination) !== cacheRoot) {
    fail("UNSAFE_CACHE", "A source destination escaped its cache root.");
  }
  try {
    await verifyCachedSource(destination, catalog, source, signal);
    onProgress?.({
      sourceId: source.id,
      familyIds,
      phase: "cached",
      progress: 1,
    });
    return destination;
  } catch (error) {
    if (error instanceof CuratedSourceError && error.code === "UNSAFE_CACHE") {
      throw error;
    }
    if (error?.code !== "ENOENT" && !(error instanceof CuratedSourceError)) {
      throw error;
    }
  }
  const prefix = `.${source.directory}-acquiring-`;
  const temporary = await fsPromises.mkdtemp(path.join(cacheRoot, prefix));
  const report = (phase, progress, archiveName) =>
    onProgress?.({
      sourceId: source.id,
      familyIds,
      phase,
      progress,
      archiveName,
    });
  try {
    if (source.type === "repository") {
      await acquireRepositorySource({
        source,
        temporary,
        fetchImpl,
        localRoot,
        report,
        signal,
      });
    } else {
      await acquireGnomeSource({
        source,
        temporary,
        fetchImpl,
        localRoot,
        report,
        signal,
      });
    }
    throwIfAborted(signal);
    await writeMarker(temporary, catalog, source);
    await verifyCachedSource(temporary, catalog, source, signal);
    throwIfAborted(signal);
    await installTransactional(temporary, destination, cacheRoot, source);
    report("complete", 1);
    return destination;
  } finally {
    try {
      const stat = await fsPromises.lstat(temporary);
      if (
        !stat.isSymbolicLink() &&
        path.dirname(temporary) === cacheRoot &&
        path.basename(temporary).startsWith(prefix)
      ) {
        await fsPromises.rm(temporary, { recursive: true });
      }
    } catch {
      // The source was either atomically installed or is an app-owned,
      // uniquely named temporary. A later cache cleanup may remove leftovers.
    }
  }
}

function selectCatalogEntries(catalog, familyIds) {
  if (!Array.isArray(familyIds) || !familyIds.length) {
    throw new TypeError("At least one curated family ID is required.");
  }
  const uniqueFamilyIds = [...new Set(familyIds)];
  const families = uniqueFamilyIds.map((familyId) => {
    const family = catalog.families.find((row) => row.id === familyId);
    if (!family) {
      throw new TypeError(`Unknown curated family: ${familyId}.`);
    }
    return family;
  });
  const sourceIds = [
    ...new Set(families.flatMap((family) => family.sourceIds)),
  ];
  return {
    familyIds: uniqueFamilyIds,
    families,
    sources: sourceIds.map((sourceId) =>
      catalog.sources.find((source) => source.id === sourceId),
    ),
  };
}

/**
 * Populate converter-compatible source roots without git or ambient tools.
 * For deterministic offline runs, `localArchiveRoot` may be injected with
 * `<source-id>.tar.gz` and `<gnome-source-id>/<archive-name>` files. Identical
 * integrity locks apply.
 */
export async function acquireCuratedFamilySources({
  familyIds,
  cacheRoot,
  catalog = CURATED_SOURCE_CATALOG,
  fetchImpl = globalThis.fetch,
  localArchiveRoot,
  onProgress,
  signal,
} = {}) {
  throwIfAborted(signal);
  const trustedCatalog =
    catalog === CURATED_SOURCE_CATALOG
      ? catalog
      : validateCuratedSourceCatalog(catalog);
  const selected = selectCatalogEntries(trustedCatalog, familyIds);
  const canonicalRoot = await canonicalCacheRoot(cacheRoot);
  const localRoot = localArchiveRoot
    ? await canonicalDirectory(
        localArchiveRoot,
        "The local source archive root",
      )
    : null;
  const acquired = [];
  for (const source of selected.sources) {
    throwIfAborted(signal);
    const key = `${canonicalRoot}\0${source.id}`;
    let promise = signal ? null : inFlight.get(key);
    if (!promise) {
      const sourceFamilies = selected.families
        .filter((family) => family.sourceIds.includes(source.id))
        .map((family) => family.id);
      const acquisition = acquireOneSource({
        catalog: trustedCatalog,
        source,
        cacheRoot: canonicalRoot,
        fetchImpl,
        localRoot,
        onProgress,
        familyIds: sourceFamilies,
        signal,
      });
      promise = signal
        ? acquisition
        : acquisition.finally(() => inFlight.delete(key));
      if (!signal) {
        inFlight.set(key, promise);
      }
    }
    acquired.push(
      Object.freeze({
        sourceId: source.id,
        root: await promise,
        type: source.type,
      }),
    );
  }
  return Object.freeze({
    sourceRoot: canonicalRoot,
    families: Object.freeze([...selected.familyIds]),
    sources: Object.freeze(acquired),
  });
}

export async function removeCuratedFamilySources({
  familyIds,
  retainedFamilyIds = [],
  cacheRoot,
  catalog = CURATED_SOURCE_CATALOG,
} = {}) {
  const trustedCatalog =
    catalog === CURATED_SOURCE_CATALOG
      ? catalog
      : validateCuratedSourceCatalog(catalog);
  const selected = selectCatalogEntries(trustedCatalog, familyIds);
  const retained = retainedFamilyIds.length
    ? selectCatalogEntries(trustedCatalog, retainedFamilyIds)
    : { sources: [] };
  const retainedIds = new Set(retained.sources.map((source) => source.id));
  const canonicalRoot = await canonicalCacheRoot(cacheRoot);
  const removed = [];
  for (const source of selected.sources) {
    if (retainedIds.has(source.id)) {
      continue;
    }
    const destination = path.join(canonicalRoot, source.directory);
    if (path.dirname(destination) !== canonicalRoot) {
      fail("UNSAFE_CACHE", "A source destination escaped its cache root.");
    }
    try {
      const stat = await fsPromises.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(
          "UNSAFE_CACHE",
          `Refusing to remove an unsafe cache: ${source.id}.`,
        );
      }
      await readOwnershipMarker(destination, source);
      await fsPromises.rm(destination, { recursive: true });
      removed.push(source.id);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return Object.freeze(removed);
}
