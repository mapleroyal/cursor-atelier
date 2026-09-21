import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as plist from "plist";
import sharp from "sharp";
import { it, expect } from "vitest";
import { MAC_TO_ROLE } from "./cursor-roles.js";
import { createWindowsCursorBackend } from "./windows-cursor-backend.js";
import { createWindowsCursorDesktop } from "./windows-cursor-desktop.js";

it
  .skipIf(
    process.platform !== "win32" ||
      process.env.CURSOR_ATELIER_LIVE_WINDOWS_SMOKE !== "1",
  )
  .each([1, 2])(
  "applies, resizes, restores and verifies real Windows desktop cursors (%i frames)",
  async (frameCount) => {
    const desktop = createWindowsCursorDesktop();
    await desktop.requireSupported();
    const before = await desktop.capture();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-atelier-live-windows-"),
    );
    await fs.writeFile(
      path.join(directory, "before.json"),
      JSON.stringify(before),
    );
    const representations = [];
    for (const scale of [1, 2, 3]) {
      representations.push(
        await sharp({
          create: {
            width: 32 * scale,
            height: 32 * scale * frameCount,
            channels: 4,
            background: { r: 27, g: 127, b: 230, alpha: 0.8 },
          },
        })
          .composite(
            frameCount === 2
              ? [
                  {
                    input: await sharp({
                      create: {
                        width: 32 * scale,
                        height: 32 * scale,
                        channels: 4,
                        background: { r: 240, g: 100, b: 20, alpha: 0.8 },
                      },
                    })
                      .png()
                      .toBuffer(),
                    left: 0,
                    top: 32 * scale,
                  },
                ]
              : [],
          )
          .png()
          .toBuffer(),
      );
    }
    const record = {
      FrameCount: frameCount,
      FrameDuration: 0.06,
      PointsWide: 32,
      PointsHigh: 32,
      HotSpotX: 4,
      HotSpotY: 6,
      Representations: representations,
    };
    const data = {
      Identifier: "WindowsLiveFixture",
      UUID: "windows-live",
      ThemeName: "Windows Live Fixture",
      Cursors: Object.fromEntries(
        Object.keys(MAC_TO_ROLE).map((identifier) => [identifier, record]),
      ),
    };
    const resourcePath = path.join(directory, "WindowsLiveFixture.cursor");
    await fs.writeFile(resourcePath, Buffer.from(plist.buildBinary(data)));
    const backend = createWindowsCursorBackend({
      stateDirectory: path.join(directory, "state"),
      encoderExecutable: path.resolve(
        process.env.CURSOR_ATELIER_LIVE_WINDOWS_ENCODER ??
          "native/cursor-packs/build/curated-converter/curated-cursor-converter/curated-cursor-converter.exe",
      ),
      getThemes: () => [
        {
          identifier: data.Identifier,
          displayName: data.ThemeName,
          resourcePath,
          uuid: data.UUID,
        },
      ],
      desktop,
    });
    const run = (command, ...args) =>
      backend.commandRunner({ command, arguments: args });
    let restored = false;
    try {
      const applied = await run("--apply-theme", data.Identifier);
      expect(applied).toMatchObject({
        supported: true,
        desiredEnabled: true,
        currentSentinelsMatchTheme: true,
      });
      const first = await desktop.capture();
      expect(first.fingerprints.Arrow.split(":")[0]).toBe("32");
      await run("--set-theme-size", data.Identifier, "150");
      const resized = await run("--apply-theme", data.Identifier);
      expect(resized).toMatchObject({
        themeSizePercentage: 150,
        currentSentinelsMatchTheme: true,
      });
      const second = await desktop.capture();
      expect(second.fingerprints.Arrow.split(":")[0]).toBe("48");
      const result = await run("--teardown");
      expect(result).toMatchObject({
        supported: true,
        desiredEnabled: false,
        effectiveApplied: false,
        currentSentinelsMatchTheme: false,
        transactionPending: false,
      });
      const after = await desktop.capture();
      expect(after.values).toEqual(before.values);
      expect(after.fingerprints).toEqual(before.fingerprints);
      restored = true;
      console.warn(
        JSON.stringify({
          session: before.session,
          frameCount,
          appliedSize: first.fingerprints.Arrow.split(":")[0],
          resizedSize: second.fingerprints.Arrow.split(":")[0],
          restored: true,
        }),
      );
    } finally {
      if (!restored) {
        await desktop.restore(before);
        restored = true;
      }
      if (restored) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
