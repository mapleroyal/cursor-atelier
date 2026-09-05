import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { __testing, DEFAULT_IMPORT_LIMITS } from "./cursor-importer.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function markerFrame(width, height, hotspotX, hotspotY, color, options = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  rgba.set(color, (hotspotY * width + hotspotX) * 4);
  rgba.set(color, (hotspotY * width + hotspotX + 1) * 4);
  return {
    width,
    height,
    hotspotX,
    hotspotY,
    rgba,
    delayMs: 50,
    nominalSize: width,
    ...options,
  };
}

function xcursorBuffer(frames) {
  const header = Buffer.alloc(16 + frames.length * 12);
  header.write("Xcur");
  header.writeUInt32LE(16, 4);
  header.writeUInt32LE(0x10000, 8);
  header.writeUInt32LE(frames.length, 12);
  let position = header.length;
  const chunks = frames.map((frame, index) => {
    const chunk = Buffer.alloc(36 + frame.rgba.length);
    const fields = [
      36,
      0xfffd0002,
      frame.nominalSize,
      1,
      frame.width,
      frame.height,
      frame.hotspotX,
      frame.hotspotY,
      frame.delayMs,
    ];
    fields.forEach((value, field) => chunk.writeUInt32LE(value, field * 4));
    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      const [red, green, blue, alpha] = frame.rgba.subarray(offset, offset + 4);
      chunk.writeUInt32LE(
        ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0,
        36 + offset,
      );
    }
    header.writeUInt32LE(0xfffd0002, 16 + index * 12);
    header.writeUInt32LE(frame.nominalSize, 20 + index * 12);
    header.writeUInt32LE(position, 24 + index * 12);
    position += chunk.length;
    return chunk;
  });
  return Buffer.concat([header, ...chunks]);
}

function pixel(rgba, width, x, y) {
  return [...rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
}

async function discoverFrames(frames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-geometry-"));
  temporaryDirectories.push(root);
  const cursors = path.join(root, "Example", "cursors");
  fs.mkdirSync(cursors, { recursive: true });
  fs.writeFileSync(path.join(cursors, "wait"), xcursorBuffer(frames));
  const discovered = await __testing.discoverVariants(
    await __testing.scanDirectory(root, DEFAULT_IMPORT_LIMITS),
    "xcursor-directory",
    DEFAULT_IMPORT_LIMITS,
  );
  return discovered.variants[0].sourceFrames.get("wait");
}

describe("cursor image geometry", () => {
  it("keeps nominal Xcursor animations together across varying canvases and shared pixel extents", async () => {
    const red = [255, 0, 0, 255];
    const blue = [0, 0, 255, 255];
    const green = [0, 255, 0, 255];
    const groups = await discoverFrames([
      markerFrame(16, 16, 6, 5, red, { nominalSize: 32 }),
      markerFrame(32, 32, 7, 5, green, { nominalSize: 64 }),
      markerFrame(32, 16, 8, 5, blue, { nominalSize: 32, delayMs: 150 }),
      markerFrame(32, 24, 7, 5, green, { nominalSize: 64, delayMs: 150 }),
    ]);

    expect([...groups.keys()]).toEqual([32, 64]);
    for (const frames of groups.values()) {
      expect(frames.map((frame) => frame.delayMs)).toEqual([50, 150]);
      expect(frames.map((frame) => [frame.width, frame.height])).toEqual([
        [32, 32],
        [32, 32],
      ]);
    }
    const { record } = await __testing.buildCursorRecord(groups);
    expect(record).toMatchObject({
      FrameCount: 4,
      FrameDuration: 0.05,
      HotSpotX: 7,
      HotSpotY: 5,
    });
    const low = await sharp(record.Representations[0]).raw().toBuffer();
    expect(
      Array.from({ length: 4 }, (_, index) =>
        pixel(low, 32, 7, 5 + index * 32),
      ),
    ).toEqual([red, blue, blue, blue]);
    expect(pixel(low, 32, 8, 5)).toEqual(red);
    expect(pixel(low, 32, 9, 5)).toEqual([0, 0, 0, 0]);
    const high = await sharp(record.Representations[1]).raw().toBuffer();
    expect(pixel(high, 64, 15, 11)[1]).toBeGreaterThan(200);
    expect(pixel(high, 64, 15, 11)[0]).toBe(0);
  });

  it("selects actual pixel tiers when their nominal sizes differ", async () => {
    const colors = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    const groups = await discoverFrames(
      [32, 64, 128].map((size, index) => ({
        ...markerFrame(size, size, size / 8, size / 8, colors[index]),
        rgba: Buffer.alloc(size * size * 4, Buffer.from(colors[index])),
        nominalSize: [24, 48, 96][index],
      })),
    );

    expect([...groups.keys()]).toEqual([24, 48, 96]);
    const { record } = await __testing.buildCursorRecord(groups);
    for (const [index, size] of [32, 64, 96, 128].entries()) {
      const { data, info } = await sharp(record.Representations[index])
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(size);
      expect(pixel(data, size, size / 2, size / 2)).toEqual(
        colors[Math.min(index, 2)],
      );
    }
  });

  it("aligns every frame and tier with the hotspot written to the record", async () => {
    const white = [255, 255, 255, 255];
    const groups = new Map([
      [
        32,
        [markerFrame(32, 32, 5, 4, white), markerFrame(32, 32, 7, 6, white)],
      ],
      [
        64,
        [
          markerFrame(64, 64, 16, 14, white),
          markerFrame(64, 64, 16, 14, white),
        ],
      ],
    ]);

    const { record } = await __testing.buildCursorRecord(groups);

    expect(record).toMatchObject({ HotSpotX: 7, HotSpotY: 6, FrameCount: 2 });
    for (const [tierIndex, size] of [32, 64].entries()) {
      const rgba = await sharp(record.Representations[tierIndex])
        .raw()
        .toBuffer();
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        expect(
          pixel(
            rgba,
            size,
            (7 * size) / 32,
            frameIndex * size + (6 * size) / 32,
          ),
        ).toEqual(white);
      }
    }
  });

  it("fits edge-filled frames around one anchor with the same scale in every tier", async () => {
    const groups = new Map();
    for (const size of [32, 64]) {
      groups.set(
        size,
        [8, 24].map((hotspot) => {
          const scale = size / 32;
          const frame = markerFrame(
            size,
            size,
            hotspot * scale,
            16 * scale,
            [255, 255, 255, 255],
          );
          frame.rgba.fill(255);
          for (let y = 14 * scale; y < 19 * scale; y += 1) {
            for (
              let x = (hotspot - 2) * scale;
              x < (hotspot + 3) * scale;
              x += 1
            ) {
              frame.rgba.set([0, 255, 0, 255], (y * size + x) * 4);
            }
          }
          return frame;
        }),
      );
    }

    const { record } = await __testing.buildCursorRecord(groups);

    expect(record.HotSpotX).toBeCloseTo(16, 8);
    expect(record.HotSpotY).toBeCloseTo(32 / 3, 8);
    for (const [tierIndex, size] of [32, 64].entries()) {
      const rgba = await sharp(record.Representations[tierIndex])
        .raw()
        .toBuffer();
      const x = Math.round((record.HotSpotX * size) / 32);
      const y = Math.round((record.HotSpotY * size) / 32);
      for (let index = 0; index < 2; index += 1) {
        const marker = pixel(rgba, size, x, y + index * size);
        expect(marker[0]).toBeLessThan(5);
        expect(marker[1]).toBe(255);
        expect(marker[2]).toBeLessThan(5);
        expect(marker[3]).toBe(255);
      }
      expect(pixel(rgba, size, size - 1, y)[3]).toBeGreaterThan(0);
      expect(pixel(rgba, size, 0, size + y)[3]).toBeGreaterThan(0);
      expect(pixel(rgba, size, 0, y)[3]).toBe(0);
      expect(pixel(rgba, size, size - 1, size + y)[3]).toBe(0);
    }
  });
});
