import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as plist from "plist";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_TO_ROLE } from "./cursor-roles.js";
import {
  installWindowsCursorTheme,
  readWindowsCursorReceipt,
  removeWindowsCursorThemes,
  WINDOWS_CURSOR_ROLES,
} from "./windows-cursor-theme.js";
import { runWindowsCursorCommand } from "./windows-cursor-desktop.js";
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "windows-cursor-theme-"),
  );
  directories.push(directory);
  const representations = [];
  for (const scale of [1, 2, 3]) {
    const width = 4 * scale;
    const pixels = Buffer.alloc(width * width * 2 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset < pixels.length / 2 ? offset : offset + 2] = 255;
      pixels[offset + 3] = offset < pixels.length / 2 ? 128 : 255;
    }
    representations.push(
      await sharp(pixels, { raw: { width, height: width * 2, channels: 4 } })
        .png()
        .toBuffer(),
    );
  }
  const record = {
    FrameCount: 2,
    FrameDuration: 0.06,
    PointsWide: 4,
    PointsHigh: 4,
    HotSpotX: 1,
    HotSpotY: 2,
    Representations: representations,
  };
  const data = {
    Identifier: "Fixture",
    UUID: "test",
    ThemeName: "Test",
    Cursors: Object.fromEntries(
      Object.keys(MAC_TO_ROLE).map((identifier) => [identifier, record]),
    ),
  };
  data.Cursors["com.apple.coregraphics.IBeam"] = {
    ...record,
    PointsWide: 2,
    Representations: await Promise.all(
      representations.map(async (png, index) => {
        const scale = index + 1;
        return sharp(png)
          .extract({ left: 0, top: 0, width: 2 * scale, height: 8 * scale })
          .png()
          .toBuffer();
      }),
    ),
  };
  const resourcePath = path.join(directory, "Fixture.cursor");
  await fs.writeFile(resourcePath, Buffer.from(plist.buildBinary(data)));
  return {
    directory,
    data,
    theme: { identifier: "Fixture", resourcePath, uuid: "test" },
  };
}

function chunk(bytes, name, offset = 12) {
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.subarray(offset, offset + 4).toString() === name) {
      return bytes.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error(`Missing ${name} chunk`);
}
describe("Windows cursor encoding", () => {
  it.skipIf(process.platform !== "win32")(
    "round-trips animation timing, hotspots, rectangular artwork and exact sizes through the real bundled writer",
    async () => {
      const { theme, directory } = await fixture();
      const themesDirectory = path.join(directory, "themes");
      const python = path.resolve(
        "native/cursor-packs/build/curated-converter/tooling-Windows-x64/Scripts/python.exe",
      );
      const options = {
        theme,
        themesDirectory,
        encoderExecutable: python,
        sizePercentage: 150,
        runCommand: (command, args, options) =>
          runWindowsCursorCommand(
            command,
            [path.resolve("native/cursor-packs/curated_runtime.py"), ...args],
            options,
          ),
      };
      const installed = await installWindowsCursorTheme(options);
      expect(Object.keys(installed.files)).toHaveLength(14);
      expect(installed.size).toBe(6);
      const bytes = await fs.readFile(installed.files.IBeam);
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
      const rates = chunk(bytes, "rate");
      expect([rates.readUInt32LE(0), rates.readUInt32LE(4)]).toEqual([4, 3]);
      const list = chunk(bytes, "LIST");
      const cursor = chunk(list, "icon", 4);
      expect(cursor.readUInt16LE(2)).toBe(2);
      expect([
        cursor[6],
        cursor[7],
        cursor.readUInt16LE(10),
        cursor.readUInt16LE(12),
      ]).toEqual([6, 6, 2, 3]);
      const png = cursor.subarray(cursor.readUInt32LE(18));
      const decoded = await sharp(png)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(decoded.info.width).toBe(6);
      expect(decoded.data[3]).toBe(128);
      expect(decoded.data[5 * 4 + 3]).toBe(0);
      await expect(installWindowsCursorTheme(options)).resolves.toMatchObject({
        name: installed.name,
      });
      await removeWindowsCursorThemes({
        themesDirectory,
        keepNames: [installed.name],
      });
      await expect(
        readWindowsCursorReceipt(installed.directory),
      ).resolves.toMatchObject({ identifier: "Fixture" });
      await fs.appendFile(installed.files.Arrow, "tampered");
      await expect(installWindowsCursorTheme(options)).rejects.toThrow(
        "integrity",
      );
      await removeWindowsCursorThemes({ themesDirectory });
      expect((await fs.stat(installed.directory)).isDirectory()).toBe(true);
    },
    30_000,
  );
});

describe("Windows cursor receipt ownership", () => {
  it.each(["hard link", "symbolic link"])(
    "rejects a %s receipt and preserves the directory during cleanup",
    async (linkType) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "windows-cursor-receipt-"),
      );
      directories.push(directory);
      const name = `cursor-atelier-${"a".repeat(20)}-100-32`;
      const generated = path.join(directory, name);
      await fs.mkdir(generated);
      const files = {};
      for (const role of Object.keys(WINDOWS_CURSOR_ROLES)) {
        const filename = `${role}.cur`;
        const bytes = Buffer.from(role);
        await fs.writeFile(path.join(generated, filename), bytes);
        files[filename] = crypto
          .createHash("sha256")
          .update(bytes)
          .digest("hex");
      }
      const receiptPath = path.join(generated, ".cursor-atelier.json");
      const receipt = JSON.stringify({
        schemaVersion: 1,
        identifier: "Fixture",
        files,
      });
      await fs.writeFile(receiptPath, receipt);
      await expect(readWindowsCursorReceipt(generated)).resolves.toMatchObject({
        identifier: "Fixture",
      });
      const backingPath = path.join(directory, "linked-receipt.json");
      await fs.rename(receiptPath, backingPath);
      if (linkType === "hard link") {
        await fs.link(backingPath, receiptPath);
      } else {
        await fs.symlink(backingPath, receiptPath, "file");
      }
      await expect(readWindowsCursorReceipt(generated)).rejects.toThrow(
        /Invalid Windows cursor receipt|theme is incomplete/,
      );
      await removeWindowsCursorThemes({ themesDirectory: directory });
      expect((await fs.stat(generated)).isDirectory()).toBe(true);
      expect(await fs.readFile(backingPath, "utf8")).toBe(receipt);
    },
  );
});
