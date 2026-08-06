import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { compress as compressXz } from "@napi-rs/lzma/xz";
import UPNG from "@upng/upng-js/dist/UPNG.esm.js";
import * as plist from "plist";
import sharp from "sharp";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  __testing,
  CursorImportError,
  DEFAULT_IMPORT_LIMITS,
  importCursorSource,
} from "./cursor-importer";

const temporaryDirectories = [];
const corpusRoot = path.resolve("native/cursor-packs/sources");
const remusDirectory = path.join(
  corpusRoot,
  "remus",
  "expanded",
  "Remus-Dark",
  "Remus-Dark",
  "Remus-Dark",
  "cursors",
);
const remusArchive = path.join(
  corpusRoot,
  "remus",
  "archives",
  "Remus-Dark.zip",
);
const nordzyCape = path.join(
  corpusRoot,
  "Nordzy-cursors",
  "MacOs_cursors",
  "Nordzy-cursors.cape",
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-importer-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function frame(size, color, delayMs) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = color[3];
  }
  return {
    rgba,
    width: size,
    height: size,
    hotspotX: size / 4,
    hotspotY: size / 4,
    delayMs,
    nominalSize: size,
  };
}

function spinnerFrame(size, phase, delayMs = 50) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.31;
  const dotRadius = Math.max(1.5, size * 0.055);
  for (let segment = 0; segment < 8; segment += 1) {
    const angle = (segment * Math.PI * 2) / 8;
    const dotX = center + Math.cos(angle) * radius;
    const dotY = center + Math.sin(angle) * radius;
    const brightness = 96 + ((segment - phase + 8) % 8) * 18;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (Math.hypot(x - dotX, y - dotY) <= dotRadius) {
          const offset = (y * size + x) * 4;
          rgba[offset] = brightness;
          rgba[offset + 1] = brightness;
          rgba[offset + 2] = brightness;
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return {
    rgba,
    width: size,
    height: size,
    hotspotX: size / 2,
    hotspotY: size / 2,
    delayMs,
    nominalSize: size,
  };
}

async function solidPng(width, height, color) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: {
        r: color[0],
        g: color[1],
        b: color[2],
        alpha: color[3] / 255,
      },
    },
  })
    .png()
    .toBuffer();
}

function plistCursorRecord({
  frameCount = 1,
  frameDuration = 1,
  hotspotX = 0,
  hotspotY = 0,
  pointsHigh,
  pointsWide,
  representations,
}) {
  return {
    FrameCount: frameCount,
    FrameDuration: frameDuration,
    HotSpotX: hotspotX,
    HotSpotY: hotspotY,
    PointsHigh: pointsHigh ?? pointsWide,
    PointsWide: pointsWide,
    Representations: representations,
  };
}

function writeCape(filePath, cursors, name = "Synthetic Cape") {
  fs.writeFileSync(
    filePath,
    Buffer.from(
      plist.buildBinary({
        CapeName: name,
        Cursors: cursors,
        Identifier: name,
      }),
    ),
  );
}

async function bitmapAnimationFrames(directory, prefix, cycleMs) {
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const frames = [];
  for (const file of files) {
    const { data, info } = await sharp(path.join(directory, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frames.push({
      rgba: data,
      width: info.width,
      height: info.height,
      hotspotX: info.width / 2,
      hotspotY: info.height / 2,
      delayMs: cycleMs / files.length,
      nominalSize: info.width,
    });
  }
  return frames;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.contents);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, data);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const centralOffset = localOffset;
  const centralSize = centralParts.reduce(
    (size, part) => size + part.length,
    0,
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function storedZip(entryName, contents) {
  return storedZipEntries([{ name: entryName, contents }]);
}

function tarEntries(entries) {
  const parts = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const type = entry.type ?? "File";
    const header = new tar.Header({
      path: entry.name,
      type,
      mode: type === "Directory" ? 0o755 : 0o644,
      size: type === "File" ? contents.length : 0,
      linkpath: entry.linkTarget,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
    });
    const headerBlock = Buffer.alloc(512);
    if (
      header.encode(headerBlock) &&
      Buffer.byteLength(entry.name, "utf8") >= 100
    ) {
      throw new Error(`Test tar entry unexpectedly needs PAX: ${entry.name}`);
    }
    parts.push(headerBlock);
    if (contents.length > 0) {
      parts.push(contents);
      const padding = (512 - (contents.length % 512)) % 512;
      if (padding > 0) {
        parts.push(Buffer.alloc(padding));
      }
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe("cursor importer conversion semantics", () => {
  it("maps standard Xcursor aliases to the correct macOS roles", () => {
    expect(__testing.canonicalRole("left_ptr")).toBe("default");
    expect(__testing.canonicalRole("link")).toBe("pointer");
    expect(__testing.canonicalRole("dnd-link")).toBe("alias");
    expect(__testing.canonicalRole("closedhand")).toBe("dnd-move");
    expect(__testing.canonicalRole("grabbing")).toBe("dnd-move");
    expect(__testing.canonicalRole("grab")).toBe("openhand");
    expect(__testing.canonicalRole("hand1")).toBe("openhand");
    expect(__testing.canonicalRole("hand2")).toBe("pointer");
    expect(__testing.canonicalRole("watch")).toBe("wait");
    expect(__testing.canonicalRole("left_ptr_watch")).toBe("progress");
  });

  it("caps a cyclic animation without shortening its cycle and retains native tiers", async () => {
    const groups = new Map();
    for (const size of [32, 64, 128]) {
      groups.set(
        size,
        Array.from({ length: 30 }, (_, index) =>
          frame(size, [index * 7, 20, 200, 255], 50),
        ),
      );
    }

    const { record } = await __testing.buildCursorRecord(groups);

    expect(record.FrameCount).toBe(24);
    expect(record.FrameDuration * record.FrameCount).toBeCloseTo(1.5, 8);
    expect(__testing.selectedFrameIndices(30)).toEqual(
      Array.from({ length: 24 }, (_, index) => Math.floor((index * 30) / 24)),
    );
    const dimensions = [];
    for (const representation of record.Representations) {
      const metadata = await sharp(representation).metadata();
      dimensions.push([metadata.width, metadata.height]);
    }
    expect(dimensions).toEqual([
      [32, 32 * 24],
      [64, 64 * 24],
      [96, 96 * 24],
      [128, 128 * 24],
    ]);
  });

  it("caps arbitrary Xcursor source tiers to macOS representation scales", async () => {
    const groups = new Map(
      [32, 40, 48, 56, 64, 72, 80, 96, 112, 128, 160, 256, 320].map((size) => [
        size,
        [frame(size, [20, 80, 160, 255], null)],
      ]),
    );

    const { record } = await __testing.buildCursorRecord(groups);
    const dimensions = await Promise.all(
      record.Representations.map(async (representation) => {
        const metadata = await sharp(representation).metadata();
        return [metadata.width, metadata.height];
      }),
    );

    expect(dimensions).toEqual([
      [32, 32],
      [64, 64],
      [96, 96],
      [128, 128],
    ]);
  });

  it("emits every animated preview frame with its cursor timing", async () => {
    const frames = [
      frame(96, [255, 0, 0, 255], 40),
      frame(96, [0, 255, 0, 255], 40),
      frame(96, [0, 0, 255, 255], 40),
    ];
    const { record } = await __testing.buildCursorRecord(
      new Map([[96, frames]]),
    );
    const preview = await __testing.previewPng(record, {
      maxSourcePixelsPerFile: 64 * 1024 * 1024,
    });
    const decoded = UPNG.decode(
      preview.buffer.slice(
        preview.byteOffset,
        preview.byteOffset + preview.byteLength,
      ),
    );

    expect(decoded.width).toBe(96);
    expect(decoded.height).toBe(96);
    expect(decoded.tabs.acTL).toEqual({ num_frames: 3, num_plays: 0 });
    expect(decoded.frames.map((decodedFrame) => decodedFrame.delay)).toEqual([
      40, 40, 40,
    ]);
  });

  it("phase-normalizes 3-frame and 5-frame resolution tiers", async () => {
    const groups = new Map([
      [
        32,
        [
          frame(32, [255, 0, 0, 255], 50),
          frame(32, [0, 255, 0, 255], 50),
          frame(32, [0, 0, 255, 255], 50),
        ],
      ],
      [
        64,
        Array.from({ length: 5 }, (_, index) =>
          frame(64, [index * 40, 30, 200, 255], 30),
        ),
      ],
    ]);

    const { normalization, record } = await __testing.buildCursorRecord(groups);

    expect(record.FrameCount).toBe(5);
    expect(record.FrameDuration * record.FrameCount).toBeCloseTo(0.15, 8);
    expect(normalization.differingFrameCounts).toBe(true);
    for (const representation of record.Representations) {
      const metadata = await sharp(representation).metadata();
      expect(metadata.height).toBe(metadata.width * 5);
    }
  });

  it("preserves heavily variable dwell times through cumulative-delay sampling", async () => {
    const frames = [
      frame(32, [10, 0, 0, 255], 900),
      frame(32, [20, 0, 0, 255], 50),
      frame(32, [30, 0, 0, 255], 50),
    ];

    const { normalization, record } = await __testing.buildCursorRecord(
      new Map([[32, frames]]),
    );
    const { data, info } = await sharp(record.Representations[0])
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const reds = Array.from({ length: record.FrameCount }, (_, index) =>
      data.readUInt8(
        (index * info.width * info.width + 16 * info.width + 16) * 4,
      ),
    );

    expect(record.FrameCount).toBe(20);
    expect(record.FrameDuration).toBeCloseTo(0.05, 8);
    expect(reds).toEqual([...Array(18).fill(10), 20, 30]);
    expect(normalization.variableDelays).toBe(true);
  });

  it("uses a conservative 50 ms default for missing animated delays", async () => {
    const { normalization, record } = await __testing.buildCursorRecord(
      new Map([
        [
          32,
          [
            frame(32, [255, 0, 0, 255], null),
            frame(32, [0, 0, 255, 255], null),
          ],
        ],
      ]),
    );

    expect(record).toMatchObject({ FrameCount: 2, FrameDuration: 0.05 });
    expect(normalization.missingDelayCount).toBe(2);
  });

  it("uses a cross-tier normalized median hotspot instead of one outlier", async () => {
    const frames = [
      frame(32, [255, 0, 0, 255], null),
      frame(64, [255, 0, 0, 255], null),
      frame(96, [255, 0, 0, 255], null),
    ];
    frames[0].hotspotX = 4;
    frames[0].hotspotY = 5;
    frames[1].hotspotX = 8;
    frames[1].hotspotY = 10;
    frames[2].hotspotX = 90;
    frames[2].hotspotY = 90;

    const { record } = await __testing.buildCursorRecord(
      new Map([
        [32, [frames[0]]],
        [64, [frames[1]]],
        [96, [frames[2]]],
      ]),
    );

    expect(record.HotSpotX).toBeCloseTo(4, 8);
    expect(record.HotSpotY).toBeCloseTo(5, 8);
  });

  it("bounds Wait/Progress comparison work with a normalized thumbnail", async () => {
    const width = 1_024;
    const height = 512;
    const source = {
      rgba: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      hotspotX: 20,
      hotspotY: 10,
      delayMs: 50,
      nominalSize: 1_024,
    };

    const thumbnail = await __testing.waitProgressThumbnail(source);

    expect(__testing.WAIT_PROGRESS_THUMBNAIL_SIZE).toBe(64);
    expect(thumbnail).toMatchObject({ width: 64, height: 64 });
    expect(thumbnail.rgba).toHaveLength(64 * 64 * 4);
  });

  it("phase-samples a 512-frame duplicate before synthesizing Progress", async () => {
    const waitFrames = Array.from({ length: 512 }, (_, index) =>
      frame(
        8,
        index === 0 ? [240, 20, 20, 255] : [20, 20, 240, 255],
        index === 0 ? 1_000 : 1,
      ),
    );
    const synthesized = await __testing.synthesizeProgressSource(
      [frame(8, [30, 30, 30, 255], null)],
      new Map([[8, waitFrames]]),
    );

    expect([...synthesized.keys()]).toEqual([32, 64, 96]);
    for (const frames of synthesized.values()) {
      expect(frames).toHaveLength(24);
      expect(frames.reduce((sum, item) => sum + item.delayMs, 0)).toBeCloseTo(
        1_511,
        8,
      );
      expect(frames.filter((item) => item.rgba[0] > item.rgba[2])).toHaveLength(
        16,
      );
    }

    const { record } = await __testing.buildCursorRecord(synthesized);
    expect(record.FrameCount).toBe(24);
    expect(record.FrameCount * record.FrameDuration).toBeCloseTo(1.511, 8);
  });

  it("synthesizes Progress when it is only a cyclically phase-shifted Wait", async () => {
    const waitFrames = Array.from({ length: 4 }, (_, phase) =>
      spinnerFrame(32, phase),
    );
    const progressFrames = [
      waitFrames[1],
      waitFrames[2],
      waitFrames[3],
      waitFrames[0],
    ].map((sourceFrame) => ({
      ...sourceFrame,
      rgba: Buffer.from(sourceFrame.rgba),
    }));
    const sourceFrames = new Map([
      ["default", [frame(32, [30, 30, 30, 255], null)]],
      ["wait", new Map([[32, waitFrames]])],
      ["progress", new Map([[32, progressFrames]])],
    ]);

    const built = await __testing.buildTheme(
      sourceFrames,
      {
        author: "Test",
        displayName: "Phase Shift",
        identifier: "PhaseShift-Test",
      },
      DEFAULT_IMPORT_LIMITS,
    );

    expect(built.warnings).toContainEqual(
      expect.stringContaining("Progress visually duplicated Wait"),
    );
    expect(
      built.theme.Cursors["com.apple.cursor.4"].Representations[0].equals(
        built.theme.Cursors["com.apple.coregraphics.Wait"].Representations[0],
      ),
    ).toBe(false);
    expect(built.theme.Cursors["com.apple.cursor.4"]).toMatchObject({
      FrameCount: 4,
      FrameDuration: 0.05,
    });
  });

  it("recognizes the optimized Google Wait and Progress spinner exports across phase/count differences", async () => {
    const directory = path.join(
      corpusRoot,
      "google-cursor",
      "bitmaps",
      "GoogleDot-White",
    );
    const waitFrames = await bitmapAnimationFrames(directory, "wait", 862.069);
    const progressFrames = await bitmapAnimationFrames(
      directory,
      "left_ptr_watch",
      862.069,
    );

    expect(waitFrames.length).not.toBe(progressFrames.length);
    expect(
      await __testing.visuallyEquivalentWaitProgress(
        new Map([[200, waitFrames]]),
        new Map([[200, progressFrames]]),
      ),
    ).toBe(true);
  });

  it("synthesizes Progress when its frames are pixel-identical to Wait", async () => {
    const waitFrames = Array.from({ length: 4 }, (_, phase) =>
      spinnerFrame(32, phase),
    );
    const built = await __testing.buildTheme(
      new Map([
        ["default", [frame(32, [30, 30, 30, 255], null)]],
        ["wait", new Map([[32, waitFrames]])],
        [
          "progress",
          new Map([
            [
              32,
              waitFrames.map((sourceFrame) => ({
                ...sourceFrame,
                rgba: Buffer.from(sourceFrame.rgba),
              })),
            ],
          ]),
        ],
      ]),
      {
        author: "Test",
        displayName: "Exact Duplicate",
        identifier: "ExactDuplicate-Test",
      },
      DEFAULT_IMPORT_LIMITS,
    );

    expect(built.warnings).toContainEqual(
      expect.stringContaining("Progress visually duplicated Wait"),
    );
    expect(
      built.theme.Cursors["com.apple.cursor.4"].Representations[0].equals(
        built.theme.Cursors["com.apple.coregraphics.Wait"].Representations[0],
      ),
    ).toBe(false);
  });

  it("leaves a genuine pointer-and-spinner Progress cursor untouched", async () => {
    const waitFrames = Array.from({ length: 4 }, (_, phase) =>
      spinnerFrame(32, phase),
    );
    const progressFrames = waitFrames.map((sourceFrame) => {
      const rgba = Buffer.from(sourceFrame.rgba);
      for (let y = 2; y < 25; y += 1) {
        for (let x = 2; x <= Math.min(14, 2 + Math.floor(y / 2)); x += 1) {
          const offset = (y * 32 + x) * 4;
          rgba[offset] = 245;
          rgba[offset + 1] = 245;
          rgba[offset + 2] = 245;
          rgba[offset + 3] = 255;
        }
      }
      return { ...sourceFrame, rgba };
    });
    const sourceFrames = new Map([
      ["default", [frame(32, [30, 30, 30, 255], null)]],
      ["wait", new Map([[32, waitFrames]])],
      ["progress", new Map([[32, progressFrames]])],
    ]);

    const built = await __testing.buildTheme(
      sourceFrames,
      {
        author: "Test",
        displayName: "Real Progress",
        identifier: "RealProgress-Test",
      },
      DEFAULT_IMPORT_LIMITS,
    );

    expect(built.warnings.join("\n")).not.toContain(
      "Progress visually duplicated Wait",
    );
    const direct = await __testing.buildCursorRecord(
      new Map([[32, progressFrames]]),
    );
    expect(
      built.theme.Cursors["com.apple.cursor.4"].Representations[0].equals(
        direct.record.Representations[0],
      ),
    ).toBe(true);
  });
});

describe("cursor importer source safety and packaging", () => {
  it("prefers canonical filenames over aliases in either encounter order and keeps first-wins alias ties", async () => {
    const root = temporaryDirectory();
    const cursorRoot = path.join(root, "Priority Theme", "cursors");
    fs.mkdirSync(cursorRoot, { recursive: true });
    const defaultCursor = path.join(remusDirectory, "default");
    const waitCursor = path.join(remusDirectory, "wait");
    for (const [name, source] of [
      ["default", defaultCursor],
      ["wait", waitCursor],
      ["watch", defaultCursor],
      ["link", waitCursor],
      ["pointer", defaultCursor],
      ["grab", waitCursor],
      ["hand1", defaultCursor],
    ]) {
      fs.copyFileSync(source, path.join(cursorRoot, name));
    }

    const discovered = await __testing.discoverVariants(
      await __testing.scanDirectory(root, DEFAULT_IMPORT_LIMITS),
      "xcursor-directory",
      DEFAULT_IMPORT_LIMITS,
    );
    const sourceFrames = discovered.variants[0].sourceFrames;
    const frameCounts = (role) =>
      [...sourceFrames.get(role).values()].map((frames) => frames.length);

    // wait sorts before watch, while link sorts before pointer. The explicit
    // canonical name wins in both directions.
    expect(Math.min(...frameCounts("wait"))).toBeGreaterThan(1);
    expect(frameCounts("pointer")).toEqual(
      Array(frameCounts("pointer").length).fill(1),
    );
    // grab and hand1 are equal-priority historical aliases; sorted first wins.
    expect(Math.min(...frameCounts("openhand"))).toBeGreaterThan(1);
  });

  it("discovers a conventional 132-variant Xcursor tree above the old cap", async () => {
    const root = temporaryDirectory();
    const source = path.join(root, "Nordzy-style download");
    const cursorBytes = fs.readFileSync(path.join(remusDirectory, "default"));
    for (let index = 0; index < 132; index += 1) {
      const cursorRoot = path.join(
        source,
        `Theme-${String(index).padStart(3, "0")}`,
        "cursors",
      );
      fs.mkdirSync(cursorRoot, { recursive: true });
      fs.writeFileSync(path.join(cursorRoot, "left_ptr"), cursorBytes);
    }

    const discovered = await __testing.discoverVariants(
      await __testing.scanDirectory(source, DEFAULT_IMPORT_LIMITS),
      "xcursor-directory",
      DEFAULT_IMPORT_LIMITS,
    );

    expect(discovered.format).toBe("xcursor-directory");
    expect(discovered.variants).toHaveLength(132);
    expect(discovered.variants.map((variant) => variant.displayName)).toEqual(
      Array.from(
        { length: 132 },
        (_, index) => `Theme ${String(index).padStart(3, "0")}`,
      ),
    );
  });

  it("rejects ZIP traversal before extraction", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "unsafe.zip");
    fs.writeFileSync(archive, storedZip("../escape", "not allowed"));

    await expect(__testing.preflightZip(archive)).rejects.toMatchObject({
      name: "CursorImportError",
      code: "UNSAFE_ARCHIVE",
    });
  });

  it("imports a ZIP with a bounded same-directory Xcursor alias", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "safe-alias.zip");
    fs.writeFileSync(
      archive,
      storedZipEntries([
        {
          name: "Odd/Theme/cursors/source",
          contents: fs.readFileSync(path.join(remusDirectory, "default")),
        },
        {
          name: "Odd/Theme/cursors/alias-target",
          contents: "source",
          mode: 0o120777,
        },
        {
          name: "Odd/Theme/cursors/left_ptr",
          contents: "alias-target",
          mode: 0o120777,
        },
      ]),
    );

    const result = await importCursorSource({
      sourcePath: archive,
      stagingDirectory: path.join(root, "staging"),
    });

    expect(result).toMatchObject({
      sourceFormat: "xcursor-archive",
      artifactCount: 1,
      selection: { displayName: "Theme" },
    });
    expect(result.artifacts[0].entry.rolePreviews).toHaveLength(47);
  });

  it("rejects cyclic ZIP cursor alias chains", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "cyclic-alias.zip");
    fs.writeFileSync(
      archive,
      storedZipEntries([
        {
          name: "Odd/Theme/cursors/left_ptr",
          contents: "other",
          mode: 0o120777,
        },
        {
          name: "Odd/Theme/cursors/other",
          contents: "left_ptr",
          mode: 0o120777,
        },
      ]),
    );

    await expect(__testing.preflightZip(archive)).rejects.toMatchObject({
      code: "UNSAFE_ARCHIVE",
      message: expect.stringContaining("cyclic cursor alias"),
    });
  });

  it("rejects a ZIP cursor alias whose target escapes its cursors directory", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "unsafe-alias.zip");
    fs.writeFileSync(
      archive,
      storedZipEntries([
        {
          name: "Odd/Theme/cursors/source",
          contents: fs.readFileSync(path.join(remusDirectory, "default")),
        },
        {
          name: "Odd/Theme/cursors/left_ptr",
          contents: "../../outside",
          mode: 0o120777,
        },
      ]),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
  });

  it("imports a nested gzip tar archive with a safe Xcursor alias chain", async () => {
    const root = temporaryDirectory();
    const themePath = "GNOME-Look Download/dist/Alias Theme";
    const archive = path.join(root, "gnome-look-download.bin");
    fs.writeFileSync(
      archive,
      gzipSync(
        tarEntries([
          {
            name: `${themePath}/index.theme`,
            contents: "[Icon Theme]\nName=Nested Tar Alias Theme\n",
          },
          {
            name: `${themePath}/cursors/source`,
            contents: fs.readFileSync(path.join(remusDirectory, "default")),
          },
          {
            name: `${themePath}/cursors/alias-target`,
            type: "SymbolicLink",
            linkTarget: "source",
          },
          {
            name: `${themePath}/cursors/left_ptr`,
            type: "SymbolicLink",
            linkTarget: "alias-target",
          },
        ]),
      ),
    );

    const result = await importCursorSource({
      sourcePath: archive,
      stagingDirectory: path.join(root, "staging"),
    });

    expect(result).toMatchObject({
      sourceFormat: "xcursor-archive",
      artifactCount: 1,
      selection: { displayName: "Nested Tar Alias Theme" },
    });
    expect(result.artifacts[0]).toMatchObject({
      sourceFormat: "xcursor-archive",
      sourceLabel: "Alias Theme",
    });
    expect(result.artifacts[0].entry.rolePreviews).toHaveLength(47);
  });

  it("detects a plain tar archive by its ustar signature", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "cursor-download.data");
    fs.writeFileSync(
      archive,
      tarEntries([
        { name: "./", type: "Directory" },
        {
          name: "./Plain Theme/index.theme",
          contents: "[Icon Theme]\nName=Plain Tar Theme\n",
        },
        {
          name: "./Plain Theme/cursors/left_ptr",
          contents: fs.readFileSync(path.join(remusDirectory, "default")),
        },
      ]),
    );

    const result = await importCursorSource({
      sourcePath: archive,
      stagingDirectory: path.join(root, "staging"),
    });

    expect(result).toMatchObject({
      sourceFormat: "xcursor-archive",
      artifactCount: 1,
      selection: { displayName: "Plain Tar Theme" },
    });
  });

  it("imports an XZ-compressed tar archive detected by magic", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "gnome-look-download.payload");
    fs.writeFileSync(
      archive,
      await compressXz(
        tarEntries([
          {
            name: "XZ Theme/index.theme",
            contents: "[Icon Theme]\nName=XZ Tar Theme\n",
          },
          {
            name: "XZ Theme/cursors/left_ptr",
            contents: fs.readFileSync(path.join(remusDirectory, "default")),
          },
        ]),
      ),
    );

    const result = await importCursorSource({
      sourcePath: archive,
      stagingDirectory: path.join(root, "staging"),
    });

    expect(result).toMatchObject({
      sourceFormat: "xcursor-archive",
      artifactCount: 1,
      selection: { displayName: "XZ Tar Theme" },
    });
  });

  it("rejects tar traversal before extraction", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "unsafe.tar.gz");
    fs.writeFileSync(
      archive,
      gzipSync(tarEntries([{ name: "../outside", contents: "not allowed" }])),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("rejects traversal in an XZ-compressed tar before extraction", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "unsafe.tar.xz");
    fs.writeFileSync(
      archive,
      await compressXz(
        tarEntries([{ name: "../escape", contents: "not allowed" }]),
      ),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
  });

  it("rejects case-folding and NFC path collisions in tar archives", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "colliding.tar");
    const cursorBytes = fs.readFileSync(path.join(remusDirectory, "default"));
    fs.writeFileSync(
      archive,
      tarEntries([
        { name: "Théme/cursors/left_ptr", contents: cursorBytes },
        { name: "Théme/CURSORS/LEFT_PTR", contents: cursorBytes },
      ]),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("bounds the XZ decompression ratio before tar extraction", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "ratio.tar.xz");
    fs.writeFileSync(
      archive,
      await compressXz(
        tarEntries([
          {
            name: "Theme/cursors/left_ptr",
            contents: Buffer.alloc(64 * 1024),
          },
        ]),
      ),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
        limits: { maxCompressionRatio: 2 },
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects an escaping cursor symlink in a tar archive", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "unsafe.tgz");
    fs.writeFileSync(
      archive,
      gzipSync(
        tarEntries([
          {
            name: "Theme/cursors/source",
            contents: fs.readFileSync(path.join(remusDirectory, "default")),
          },
          {
            name: "Theme/cursors/left_ptr",
            type: "SymbolicLink",
            linkTarget: "../../outside",
          },
          { name: "outside", contents: "not an Xcursor" },
        ]),
      ),
    );

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("rejects hard links in tar archives", async () => {
    const root = temporaryDirectory();
    const archive = path.join(root, "hardlink.tar.gz");
    fs.writeFileSync(
      archive,
      gzipSync(
        tarEntries([
          {
            name: "Theme/cursors/left_ptr",
            contents: fs.readFileSync(path.join(remusDirectory, "default")),
          },
          {
            name: "Theme/cursors/hardlink-alias",
            type: "Link",
            linkTarget: "Theme/cursors/left_ptr",
          },
        ]),
      ),
    );
    const entryTypes = [];
    await tar.list({
      file: archive,
      onReadEntry(entry) {
        entryTypes.push(entry.type);
      },
    });
    expect(entryTypes).toContain("Link");

    await expect(
      importCursorSource({
        sourcePath: archive,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("safely resolves same-directory Xcursor symlink aliases", async () => {
    const root = temporaryDirectory();
    const themeRoot = path.join(root, "Alias Theme");
    const cursorRoot = path.join(themeRoot, "cursors");
    const staging = path.join(root, "staging");
    fs.mkdirSync(cursorRoot, { recursive: true });
    fs.copyFileSync(
      path.join(remusDirectory, "default"),
      path.join(cursorRoot, "source"),
    );
    fs.symlinkSync("source", path.join(cursorRoot, "left_ptr"));
    fs.writeFileSync(
      path.join(themeRoot, "index.theme"),
      "[Icon Theme]\nName=Safe Alias Theme\n",
    );

    const result = await importCursorSource({
      sourcePath: themeRoot,
      stagingDirectory: staging,
    });

    expect(result.artifactCount).toBe(1);
    expect(result.selection.displayName).toBe("Safe Alias Theme");
    expect(result.artifacts[0].entry.rolePreviews).toHaveLength(47);
    const parsed = plist.parseBinary(
      fs.readFileSync(result.artifacts[0].cursorPath),
    );
    expect(parsed.Cursors["com.apple.coregraphics.Arrow"].FrameCount).toBe(1);
  });

  it("rejects symlink aliases that escape their cursors directory", async () => {
    const root = temporaryDirectory();
    const cursorRoot = path.join(root, "Theme", "cursors");
    fs.mkdirSync(cursorRoot, { recursive: true });
    fs.copyFileSync(
      path.join(remusDirectory, "default"),
      path.join(root, "outside"),
    );
    fs.symlinkSync("../../outside", path.join(cursorRoot, "left_ptr"));

    await expect(
      importCursorSource({
        sourcePath: path.join(root, "Theme"),
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
  });

  it("imports an oddly nested GNOME-Look ZIP into a self-contained schema-v2 artifact", async () => {
    const root = temporaryDirectory();
    const first = await importCursorSource({
      sourcePath: remusArchive,
      stagingDirectory: path.join(root, "first"),
    });
    const artifact = first.artifacts[0];
    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, "utf8"));
    const waitPreview = artifact.entry.rolePreviews.find(
      (preview) => preview.role === "wait",
    );
    const waitBytes = fs.readFileSync(
      path.join(artifact.directory, waitPreview.asset),
    );
    const waitAnimation = UPNG.decode(
      waitBytes.buffer.slice(
        waitBytes.byteOffset,
        waitBytes.byteOffset + waitBytes.byteLength,
      ),
    );

    expect(first).toMatchObject({
      sourceFormat: "xcursor-archive",
      artifactCount: 1,
      selection: { identifier: artifact.identifier },
    });
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      roleCount: 47,
      themes: [
        {
          Identifier: artifact.identifier,
          DisplayName: expect.any(String),
          Resource: `${artifact.identifier}.cursor`,
          SHA256: expect.stringMatching(/^[a-f0-9]{64}$/),
          UUID: expect.stringMatching(/^[A-F0-9-]{36}$/),
          ThemeName: expect.any(String),
          Group: "Imported",
          preview: expect.any(String),
          rolePreviews: expect.any(Array),
        },
      ],
    });
    expect(fs.statSync(artifact.cursorPath).size).toBeLessThanOrEqual(
      32 * 1024 * 1024,
    );
    expect(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(artifact.cursorPath))
        .digest("hex"),
    ).toBe(artifact.entry.SHA256);
    expect(path.dirname(fs.realpathSync(artifact.cursorPath))).toBe(
      fs.realpathSync(artifact.directory),
    );
    for (const rolePreview of artifact.entry.rolePreviews) {
      expect(rolePreview.asset).toMatch(
        new RegExp(`^previews/${artifact.identifier}/[A-Za-z0-9_-]+\\.png$`),
      );
      expect(
        path.relative(
          fs.realpathSync(artifact.directory),
          fs.realpathSync(path.join(artifact.directory, rolePreview.asset)),
        ),
      ).not.toMatch(/^\.\./);
    }
    expect(waitAnimation.frames.length).toBeGreaterThan(1);
    expect(waitAnimation.tabs.acTL.num_plays).toBe(0);
    expect(waitAnimation.frames.map((frame) => frame.delay)).toEqual(
      Array(waitAnimation.frames.length).fill(
        Math.round(waitPreview.frameDuration * 1000),
      ),
    );

    const duplicate = await importCursorSource({
      sourcePath: remusArchive,
      stagingDirectory: path.join(root, "second"),
    });
    expect(duplicate.artifacts[0]).toMatchObject({
      identifier: artifact.identifier,
      digest: artifact.digest,
    });

    const reimported = await importCursorSource({
      sourcePath: artifact.cursorPath,
      stagingDirectory: path.join(root, "third"),
    });
    expect(reimported).toMatchObject({
      sourceFormat: "native-cursor",
      artifactCount: 1,
    });
    expect(reimported.artifacts[0].entry.rolePreviews).toHaveLength(47);

    const validCape = path.join(root, "valid.cape");
    fs.copyFileSync(artifact.cursorPath, validCape);
    const capeImport = await importCursorSource({
      sourcePath: validCape,
      stagingDirectory: path.join(root, "fourth"),
    });
    expect(capeImport).toMatchObject({
      sourceFormat: "mousecape",
      artifactCount: 1,
    });
  }, 120_000);

  it("normalizes an isotropically scaled rectangular Cape frame with top-left padding", async () => {
    const root = temporaryDirectory();
    const capePath = path.join(root, "rectangular.cape");
    const representation = await solidPng(128, 64, [80, 140, 220, 255]);
    writeCape(capePath, {
      "com.apple.coregraphics.Arrow": plistCursorRecord({
        hotspotX: 8,
        hotspotY: 4,
        pointsWide: 64,
        pointsHigh: 32,
        representations: [representation],
      }),
    });

    const result = await importCursorSource({
      sourcePath: capePath,
      stagingDirectory: path.join(root, "staging"),
    });
    const parsed = plist.parseBinary(
      fs.readFileSync(result.artifacts[0].cursorPath),
    );
    const arrow = parsed.Cursors["com.apple.coregraphics.Arrow"];
    const { data, info } = await sharp(Buffer.from(arrow.Representations[0]))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3];

    expect(arrow).toMatchObject({
      HotSpotX: 4,
      HotSpotY: 2,
      PointsWide: 32,
      PointsHigh: 32,
    });
    expect([info.width, info.height]).toEqual([32, 32]);
    expect(alphaAt(16, 6)).toBeGreaterThan(250);
    expect(alphaAt(16, 26)).toBe(0);
  });

  it("accepts coherent 64-point Cape roles with meaningful hotspots", async () => {
    const root = temporaryDirectory();
    const capePath = path.join(root, "coherent-64.cape");
    const representation = await solidPng(64, 64, [120, 80, 180, 255]);
    const identifiers = [
      "com.apple.coregraphics.Arrow",
      "com.apple.coregraphics.Alias",
      "com.apple.coregraphics.IBeam",
      "com.apple.coregraphics.Move",
      "com.apple.coregraphics.Wait",
      "com.apple.cursor.3",
      "com.apple.cursor.5",
      "com.apple.cursor.13",
    ];
    const cursors = Object.fromEntries(
      identifiers.map((identifier, index) => [
        identifier,
        plistCursorRecord({
          hotspotX: 2 + index * 2,
          hotspotY: 3 + index,
          pointsWide: 64,
          representations: [representation],
        }),
      ]),
    );
    writeCape(capePath, cursors, "Coherent 64");

    const result = await importCursorSource({
      sourcePath: capePath,
      stagingDirectory: path.join(root, "staging"),
    });

    expect(result).toMatchObject({
      sourceFormat: "mousecape",
      artifactCount: 1,
      selection: { displayName: "Coherent 64" },
    });
  });

  it("rejects a theme-wide ambiguous centered 64-point Cape", async () => {
    const root = temporaryDirectory();
    const capePath = path.join(root, "ambiguous-64.cape");
    const representation = await solidPng(64, 64, [120, 80, 180, 255]);
    const identifiers = [
      "com.apple.coregraphics.Arrow",
      "com.apple.coregraphics.Alias",
      "com.apple.coregraphics.IBeam",
      "com.apple.coregraphics.Move",
      "com.apple.coregraphics.Wait",
      "com.apple.cursor.3",
      "com.apple.cursor.5",
      "com.apple.cursor.13",
    ];
    writeCape(
      capePath,
      Object.fromEntries(
        identifiers.map((identifier) => [
          identifier,
          plistCursorRecord({
            hotspotX: 32,
            hotspotY: 32,
            pointsWide: 64,
            representations: [representation],
          }),
        ]),
      ),
      "Ambiguous 64",
    );

    await expect(
      importCursorSource({
        sourcePath: capePath,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPE_GEOMETRY",
      message: expect.stringContaining("Xcursor archive"),
    });
  });

  it("preserves dark straight-alpha Cape pixels without brightening them", async () => {
    const root = temporaryDirectory();
    const capePath = path.join(root, "dark-alpha.cape");
    const representation = await solidPng(32, 32, [20, 10, 5, 64]);
    writeCape(capePath, {
      "com.apple.coregraphics.Arrow": plistCursorRecord({
        pointsWide: 32,
        representations: [representation],
      }),
    });

    const result = await importCursorSource({
      sourcePath: capePath,
      stagingDirectory: path.join(root, "staging"),
    });
    const parsed = plist.parseBinary(
      fs.readFileSync(result.artifacts[0].cursorPath),
    );
    const { data, info } = await sharp(
      Buffer.from(
        parsed.Cursors["com.apple.coregraphics.Arrow"].Representations[0],
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (16 * info.width + 16) * 4;

    expect([...data.subarray(offset, offset + 4)]).toEqual([20, 10, 5, 64]);
  });

  it("rejects Nordzy's known 64-point Cape geometry in favor of its Xcursor build", async () => {
    const root = temporaryDirectory();

    await expect(
      importCursorSource({
        sourcePath: nordzyCape,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_CAPE_GEOMETRY",
        message: expect.stringContaining("Xcursor archive"),
      }),
    );
  });

  it("returns a clear unsupported error for raw SVG source trees", async () => {
    const root = temporaryDirectory();
    const source = path.join(root, "raw-theme");
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "left_ptr.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
    );

    await expect(
      importCursorSource({
        sourcePath: source,
        stagingDirectory: path.join(root, "staging"),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SOURCE",
        message: expect.stringContaining("compiled Xcursor archive"),
      }),
    );
  });

  it("uses typed errors for callers", () => {
    const error = new CursorImportError("EXAMPLE", "example");
    expect(error).toMatchObject({ name: "CursorImportError", code: "EXAMPLE" });
  });
});
