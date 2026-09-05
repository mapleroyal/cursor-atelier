import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as plist from "plist";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_TO_ROLE } from "./cursor-roles.js";
import {
  installLinuxCursorTheme,
  readLinuxCursorTheme,
  removeLinuxCursorThemes,
} from "./linux-cursor-theme.js";
import { runLinuxCursorCommand } from "./linux-cursor-desktop.js";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "linux-cursor-theme-"),
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
function images(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe("Xcur");
  const count = bytes.readUInt32LE(12);
  return Array.from({ length: count }, (_, index) => {
    const toc = 16 + index * 12;
    const offset = bytes.readUInt32LE(toc + 8);
    return {
      size: bytes.readUInt32LE(toc + 4),
      width: bytes.readUInt32LE(offset + 16),
      height: bytes.readUInt32LE(offset + 20),
      xhot: bytes.readUInt32LE(offset + 24),
      yhot: bytes.readUInt32LE(offset + 28),
      delay: bytes.readUInt32LE(offset + 32),
      pixel: bytes.readUInt32LE(offset + 36),
    };
  });
}

describe("Linux Xcursor export", () => {
  it("validates full role coverage and resource hashes before invoking any encoder", async () => {
    const { theme, data } = await fixture();
    await expect(
      readLinuxCursorTheme({ ...theme, sha256: "0".repeat(64) }),
    ).rejects.toThrow("integrity");
    delete data.Cursors["com.apple.cursor.43"];
    await fs.writeFile(
      theme.resourcePath,
      Buffer.from(plist.buildBinary(data)),
    );
    await expect(readLinuxCursorTheme(theme)).rejects.toThrow("roles");
  });

  it.skipIf(spawnSync("xcursorgen", ["--version"]).status !== 0)(
    "round-trips PNG pixels, alpha, frames, hotspots, native tiers and requested sizes through X.Org",
    async () => {
      const { theme, directory } = await fixture();
      const iconsDirectory = path.join(directory, "icons");
      const installed = await installLinuxCursorTheme({
        theme,
        iconsDirectory,
        runCommand: runLinuxCursorCommand,
        sizePercentage: 125,
      });
      const cursor = await fs.readFile(
        path.join(installed.directory, "cursors", "default"),
      );
      const decoded = images(cursor);
      expect(decoded.map((frame) => frame.size)).toEqual([
        4, 4, 8, 8, 12, 12, 5, 5, 10, 10, 15, 15,
      ]);
      expect(decoded[0]).toMatchObject({
        width: 4,
        height: 4,
        xhot: 1,
        yhot: 2,
        delay: 60,
        pixel: 0x80800000,
      });
      expect(decoded[1].pixel).toBe(0xff0000ff);
      const textCursor = images(
        await fs.readFile(path.join(installed.directory, "cursors", "text")),
      );
      expect(textCursor[0]).toMatchObject({ size: 4, width: 2, height: 4 });
      expect(textCursor.find((frame) => frame.size === 5)).toMatchObject({
        width: 3,
        height: 5,
      });
      expect(
        await fs.readlink(
          path.join(installed.directory, "cursors", "left_ptr"),
        ),
      ).toBe("default");
      expect(
        await fs.readlink(
          path.join(
            installed.directory,
            "cursors",
            "08e8e1c95fe2fc01f976f1e063a24ccd",
          ),
        ),
      ).toBe("progress");
      await removeLinuxCursorThemes({
        iconsDirectory,
        keepNames: [installed.name],
      });
      expect(await fs.stat(installed.directory)).toBeTruthy();
      await removeLinuxCursorThemes({ iconsDirectory });
      await expect(fs.stat(installed.directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
