import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as plist from "plist";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { importCursorSource } from "./cursor-importer.js";

const corpusRoot = path.resolve("aggregator-downloads");
const corpusArchives = [
  "bibata-extra-modern.tar.gz",
  "bibata-modern-ice.tar.xz",
  "capitaine-r4.tar.gz",
  "colloid-default.tar.gz",
  "drop-blue.zip",
  "future-default.tar.gz",
  "googledot-blue.tar.gz",
  "moga-candy-blue.zip",
  "moga-classic-black.zip",
  "moga-colors-blue.zip",
  "moga-light-blue.zip",
  "moga-neon-blue.zip",
  "nordzy-default.tar.gz",
  "oreo-white-cursors.tar.gz",
  "qogir-default.tar.xz",
  "remus-black.zip",
  "simp1e-default.tar.xz",
  "vimix-default.tar.xz",
  "volantes-default.tar.gz",
];
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-import-corpus-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe.runIf(process.env.CURSOR_IMPORT_CORPUS === "1")(
  "representative GNOME-Look import corpus",
  () => {
    it.each(corpusArchives)(
      "converts %s to complete native tiers",
      async (archiveName) => {
        expect(fs.existsSync(path.join(corpusRoot, archiveName))).toBe(true);
        const root = temporaryDirectory();
        const result = await importCursorSource({
          sourcePath: path.join(corpusRoot, archiveName),
          stagingDirectory: path.join(root, "staging"),
        });

        expect(result.sourceFormat).toBe("xcursor-archive");
        expect(result.artifactCount).toBeGreaterThan(0);
        for (const artifact of result.artifacts) {
          expect(["learned-filter", "nohalo"]).toContain(
            artifact.reconstruction.method,
          );
          const theme = plist.parseBinary(fs.readFileSync(artifact.cursorPath));
          expect(Object.keys(theme.Cursors)).toHaveLength(47);
          for (const record of Object.values(theme.Cursors)) {
            const widths = await Promise.all(
              record.Representations.map(async (representation) =>
                Number(
                  (await sharp(Buffer.from(representation)).metadata()).width,
                ),
              ),
            );
            expect(widths).toEqual([32, 64, 96, 128]);
            expect(record.HotSpotX).toBeGreaterThanOrEqual(0);
            expect(record.HotSpotY).toBeGreaterThanOrEqual(0);
            expect(record.FrameCount).toBeGreaterThan(0);
            expect(record.FrameDuration).toBeGreaterThan(0);
          }
        }
      },
      180_000,
    );
  },
);
