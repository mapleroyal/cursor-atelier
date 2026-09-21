import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import * as plist from "plist";
import path from "node:path";
import sharp from "sharp";
import { MAC_TO_ROLE } from "./cursor-roles.js";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_IMPORTED_CURSOR";
  return error;
}

function number(value, min, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

export async function readCursorTheme(theme) {
  if (
    !IDENTIFIER.test(theme?.identifier ?? "") ||
    !path.isAbsolute(theme?.resourcePath ?? "")
  ) {
    throw invalid("The cursor theme resource is invalid.");
  }
  const initial = await fs.lstat(theme.resourcePath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw invalid("The cursor resource must be a regular, unlinked file.");
  }
  const file = await fs.open(
    theme.resourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.ino !== initial.ino ||
      stat.dev !== initial.dev ||
      stat.size < 8 ||
      stat.size > MAX_FILE_BYTES
    ) {
      throw invalid("The cursor theme exceeds the supported file size.");
    }
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    const tail = await file.read(Buffer.alloc(1), 0, 1, offset);
    if (offset !== stat.size || tail.bytesRead) {
      throw invalid("The cursor theme changed while reading it.");
    }
  } finally {
    await file.close();
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (theme.sha256 && sha256 !== theme.sha256.toLowerCase()) {
    throw invalid("The cursor theme resource failed its integrity check.");
  }
  const parsed =
    bytes.subarray(0, 8).toString() === "bplist00"
      ? plist.parseBinary(bytes)
      : plist.parse(bytes.toString("utf8"));
  if (
    parsed?.Identifier !== theme.identifier ||
    (theme.uuid && parsed.UUID !== theme.uuid) ||
    (theme.themeName && parsed.ThemeName !== theme.themeName) ||
    !parsed.Cursors ||
    typeof parsed.Cursors !== "object" ||
    Object.keys(parsed.Cursors).length !== Object.keys(MAC_TO_ROLE).length ||
    Object.keys(parsed.Cursors).some((key) => !(key in MAC_TO_ROLE))
  ) {
    throw invalid("The cursor theme metadata or cursor roles are invalid.");
  }
  const roles = new Map();
  let decodedBytes = 0;
  for (const [identifier, role] of Object.entries(MAC_TO_ROLE)) {
    const record = parsed.Cursors[identifier];
    if (
      !record ||
      !Number.isInteger(record.FrameCount) ||
      !number(record.FrameCount, 1, 24) ||
      !number(record.FrameDuration, 0.001, 10) ||
      !number(record.PointsWide, 1, 256) ||
      !number(record.PointsHigh, 1, 256) ||
      !number(record.HotSpotX, 0, record.PointsWide - 0.000001) ||
      !number(record.HotSpotY, 0, record.PointsHigh - 0.000001) ||
      !Array.isArray(record.Representations) ||
      record.Representations.length < 3 ||
      record.Representations.length > 16
    ) {
      throw invalid(
        `The cursor ${identifier} has invalid geometry or animation timing.`,
      );
    }
    const representations = [];
    let previousScale = 0;
    let encodedBytes = 0;
    for (const representation of record.Representations) {
      const png =
        representation instanceof Uint8Array
          ? Buffer.from(representation)
          : null;
      if (!png || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw invalid(
          `The cursor ${identifier} has an invalid PNG representation.`,
        );
      }
      encodedBytes += png.length;
      if (encodedBytes > 16 * 1024 * 1024) {
        throw invalid("The cursor PNG payload is too large.");
      }
      const metadata = await sharp(png, {
        limitInputPixels: MAX_DECODED_BYTES / 4,
      }).metadata();
      const { width, height } = metadata;
      const scale = width / record.PointsWide;
      const frameHeight = height / record.FrameCount;
      const imageBytes = width * height * 4;
      decodedBytes += imageBytes;
      if (
        !Number.isInteger(frameHeight) ||
        scale < 1 ||
        scale > 10 ||
        scale <= previousScale ||
        Math.abs(frameHeight / record.PointsHigh - scale) > 0.000001 ||
        width > 8192 ||
        height > 8192 ||
        decodedBytes > MAX_DECODED_BYTES
      ) {
        throw invalid(
          `The cursor ${identifier} has invalid sprite-sheet dimensions.`,
        );
      }
      // Force a decode during validation, rather than accepting only a PNG header.
      await sharp(png, { limitInputPixels: MAX_DECODED_BYTES / 4 })
        .raw()
        .toBuffer();
      previousScale = scale;
      representations.push({ png, width, height: frameHeight, scale });
    }
    if (
      ![1, 2, 3].every((scale) =>
        representations.some((rep) => rep.scale === scale),
      )
    ) {
      throw invalid(
        `The cursor ${identifier} is missing a 1x, 2x, or 3x representation.`,
      );
    }
    if (role && !roles.has(role)) {
      roles.set(role, { ...record, representations });
    }
  }
  return {
    identifier: theme.identifier,
    sha256,
    roles,
    nominalSize: Math.round(
      parsed.Cursors["com.apple.coregraphics.Arrow"].PointsWide,
    ),
  };
}
