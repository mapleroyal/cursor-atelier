import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { promisify, TextDecoder } from "node:util";

import { createDecompressStream as createXzDecompressStream } from "@napi-rs/lzma/xz";
import * as plist from "plist";
import sharp from "sharp";
import * as tar from "tar";
import UPNG from "@upng/upng-js/dist/UPNG.esm.js";
import yauzl from "yauzl";

import { sanitizeCursorManifestText } from "./cursor-manifest-text.js";
import { assertBinaryCursorPlistBudget } from "./cursor-plist-budget.js";

const openZip = promisify(yauzl.open);

import { MAC_TO_ROLE, ROLE_ALIASES } from "./cursor-roles.js";

const BASE_REPRESENTATION_SIZES = Object.freeze([32, 64, 96]);
const VECTOR_REPRESENTATION_SIZES = Object.freeze([32, 64, 96, 128]);
const MAX_MACOS_FRAMES = 24;
const WAIT_PROGRESS_THUMBNAIL_SIZE = 64;
const MACURSOR_UUID_NAMESPACE = "193513ce-4c25-4e1a-9e28-878e5850bb6e";
const XCURSOR_IMAGE_TYPE = 0xfffd0002;
const XCURSOR_VERSION = 0x00010000;
const MAX_NATIVE_CURSOR_BYTES = 32 * 1024 * 1024;
const XCURSOR_UPSCALE_TARGET = 128;
const XCURSOR_FILTER_HOLDOUT_FRACTION = 0.2;
const XCURSOR_FILTER_MAX_FRAMES_PER_ROLE = 4;
const XCURSOR_FILTER_MIN_ROLES = 8;
const XCURSOR_FILTER_MIN_HOLDOUT_ROLES = 4;
const XCURSOR_FILTER_RIDGE = 1e-4;

// Maps decoded Xcursor role tiers to a reconstruction strategy without
// changing their authentic frame/tier inventory. This lets conversion sample
// at most the 24 frames macOS can consume instead of materializing a new
// 128 px copy of every source animation frame.
const XCURSOR_RECONSTRUCTION = new WeakMap();

export const DEFAULT_IMPORT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 50_000,
  maxFiles: 40_000,
  maxPathDepth: 16,
  maxPathLength: 512,
  maxEntryBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 2_000,
  maxSymlinkBytes: 512,
  maxThemes: 256,
  maxCursorFilesPerTheme: 512,
  maxXcursorBytes: 64 * 1024 * 1024,
  maxSourceDimension: 1_024,
  maxRepresentationSize: 320,
  maxSourceFrames: 512,
  maxSourcePixelsPerFile: 64 * 1024 * 1024,
  maxDecodedSourceBytesPerVariant: 256 * 1024 * 1024,
  maxPlistBytes: 256 * 1024 * 1024,
  maxCursorOutputBytes: 32 * 1024 * 1024,
  maxGeneratedBytes: 512 * 1024 * 1024,
});

export class CursorImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CursorImportError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new CursorImportError(code, message, cause ? { cause } : undefined);
}

function mergedLimits(limits = {}) {
  const result = { ...DEFAULT_IMPORT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value <= 0) {
      fail("INVALID_OPTIONS", `Invalid import limit: ${key}.`);
    }
    result[key] = value;
  }
  return result;
}

function createDecodedSourceBudget(limits) {
  let decodedBytes = 0;
  return {
    reserve(byteLength) {
      const next = decodedBytes + byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength <= 0 ||
        next > limits.maxDecodedSourceBytesPerVariant
      ) {
        fail(
          "LIMIT_EXCEEDED",
          "A cursor variant exceeds the decoded artwork limit.",
        );
      }
      decodedBytes = next;
    },
    release(byteLength) {
      decodedBytes -= byteLength;
    },
  };
}

function normalizedCursorFilename(value) {
  let role = path.basename(String(value));
  role = role.replace(/\.(?:png|svg|cursor|spec|cur)$/i, "");
  while (/(?:[-_](?:\d{2,4})(?:x\d{2,4})?)$/.test(role)) {
    role = role.replace(/(?:[-_](?:\d{2,4})(?:x\d{2,4})?)$/, "");
  }
  return role.trim().toLowerCase().replaceAll(" ", "-");
}

function canonicalRole(value) {
  const role = normalizedCursorFilename(value);
  return ROLE_ALIASES[role] ?? role;
}

function canonicalFilenamePriority(value) {
  const normalized = normalizedCursorFilename(value);
  return normalized === canonicalRole(normalized) ? 1 : 0;
}

function selectedFrameIndices(frameCount, maximum = MAX_MACOS_FRAMES) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    fail("INVALID_CURSOR", "A cursor must contain at least one frame.");
  }
  if (frameCount <= maximum) {
    return Array.from({ length: frameCount }, (_, index) => index);
  }
  return Array.from({ length: maximum }, (_, index) =>
    Math.floor((index * frameCount) / maximum),
  );
}

function safeText(value, fallback, maximum = 96) {
  const bounded = String(value ?? "").slice(0, maximum * 16);
  const cleaned = sanitizeCursorManifestText(bounded)
    .replace(/\s+/g, " ")
    .trim();
  return [...(cleaned || fallback)].slice(0, maximum).join("");
}

function safeMetadataUrl(value, key) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 2_048) {
    fail("INVALID_OPTIONS", `Invalid import metadata: ${key}.`);
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.href.length > 2_048
    ) {
      throw new Error("unsupported URL");
    }
    return parsed.href;
  } catch {
    fail("INVALID_OPTIONS", `Invalid import metadata: ${key}.`);
  }
}

function normalizeImportMetadata(value) {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_OPTIONS", "Import metadata must be an object.");
  }
  const allowed = new Set([
    "author",
    "catalogId",
    "displayName",
    "family",
    "group",
    "license",
    "licenseUrl",
    "sourceUrl",
    "sourceVariant",
    "upstreamVariant",
    "variant",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("INVALID_OPTIONS", "Import metadata contains an unsupported field.");
  }
  const result = {};
  if (value.catalogId !== undefined) {
    if (
      typeof value.catalogId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.catalogId)
    ) {
      fail("INVALID_OPTIONS", "Invalid import metadata: catalogId.");
    }
    result.catalogId = value.catalogId;
  }
  for (const [key, maximum] of [
    ["author", 160],
    ["displayName", 96],
    ["family", 96],
    ["group", 96],
    ["license", 96],
    ["sourceVariant", 160],
    ["upstreamVariant", 160],
    ["variant", 96],
  ]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !value[key].trim()) {
        fail("INVALID_OPTIONS", `Invalid import metadata: ${key}.`);
      }
      const normalized = safeText(value[key], "", maximum);
      if (!normalized) {
        fail("INVALID_OPTIONS", `Invalid import metadata: ${key}.`);
      }
      result[key] = normalized;
    }
  }
  result.sourceUrl = safeMetadataUrl(value.sourceUrl, "sourceUrl");
  result.licenseUrl = safeMetadataUrl(value.licenseUrl, "licenseUrl");
  return Object.fromEntries(
    Object.entries(result).filter(([, entry]) => entry !== undefined),
  );
}

function titleFromName(value) {
  const words = String(value)
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words
    .split(" ")
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function slugIdentifier(value) {
  const words = String(value).match(/[A-Za-z0-9]+/g) ?? [];
  const slug = words
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join("")
    .slice(0, 48);
  return slug || "ImportedCursor";
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidV5(namespace, name) {
  const digest = crypto
    .createHash("sha1")
    .update(uuidBytes(namespace))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readPrefix(filePath, length = 512) {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isXcursorPrefix(buffer) {
  return (
    buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("Xcur"))
  );
}

function isZipPrefix(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08))
  );
}

function isGzipPrefix(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isTarPrefix(buffer) {
  return (
    buffer.length >= 265 &&
    buffer.subarray(257, 262).toString("ascii") === "ustar"
  );
}

function isXzPrefix(buffer) {
  return (
    buffer.length >= 6 &&
    buffer
      .subarray(0, 6)
      .equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
  );
}

function hasTarExtension(filePath) {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  );
}

function hasXzTarExtension(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".tar.xz") || lower.endsWith(".txz");
}

function looksLikePlist(buffer) {
  if (buffer.subarray(0, 8).toString("ascii") === "bplist00") {
    return true;
  }
  const text = buffer
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  return text.startsWith("<?xml") || text.startsWith("<plist");
}

function validateArchivePath(fileName, limits) {
  if (
    !fileName ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    /^[A-Za-z]:/.test(fileName) ||
    Buffer.byteLength(fileName, "utf8") > limits.maxPathLength
  ) {
    fail("UNSAFE_ARCHIVE", `The archive contains an unsafe path: ${fileName}.`);
  }
  const withoutTrailingSlash = fileName.endsWith("/")
    ? fileName.slice(0, -1)
    : fileName;
  const rawComponents = withoutTrailingSlash.split("/");
  const normalized = path.posix.normalize(withoutTrailingSlash);
  const components = normalized === "." ? [] : normalized.split("/");
  if (
    components.length > limits.maxPathDepth ||
    rawComponents.includes("..") ||
    components.some((component) => component === "" || component === "..")
  ) {
    fail("UNSAFE_ARCHIVE", `The archive contains an unsafe path: ${fileName}.`);
  }
  return normalized;
}

async function preflightZip(zipPath, limits = DEFAULT_IMPORT_LIMITS) {
  const archiveStat = await fsPromises.lstat(zipPath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    fail("UNSAFE_SOURCE", "The selected archive must be a regular file.");
  }
  if (archiveStat.size > limits.maxArchiveBytes) {
    fail(
      "LIMIT_EXCEEDED",
      "The selected archive is larger than the import limit.",
    );
  }

  let zip;
  try {
    zip = await openZip(zipPath, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    fail("INVALID_ARCHIVE", "The selected file is not a valid archive.", error);
  }

  let entryCount = 0;
  let fileCount = 0;
  let uncompressedBytes = 0;
  const seen = new Set();
  const records = new Map();
  const symlinks = [];
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            fail("LIMIT_EXCEEDED", "The archive contains too many entries.");
          }
          const normalized = validateArchivePath(entry.fileName, limits);
          const collisionKey = normalized
            .normalize("NFC")
            .toLocaleLowerCase("en-US");
          if (seen.has(collisionKey)) {
            fail(
              "UNSAFE_ARCHIVE",
              `The archive contains colliding paths: ${entry.fileName}.`,
            );
          }
          seen.add(collisionKey);

          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          const directory = entry.fileName.endsWith("/");
          if (normalized === "." && !directory) {
            fail(
              "UNSAFE_ARCHIVE",
              "Only a directory entry may represent an archive's root.",
            );
          }
          if (
            fileType !== 0 &&
            fileType !== 0o100000 &&
            fileType !== 0o040000 &&
            fileType !== 0o120000
          ) {
            fail(
              "UNSAFE_ARCHIVE",
              `The archive contains a special file: ${entry.fileName}.`,
            );
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            fail(
              "UNSUPPORTED_ARCHIVE",
              "Encrypted ZIP archives are not supported.",
            );
          }
          if (![0, 8].includes(entry.compressionMethod)) {
            fail(
              "UNSUPPORTED_ARCHIVE",
              `The ZIP uses an unsupported compression method for ${entry.fileName}.`,
            );
          }
          if (fileType === 0o120000 && directory) {
            fail(
              "UNSAFE_ARCHIVE",
              `The archive contains an invalid cursor alias: ${entry.fileName}.`,
            );
          }
          if (!directory) {
            fileCount += 1;
            uncompressedBytes += entry.uncompressedSize;
            const ratio =
              entry.uncompressedSize / Math.max(1, entry.compressedSize);
            if (
              fileCount > limits.maxFiles ||
              entry.uncompressedSize > limits.maxEntryBytes ||
              uncompressedBytes > limits.maxUncompressedBytes ||
              ratio > limits.maxCompressionRatio
            ) {
              fail(
                "LIMIT_EXCEEDED",
                "The archive exceeds the safe extraction limits.",
              );
            }
          }
          const record = {
            directory,
            entry,
            fileType,
            normalized,
          };
          records.set(normalized, record);
          if (fileType === 0o120000) {
            if (entry.uncompressedSize > limits.maxSymlinkBytes) {
              fail(
                "LIMIT_EXCEEDED",
                `An archive cursor alias is too large: ${entry.fileName}.`,
              );
            }
            symlinks.push(record);
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });

    const aliasTargets = new Map();
    for (const alias of symlinks) {
      const aliasParent = path.posix.dirname(alias.normalized);
      if (path.posix.basename(aliasParent).toLowerCase() !== "cursors") {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive symbolic link is outside a cursors directory: ${alias.normalized}.`,
        );
      }
      const linkBytes = await inspectZipEntry(
        zip,
        alias.entry,
        limits.maxSymlinkBytes,
        true,
      );
      let linkTarget;
      try {
        linkTarget = new TextDecoder("utf-8", { fatal: true }).decode(
          linkBytes,
        );
      } catch (error) {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive cursor alias has an invalid target: ${alias.normalized}.`,
          error,
        );
      }
      if (
        !linkTarget ||
        linkTarget.includes("\0") ||
        linkTarget.includes("\\") ||
        path.posix.isAbsolute(linkTarget) ||
        path.posix.dirname(linkTarget) !== "." ||
        [".", ".."].includes(linkTarget)
      ) {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive cursor alias escapes its cursors directory: ${alias.normalized}.`,
        );
      }
      const targetName = path.posix.join(aliasParent, linkTarget);
      const target = records.get(targetName);
      if (!target || target.directory) {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive cursor alias does not resolve inside the same cursors directory: ${alias.normalized}.`,
        );
      }
      aliasTargets.set(alias.normalized, targetName);
    }

    const resolvedTargets = new Map();
    const resolveAlias = (aliasName, visiting = new Set()) => {
      if (resolvedTargets.has(aliasName)) {
        return resolvedTargets.get(aliasName);
      }
      if (visiting.has(aliasName)) {
        fail(
          "UNSAFE_ARCHIVE",
          `The archive contains a cyclic cursor alias: ${aliasName}.`,
        );
      }
      visiting.add(aliasName);
      const targetName = aliasTargets.get(aliasName);
      const target = records.get(targetName);
      let resolved;
      if (target?.fileType === 0o120000) {
        if (!aliasTargets.has(targetName)) {
          fail(
            "UNSAFE_ARCHIVE",
            `An archive cursor alias target is invalid: ${aliasName}.`,
          );
        }
        resolved = resolveAlias(targetName, visiting);
      } else if (
        target &&
        !target.directory &&
        [0, 0o100000].includes(target.fileType) &&
        target.entry.uncompressedSize <= limits.maxXcursorBytes
      ) {
        resolved = target;
      } else {
        fail(
          "UNSAFE_ARCHIVE",
          `An archive cursor alias does not resolve to a regular Xcursor file: ${aliasName}.`,
        );
      }
      visiting.delete(aliasName);
      resolvedTargets.set(aliasName, resolved);
      return resolved;
    };

    const inspectedTargets = new Set();
    for (const alias of symlinks) {
      const target = resolveAlias(alias.normalized);
      if (!inspectedTargets.has(target.normalized)) {
        const targetPrefix = await inspectZipEntry(
          zip,
          target.entry,
          limits.maxXcursorBytes,
          false,
        );
        if (!isXcursorPrefix(targetPrefix)) {
          fail(
            "UNSAFE_ARCHIVE",
            `An archive cursor alias target is not an Xcursor binary: ${target.normalized}.`,
          );
        }
        inspectedTargets.add(target.normalized);
      }
    }
  } catch (error) {
    if (error instanceof CursorImportError) {
      throw error;
    }
    if (
      /invalid relative path|absolute path|invalid filename/i.test(
        error?.message,
      )
    ) {
      fail("UNSAFE_ARCHIVE", "The archive contains an unsafe path.", error);
    }
    fail("INVALID_ARCHIVE", "The archive directory is invalid.", error);
  } finally {
    zip.close();
  }
}

async function inspectZipEntry(zip, entry, maximumBytes, captureAll) {
  const stream = await new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, openedStream) => {
      if (error) {
        reject(error);
      } else {
        resolve(openedStream);
      }
    });
  });
  return new Promise((resolve, reject) => {
    let byteCount = 0;
    const captured = [];
    const prefix = Buffer.alloc(4);
    let prefixBytes = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    stream.on("error", rejectOnce);
    stream.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > maximumBytes) {
        stream.destroy();
        rejectOnce(
          new CursorImportError(
            "LIMIT_EXCEEDED",
            `An archive entry exceeds its safe decoded size: ${entry.fileName}.`,
          ),
        );
        return;
      }
      if (captureAll) {
        captured.push(chunk);
      } else if (prefixBytes < prefix.length) {
        const copyLength = Math.min(prefix.length - prefixBytes, chunk.length);
        chunk.copy(prefix, prefixBytes, 0, copyLength);
        prefixBytes += copyLength;
      }
    });
    stream.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (byteCount !== entry.uncompressedSize) {
        reject(
          new CursorImportError(
            "INVALID_ARCHIVE",
            `An archive entry's decoded size is inconsistent: ${entry.fileName}.`,
          ),
        );
        return;
      }
      resolve(
        captureAll
          ? Buffer.concat(captured, byteCount)
          : prefix.subarray(0, prefixBytes),
      );
    });
  });
}

const TAR_REGULAR_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);

function createTarStreamLimiter(archiveBytes, limits) {
  let decodedBytes = 0;
  const maximumTarBytes =
    limits.maxUncompressedBytes +
    limits.maxEntries * 1024 +
    limits.maxEntryBytes;
  return new Transform({
    transform(chunk, _encoding, callback) {
      decodedBytes += chunk.length;
      if (
        decodedBytes > maximumTarBytes ||
        decodedBytes / Math.max(1, archiveBytes) > limits.maxCompressionRatio
      ) {
        callback(
          new CursorImportError(
            "LIMIT_EXCEEDED",
            "The archive exceeds the safe decompression limits.",
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
}

async function preflightTar(
  tarPath,
  limits = DEFAULT_IMPORT_LIMITS,
  compression = "auto",
) {
  const archiveStat = await fsPromises.lstat(tarPath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    fail("UNSAFE_SOURCE", "The selected archive must be a regular file.");
  }
  if (archiveStat.size > limits.maxArchiveBytes) {
    fail(
      "LIMIT_EXCEEDED",
      "The selected archive is larger than the import limit.",
    );
  }

  let entryCount = 0;
  let fileCount = 0;
  let uncompressedBytes = 0;
  const seen = new Set();
  const records = new Map();
  const symlinks = [];
  try {
    await new Promise((resolve, reject) => {
      const parser = new tar.Parser({
        file: tarPath,
        maxDecompressionRatio: limits.maxCompressionRatio,
        maxMetaEntrySize: limits.maxEntryBytes,
        strict: true,
      });
      const input = fs.createReadStream(tarPath);
      const decoder = compression === "xz" ? createXzDecompressStream() : null;
      const limiter = decoder
        ? createTarStreamLimiter(archiveStat.size, limits)
        : null;
      const inputStreams = [input, decoder, limiter].filter(Boolean);
      let settled = false;
      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          for (const stream of inputStreams) {
            stream.destroy();
          }
          reject(error);
        }
      };
      parser.on("error", rejectOnce);
      for (const stream of inputStreams) {
        stream.on("error", rejectOnce);
      }
      parser.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      parser.on("meta", (metadata) => {
        try {
          entryCount += 1;
          uncompressedBytes += Buffer.byteLength(metadata, "utf8");
          if (
            entryCount > limits.maxEntries ||
            uncompressedBytes > limits.maxUncompressedBytes
          ) {
            fail(
              "LIMIT_EXCEEDED",
              "The archive metadata exceeds the safe extraction limits.",
            );
          }
        } catch (error) {
          parser.abort(error);
        }
      });
      parser.on("entry", (entry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            fail("LIMIT_EXCEEDED", "The archive contains too many entries.");
          }
          const normalized = validateArchivePath(entry.path, limits);
          const collisionKey = normalized
            .normalize("NFC")
            .toLocaleLowerCase("en-US");
          if (seen.has(collisionKey)) {
            fail(
              "UNSAFE_ARCHIVE",
              `The archive contains colliding paths: ${entry.path}.`,
            );
          }
          seen.add(collisionKey);

          let type;
          if (TAR_REGULAR_TYPES.has(entry.type)) {
            type = "regular";
          } else if (entry.type === "Directory") {
            type = "directory";
          } else if (entry.type === "SymbolicLink") {
            type = "symlink";
          } else {
            fail(
              "UNSAFE_ARCHIVE",
              `The archive contains an unsupported ${entry.type || "special"} entry: ${entry.path}.`,
            );
          }
          if (normalized === "." && type !== "directory") {
            fail(
              "UNSAFE_ARCHIVE",
              "Only a directory entry may represent an archive's root.",
            );
          }

          const size = Number(entry.size);
          if (!Number.isSafeInteger(size) || size < 0) {
            fail(
              "INVALID_ARCHIVE",
              `An archive entry has an invalid size: ${entry.path}.`,
            );
          }
          if (type === "directory" && size !== 0) {
            fail(
              "INVALID_ARCHIVE",
              `An archive directory has an invalid body: ${entry.path}.`,
            );
          }

          if (type !== "directory") {
            fileCount += 1;
            if (fileCount > limits.maxFiles) {
              fail("LIMIT_EXCEEDED", "The archive contains too many files.");
            }
          }
          if (type === "regular") {
            uncompressedBytes += size;
            if (
              size > limits.maxEntryBytes ||
              uncompressedBytes > limits.maxUncompressedBytes ||
              uncompressedBytes /
                Math.max(
                  1,
                  Math.min(archiveStat.size, limits.maxArchiveBytes),
                ) >
                limits.maxCompressionRatio
            ) {
              fail(
                "LIMIT_EXCEEDED",
                "The archive exceeds the safe extraction limits.",
              );
            }
          }

          const record = {
            normalized,
            type,
            size,
            entryType: entry.type,
            linkTarget: entry.linkpath,
            prefix: Buffer.alloc(4),
            prefixBytes: 0,
            decodedBytes: 0,
          };
          records.set(normalized, record);
          if (type === "symlink") {
            symlinks.push(record);
          }
          entry.on("data", (chunk) => {
            record.decodedBytes += chunk.length;
            if (record.prefixBytes < record.prefix.length) {
              const copyLength = Math.min(
                record.prefix.length - record.prefixBytes,
                chunk.length,
              );
              chunk.copy(record.prefix, record.prefixBytes, 0, copyLength);
              record.prefixBytes += copyLength;
            }
          });
          entry.resume();
        } catch (error) {
          entry.resume();
          parser.abort(error);
        }
      });
      if (decoder) {
        input.pipe(decoder).pipe(limiter).pipe(parser);
      } else {
        input.pipe(parser);
      }
    });

    if (entryCount === 0) {
      fail("INVALID_ARCHIVE", "The selected archive is empty.");
    }
    for (const record of records.values()) {
      if (record.type === "regular" && record.decodedBytes !== record.size) {
        fail(
          "INVALID_ARCHIVE",
          `An archive entry's decoded size is inconsistent: ${record.normalized}.`,
        );
      }
    }

    const aliasTargets = new Map();
    for (const alias of symlinks) {
      const aliasParent = path.posix.dirname(alias.normalized);
      if (path.posix.basename(aliasParent) !== "cursors") {
        fail(
          "UNSAFE_ARCHIVE",
          `A symbolic link is outside a literal cursors directory: ${alias.normalized}.`,
        );
      }
      const linkTarget = alias.linkTarget;
      if (
        typeof linkTarget !== "string" ||
        !linkTarget ||
        Buffer.byteLength(linkTarget, "utf8") > limits.maxSymlinkBytes ||
        linkTarget.includes("\0") ||
        linkTarget.includes("\\") ||
        path.posix.isAbsolute(linkTarget) ||
        path.posix.dirname(linkTarget) !== "." ||
        [".", ".."].includes(linkTarget)
      ) {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias escapes its cursors directory: ${alias.normalized}.`,
        );
      }
      const targetName = path.posix.join(aliasParent, linkTarget);
      const target = records.get(targetName);
      if (!target || target.type === "directory") {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias does not resolve inside the same cursors directory: ${alias.normalized}.`,
        );
      }
      aliasTargets.set(alias.normalized, targetName);
    }

    const resolvedTargets = new Map();
    const resolveAlias = (aliasName, visiting = new Set()) => {
      if (resolvedTargets.has(aliasName)) {
        return resolvedTargets.get(aliasName);
      }
      if (visiting.has(aliasName)) {
        fail(
          "UNSAFE_ARCHIVE",
          `The archive contains a cyclic cursor alias: ${aliasName}.`,
        );
      }
      visiting.add(aliasName);
      const targetName = aliasTargets.get(aliasName);
      const target = records.get(targetName);
      let resolved;
      if (target?.type === "symlink") {
        resolved = resolveAlias(targetName, visiting);
      } else if (
        target?.type === "regular" &&
        target.size <= limits.maxXcursorBytes
      ) {
        resolved = target;
      } else {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias does not resolve to a regular Xcursor file: ${aliasName}.`,
        );
      }
      visiting.delete(aliasName);
      resolvedTargets.set(aliasName, resolved);
      return resolved;
    };

    for (const alias of symlinks) {
      const target = resolveAlias(alias.normalized);
      if (!isXcursorPrefix(target.prefix.subarray(0, target.prefixBytes))) {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias target is not an Xcursor binary: ${target.normalized}.`,
        );
      }
    }
    return records;
  } catch (error) {
    if (error instanceof CursorImportError) {
      throw error;
    }
    if (/max decompression ratio exceeded/i.test(error?.message)) {
      fail(
        "LIMIT_EXCEEDED",
        "The archive exceeds the safe decompression limits.",
        error,
      );
    }
    if (
      /invalid relative path|absolute path|invalid filename|path contains \.\./i.test(
        error?.message,
      )
    ) {
      fail("UNSAFE_ARCHIVE", "The archive contains an unsafe path.", error);
    }
    fail("INVALID_ARCHIVE", "The selected tar archive is invalid.", error);
  }
}

async function extractTar(
  tarPath,
  extractionRoot,
  records,
  limits,
  compression = "auto",
) {
  try {
    const extractionOptions = {
      cwd: extractionRoot,
      strict: true,
      maxDecompressionRatio: limits.maxCompressionRatio,
      maxMetaEntrySize: limits.maxEntryBytes,
      preservePaths: false,
      preserveOwner: false,
      chmod: false,
      noMtime: true,
      keep: true,
      maxDepth: limits.maxPathDepth,
      dmode: 0o700,
      fmode: 0o600,
      umask: 0o077,
      filter(entryPath, entry) {
        const normalized = validateArchivePath(entryPath, limits);
        const record = records.get(normalized);
        return Boolean(
          record &&
          normalized !== "." &&
          record.entryType === entry.type &&
          record.type !== "symlink",
        );
      },
    };
    if (compression === "xz") {
      const archiveBytes = (await fsPromises.stat(tarPath)).size;
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(tarPath);
        const decoder = createXzDecompressStream();
        const limiter = createTarStreamLimiter(archiveBytes, limits);
        const unpacker = tar.extract(extractionOptions);
        const streams = [input, decoder, limiter];
        let settled = false;
        const rejectOnce = (error) => {
          if (!settled) {
            settled = true;
            for (const stream of streams) {
              stream.destroy();
            }
            unpacker.abort(error);
            reject(error);
          }
        };
        for (const stream of streams) {
          stream.on("error", rejectOnce);
        }
        unpacker.on("error", rejectOnce);
        unpacker.on("finish", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        input.pipe(decoder).pipe(limiter).pipe(unpacker);
      });
    } else {
      await tar.extract({ file: tarPath, ...extractionOptions });
    }
    const extractionRealPath = await fsPromises.realpath(extractionRoot);
    for (const record of records.values()) {
      if (record.type !== "symlink") {
        continue;
      }
      const aliasPath = path.resolve(
        extractionRealPath,
        ...record.normalized.split("/"),
      );
      const aliasParent = path.dirname(aliasPath);
      if (!isWithin(extractionRealPath, aliasPath)) {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias has an unsafe extraction path: ${record.normalized}.`,
        );
      }
      const parentStat = await fsPromises.lstat(aliasParent);
      const parentRealPath = await fsPromises.realpath(aliasParent);
      if (
        !parentStat.isDirectory() ||
        parentStat.isSymbolicLink() ||
        parentRealPath !== aliasParent ||
        path.basename(aliasParent) !== "cursors"
      ) {
        fail(
          "UNSAFE_ARCHIVE",
          `A cursor alias has an unsafe extraction directory: ${record.normalized}.`,
        );
      }
      await fsPromises.symlink(record.linkTarget, aliasPath);
    }
  } catch (error) {
    if (error instanceof CursorImportError) {
      throw error;
    }
    fail(
      "INVALID_ARCHIVE",
      "The tar archive could not be extracted safely.",
      error,
    );
  }
}

async function scanDirectory(rootPath, limits) {
  const rootStat = await fsPromises.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(
      "UNSAFE_SOURCE",
      "The selected cursor source must be a regular directory.",
    );
  }
  const rootRealPath = await fsPromises.realpath(rootPath);
  const files = [];
  const countedFiles = new Set();
  let entries = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory, depth) {
    if (depth > limits.maxPathDepth) {
      fail("LIMIT_EXCEEDED", "The cursor source is nested too deeply.");
    }
    const children = await fsPromises.readdir(directory, {
      withFileTypes: true,
    });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries) {
        fail("LIMIT_EXCEEDED", "The cursor source contains too many entries.");
      }
      const relative = relativeDirectory
        ? path.join(relativeDirectory, child.name)
        : child.name;
      if (Buffer.byteLength(relative, "utf8") > limits.maxPathLength) {
        fail(
          "UNSAFE_SOURCE",
          `The cursor source contains an unsafe path: ${relative}.`,
        );
      }
      const absolute = path.join(directory, child.name);
      const stat = await fsPromises.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const linkTarget = await fsPromises.readlink(absolute);
        if (
          path.isAbsolute(linkTarget) ||
          linkTarget.includes("\\") ||
          path.dirname(linkTarget) !== "."
        ) {
          fail(
            "UNSAFE_SOURCE",
            `The cursor alias must point to a filename in the same cursors directory: ${relative}.`,
          );
        }
        let target;
        try {
          target = await fsPromises.realpath(absolute);
        } catch (error) {
          fail(
            "UNSAFE_SOURCE",
            `The cursor alias is dangling or cyclic: ${relative}.`,
            error,
          );
        }
        const targetStat = await fsPromises.lstat(target);
        const directoryRealPath = await fsPromises.realpath(directory);
        if (
          path.basename(directoryRealPath).toLowerCase() !== "cursors" ||
          path.dirname(target) !== directoryRealPath ||
          !targetStat.isFile() ||
          targetStat.isSymbolicLink() ||
          !isXcursorPrefix(await readPrefix(target, 4))
        ) {
          fail(
            "UNSAFE_SOURCE",
            `Only aliases to regular Xcursor files in the same cursors directory are accepted: ${relative}.`,
          );
        }
        if (targetStat.size > limits.maxXcursorBytes) {
          fail(
            "LIMIT_EXCEEDED",
            `An Xcursor alias target is too large: ${relative}.`,
          );
        }
        files.push({
          absolute: target,
          logicalName: child.name,
          relative,
          size: targetStat.size,
          symlinkAlias: true,
        });
        if (files.length > limits.maxFiles) {
          fail("LIMIT_EXCEEDED", "The cursor source contains too many files.");
        }
      } else if (stat.isDirectory()) {
        await visit(absolute, relative, depth + 1);
      } else if (stat.isFile()) {
        if (stat.size > limits.maxEntryBytes) {
          fail("LIMIT_EXCEEDED", `A source file is too large: ${relative}.`);
        }
        const realFile = await fsPromises.realpath(absolute);
        if (!countedFiles.has(realFile)) {
          countedFiles.add(realFile);
          totalBytes += stat.size;
        }
        if (
          files.length + 1 > limits.maxFiles ||
          totalBytes > limits.maxUncompressedBytes
        ) {
          fail(
            "LIMIT_EXCEEDED",
            "The cursor source exceeds the import limits.",
          );
        }
        files.push({ absolute, relative, size: stat.size });
      } else {
        fail("UNSAFE_SOURCE", `Special files are not accepted: ${relative}.`);
      }
    }
  }

  await visit(rootRealPath, "", 0);
  return { files, root: rootRealPath };
}

function readUInt32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) {
    fail("INVALID_XCURSOR", `Truncated Xcursor ${label}.`);
  }
  return buffer.readUInt32LE(offset);
}

function parseXcursorBuffer(
  buffer,
  limits = DEFAULT_IMPORT_LIMITS,
  decodedBudget = createDecodedSourceBudget(limits),
) {
  if (!isXcursorPrefix(buffer) || buffer.length < 16) {
    fail("INVALID_XCURSOR", "The file is not an Xcursor binary.");
  }
  if (buffer.length > limits.maxXcursorBytes) {
    fail("LIMIT_EXCEEDED", "An Xcursor file is larger than the import limit.");
  }
  const headerSize = readUInt32(buffer, 4, "header");
  const version = readUInt32(buffer, 8, "version");
  const tocCount = readUInt32(buffer, 12, "table of contents");
  if (
    headerSize < 16 ||
    headerSize > buffer.length ||
    version !== XCURSOR_VERSION ||
    tocCount > limits.maxSourceFrames * 4 ||
    headerSize + tocCount * 12 > buffer.length
  ) {
    fail("INVALID_XCURSOR", "The Xcursor header is invalid or unsupported.");
  }

  const frames = [];
  let totalPixels = 0;
  for (let index = 0; index < tocCount; index += 1) {
    const tocOffset = headerSize + index * 12;
    const chunkType = readUInt32(buffer, tocOffset, "chunk type");
    const tocSubtype = readUInt32(buffer, tocOffset + 4, "chunk subtype");
    const chunkOffset = readUInt32(buffer, tocOffset + 8, "chunk offset");
    if (chunkType !== XCURSOR_IMAGE_TYPE) {
      continue;
    }
    if (chunkOffset + 36 > buffer.length) {
      fail("INVALID_XCURSOR", "An Xcursor image chunk is truncated.");
    }
    const chunkHeader = readUInt32(buffer, chunkOffset, "image header");
    const actualType = readUInt32(buffer, chunkOffset + 4, "image type");
    const nominalSize = readUInt32(buffer, chunkOffset + 8, "nominal size");
    const chunkVersion = readUInt32(buffer, chunkOffset + 12, "image version");
    const width = readUInt32(buffer, chunkOffset + 16, "image width");
    const height = readUInt32(buffer, chunkOffset + 20, "image height");
    const hotspotX = readUInt32(buffer, chunkOffset + 24, "horizontal hotspot");
    const hotspotY = readUInt32(buffer, chunkOffset + 28, "vertical hotspot");
    const delayMs = readUInt32(buffer, chunkOffset + 32, "frame delay");
    const pixelCount = width * height;
    const pixelStart = chunkOffset + chunkHeader;
    const pixelEnd = pixelStart + pixelCount * 4;
    totalPixels += pixelCount;
    if (
      chunkHeader < 36 ||
      actualType !== XCURSOR_IMAGE_TYPE ||
      chunkVersion !== 1 ||
      width === 0 ||
      height === 0 ||
      width > limits.maxSourceDimension ||
      height > limits.maxSourceDimension ||
      hotspotX >= width ||
      hotspotY >= height ||
      !Number.isSafeInteger(pixelCount) ||
      totalPixels > limits.maxSourcePixelsPerFile ||
      pixelEnd > buffer.length
    ) {
      fail("INVALID_XCURSOR", "An Xcursor image chunk has invalid geometry.");
    }
    decodedBudget.reserve(pixelCount * 4);
    const rgba = Buffer.allocUnsafe(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const word = buffer.readUInt32LE(pixelStart + pixelIndex * 4);
      const alpha = word >>> 24;
      let red = (word >>> 16) & 0xff;
      let green = (word >>> 8) & 0xff;
      let blue = word & 0xff;
      if (alpha === 0) {
        red = 0;
        green = 0;
        blue = 0;
      } else if (alpha !== 255) {
        const rounding = Math.floor(alpha / 2);
        red = Math.min(255, Math.floor((red * 255 + rounding) / alpha));
        green = Math.min(255, Math.floor((green * 255 + rounding) / alpha));
        blue = Math.min(255, Math.floor((blue * 255 + rounding) / alpha));
      }
      const outputOffset = pixelIndex * 4;
      rgba[outputOffset] = red;
      rgba[outputOffset + 1] = green;
      rgba[outputOffset + 2] = blue;
      rgba[outputOffset + 3] = alpha;
    }
    frames.push({
      rgba,
      width,
      height,
      hotspotX,
      hotspotY,
      delayMs: delayMs || null,
      nominalSize: nominalSize || tocSubtype || width,
    });
  }
  if (frames.length === 0) {
    fail("INVALID_XCURSOR", "The Xcursor file contains no image chunks.");
  }
  if (frames.length > limits.maxSourceFrames * 4) {
    fail("LIMIT_EXCEEDED", "The Xcursor file contains too many image chunks.");
  }
  return frames;
}

function groupXcursorFrames(frames, limits) {
  const groups = new Map();
  for (const frame of frames) {
    const group = groups.get(frame.nominalSize) ?? [];
    group.push(frame);
    groups.set(frame.nominalSize, group);
  }
  for (const [nominalSize, group] of groups) {
    if (group.length > limits.maxSourceFrames) {
      fail("LIMIT_EXCEEDED", "An Xcursor animation contains too many frames.");
    }
    // A nominal-size sequence can contain differently cropped frames. Pad
    // them to one canvas so resizing preserves their relative artwork scale.
    const canvasSize = Math.max(
      ...group.map((frame) => Math.max(frame.width, frame.height)),
    );
    groups.set(
      nominalSize,
      group.map((frame) => ({
        ...frame,
        representationSize: canvasSize,
        ...(frame.width === canvasSize && frame.height === canvasSize
          ? {}
          : {
              rgba: squareFrameRgba(frame, canvasSize),
              width: canvasSize,
              height: canvasSize,
            }),
      })),
    );
  }
  return groups;
}

function pixelTiers(groups) {
  return [...groups].map(([nominalSize, frames]) => ({
    nominalSize,
    frames,
    size: frames[0].representationSize ?? nominalSize,
  }));
}

function framesForSize(groups, targetSize) {
  const tiers = pixelTiers(groups);
  const sizes = tiers.map((tier) => tier.size);
  const larger = sizes.filter((size) => size >= targetSize);
  const sourceSize = larger.length ? Math.min(...larger) : Math.max(...sizes);
  return tiers
    .filter((tier) => tier.size === sourceSize)
    .sort(
      (left, right) =>
        Math.abs(left.nominalSize - targetSize) -
          Math.abs(right.nominalSize - targetSize) ||
        left.nominalSize - right.nominalSize,
    )[0].frames;
}

function framesNearestSize(groups, targetSize) {
  return pixelTiers(groups).sort(
    (left, right) =>
      Math.abs(left.size - targetSize) - Math.abs(right.size - targetSize) ||
      left.size - right.size ||
      Math.abs(left.nominalSize - targetSize) -
        Math.abs(right.nominalSize - targetSize) ||
      left.nominalSize - right.nominalSize,
  )[0].frames;
}

function representationSizes(groups) {
  if (XCURSOR_RECONSTRUCTION.has(groups)) {
    return [...VECTOR_REPRESENTATION_SIZES];
  }
  const sizes = new Set(BASE_REPRESENTATION_SIZES);
  if (Math.max(...pixelTiers(groups).map((tier) => tier.size)) >= 128) {
    sizes.add(128);
  }
  return [...sizes].sort((left, right) => left - right);
}

function clearTransparentRgb(buffer) {
  for (let offset = 0; offset < buffer.length; offset += 4) {
    if (buffer[offset + 3] === 0) {
      buffer[offset] = 0;
      buffer[offset + 1] = 0;
      buffer[offset + 2] = 0;
    }
  }
  return buffer;
}

function squareFrameRgba(
  frame,
  canvasSize = Math.max(frame.width, frame.height),
) {
  if (frame.width === canvasSize && frame.height === canvasSize) {
    return Buffer.from(frame.rgba);
  }
  const squareRgba = Buffer.alloc(canvasSize * canvasSize * 4);
  const sourceRowBytes = frame.width * 4;
  const targetRowBytes = canvasSize * 4;
  for (let row = 0; row < frame.height; row += 1) {
    frame.rgba.copy(
      squareRgba,
      row * targetRowBytes,
      row * sourceRowBytes,
      row * sourceRowBytes + sourceRowBytes,
    );
  }
  return squareRgba;
}

async function resizeRawRgba(rgba, sourceSize, targetSize, nohalo = false) {
  if (sourceSize === targetSize) {
    return Buffer.from(rgba);
  }
  const pipeline = sharp(rgba, {
    raw: {
      width: sourceSize,
      height: sourceSize,
      channels: 4,
    },
  });
  const output = nohalo
    ? await pipeline
        .affine(
          [
            [targetSize / sourceSize, 0],
            [0, targetSize / sourceSize],
          ],
          {
            interpolator: sharp.interpolators.nohalo,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        )
        .raw()
        .toBuffer({ resolveWithObject: true })
    : await pipeline
        .resize(targetSize, targetSize, { kernel: sharp.kernel.lanczos3 })
        .raw()
        .toBuffer({ resolveWithObject: true });
  if (output.info.width !== targetSize || output.info.height !== targetSize) {
    fail("INVALID_CURSOR", "A reconstructed cursor tier has invalid geometry.");
  }
  return clearTransparentRgb(output.data);
}

async function resizeFrame(frame, size) {
  const canvasSize = Math.max(frame.width, frame.height);
  return resizeRawRgba(squareFrameRgba(frame), canvasSize, size, false);
}

function premultipliedRgba(rgba) {
  const output = new Float64Array(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3] / 255;
    output[offset] = (rgba[offset] / 255) * alpha;
    output[offset + 1] = (rgba[offset + 1] / 255) * alpha;
    output[offset + 2] = (rgba[offset + 2] / 255) * alpha;
    output[offset + 3] = alpha;
  }
  return output;
}

function filterFeatures(pixels, size, x, y, channel) {
  const at = (column, row) =>
    pixels[
      (Math.min(size - 1, Math.max(0, row)) * size +
        Math.min(size - 1, Math.max(0, column))) *
        4 +
        channel
    ];
  return [
    at(x, y),
    (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4,
    (at(x - 1, y - 1) +
      at(x + 1, y - 1) +
      at(x - 1, y + 1) +
      at(x + 1, y + 1)) /
      4,
  ];
}

function applyReconstructionFilter(rgba, size, filter) {
  const source = premultipliedRgba(rgba);
  const output = Buffer.allocUnsafe(rgba.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const alphaFeatures = filterFeatures(source, size, x, y, 3);
      const alpha = Math.min(
        1,
        Math.max(
          0,
          alphaFeatures.reduce(
            (sum, value, index) => sum + value * filter.alpha[index],
            0,
          ),
        ),
      );
      output[offset + 3] = Math.round(alpha * 255);
      for (let channel = 0; channel < 3; channel += 1) {
        const features = filterFeatures(source, size, x, y, channel);
        const premultiplied = Math.min(
          alpha,
          Math.max(
            0,
            features.reduce(
              (sum, value, index) => sum + value * filter.color[index],
              0,
            ),
          ),
        );
        output[offset + channel] =
          alpha > 1 / 255 ? Math.round((premultiplied / alpha) * 255) : 0;
      }
    }
  }
  return clearTransparentRgb(output);
}

async function reconstructFrame(frame, size, reconstruction) {
  const canvasSize = Math.max(frame.width, frame.height);
  if (canvasSize >= size) {
    return resizeFrame(frame, size);
  }
  const baseline = await resizeRawRgba(
    squareFrameRgba(frame),
    canvasSize,
    size,
    true,
  );
  return reconstruction?.filter
    ? applyReconstructionFilter(baseline, size, reconstruction.filter)
    : baseline;
}

function rgbaBounds(rgba, size) {
  let left = size;
  let top = size;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] !== 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }
  return left === size ? null : { left, top, right, bottom };
}

async function renderRepresentation(frames, indices, size, reconstruction) {
  const rendered = new Map();
  for (const index of new Set(indices)) {
    const frame = frames[index];
    const rgba = reconstruction
      ? await reconstructFrame(frame, size, reconstruction)
      : await resizeFrame(frame, size);
    const canvasSize = Math.max(frame.width, frame.height);
    rendered.set(index, {
      rgba,
      bounds: rgbaBounds(rgba, size),
      hotspot: {
        x: (frame.hotspotX * 32) / canvasSize,
        y: (frame.hotspotY * 32) / canvasSize,
      },
    });
  }
  return { size, frames: indices.map((index) => rendered.get(index)) };
}

function commonRepresentationGeometry(representations, hotspot) {
  let left = 0;
  let top = 0;
  let right = 32;
  let bottom = 32;
  for (const { size, frames } of representations) {
    for (const frame of new Set(frames)) {
      if (!frame.bounds) {
        continue;
      }
      const dx = hotspot.x - frame.hotspot.x;
      const dy = hotspot.y - frame.hotspot.y;
      left = Math.min(left, (frame.bounds.left * 32) / size + dx);
      top = Math.min(top, (frame.bounds.top * 32) / size + dy);
      right = Math.max(right, (frame.bounds.right * 32) / size + dx);
      bottom = Math.max(bottom, (frame.bounds.bottom * 32) / size + dy);
    }
  }
  // One shared square contains every translated frame. Whole-point padding
  // gives the standard 1x/2x/3x/4x tiers the exact same final scale.
  left = Math.floor(left);
  top = Math.floor(top);
  const canvasPoints = Math.ceil(Math.max(right - left, bottom - top));
  return {
    left,
    top,
    canvasPoints,
    sourceHotspot: hotspot,
    hotspot: {
      x: ((hotspot.x - left) * 32) / canvasPoints,
      y: ((hotspot.y - top) * 32) / canvasPoints,
    },
  };
}

async function composeRepresentation({ size, frames }, geometry) {
  const bytesPerFrame = size * size * 4;
  const sheet = Buffer.alloc(bytesPerFrame * frames.length);
  const canvasSize = (size * geometry.canvasPoints) / 32;
  const alignedFrames = new Map();
  for (let outputIndex = 0; outputIndex < frames.length; outputIndex += 1) {
    const frame = frames[outputIndex];
    if (!alignedFrames.has(frame)) {
      const padded = Buffer.alloc(canvasSize * canvasSize * 4);
      if (frame.bounds) {
        const shiftX = Math.round(
          ((geometry.sourceHotspot.x - frame.hotspot.x - geometry.left) *
            size) /
            32,
        );
        const shiftY = Math.round(
          ((geometry.sourceHotspot.y - frame.hotspot.y - geometry.top) * size) /
            32,
        );
        const { left, top, right, bottom } = frame.bounds;
        for (let y = top; y < bottom; y += 1) {
          frame.rgba.copy(
            padded,
            ((y + shiftY) * canvasSize + left + shiftX) * 4,
            (y * size + left) * 4,
            (y * size + right) * 4,
          );
        }
      }
      alignedFrames.set(frame, await resizeRawRgba(padded, canvasSize, size));
    }
    alignedFrames.get(frame).copy(sheet, outputIndex * bytesPerFrame);
  }
  return sharp(sheet, {
    raw: { width: size, height: size * frames.length, channels: 4 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

function compatibleCalibrationFrames(lowFrames, highFrames, lowSize, highSize) {
  if (
    !lowFrames ||
    !highFrames ||
    lowFrames.length !== highFrames.length ||
    lowFrames.length === 0
  ) {
    return false;
  }
  const lowCycle = sourceCycleDuration(lowFrames);
  const highCycle = sourceCycleDuration(highFrames);
  if (
    lowFrames.length > 1 &&
    Math.abs(lowCycle - highCycle) / Math.max(1, lowCycle, highCycle) > 0.1
  ) {
    return false;
  }
  return lowFrames.every((lowFrame, index) => {
    const highFrame = highFrames[index];
    const lowCanvas = Math.max(lowFrame.width, lowFrame.height);
    const highCanvas = Math.max(highFrame.width, highFrame.height);
    const hotspotDifference = Math.hypot(
      (lowFrame.hotspotX * 32) / lowCanvas -
        (highFrame.hotspotX * 32) / highCanvas,
      (lowFrame.hotspotY * 32) / lowCanvas -
        (highFrame.hotspotY * 32) / highCanvas,
    );
    return (
      lowCanvas === lowSize &&
      highCanvas === highSize &&
      hotspotDifference <= 1.5
    );
  });
}

function visualReconstructionError(left, right) {
  let union = 0;
  let intersection = 0;
  let difference = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const leftAlpha = left[offset + 3] / 255;
    const rightAlpha = right[offset + 3] / 255;
    union += Math.max(leftAlpha, rightAlpha);
    intersection += Math.min(leftAlpha, rightAlpha);
    for (const background of [0, 0.5, 1]) {
      for (let channel = 0; channel < 3; channel += 1) {
        const leftComposite =
          (left[offset + channel] / 255) * leftAlpha +
          background * (1 - leftAlpha);
        const rightComposite =
          (right[offset + channel] / 255) * rightAlpha +
          background * (1 - rightAlpha);
        difference += Math.abs(leftComposite - rightComposite);
      }
    }
  }
  return {
    error: union > 0 ? difference / (union * 9) : 0,
    alphaOverlap: union > 0 ? intersection / union : 1,
  };
}

function normalEquations() {
  return {
    xx: new Float64Array(9),
    xy: new Float64Array(3),
    sampleCount: 0,
  };
}

function addNormalSample(equations, features, target) {
  for (let row = 0; row < 3; row += 1) {
    equations.xy[row] += features[row] * target;
    for (let column = 0; column < 3; column += 1) {
      equations.xx[row * 3 + column] += features[row] * features[column];
    }
  }
  equations.sampleCount += 1;
}

function accumulateFilterSamples(equations, baseline, reference, size) {
  const source = premultipliedRgba(baseline);
  const target = premultipliedRgba(reference);
  const stride = Math.max(1, Math.floor(size / 96));
  for (let y = 0; y < size; y += stride) {
    for (let x = 0; x < size; x += stride) {
      const offset = (y * size + x) * 4;
      const alphaFeatures = filterFeatures(source, size, x, y, 3);
      if (
        target[offset + 3] <= 1 / 255 &&
        alphaFeatures.every((value) => value <= 1 / 255)
      ) {
        continue;
      }
      addNormalSample(equations.alpha, alphaFeatures, target[offset + 3]);
      for (let channel = 0; channel < 3; channel += 1) {
        addNormalSample(
          equations.color,
          filterFeatures(source, size, x, y, channel),
          target[offset + channel],
        );
      }
    }
  }
}

function solveThreeByThree(equations) {
  const count = Math.max(1, equations.sampleCount);
  const penalty = XCURSOR_FILTER_RIDGE * count;
  const rows = Array.from({ length: 3 }, (_, row) => [
    ...Array.from(
      { length: 3 },
      (_, column) =>
        equations.xx[row * 3 + column] + (row === column ? penalty : 0),
    ),
    equations.xy[row] + (row === 0 ? penalty : 0),
  ]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
        pivot = row;
      }
    }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    if (Math.abs(rows[column][column]) < 1e-12) {
      return null;
    }
    const divisor = rows[column][column];
    for (let index = column; index < 4; index += 1) {
      rows[column][index] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) {
        continue;
      }
      const multiplier = rows[row][column];
      for (let index = column; index < 4; index += 1) {
        rows[row][index] -= multiplier * rows[column][index];
      }
    }
  }
  const weights = rows.map((row) => row[3]);
  return weights.every(Number.isFinite) &&
    weights.every((weight) => Math.abs(weight) <= 4) &&
    weights.reduce((sum, weight) => sum + Math.abs(weight), 0) <= 8
    ? weights
    : null;
}

function fitReconstructionFilter(samples) {
  const equations = {
    alpha: normalEquations(),
    color: normalEquations(),
  };
  for (const sample of samples) {
    accumulateFilterSamples(
      equations,
      sample.baseline,
      sample.reference,
      sample.size,
    );
  }
  const alpha = solveThreeByThree(equations.alpha);
  const color = solveThreeByThree(equations.color);
  return alpha && color ? { alpha, color } : null;
}

function evaluateReconstructionSamples(samples, filter) {
  const roles = new Map();
  let improved = 0;
  let largestRegression = 0;
  for (const sample of samples) {
    const baseline = visualReconstructionError(
      sample.baseline,
      sample.reference,
    ).error;
    const filtered = visualReconstructionError(
      applyReconstructionFilter(sample.baseline, sample.size, filter),
      sample.reference,
    ).error;
    const role = roles.get(sample.role) ?? {
      baselineError: 0,
      filteredError: 0,
      sampleCount: 0,
    };
    role.baselineError += baseline;
    role.filteredError += filtered;
    role.sampleCount += 1;
    roles.set(sample.role, role);
    improved += Number(filtered < baseline);
    largestRegression = Math.max(largestRegression, filtered - baseline);
  }
  const roleResults = [...roles.values()].map((role) => ({
    baselineError: role.baselineError / role.sampleCount,
    filteredError: role.filteredError / role.sampleCount,
  }));
  return {
    baselineError:
      roleResults.reduce((sum, role) => sum + role.baselineError, 0) /
      roleResults.length,
    filteredError:
      roleResults.reduce((sum, role) => sum + role.filteredError, 0) /
      roleResults.length,
    improved,
    improvedRoleCount: roleResults.filter(
      (role) => role.filteredError < role.baselineError,
    ).length,
    largestRegression,
    roleCount: roleResults.length,
    sampleCount: samples.length,
  };
}

function selectCalibrationPair(sourceFrames) {
  const roleEntries = [...sourceFrames.entries()].filter(
    ([, groups]) => groups instanceof Map && groups.size > 1,
  );
  const masterSizes = roleEntries.map(([, groups]) =>
    Math.max(...pixelTiers(groups).map((tier) => tier.size)),
  );
  const variantMaster = median(masterSizes);
  if (
    !Number.isFinite(variantMaster) ||
    variantMaster >= XCURSOR_UPSCALE_TARGET
  ) {
    return null;
  }
  const tiers = [
    ...new Set(
      roleEntries.flatMap(([, groups]) =>
        pixelTiers(groups).map((tier) => tier.size),
      ),
    ),
  ]
    .filter((size) => size < XCURSOR_UPSCALE_TARGET)
    .sort((left, right) => left - right);
  const desiredRatio = XCURSOR_UPSCALE_TARGET / variantMaster;
  const candidates = [];
  for (let lowIndex = 0; lowIndex + 1 < tiers.length; lowIndex += 1) {
    for (
      let highIndex = lowIndex + 1;
      highIndex < tiers.length;
      highIndex += 1
    ) {
      const lowSize = tiers[lowIndex];
      const highSize = tiers[highIndex];
      const ratio = highSize / lowSize;
      if (
        ratio < 1.15 ||
        ratio > 2.1 ||
        (variantMaster < 96 && highSize !== variantMaster)
      ) {
        continue;
      }
      const roles = roleEntries.filter(([, groups]) =>
        compatibleCalibrationFrames(
          framesForSize(groups, lowSize),
          framesForSize(groups, highSize),
          lowSize,
          highSize,
        ),
      );
      if (roles.length >= XCURSOR_FILTER_MIN_ROLES) {
        candidates.push({
          lowSize,
          highSize,
          roles,
          ratioDifference:
            variantMaster < 96
              ? (variantMaster - lowSize) / variantMaster
              : Math.abs(Math.log(ratio) - Math.log(desiredRatio)),
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.ratioDifference - right.ratioDifference ||
      right.highSize - left.highSize,
  )[0];
}

async function calibrationSamples(pair) {
  const samples = [];
  for (const [role, groups] of pair.roles) {
    const lowFrames = framesForSize(groups, pair.lowSize);
    const highFrames = framesForSize(groups, pair.highSize);
    const indices = selectedFrameIndices(
      lowFrames.length,
      XCURSOR_FILTER_MAX_FRAMES_PER_ROLE,
    );
    for (const index of indices) {
      const baseline = await resizeRawRgba(
        squareFrameRgba(lowFrames[index]),
        pair.lowSize,
        pair.highSize,
        true,
      );
      const reference = squareFrameRgba(highFrames[index]);
      const quality = visualReconstructionError(baseline, reference);
      if (quality.alphaOverlap >= 0.55 && quality.error <= 0.2) {
        samples.push({
          baseline,
          reference,
          role,
          size: pair.highSize,
        });
      }
    }
  }
  return samples;
}

function nohaloReconstruction(groups) {
  return {
    filter: null,
    masterSize: Math.max(...pixelTiers(groups).map((tier) => tier.size)),
    method: "nohalo",
  };
}

async function learnXcursorReconstruction(sourceFrames) {
  const pair = selectCalibrationPair(sourceFrames);
  const fallback = (reason, details) => {
    for (const groups of sourceFrames.values()) {
      XCURSOR_RECONSTRUCTION.set(groups, nohaloReconstruction(groups));
    }
    return { method: "nohalo", reason, ...(details ? { details } : {}) };
  };
  if (!pair) {
    return fallback("no-compatible-tier-pair");
  }
  const samples = await calibrationSamples(pair);
  const roles = [...new Set(samples.map((sample) => sample.role))].sort(
    (a, b) => a.localeCompare(b, "en"),
  );
  const holdoutCount = Math.max(
    XCURSOR_FILTER_MIN_HOLDOUT_ROLES,
    Math.ceil(roles.length * XCURSOR_FILTER_HOLDOUT_FRACTION),
  );
  if (roles.length - holdoutCount < XCURSOR_FILTER_MIN_ROLES) {
    return fallback("insufficient-calibration-roles", {
      eligibleRoleCount: roles.length,
    });
  }
  const holdoutRoles = new Set(
    Array.from(
      { length: holdoutCount },
      (_, index) =>
        roles[
          Math.min(
            roles.length - 1,
            Math.floor(((index + 0.5) * roles.length) / holdoutCount),
          )
        ],
    ),
  );
  const training = samples.filter((sample) => !holdoutRoles.has(sample.role));
  const holdout = samples.filter((sample) => holdoutRoles.has(sample.role));
  const filter = fitReconstructionFilter(training);
  if (!filter || holdout.length < XCURSOR_FILTER_MIN_HOLDOUT_ROLES) {
    return fallback("filter-fit-failed", {
      holdoutSampleCount: holdout.length,
    });
  }
  const validation = evaluateReconstructionSamples(holdout, filter);
  if (
    validation.filteredError >= validation.baselineError * 0.99 ||
    validation.improvedRoleCount / validation.roleCount < 0.6 ||
    validation.largestRegression > 0.01
  ) {
    return fallback("held-out-regression", {
      pair: [pair.lowSize, pair.highSize],
      validation,
    });
  }

  const acceptedRoles = new Set();
  for (const role of roles) {
    const roleSamples = samples.filter((sample) => sample.role === role);
    const result = evaluateReconstructionSamples(roleSamples, filter);
    if (
      result.filteredError < result.baselineError * 0.995 &&
      result.largestRegression <= 0.005
    ) {
      acceptedRoles.add(role);
    }
  }
  for (const [role, groups] of sourceFrames) {
    XCURSOR_RECONSTRUCTION.set(groups, {
      ...nohaloReconstruction(groups),
      ...(acceptedRoles.has(role) ? { filter, method: "learned-filter" } : {}),
    });
  }
  return {
    method: "learned-filter",
    pair: [pair.lowSize, pair.highSize],
    roleCount: acceptedRoles.size,
    validation,
  };
}

function sourceGroups(source) {
  if (source instanceof Map) {
    return source;
  }
  if (!Array.isArray(source) || source.length === 0) {
    fail("INVALID_CURSOR", "A cursor role contains no frames.");
  }
  return new Map([[Math.max(source[0].width, source[0].height), source]]);
}

function frameDurations(frames) {
  return frames.map((frame) =>
    Number.isFinite(frame.delayMs) && frame.delayMs > 0 ? frame.delayMs : 50,
  );
}

function greatestCommonDivisor(left, right) {
  let a = Math.max(1, Math.round(Math.abs(left)));
  let b = Math.max(1, Math.round(Math.abs(right)));
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function idealTimelineFrameCount(frames) {
  const durations = frameDurations(frames).map((duration) =>
    Math.max(1, Math.round(duration)),
  );
  const quantum = durations.reduce(greatestCommonDivisor);
  return Math.max(
    frames.length,
    Math.round(
      durations.reduce((sum, duration) => sum + duration, 0) / quantum,
    ),
  );
}

function sampledFrameIndices(frames, outputCount) {
  const durations = frameDurations(frames);
  const cycleDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const boundaries = [];
  let elapsed = 0;
  for (const duration of durations) {
    elapsed += duration;
    boundaries.push(elapsed);
  }
  return Array.from({ length: outputCount }, (_, outputIndex) => {
    const sampleTime = (outputIndex * cycleDuration) / outputCount;
    const frameIndex = boundaries.findIndex(
      (boundary) => sampleTime < boundary,
    );
    return frameIndex === -1 ? frames.length - 1 : frameIndex;
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizedMedianHotspot(groups) {
  const tierHotspots = [...groups.values()].map((frames) => ({
    x: median(
      frames.map(
        (frame) =>
          (Number(frame.hotspotX) * 32) /
          Math.max(1, frame.width, frame.height),
      ),
    ),
    y: median(
      frames.map(
        (frame) =>
          (Number(frame.hotspotY) * 32) /
          Math.max(1, frame.width, frame.height),
      ),
    ),
  }));
  return {
    x: median(tierHotspots.map((hotspot) => hotspot.x)),
    y: median(tierHotspots.map((hotspot) => hotspot.y)),
  };
}

async function buildCursorRecord(source, _limits = DEFAULT_IMPORT_LIMITS) {
  const groups = sourceGroups(source);
  if (groups.size === 0) {
    fail("INVALID_CURSOR", "A cursor role contains no frames.");
  }
  const sizes = representationSizes(groups);
  const uniqueFrameGroups = [...new Set(groups.values())];
  const canonicalFrames = framesNearestSize(groups, 32);
  const canonicalDurations = frameDurations(canonicalFrames);
  const sourceCounts = uniqueFrameGroups.map((frames) => frames.length);
  const sourceCycles = uniqueFrameGroups.map(sourceCycleDuration);
  const idealCount = Math.max(
    ...uniqueFrameGroups.map(idealTimelineFrameCount),
  );
  const outputCount = Math.min(MAX_MACOS_FRAMES, idealCount);
  const missingDelayCount = uniqueFrameGroups.reduce(
    (count, frames) =>
      count +
      (frames.length > 1
        ? frames.filter(
            (frame) => !Number.isFinite(frame.delayMs) || frame.delayMs <= 0,
          ).length
        : 0),
    0,
  );
  let frameDuration;
  if (canonicalFrames.length === 1 && outputCount === 1) {
    frameDuration = 1;
  } else {
    const sourceCycleSeconds =
      canonicalDurations.reduce((sum, duration) => sum + duration, 0) / 1000;
    frameDuration = Math.max(0.001, sourceCycleSeconds / outputCount);
  }
  const representations = [];
  const reconstruction = XCURSOR_RECONSTRUCTION.get(groups);
  const hotspot = normalizedMedianHotspot(groups);
  for (const size of sizes) {
    const frames = framesForSize(groups, size);
    representations.push(
      await renderRepresentation(
        frames,
        sampledFrameIndices(frames, outputCount),
        size,
        reconstruction,
      ),
    );
  }
  const geometry = commonRepresentationGeometry(representations, hotspot);
  const composed = [];
  for (const representation of representations) {
    composed.push(await composeRepresentation(representation, geometry));
  }
  return {
    record: {
      FrameCount: outputCount,
      FrameDuration: frameDuration,
      HotSpotX: geometry.hotspot.x,
      HotSpotY: geometry.hotspot.y,
      PointsWide: 32,
      PointsHigh: 32,
      Representations: composed,
    },
    sourceFrameCount: Math.max(...sourceCounts),
    sourceDurations: canonicalDurations,
    normalization: {
      capped: idealCount > MAX_MACOS_FRAMES,
      differingCycleDurations:
        Math.max(...sourceCycles) - Math.min(...sourceCycles) >
        Math.max(1, Math.max(...sourceCycles) * 0.01),
      differingFrameCounts: new Set(sourceCounts).size > 1,
      idealFrameCount: idealCount,
      missingDelayCount,
      variableDelays: uniqueFrameGroups.some(
        (frames) => new Set(frameDurations(frames)).size > 1,
      ),
    },
  };
}

let transparentRecordPromise;

function transparentCursorRecord() {
  transparentRecordPromise ??= (async () => {
    const representations = [];
    for (const size of VECTOR_REPRESENTATION_SIZES) {
      representations.push(
        await sharp({
          create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png({ compressionLevel: 9 })
          .toBuffer(),
      );
    }
    return {
      FrameCount: 1,
      FrameDuration: 1,
      HotSpotX: 0,
      HotSpotY: 0,
      PointsWide: 32,
      PointsHigh: 32,
      Representations: representations,
    };
  })();
  return transparentRecordPromise;
}

function exactlyMatchingPixels(leftSource, rightSource) {
  const leftGroups = sourceGroups(leftSource);
  const rightGroups = sourceGroups(rightSource);
  const leftSizes = [...leftGroups.keys()].sort((left, right) => left - right);
  const rightSizes = [...rightGroups.keys()].sort(
    (left, right) => left - right,
  );
  if (
    leftSizes.length !== rightSizes.length ||
    leftSizes.some((size, index) => size !== rightSizes[index])
  ) {
    return false;
  }
  return leftSizes.every((size) => {
    const leftFrames = leftGroups.get(size);
    const rightFrames = rightGroups.get(size);
    return (
      leftFrames.length === rightFrames.length &&
      leftFrames.every(
        (frame, index) =>
          frame.width === rightFrames[index].width &&
          frame.height === rightFrames[index].height &&
          frame.rgba.equals(rightFrames[index].rgba),
      )
    );
  });
}

function sourceCycleDuration(frames) {
  return frameDurations(frames).reduce((sum, duration) => sum + duration, 0);
}

function alignedVisualError(
  leftFrames,
  rightFrames,
  leftIndices,
  rightIndices,
  shift,
) {
  let alphaDifference = 0;
  let alphaIntersection = 0;
  let alphaUnion = 0;
  let rgbDifference = 0;
  for (let sample = 0; sample < leftIndices.length; sample += 1) {
    const left = leftFrames[leftIndices[sample]].rgba;
    const right =
      rightFrames[rightIndices[(sample + shift) % rightIndices.length]].rgba;
    for (let offset = 0; offset < left.length; offset += 4) {
      const leftAlpha = left[offset + 3];
      const rightAlpha = right[offset + 3];
      const intersection = Math.min(leftAlpha, rightAlpha);
      const union = Math.max(leftAlpha, rightAlpha);
      alphaDifference += Math.abs(leftAlpha - rightAlpha);
      alphaIntersection += intersection;
      alphaUnion += union;
      rgbDifference +=
        intersection *
        (Math.abs(left[offset] - right[offset]) +
          Math.abs(left[offset + 1] - right[offset + 1]) +
          Math.abs(left[offset + 2] - right[offset + 2]));
    }
  }
  if (alphaUnion === 0 || alphaIntersection === 0) {
    return null;
  }
  return {
    alphaError: alphaDifference / alphaUnion,
    alphaOverlap: alphaIntersection / alphaUnion,
    rgbError: rgbDifference / (alphaIntersection * 3 * 255),
  };
}

async function waitProgressThumbnail(frame) {
  return {
    ...frame,
    rgba: await resizeFrame(frame, WAIT_PROGRESS_THUMBNAIL_SIZE),
    width: WAIT_PROGRESS_THUMBNAIL_SIZE,
    height: WAIT_PROGRESS_THUMBNAIL_SIZE,
  };
}

async function sampledWaitProgressFrames(frames, indices) {
  const thumbnails = new Map();
  const output = [];
  for (const index of indices) {
    if (!thumbnails.has(index)) {
      thumbnails.set(index, await waitProgressThumbnail(frames[index]));
    }
    output.push(thumbnails.get(index));
  }
  return output;
}

async function visuallyEquivalentWaitProgress(waitSource, progressSource) {
  const waitGroups = sourceGroups(waitSource);
  const progressGroups = sourceGroups(progressSource);
  const waitHotspot = normalizedMedianHotspot(waitGroups);
  const progressHotspot = normalizedMedianHotspot(progressGroups);
  if (
    Math.hypot(
      waitHotspot.x - progressHotspot.x,
      waitHotspot.y - progressHotspot.y,
    ) > 2
  ) {
    return false;
  }

  const waitFrames = framesNearestSize(waitGroups, 32);
  const progressFrames = framesNearestSize(progressGroups, 32);
  if (
    waitFrames.some(
      (frame) =>
        frame.width !== waitFrames[0].width ||
        frame.height !== waitFrames[0].height,
    ) ||
    progressFrames.some(
      (frame) =>
        frame.width !== progressFrames[0].width ||
        frame.height !== progressFrames[0].height,
    ) ||
    waitFrames[0].width !== progressFrames[0].width ||
    waitFrames[0].height !== progressFrames[0].height
  ) {
    return false;
  }

  const waitCycle = sourceCycleDuration(waitFrames);
  const progressCycle = sourceCycleDuration(progressFrames);
  if (
    Math.abs(waitCycle - progressCycle) /
      Math.max(1, waitCycle, progressCycle) >
    0.1
  ) {
    return false;
  }
  if (exactlyMatchingPixels(waitSource, progressSource)) {
    return true;
  }

  const sampleCount = Math.min(
    48,
    Math.max(12, waitFrames.length, progressFrames.length),
  );
  const waitIndices = sampledFrameIndices(waitFrames, sampleCount);
  const progressIndices = sampledFrameIndices(progressFrames, sampleCount);
  const waitSamples = await sampledWaitProgressFrames(waitFrames, waitIndices);
  const progressSamples = await sampledWaitProgressFrames(
    progressFrames,
    progressIndices,
  );
  const thumbnailIndices = Array.from(
    { length: sampleCount },
    (_, index) => index,
  );
  let best;
  for (let shift = 0; shift < sampleCount; shift += 1) {
    const error = alignedVisualError(
      waitSamples,
      progressSamples,
      thumbnailIndices,
      thumbnailIndices,
      shift,
    );
    if (
      error &&
      (!best ||
        error.alphaError + error.rgbError < best.alphaError + best.rgbError)
    ) {
      best = error;
    }
  }
  return Boolean(
    best &&
    best.alphaOverlap >= 0.88 &&
    best.alphaError <= 0.12 &&
    best.rgbError <= 0.1,
  );
}

async function synthesizeProgressSource(defaultSource, waitSource) {
  const defaultGroups = sourceGroups(defaultSource);
  const waitGroups = sourceGroups(waitSource);
  const defaultReconstruction = XCURSOR_RECONSTRUCTION.get(defaultGroups);
  const waitReconstruction = XCURSOR_RECONSTRUCTION.get(waitGroups);
  const progressGroups = new Map();
  const outputCount = Math.min(
    MAX_MACOS_FRAMES,
    Math.max(...[...waitGroups.values()].map(idealTimelineFrameCount)),
  );
  for (const size of representationSizes(waitGroups)) {
    const waitFrames = framesForSize(waitGroups, size);
    const waitIndices = sampledFrameIndices(waitFrames, outputCount);
    const pointerFrames = framesForSize(defaultGroups, size);
    const pointerIndices = sampledFrameIndices(pointerFrames, outputCount);
    const frameDelay = sourceCycleDuration(waitFrames) / outputCount;
    const frames = [];
    for (let index = 0; index < outputCount; index += 1) {
      const waitFrame = waitFrames[waitIndices[index]];
      const pointerFrame = pointerFrames[pointerIndices[index]];
      const canvasSize = waitReconstruction
        ? size
        : Math.max(waitFrame.width, waitFrame.height);
      const pointerCanvasSize = Math.max(
        pointerFrame.width,
        pointerFrame.height,
      );
      const base = defaultReconstruction
        ? await reconstructFrame(
            pointerFrame,
            canvasSize,
            defaultReconstruction,
          )
        : await resizeFrame(pointerFrame, canvasSize);
      const waitCanvas = waitReconstruction
        ? await reconstructFrame(waitFrame, canvasSize, waitReconstruction)
        : await resizeFrame(waitFrame, canvasSize);
      const spinnerSize = Math.min(
        canvasSize,
        Math.max(8, Math.round(canvasSize * 0.42)),
      );
      const spinner = await sharp(waitCanvas, {
        raw: {
          width: canvasSize,
          height: canvasSize,
          channels: 4,
        },
      })
        .resize(spinnerSize, spinnerSize, { kernel: sharp.kernel.lanczos3 })
        .raw()
        .toBuffer();
      const margin = Math.max(0, Math.round(canvasSize * 0.02));
      const rgba = await sharp(base, {
        raw: {
          width: canvasSize,
          height: canvasSize,
          channels: 4,
        },
      })
        .composite([
          {
            input: spinner,
            raw: {
              width: spinnerSize,
              height: spinnerSize,
              channels: 4,
            },
            left: canvasSize - spinnerSize - margin,
            top: canvasSize - spinnerSize - margin,
          },
        ])
        .raw()
        .toBuffer();
      frames.push({
        rgba: clearTransparentRgb(rgba),
        width: canvasSize,
        height: canvasSize,
        hotspotX:
          (Number(pointerFrame.hotspotX) * canvasSize) /
          Math.max(1, pointerCanvasSize),
        hotspotY:
          (Number(pointerFrame.hotspotY) * canvasSize) /
          Math.max(1, pointerCanvasSize),
        delayMs: frameDelay,
        nominalSize: size,
      });
    }
    progressGroups.set(size, frames);
  }
  return progressGroups;
}

function mergeRoles(sourceFrames) {
  const roles = new Map();
  const priorities = new Map();
  for (const [sourceRole, frames] of sourceFrames) {
    if (frames && (!(frames instanceof Map) || frames.size > 0)) {
      const role = canonicalRole(sourceRole);
      const priority = canonicalFilenamePriority(sourceRole);
      if (!roles.has(role) || priority > priorities.get(role)) {
        roles.set(role, frames);
        priorities.set(role, priority);
      }
    }
  }
  if (!roles.has("default")) {
    for (const fallback of ["pointer", "right-arrow", "left-arrow"]) {
      if (roles.has(fallback)) {
        roles.set("default", roles.get(fallback));
        break;
      }
    }
  }
  if (!roles.has("default")) {
    fail("UNSUPPORTED_SOURCE", "The source has no default or left_ptr cursor.");
  }
  return roles;
}

async function buildTheme(sourceFrames, metadata, limits) {
  const roles = mergeRoles(sourceFrames);
  const bindings = new Map();
  const cursors = {};
  const builtRoles = new Map();
  const warnings = [];
  if (
    roles.has("wait") &&
    roles.has("progress") &&
    (await visuallyEquivalentWaitProgress(
      roles.get("wait"),
      roles.get("progress"),
    ))
  ) {
    roles.set(
      "progress",
      await synthesizeProgressSource(roles.get("default"), roles.get("wait")),
    );
    warnings.push(
      "Progress visually duplicated Wait, so a conventional pointer with a smaller lower-right spinner was synthesized.",
    );
  }
  const empty = await transparentCursorRecord();
  for (const [macIdentifier, requestedRole] of Object.entries(MAC_TO_ROLE)) {
    if (requestedRole === null || requestedRole === undefined) {
      cursors[macIdentifier] = empty;
      bindings.set(macIdentifier, {
        requested: "empty",
        resolved: "empty",
        fallback: false,
      });
      continue;
    }
    const resolvedRole = roles.has(requestedRole) ? requestedRole : "default";
    if (!builtRoles.has(resolvedRole)) {
      const built = await buildCursorRecord(roles.get(resolvedRole), limits);
      builtRoles.set(resolvedRole, built.record);
      if (built.sourceFrameCount > MAX_MACOS_FRAMES) {
        warnings.push(
          `${resolvedRole} was evenly reduced from ${built.sourceFrameCount} to ${MAX_MACOS_FRAMES} frames while preserving its full cycle time.`,
        );
      }
      if (
        built.normalization.capped &&
        built.sourceFrameCount <= MAX_MACOS_FRAMES
      ) {
        warnings.push(
          `${resolvedRole}'s variable timing was phase-sampled onto ${MAX_MACOS_FRAMES} frames while preserving its full cycle time.`,
        );
      }
      if (built.normalization.differingFrameCounts) {
        warnings.push(
          `${resolvedRole} used different frame counts across resolution tiers; they were normalized onto one phase-aligned timeline.`,
        );
      }
      if (built.normalization.differingCycleDurations) {
        warnings.push(
          `${resolvedRole} used different cycle durations across resolution tiers; the tier nearest 32 px supplied the canonical cycle time.`,
        );
      }
      if (built.normalization.variableDelays) {
        warnings.push(
          `${resolvedRole} used variable frame delays; cumulative-delay sampling preserved their relative dwell times on macOS's uniform timeline.`,
        );
      }
      if (built.normalization.missingDelayCount > 0) {
        warnings.push(
          `${resolvedRole} omitted ${built.normalization.missingDelayCount} frame delay${built.normalization.missingDelayCount === 1 ? "" : "s"}; a conservative 50 ms delay was used.`,
        );
      }
    }
    cursors[macIdentifier] = builtRoles.get(resolvedRole);
    bindings.set(macIdentifier, {
      requested: requestedRole,
      resolved: resolvedRole,
      fallback: resolvedRole !== requestedRole,
    });
  }
  const fallbackCount = [...bindings.values()].filter(
    (binding) => binding.fallback,
  ).length;
  if (fallbackCount > 0) {
    warnings.push(
      `${fallbackCount} macOS cursor states were unavailable and use the theme's default pointer artwork.`,
    );
  }
  const theme = {
    Creator: metadata.author || "Imported by Cursor Atelier",
    Cursors: cursors,
    HiDPI: true,
    Identifier: metadata.identifier,
    ThemeName: metadata.displayName,
    ThemeVersion: 1,
    UUID: uuidV5(
      MACURSOR_UUID_NAMESPACE,
      `cursor-atelier:${metadata.identifier}`,
    ),
    Group: metadata.group || "Imported",
  };
  return { bindings, theme, warnings };
}

async function pngMetadata(buffer, limits) {
  try {
    return await sharp(buffer, {
      limitInputPixels: limits.maxSourcePixelsPerFile,
    }).metadata();
  } catch (error) {
    fail(
      "INVALID_CURSOR",
      "A cursor representation is not a valid PNG.",
      error,
    );
  }
}

async function framesFromPlistRecord(record, limits, decodedBudget) {
  if (!record || typeof record !== "object") {
    fail("INVALID_CURSOR", "A plist cursor record is malformed.");
  }
  const frameCount = Number(record.FrameCount ?? 1);
  const frameDuration = Number(record.FrameDuration ?? 1);
  const pointsWide = Number(record.PointsWide);
  const pointsHigh = Number(record.PointsHigh ?? pointsWide);
  const hotspotX = Number(record.HotSpotX ?? 0);
  const hotspotY = Number(record.HotSpotY ?? 0);
  const representations = record.Representations;
  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    frameCount > limits.maxSourceFrames ||
    !Number.isFinite(frameDuration) ||
    frameDuration <= 0 ||
    frameDuration > 60 ||
    !Number.isFinite(pointsWide) ||
    !Number.isFinite(pointsHigh) ||
    pointsWide <= 0 ||
    pointsHigh <= 0 ||
    pointsWide > limits.maxRepresentationSize ||
    pointsHigh > limits.maxRepresentationSize ||
    !Number.isFinite(hotspotX) ||
    !Number.isFinite(hotspotY) ||
    hotspotX < 0 ||
    hotspotY < 0 ||
    hotspotX >= pointsWide ||
    hotspotY >= pointsHigh ||
    !Array.isArray(representations) ||
    representations.length === 0 ||
    representations.length > 16
  ) {
    fail(
      "INVALID_CURSOR",
      "A plist cursor record has invalid geometry or timing.",
    );
  }

  const groups = new Map();
  for (const encodedValue of representations) {
    const encoded = Buffer.from(encodedValue);
    if (encoded.length === 0 || encoded.length > limits.maxEntryBytes) {
      fail("LIMIT_EXCEEDED", "A plist cursor representation is too large.");
    }
    const metadata = await pngMetadata(encoded, limits);
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > limits.maxSourceDimension ||
      metadata.height > limits.maxSourceDimension * frameCount ||
      metadata.height % frameCount !== 0 ||
      (metadata.pages ?? 1) !== 1
    ) {
      fail(
        "INVALID_CURSOR",
        "A plist cursor representation does not match its declared frame count.",
      );
    }
    const frameHeight = metadata.height / frameCount;
    const horizontalScale = metadata.width / pointsWide;
    const verticalScale = frameHeight / pointsHigh;
    const scaleTolerance = Math.max(
      0.01,
      Math.max(horizontalScale, verticalScale) * 0.01,
    );
    if (
      !Number.isFinite(horizontalScale) ||
      !Number.isFinite(verticalScale) ||
      Math.abs(horizontalScale - verticalScale) > scaleTolerance
    ) {
      fail(
        "INVALID_CURSOR",
        "A plist cursor representation does not use one isotropic declared scale.",
      );
    }
    const sourceScale = (horizontalScale + verticalScale) / 2;
    const targetSize = Math.max(1, Math.round(32 * sourceScale));
    if (targetSize > limits.maxSourceDimension) {
      fail(
        "LIMIT_EXCEEDED",
        "A plist cursor representation has an excessive scale.",
      );
    }
    const decodedByteLength = metadata.width * metadata.height * 4;
    decodedBudget.reserve(decodedByteLength);
    const { data, info } = await sharp(encoded, {
      limitInputPixels: limits.maxSourcePixelsPerFile,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== metadata.width || info.height !== metadata.height) {
      fail(
        "INVALID_CURSOR",
        "A plist cursor representation decoded inconsistently.",
      );
    }
    if (groups.has(targetSize)) {
      decodedBudget.release(decodedByteLength);
      continue;
    }
    // PNG stores straight-alpha color. Treat it as authoritative; guessing that
    // dark translucent pixels are premultiplied visibly brightens dark themes.
    const rgba = clearTransparentRgb(data);
    const frameBytes = metadata.width * frameHeight * 4;
    const frames = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      frames.push({
        rgba: rgba.subarray(
          frameIndex * frameBytes,
          (frameIndex + 1) * frameBytes,
        ),
        width: metadata.width,
        height: frameHeight,
        hotspotX: hotspotX * sourceScale,
        hotspotY: hotspotY * sourceScale,
        delayMs: frameDuration * 1000,
        nominalSize: targetSize,
      });
    }
    groups.set(targetSize, frames);
  }
  return groups;
}

function rejectAmbiguousCapeGeometry(cursors) {
  const records = [];
  const roles = new Set();
  for (const [identifier, role] of Object.entries(MAC_TO_ROLE)) {
    const record = cursors[identifier];
    if (!role || !record || roles.has(role)) {
      continue;
    }
    const width = Number(record.PointsWide);
    const height = Number(record.PointsHigh ?? width);
    const hotspotX = Number(record.HotSpotX ?? 0);
    const hotspotY = Number(record.HotSpotY ?? 0);
    if (
      [width, height, hotspotX, hotspotY].every(Number.isFinite) &&
      width > 0 &&
      height > 0
    ) {
      roles.add(role);
      records.push({ height, hotspotX, hotspotY, width });
    }
  }
  if (
    records.length >= 8 &&
    records.every(
      ({ height, hotspotX, hotspotY, width }) =>
        Math.max(width, height) > 48 &&
        Math.abs(hotspotX - width / 2) <= 0.01 &&
        Math.abs(hotspotY - height / 2) <= 0.01,
    ) &&
    new Set(records.map(({ hotspotX, hotspotY }) => `${hotspotX},${hotspotY}`))
      .size === 1
  ) {
    fail(
      "UNSUPPORTED_CAPE_GEOMETRY",
      "This Mousecape file applies the same centered hotspot to many semantically different 64-point cursor roles, so its local artwork origin cannot be recovered reliably. Import its Xcursor archive instead.",
    );
  }
}

function parsePlistBuffer(buffer) {
  try {
    if (buffer.subarray(0, 8).toString("ascii") === "bplist00") {
      assertBinaryCursorPlistBudget(buffer);
      return plist.parseBinary(buffer);
    }
    return plist.parse(buffer.toString("utf8"));
  } catch (error) {
    fail("INVALID_CURSOR", "The selected plist could not be parsed.", error);
  }
}

async function loadPlistVariant(file, format, limits) {
  if (file.size > limits.maxPlistBytes) {
    fail("LIMIT_EXCEEDED", "The selected cursor plist is too large.");
  }
  const bytes = await fsPromises.readFile(file.absolute);
  const parsed = parsePlistBuffer(bytes);
  if (!parsed || typeof parsed !== "object" || !parsed.Cursors) {
    fail("INVALID_CURSOR", "The selected plist has no Cursors dictionary.");
  }
  const cape = format === "mousecape";
  if (cape) {
    rejectAmbiguousCapeGeometry(parsed.Cursors);
  }
  const sourceFrames = new Map();
  const parsedRoles = new Map();
  const decodedBudget = createDecodedSourceBudget(limits);
  for (const [macIdentifier, role] of Object.entries(MAC_TO_ROLE)) {
    if (!role || parsedRoles.has(role) || !parsed.Cursors[macIdentifier]) {
      continue;
    }
    parsedRoles.set(role, true);
    sourceFrames.set(
      role,
      await framesFromPlistRecord(
        parsed.Cursors[macIdentifier],
        limits,
        decodedBudget,
      ),
    );
  }
  const fallbackName = titleFromName(
    path.basename(file.absolute, path.extname(file.absolute)),
  );
  const displayName = safeText(
    parsed.ThemeName ?? parsed.CapeName ?? parsed.Identifier,
    fallbackName,
  );
  return {
    author: safeText(
      parsed.Creator ?? parsed.Author,
      "Imported by Cursor Atelier",
    ),
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
    displayName,
    sourceFrames,
    sourceLabel: path.basename(file.absolute),
  };
}

function parseIndexTheme(text) {
  let inIconTheme = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inIconTheme = line.toLowerCase() === "[icon theme]";
      continue;
    }
    if (inIconTheme) {
      const separator = line.indexOf("=");
      if (
        separator > 0 &&
        line.slice(0, separator).trim().toLowerCase() === "name"
      ) {
        const value = line.slice(separator + 1).trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          return value.slice(1, -1).trim();
        }
        return value;
      }
    }
  }
  return null;
}

async function displayNameForXcursorDirectory(cursorDirectory) {
  const themeDirectory = path.dirname(cursorDirectory);
  const indexPath = path.join(themeDirectory, "index.theme");
  try {
    const stat = await fsPromises.lstat(indexPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024) {
      const name = parseIndexTheme(
        await fsPromises.readFile(indexPath, "utf8"),
      );
      if (name) {
        return safeText(name, titleFromName(path.basename(themeDirectory)));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  let sourceName = path.basename(themeDirectory);
  if (
    ["dist", "xcursors", "icons", ".icons"].includes(sourceName.toLowerCase())
  ) {
    sourceName = path.basename(path.dirname(themeDirectory));
  }
  return safeText(titleFromName(sourceName), "Imported Cursor");
}

async function loadXcursorVariant(cursorDirectory, files, limits) {
  const immediate = files
    .filter((file) => path.dirname(file.absolute) === cursorDirectory)
    .sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  if (immediate.length > limits.maxCursorFilesPerTheme) {
    fail("LIMIT_EXCEEDED", "An Xcursor theme contains too many cursor files.");
  }

  const xcursorFiles = [];
  const digestCache = new Map();
  for (const file of immediate) {
    const prefix = await readPrefix(file.absolute, 4);
    if (!isXcursorPrefix(prefix)) {
      continue;
    }
    if (file.size > limits.maxXcursorBytes) {
      fail("LIMIT_EXCEEDED", `An Xcursor file is too large: ${file.relative}.`);
    }
    if (!digestCache.has(file.absolute)) {
      digestCache.set(file.absolute, await sha256File(file.absolute));
    }
    xcursorFiles.push({
      ...file,
      digest: digestCache.get(file.absolute),
    });
  }
  if (xcursorFiles.length === 0) {
    fail(
      "INVALID_XCURSOR",
      "The discovered cursor directory contains no Xcursor files.",
    );
  }

  const variantHash = crypto.createHash("sha256");
  const roleFiles = new Map();
  const rolePriorities = new Map();
  for (const file of xcursorFiles) {
    const name = file.logicalName ?? path.basename(file.absolute);
    variantHash
      .update(name, "utf8")
      .update("\0")
      .update(String(file.size))
      .update("\0")
      .update(file.digest, "ascii")
      .update("\0");
    const role = canonicalRole(name);
    const priority = canonicalFilenamePriority(name);
    if (!roleFiles.has(role) || priority > rolePriorities.get(role)) {
      roleFiles.set(role, file);
      rolePriorities.set(role, priority);
    }
  }

  const neededRoles = new Set(Object.values(MAC_TO_ROLE).filter(Boolean));
  const sourceFrames = new Map();
  const frameCache = new Map();
  const decodedBudget = createDecodedSourceBudget(limits);
  for (const [role, file] of roleFiles) {
    if (!neededRoles.has(role)) {
      continue;
    }
    if (!frameCache.has(file.digest)) {
      const buffer = await fsPromises.readFile(file.absolute);
      frameCache.set(
        file.digest,
        groupXcursorFrames(
          parseXcursorBuffer(buffer, limits, decodedBudget),
          limits,
        ),
      );
    }
    sourceFrames.set(role, frameCache.get(file.digest));
  }
  const reconstruction = await learnXcursorReconstruction(sourceFrames);
  const displayName = await displayNameForXcursorDirectory(cursorDirectory);
  return {
    author: "Imported by Cursor Atelier",
    digest: variantHash.digest("hex"),
    displayName,
    reconstruction,
    sourceFrames,
    sourceLabel: path.basename(path.dirname(cursorDirectory)),
  };
}

async function discoverVariants(
  scan,
  sourceFormat,
  limits,
  consumeVariant = null,
) {
  const xcursorDirectories = new Set();
  const plistFiles = [];
  let capeCount = 0;
  let rawSourceCount = 0;
  for (const file of scan.files) {
    const extension = path.extname(file.absolute).toLowerCase();
    const prefix = await readPrefix(file.absolute);
    if (isXcursorPrefix(prefix)) {
      xcursorDirectories.add(path.dirname(file.absolute));
    }
    if (
      (extension === ".cape" || extension === ".cursor") &&
      looksLikePlist(prefix)
    ) {
      plistFiles.push({
        ...file,
        format: extension === ".cape" ? "mousecape" : "native-cursor",
      });
      if (extension === ".cape") {
        capeCount += 1;
      }
    }
    if ([".svg", ".spec"].includes(extension)) {
      rawSourceCount += 1;
    }
  }

  if (xcursorDirectories.size > 0) {
    const directories = [...xcursorDirectories].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    if (directories.length > limits.maxThemes) {
      fail("LIMIT_EXCEEDED", "The source contains too many cursor variants.");
    }
    const discovered = {
      format: sourceFormat,
      variants: [],
      warnings:
        capeCount > 0
          ? [
              `Used ${directories.length} Xcursor variant${directories.length === 1 ? "" : "s"} and ignored ${capeCount} Mousecape file${capeCount === 1 ? "" : "s"} from the same source to preserve native artwork scale.`,
            ]
          : [],
    };
    for (const directory of directories) {
      const variant = await loadXcursorVariant(directory, scan.files, limits);
      if (consumeVariant) {
        await consumeVariant(variant, discovered);
      } else {
        discovered.variants.push(variant);
      }
    }
    return discovered;
  }

  if (plistFiles.length > 0) {
    if (plistFiles.length > limits.maxThemes) {
      fail("LIMIT_EXCEEDED", "The source contains too many cursor variants.");
    }
    const formats = new Set(plistFiles.map((file) => file.format));
    const sourceContainer = sourceFormat.endsWith("-archive")
      ? "archive"
      : "directory";
    const discovered = {
      format:
        formats.size === 1
          ? `${[...formats][0]}-${sourceContainer}`
          : `plist-${sourceContainer}`,
      variants: [],
      warnings: [],
    };
    for (const file of plistFiles) {
      const variant = {
        ...(await loadPlistVariant(file, file.format, limits)),
        format: file.format,
      };
      if (consumeVariant) {
        await consumeVariant(variant, discovered);
      } else {
        discovered.variants.push(variant);
      }
    }
    return discovered;
  }

  if (rawSourceCount > 0) {
    fail(
      "UNSUPPORTED_SOURCE",
      "Raw SVG/config cursor sources are not supported in the packaged app. Choose the site's compiled Xcursor archive instead.",
    );
  }
  fail(
    "UNSUPPORTED_SOURCE",
    "No compiled Xcursor theme or supported macOS cursor plist was found.",
  );
}

async function previewPng(record, limits) {
  let representation = record.Representations.at(-1);
  for (const candidate of record.Representations) {
    const metadata = await pngMetadata(candidate, limits);
    if (metadata.width === 96) {
      representation = candidate;
      break;
    }
  }
  const metadata = await pngMetadata(representation, limits);
  if (
    !metadata.width ||
    metadata.height !== metadata.width * record.FrameCount ||
    (metadata.pages ?? 1) !== 1
  ) {
    fail("INVALID_CURSOR", "A generated preview representation is malformed.");
  }
  const { data, info } = await sharp(representation)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (record.FrameCount === 1) {
    return sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  }
  const duration = Math.max(1, Math.round(record.FrameDuration * 1000));
  const frameBytes = info.width * info.width * 4;
  const frames = Array.from({ length: record.FrameCount }, (_, index) => {
    const frameData = data.subarray(
      index * frameBytes,
      (index + 1) * frameBytes,
    );
    return frameData.buffer.slice(
      frameData.byteOffset,
      frameData.byteOffset + frameData.byteLength,
    );
  });
  return Buffer.from(
    UPNG.encode(
      frames,
      info.width,
      info.width,
      0,
      Array(record.FrameCount).fill(duration),
    ),
  );
}

function assertSafeOutputRoot(stagingRoot, artifactRoot) {
  if (
    path.dirname(artifactRoot) !== stagingRoot ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path.basename(artifactRoot))
  ) {
    fail("UNSAFE_OUTPUT", "The generated import identifier is unsafe.");
  }
}

async function writeArtifact(
  stagingRoot,
  variant,
  sourceFormat,
  sharedWarnings,
  limits,
  maximumGeneratedBytes,
  importMetadata,
) {
  const displayName = safeText(
    importMetadata?.displayName ?? variant.displayName,
    "Imported Cursor",
  );
  const identifier = `${slugIdentifier(displayName)}-${variant.digest.slice(0, 16)}`;
  const artifactRoot = path.join(stagingRoot, identifier);
  assertSafeOutputRoot(stagingRoot, artifactRoot);
  try {
    await fsPromises.mkdir(artifactRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        "OUTPUT_EXISTS",
        `The staging directory already contains ${identifier}.`,
        error,
      );
    }
    throw error;
  }

  try {
    let generatedBytes = 0;
    const countGeneratedBytes = (byteLength) => {
      const next = generatedBytes + byteLength;
      if (next > maximumGeneratedBytes) {
        fail(
          "LIMIT_EXCEEDED",
          "The converted cursor artifacts exceed the import output limit.",
        );
      }
      generatedBytes = next;
    };
    const built = await buildTheme(
      variant.sourceFrames,
      {
        author: importMetadata?.author ?? variant.author,
        displayName,
        group: importMetadata?.family ?? importMetadata?.group,
        identifier,
      },
      limits,
    );
    const cursorFileName = `${identifier}.cursor`;
    const cursorPath = path.join(artifactRoot, cursorFileName);
    const cursorBytes = Buffer.from(plist.buildBinary(built.theme));
    if (
      cursorBytes.length >
      Math.min(limits.maxCursorOutputBytes, MAX_NATIVE_CURSOR_BYTES)
    ) {
      fail(
        "LIMIT_EXCEEDED",
        `The converted theme is ${(cursorBytes.length / (1024 * 1024)).toFixed(1)} MiB; macOS imports are limited to 32 MiB.`,
      );
    }
    countGeneratedBytes(cursorBytes.length);
    await fsPromises.writeFile(cursorPath, cursorBytes, {
      flag: "wx",
      mode: 0o600,
    });

    const previewRoot = path.join(artifactRoot, "previews", identifier);
    await fsPromises.mkdir(previewRoot, { recursive: true, mode: 0o700 });
    const assets = new Map();
    const rolePreviews = [];
    for (const [macIdentifier, requestedRole] of Object.entries(MAC_TO_ROLE)) {
      const binding = built.bindings.get(macIdentifier);
      const record = built.theme.Cursors[macIdentifier];
      if (!assets.has(binding.resolved)) {
        const assetName = `${binding.resolved}.png`;
        const assetPath = path.join(previewRoot, assetName);
        const previewBytes = await previewPng(record, limits);
        countGeneratedBytes(previewBytes.length);
        await fsPromises.writeFile(assetPath, previewBytes, {
          flag: "wx",
          mode: 0o600,
        });
        assets.set(
          binding.resolved,
          path.posix.join("previews", identifier, assetName),
        );
      }
      rolePreviews.push({
        asset: assets.get(binding.resolved),
        fallback: binding.fallback,
        frameCount: record.FrameCount,
        frameDuration: record.FrameDuration,
        hotspot: { x: record.HotSpotX, y: record.HotSpotY },
        macIdentifier,
        resolvedRole: binding.resolved,
        role: requestedRole ?? "empty",
      });
    }

    const warnings = [...new Set([...sharedWarnings, ...built.warnings])];
    const cursorDigest = crypto
      .createHash("sha256")
      .update(cursorBytes)
      .digest("hex");
    const entry = {
      Identifier: identifier,
      DisplayName: displayName,
      Resource: cursorFileName,
      SHA256: cursorDigest,
      UUID: built.theme.UUID,
      ThemeName: displayName,
      Group: importMetadata?.family ?? importMetadata?.group ?? "Imported",
      Author: built.theme.Creator,
      ImportDigest: variant.digest,
      SourceFormat: variant.format ?? sourceFormat,
      ...(importMetadata?.catalogId
        ? { catalogId: importMetadata.catalogId }
        : {}),
      ...(importMetadata?.variant
        ? {
            Variant: importMetadata.variant,
            VariantLabel: importMetadata.variant,
          }
        : {}),
      ...(importMetadata?.upstreamVariant
        ? { UpstreamVariant: importMetadata.upstreamVariant }
        : {}),
      ...(importMetadata?.sourceUrl
        ? { SourceURL: importMetadata.sourceUrl }
        : {}),
      ...(importMetadata?.license ? { License: importMetadata.license } : {}),
      ...(importMetadata?.licenseUrl
        ? { LicenseURL: importMetadata.licenseUrl }
        : {}),
      preview: assets.get("default"),
      rolePreviews,
      ...(warnings.length > 0 ? { ImportWarnings: warnings } : {}),
    };
    const manifest = {
      roleCount: Object.keys(MAC_TO_ROLE).length,
      schemaVersion: 2,
      themes: [entry],
    };
    const manifestPath = path.join(artifactRoot, "manifest.json");
    const manifestBytes = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    countGeneratedBytes(manifestBytes.length);
    await fsPromises.writeFile(manifestPath, manifestBytes, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      generatedBytes,
      artifact: {
        identifier,
        displayName,
        digest: variant.digest,
        directory: artifactRoot,
        manifestPath,
        cursorPath,
        reconstruction: variant.reconstruction,
        sourceFormat: entry.SourceFormat,
        sourceLabel: variant.sourceLabel,
        warnings,
        entry,
      },
    };
  } catch (error) {
    await fsPromises.rm(artifactRoot, { recursive: true, force: true });
    throw error;
  }
}

async function ensureStagingRoot(stagingDirectory, sourcePath) {
  if (!stagingDirectory || typeof stagingDirectory !== "string") {
    fail("INVALID_OPTIONS", "A staging directory is required.");
  }
  const resolved = path.resolve(stagingDirectory);
  await fsPromises.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fsPromises.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_OUTPUT", "The staging path must be a regular directory.");
  }
  const real = await fsPromises.realpath(resolved);
  if (isWithin(sourcePath, real)) {
    fail("UNSAFE_OUTPUT", "The staging directory cannot be inside the source.");
  }
  return real;
}

async function directPlistVariant(sourcePath, format, limits) {
  const stat = await fsPromises.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("UNSAFE_SOURCE", "The selected cursor plist must be a regular file.");
  }
  const prefix = await readPrefix(sourcePath);
  if (!looksLikePlist(prefix)) {
    fail(
      "UNSUPPORTED_SOURCE",
      "This .cursor file is a build config, not a compiled macOS cursor theme. Choose a compiled Xcursor archive instead.",
    );
  }
  return loadPlistVariant(
    {
      absolute: sourcePath,
      relative: path.basename(sourcePath),
      size: stat.size,
    },
    format,
    limits,
  );
}

/**
 * Convert a downloaded cursor pack into self-contained, atomically installable
 * artifacts below a caller-owned staging directory.
 */
function importProgressReporter(callback) {
  if (callback !== undefined && typeof callback !== "function") {
    fail("INVALID_OPTIONS", "The import progress callback must be a function.");
  }
  let lastProgress = -1;
  return (phase, progress) => {
    const boundedProgress = Math.min(1, Math.max(lastProgress, progress));
    lastProgress = boundedProgress;
    if (!callback) {
      return;
    }
    try {
      callback({ phase, progress: boundedProgress });
    } catch {
      // Observers must not be able to interrupt an otherwise valid import.
    }
  };
}

export async function importCursorSource({
  sourcePath,
  stagingDirectory,
  limits: limitOverrides,
  onProgress,
  trustedMetadata,
}) {
  if (!sourcePath || typeof sourcePath !== "string") {
    fail("INVALID_OPTIONS", "A cursor source path is required.");
  }
  const reportProgress = importProgressReporter(onProgress);
  const importMetadata = normalizeImportMetadata(trustedMetadata);
  reportProgress("preparing", 0);
  const limits = mergedLimits(limitOverrides);
  const resolvedSource = path.resolve(sourcePath);
  let sourceStat;
  try {
    sourceStat = await fsPromises.lstat(resolvedSource);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("SOURCE_NOT_FOUND", "The selected cursor source no longer exists.");
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    fail("UNSAFE_SOURCE", "Symbolic-link import sources are not accepted.");
  }
  const sourceRealPath = await fsPromises.realpath(resolvedSource);
  const stagingRoot = await ensureStagingRoot(stagingDirectory, sourceRealPath);
  const extension = path.extname(sourceRealPath).toLowerCase();
  const sourcePrefix = sourceStat.isFile()
    ? await readPrefix(sourceRealPath, 512)
    : Buffer.alloc(0);
  let archiveKind = null;
  if (sourceStat.isFile()) {
    if (isZipPrefix(sourcePrefix)) {
      archiveKind = "zip";
    } else if (isXzPrefix(sourcePrefix)) {
      archiveKind = "xz";
    } else if (isGzipPrefix(sourcePrefix) || isTarPrefix(sourcePrefix)) {
      archiveKind = "tar";
    } else if (extension === ".zip") {
      archiveKind = "zip";
    } else if (hasXzTarExtension(sourceRealPath)) {
      archiveKind = "xz";
    } else if (hasTarExtension(sourceRealPath)) {
      archiveKind = "tar";
    }
  }

  let discovered;
  let temporaryRoot;
  const artifacts = [];
  const seen = new Map();
  const duplicateWarnings = [];
  let generatedBytes = 0;
  const consumeVariant = async (variant, metadata) => {
    if (
      importMetadata?.sourceVariant &&
      ![variant.sourceLabel, variant.displayName].some(
        (candidate) =>
          String(candidate).toLocaleLowerCase("en-US") ===
          importMetadata.sourceVariant.toLocaleLowerCase("en-US"),
      )
    ) {
      return;
    }
    const identityKey = `${slugIdentifier(variant.displayName)}-${variant.digest.slice(0, 16)}`;
    if (seen.has(identityKey)) {
      if (seen.get(identityKey) !== variant.digest) {
        fail(
          "IDENTIFIER_COLLISION",
          "Two imported variants produced the same identifier.",
        );
      }
      duplicateWarnings.push(
        `Skipped duplicate variant ${safeText(variant.displayName, identityKey)}.`,
      );
      return;
    }
    if (importMetadata?.catalogId && artifacts.length > 0) {
      fail(
        "AMBIGUOUS_METADATA",
        "Catalog metadata matched more than one cursor variant; specify sourceVariant.",
      );
    }
    seen.set(identityKey, variant.digest);
    reportProgress("converting", 0.55);
    const written = await writeArtifact(
      stagingRoot,
      variant,
      metadata.format,
      metadata.warnings,
      limits,
      limits.maxGeneratedBytes - generatedBytes,
      importMetadata,
    );
    generatedBytes += written.generatedBytes;
    artifacts.push(written.artifact);
  };
  try {
    if (sourceStat.isDirectory()) {
      reportProgress("discovering", 0.25);
      discovered = await discoverVariants(
        await scanDirectory(sourceRealPath, limits),
        "xcursor-directory",
        limits,
        consumeVariant,
      );
    } else if (archiveKind) {
      if (sourceStat.size > limits.maxArchiveBytes) {
        fail(
          "LIMIT_EXCEEDED",
          "The selected archive is larger than the import limit.",
        );
      }
      temporaryRoot = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "cursor-atelier-import-"),
      );
      await fsPromises.chmod(temporaryRoot, 0o700);
      reportProgress("extracting", 0.1);
      const pinnedArchive = path.join(temporaryRoot, "source.archive");
      await fsPromises.copyFile(
        sourceRealPath,
        pinnedArchive,
        fs.constants.COPYFILE_EXCL,
      );
      await fsPromises.chmod(pinnedArchive, 0o600);
      const extractionRoot = path.join(temporaryRoot, "expanded");
      await fsPromises.mkdir(extractionRoot, { mode: 0o700 });
      if (archiveKind === "zip") {
        await preflightZip(pinnedArchive, limits);
        const { default: extractZip } = await import("extract-zip");
        try {
          await extractZip(pinnedArchive, {
            dir: extractionRoot,
            defaultDirMode: 0o700,
            defaultFileMode: 0o600,
          });
        } catch (error) {
          fail(
            "INVALID_ARCHIVE",
            "The archive could not be extracted safely.",
            error,
          );
        }
      } else {
        const compression = archiveKind === "xz" ? "xz" : "auto";
        const records = await preflightTar(pinnedArchive, limits, compression);
        await extractTar(
          pinnedArchive,
          extractionRoot,
          records,
          limits,
          compression,
        );
      }
      reportProgress("discovering", 0.3);
      discovered = await discoverVariants(
        await scanDirectory(extractionRoot, limits),
        "xcursor-archive",
        limits,
        consumeVariant,
      );
    } else if (sourceStat.isFile() && extension === ".cursor") {
      reportProgress("discovering", 0.25);
      discovered = {
        format: "native-cursor",
        variants: [],
        warnings: [],
      };
      await consumeVariant(
        {
          ...(await directPlistVariant(
            sourceRealPath,
            "native-cursor",
            limits,
          )),
          format: "native-cursor",
        },
        discovered,
      );
    } else if (sourceStat.isFile() && extension === ".cape") {
      reportProgress("discovering", 0.25);
      discovered = {
        format: "mousecape",
        variants: [],
        warnings: [],
      };
      await consumeVariant(
        {
          ...(await directPlistVariant(sourceRealPath, "mousecape", limits)),
          format: "mousecape",
        },
        discovered,
      );
    } else {
      fail(
        "UNSUPPORTED_SOURCE",
        "Choose a compiled Xcursor theme directory or archive, a .cursor theme, or a compatible .cape file. Raw SVG/config sources are not supported.",
      );
    }

    if (artifacts.length === 0) {
      fail(
        "UNSUPPORTED_SOURCE",
        "The source contained no distinct cursor variants.",
      );
    }
    reportProgress("finalizing", 0.95);
    const result = {
      sourceFormat: discovered.format,
      sourcePath: sourceRealPath,
      artifactCount: artifacts.length,
      artifacts,
      warnings: [...new Set([...discovered.warnings, ...duplicateWarnings])],
      selection: {
        identifier: artifacts[0].identifier,
        displayName: artifacts[0].displayName,
      },
    };
    reportProgress("completed", 1);
    return result;
  } catch (error) {
    for (const artifact of artifacts) {
      if (path.dirname(artifact.directory) === stagingRoot) {
        await fsPromises.rm(artifact.directory, {
          recursive: true,
          force: true,
        });
      }
    }
    throw error;
  } finally {
    if (temporaryRoot) {
      const temporaryParent = path.resolve(os.tmpdir());
      const resolvedTemporaryRoot = path.resolve(temporaryRoot);
      if (
        path.dirname(resolvedTemporaryRoot) === temporaryParent &&
        path
          .basename(resolvedTemporaryRoot)
          .startsWith("cursor-atelier-import-")
      ) {
        await fsPromises.rm(resolvedTemporaryRoot, {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

export const __testing = Object.freeze({
  MAC_TO_ROLE,
  ROLE_ALIASES,
  buildTheme,
  buildCursorRecord,
  canonicalRole,
  discoverVariants,
  learnXcursorReconstruction,
  parseXcursorBuffer,
  preflightTar,
  preflightZip,
  previewPng,
  safeText,
  scanDirectory,
  selectedFrameIndices,
  synthesizeProgressSource,
  visualReconstructionError,
  waitProgressThumbnail,
  WAIT_PROGRESS_THUMBNAIL_SIZE,
  visuallyEquivalentWaitProgress,
});
