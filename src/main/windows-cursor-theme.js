import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { readCursorTheme } from "./cursor-theme-reader.js";

// No handwriting/location/person artwork exists in the portable format.
// Those Windows roles retain the user's original cursor.
export const WINDOWS_CURSOR_ROLES = Object.freeze({
  Arrow: "default",
  Help: "help",
  AppStarting: "progress",
  Wait: "wait",
  Crosshair: "crosshair",
  IBeam: "text",
  No: "not-allowed",
  SizeNS: "size_ver",
  SizeWE: "size_hor",
  SizeNWSE: "size_fdiag",
  SizeNESW: "size_bdiag",
  SizeAll: "fleur",
  UpArrow: "up-arrow",
  Hand: "pointer",
});
const GENERATED =
  /^cursor-atelier-[a-f0-9]{20}-(?:[5-9][0-9]|1[0-9]{2}|200)-[0-9]{1,3}$/;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export async function readWindowsCursorReceipt(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Unsafe Windows cursor directory.");
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    entries.length !== Object.keys(WINDOWS_CURSOR_ROLES).length + 1 ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error("The generated Windows cursor theme is incomplete.");
  }
  const receiptPath = path.join(directory, ".cursor-atelier.json");
  const receiptStat = await fs.lstat(receiptPath);
  if (
    !receiptStat.isFile() ||
    receiptStat.isSymbolicLink() ||
    receiptStat.nlink !== 1 ||
    receiptStat.size > 64 * 1024
  ) {
    throw new Error("Invalid Windows cursor receipt.");
  }
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    !receipt.files ||
    Object.keys(receipt.files).length !==
      Object.keys(WINDOWS_CURSOR_ROLES).length
  ) {
    throw new Error("Invalid Windows cursor receipt.");
  }
  const files = {};
  for (const name of Object.keys(WINDOWS_CURSOR_ROLES)) {
    const entry = entries.find(
      (item) => item.name === `${name}.cur` || item.name === `${name}.ani`,
    );
    if (!entry) {
      throw new Error(`The generated ${name} cursor is missing.`);
    }
    const filename = path.join(directory, entry.name);
    const fileStat = await fs.lstat(filename);
    if (
      fileStat.nlink !== 1 ||
      fileStat.size > MAX_FILE_BYTES ||
      hash(await fs.readFile(filename)) !== receipt.files[entry.name]
    ) {
      throw new Error("A generated Windows cursor failed its integrity check.");
    }
    files[name] = filename;
  }
  return { ...receipt, files };
}

export async function installWindowsCursorTheme({
  theme,
  themesDirectory,
  runCommand,
  encoderExecutable,
  sizePercentage = 100,
  systemSize = 32,
}) {
  if (
    !Number.isInteger(sizePercentage) ||
    sizePercentage < 50 ||
    sizePercentage > 200 ||
    !Number.isInteger(systemSize) ||
    systemSize < 16 ||
    systemSize > 256
  ) {
    throw new TypeError("The Windows cursor size is invalid.");
  }
  const decoded = await readCursorTheme(theme);
  const name = `cursor-atelier-${decoded.sha256.slice(0, 20)}-${sizePercentage}-${systemSize}`;
  const destination = path.join(themesDirectory, name);
  const scale = ((sizePercentage / 100) * systemSize) / 32;
  const size = Math.max(1, Math.round(decoded.nominalSize * scale));
  const marker = {
    schemaVersion: 1,
    identifier: theme.identifier,
    sha256: decoded.sha256,
    sizePercentage,
    systemSize,
    size,
  };
  try {
    const existing = await readWindowsCursorReceipt(destination);
    if (
      Object.entries(marker).some(([key, value]) => existing[key] !== value)
    ) {
      throw new Error("The generated Windows cursor identity is invalid.");
    }
    return { name, size, directory: destination, files: existing.files };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!path.isAbsolute(encoderExecutable ?? "")) {
    throw new Error("The bundled Windows cursor encoder is unavailable.");
  }
  await fs.mkdir(themesDirectory, { recursive: true });
  const stage = await fs.mkdtemp(
    path.join(themesDirectory, ".cursor-atelier-stage-"),
  );
  const framesDirectory = path.join(stage, "frames");
  try {
    await fs.mkdir(framesDirectory);
    const jobs = [];
    for (const [slot, role] of Object.entries(WINDOWS_CURSOR_ROLES)) {
      const record = decoded.roles.get(role);
      if (!record) {
        throw new Error(`The cursor theme is missing the ${role} role.`);
      }
      const width = Math.max(1, Math.round(record.PointsWide * scale));
      const height = Math.max(1, Math.round(record.PointsHigh * scale));
      const canvas = Math.max(width, height);
      if (canvas > 256) {
        throw new Error(
          "This cursor exceeds Windows' 256-pixel cursor limit at the selected size.",
        );
      }
      const source =
        record.representations.find(
          (rep) => rep.width >= width && rep.height >= height,
        ) ?? record.representations.at(-1);
      const frames = [];
      for (let frame = 0; frame < record.FrameCount; frame++) {
        const filename = `${slot}-${frame}.png`;
        await sharp(source.png)
          .extract({
            left: 0,
            top: frame * source.height,
            width: source.width,
            height: source.height,
          })
          .resize(width, height, { kernel: sharp.kernel.lanczos3 })
          .extend({
            top: 0,
            left: 0,
            right: canvas - width,
            bottom: canvas - height,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toFile(path.join(framesDirectory, filename));
        frames.push({
          filename,
          hotX: Math.min(
            width - 1,
            Math.round((record.HotSpotX * width) / record.PointsWide),
          ),
          hotY: Math.min(
            height - 1,
            Math.round((record.HotSpotY * height) / record.PointsHigh),
          ),
          durationSeconds: record.FrameDuration,
        });
      }
      jobs.push({ name: slot, frames });
    }
    const manifestPath = path.join(framesDirectory, "encode.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, cursors: jobs }),
    );
    await runCommand(
      encoderExecutable,
      ["encode-windows", "--manifest", manifestPath, "--output-root", stage],
      { timeout: 120_000 },
    );
    await fs.rm(framesDirectory, { recursive: true });
    const files = {};
    for (const entry of await fs.readdir(stage, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^[A-Za-z]+\.(?:cur|ani)$/.test(entry.name) ||
        !Object.hasOwn(WINDOWS_CURSOR_ROLES, path.parse(entry.name).name)
      ) {
        throw new Error("The Windows encoder produced an unexpected artifact.");
      }
      const filename = path.join(stage, entry.name);
      if ((await fs.stat(filename)).size > MAX_FILE_BYTES) {
        throw new Error("The Windows encoder produced an oversized cursor.");
      }
      files[entry.name] = hash(await fs.readFile(filename));
    }
    await fs.writeFile(
      path.join(stage, ".cursor-atelier.json"),
      JSON.stringify({ ...marker, files }),
    );
    await readWindowsCursorReceipt(stage);
    await fs.rename(stage, destination);
    return {
      name,
      size,
      directory: destination,
      files: (await readWindowsCursorReceipt(destination)).files,
    };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function removeWindowsCursorThemes({
  themesDirectory,
  identifier = null,
  keepNames = [],
}) {
  let entries;
  try {
    entries = await fs.readdir(themesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (entries.length > 8192) {
    throw new Error(
      "Too many generated Windows cursor themes to clean safely.",
    );
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !GENERATED.test(entry.name) ||
      keepNames.includes(entry.name)
    ) {
      continue;
    }
    const directory = path.join(themesDirectory, entry.name);
    let receipt;
    try {
      receipt = await readWindowsCursorReceipt(directory);
    } catch {
      continue;
    }
    if (!identifier || receipt.identifier === identifier) {
      await fs.rm(directory, { recursive: true });
    }
  }
}
