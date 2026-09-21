import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { ROLE_ALIASES } from "./cursor-roles.js";

import { readCursorTheme as readLinuxCursorTheme } from "./cursor-theme-reader.js";
export { readLinuxCursorTheme };

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// X11 names still requested by older toolkits, in addition to CSS/Wayland names.
const X11_ALIASES = Object.freeze({
  X_cursor: "pirate",
  "00008160000006810000408080010102": "size_ver",
  "028006030e0e7ebffc7f7070c0600140": "size_hor",
  "03b6e0fcb3499374a867c041f52298f0": "not-allowed",
  "08e8e1c95fe2fc01f976f1e063a24ccd": "progress",
  "1081e37283d90000800003c07f3ef6bf": "copy",
  "3085a0e285430894940527032f8b26df": "alias",
  "3ecb610c1bf2410f44200f48c40d3599": "progress",
  "4498f0e0c1937ffe01fd06f973665830": "fleur",
  "6407b0e94181790501fd1e167b474872": "copy",
  "640fb0e74195791501fd1ed57b41487f": "alias",
  "9d800788f1b08800ae810202380a0822": "pointer",
  c7088f0f3e6c8088236ef8e1e3e70000: "size_bdiag",
  d9ce0ab605698f320427677b458ad60b: "help",
  e29285e634086352946a0e7090d73106: "pointer",
  fcf1c3c7cd4491d801f1e1c78f100000: "size_fdiag",
  "9081237383d90e509aa00f00170e968f": "fleur",
  fleur: "fleur",
});

/** Repackage approved PNGs with the encoder in the bundled conversion runtime. */
export async function installLinuxCursorTheme({
  theme,
  iconsDirectory,
  runCommand,
  encoderExecutable,
  sizePercentage = 100,
}) {
  if (
    !Number.isInteger(sizePercentage) ||
    sizePercentage < 50 ||
    sizePercentage > 200
  ) {
    throw new TypeError("Cursor size must be an integer between 50 and 200.");
  }
  const decoded = await readLinuxCursorTheme(theme);
  const name = `cursor-atelier-${decoded.sha256.slice(0, 20)}-${sizePercentage}`;
  const destination = path.join(iconsDirectory, name);
  const size = Math.max(
    1,
    Math.round((decoded.nominalSize * sizePercentage) / 100),
  );
  const marker = {
    schemaVersion: 1,
    identifier: theme.identifier,
    sha256: decoded.sha256,
    sizePercentage,
  };
  try {
    const existing = await verifiedGeneratedTheme(destination);
    if (
      existing &&
      existing.identifier === marker.identifier &&
      existing.sha256 === marker.sha256 &&
      existing.sizePercentage === marker.sizePercentage
    ) {
      return { name, size, directory: destination };
    }
    await fs.access(destination);
    throw new Error(
      "A generated cursor theme is incomplete. Restore the system cursor before removing that generated theme.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!path.isAbsolute(encoderExecutable ?? "")) {
    throw new Error("The bundled Linux cursor encoder is unavailable.");
  }
  await fs.mkdir(iconsDirectory, { recursive: true });
  const stage = await fs.mkdtemp(
    path.join(iconsDirectory, ".cursor-atelier-stage-"),
  );
  const framesDirectory = path.join(stage, "frames");
  const cursorsDirectory = path.join(stage, "cursors");
  try {
    await fs.mkdir(framesDirectory);
    await fs.mkdir(cursorsDirectory);
    const cursorJobs = [];
    for (const [role, record] of decoded.roles) {
      const frames = [];
      const representations = [...record.representations];
      // Keep every original tier. Additional sizes make the percentage slider exact
      // on desktops whose Xcursor loader only chooses existing nominal sizes.
      for (const factor of [1, 2, 3]) {
        const width = Math.max(
          1,
          Math.round(((record.PointsWide * sizePercentage) / 100) * factor),
        );
        if (representations.some((rep) => rep.width === width)) {
          continue;
        }
        const source =
          record.representations.find((rep) => rep.width >= width) ??
          record.representations.at(-1);
        representations.push({
          ...source,
          outputWidth: width,
          nominalSize: Math.max(
            1,
            Math.round(((decoded.nominalSize * sizePercentage) / 100) * factor),
          ),
          outputHeight: Math.max(
            1,
            Math.round(((record.PointsHigh * sizePercentage) / 100) * factor),
          ),
        });
      }
      for (const [representationIndex, rep] of representations.entries()) {
        for (let frame = 0; frame < record.FrameCount; frame++) {
          const filename = `${role}-${representationIndex}-${frame}.png`;
          const width = rep.outputWidth ?? rep.width;
          const height = rep.outputHeight ?? rep.height;
          let pipeline = sharp(rep.png).extract({
            left: 0,
            top: frame * rep.height,
            width: rep.width,
            height: rep.height,
          });
          if (rep.outputWidth) {
            pipeline = pipeline.resize(width, height, {
              kernel: sharp.kernel.lanczos3,
            });
          }
          await pipeline.png().toFile(path.join(framesDirectory, filename));
          const hotX = Math.min(
            width - 1,
            Math.round((record.HotSpotX * width) / record.PointsWide),
          );
          const hotY = Math.min(
            height - 1,
            Math.round((record.HotSpotY * height) / record.PointsHigh),
          );
          const nominalSize =
            rep.nominalSize ?? Math.round(decoded.nominalSize * rep.scale);
          frames.push({
            nominalSize,
            hotX,
            hotY,
            filename,
            delay: Math.round(record.FrameDuration * 1000),
          });
        }
      }
      cursorJobs.push({ name: role, frames });
    }
    const manifestPath = path.join(framesDirectory, "encode.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, cursors: cursorJobs }),
    );
    await runCommand(
      encoderExecutable,
      [
        "encode-xcursor",
        "--manifest",
        manifestPath,
        "--output-root",
        cursorsDirectory,
      ],
      { timeout: 120_000 },
    );
    for (const [alias, role] of Object.entries({
      ...ROLE_ALIASES,
      ...X11_ALIASES,
    })) {
      if (!decoded.roles.has(alias) && decoded.roles.has(role)) {
        await fs.symlink(role, path.join(cursorsDirectory, alias));
      }
    }
    await fs.writeFile(
      path.join(stage, "index.theme"),
      `[Icon Theme]\nName=${name}\nComment=Cursor Atelier\nInherits=default\n`,
    );
    await fs.rm(framesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(stage, ".cursor-atelier.json"),
      JSON.stringify({ ...marker, files: await generatedFiles(stage) }),
    );
    await fs.chmod(stage, 0o755);
    await fs.rename(stage, destination);
    return { name, size, directory: destination };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only complete generated artifacts whose contents still match our receipt. */
export async function removeLinuxCursorThemes({
  iconsDirectory,
  identifier = null,
  keepNames = [],
}) {
  let entries;
  try {
    entries = await fs.readdir(iconsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (entries.length > 8192) {
    throw new Error(
      "The cursor icon directory has too many entries to clean safely.",
    );
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^cursor-atelier-[a-f0-9]{20}-(?:[5-9][0-9]|1[0-9]{2}|200)$/.test(
        entry.name,
      ) ||
      keepNames.includes(entry.name)
    ) {
      continue;
    }
    const directory = path.join(iconsDirectory, entry.name);
    const receipt = await verifiedGeneratedTheme(directory);
    if (!receipt || (identifier && receipt.identifier !== identifier)) {
      continue;
    }
    await fs.rm(directory, { recursive: true });
  }
}

async function generatedFiles(directory) {
  const files = {};
  const roots = (await fs.readdir(directory)).sort();
  if (
    roots.some(
      (name) =>
        !["cursors", "index.theme", ".cursor-atelier.json"].includes(name),
    )
  ) {
    return null;
  }
  const cursorRoot = path.join(directory, "cursors");
  const entries = await fs.readdir(cursorRoot, { withFileTypes: true });
  if (entries.length > 256) {
    return null;
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const filename = path.join(cursorRoot, entry.name);
    if (entry.isSymbolicLink()) {
      files[`cursors/${entry.name}`] = `link:${await fs.readlink(filename)}`;
    } else if (entry.isFile()) {
      const stat = await fs.lstat(filename);
      totalBytes += stat.size;
      if (
        !stat.isFile() ||
        stat.size > MAX_FILE_BYTES ||
        totalBytes > 512 * 1024 * 1024
      ) {
        return null;
      }
      files[`cursors/${entry.name}`] = crypto
        .createHash("sha256")
        .update(await fs.readFile(filename))
        .digest("hex");
    } else {
      return null;
    }
  }
  files["index.theme"] = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(directory, "index.theme")))
    .digest("hex");
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function verifiedGeneratedTheme(directory) {
  try {
    const markerPath = path.join(directory, ".cursor-atelier.json");
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.size > 64 * 1024) {
      return null;
    }
    const receipt = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (
      receipt.schemaVersion !== 1 ||
      !IDENTIFIER.test(receipt.identifier) ||
      !receipt.files ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      path.basename(directory) !==
        `cursor-atelier-${receipt.sha256.slice(0, 20)}-${receipt.sizePercentage}`
    ) {
      return null;
    }
    return JSON.stringify(receipt.files) ===
      JSON.stringify(await generatedFiles(directory))
      ? receipt
      : null;
  } catch {
    return null;
  }
}
