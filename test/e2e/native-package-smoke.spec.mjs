import { chromium, expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function loadBundledThemeIds() {
  const manifestPath = path.join(
    projectRoot,
    "native",
    "cursor-packs",
    "generated",
    "manifest.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const identifiers = manifest.themes?.map((theme) => theme.Identifier);
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(identifiers) ||
    identifiers.length !== 239 ||
    identifiers.some(
      (identifier) => typeof identifier !== "string" || identifier.length === 0,
    ) ||
    new Set(identifiers).size !== identifiers.length
  ) {
    throw new Error(
      `Expected ${manifestPath} to describe 239 unique schema-v2 themes.`,
    );
  }
  return Object.freeze(identifiers.toSorted());
}

const bundledThemeIds = loadBundledThemeIds();
const bundledThemeIdSet = new Set(bundledThemeIds);

function findPackagedExecutable() {
  const executable = path.join(
    projectRoot,
    "out",
    `Cursor Atelier-darwin-${process.arch}`,
    "Cursor Atelier.app",
    "Contents",
    "MacOS",
    "Cursor Atelier",
  );
  if (fs.existsSync(executable)) {
    return executable;
  }
  throw new Error("No packaged Cursor Atelier executable was found.");
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback debugging port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function waitForExit(child, timeout = 7_500) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("The packaged app did not exit after SIGTERM."));
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function removeTemporaryUserData(directory) {
  const resolvedDirectory = fs.realpathSync(directory);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (
    path.dirname(resolvedDirectory) !== temporaryRoot ||
    !path.basename(resolvedDirectory).startsWith("cursor-atelier-native-smoke-")
  ) {
    throw new Error(`Refusing to remove unexpected path: ${resolvedDirectory}`);
  }
  await fs.promises.rm(resolvedDirectory, { recursive: true });
}

test.describe("packaged native integration", () => {
  test.skip(process.platform !== "darwin", "Cursor Atelier is macOS-only.");

  test("discovers the signed native bundle without changing cursors", async () => {
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cursor-atelier-native-smoke-"),
    );
    const environment = { ...process.env };
    delete environment.CURSOR_NATIVE_BRIDGE;
    delete environment.CURSOR_PACK_MANIFEST;
    // This is a read-only discovery smoke, not a launch-at-login exercise.
    environment.CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION = "1";
    environment.HOME = userDataDirectory;
    environment.CFFIXED_USER_HOME = userDataDirectory;
    const debuggingPort = await reserveLoopbackPort();
    const debugUrl = `http://127.0.0.1:${debuggingPort}`;
    const output = [];
    const app = spawn(
      findPackagedExecutable(),
      [
        `--user-data-dir=${userDataDirectory}`,
        `--remote-debugging-port=${debuggingPort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    app.stdout.on("data", (chunk) => output.push(chunk.toString()));
    app.stderr.on("data", (chunk) => output.push(chunk.toString()));
    let browser;
    try {
      await expect
        .poll(
          async () => {
            if (app.exitCode !== null || app.signalCode !== null) {
              throw new Error(
                `The packaged app exited before exposing CDP.\n${output.join("")}`,
              );
            }
            try {
              const response = await fetch(`${debugUrl}/json/version`);
              return response.ok;
            } catch {
              return false;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      browser = await chromium.connectOverCDP(debugUrl);
      const context = browser.contexts()[0];
      await expect.poll(() => context.pages().length).toBeGreaterThan(0);
      const page = context.pages()[0];
      await page.waitForLoadState("domcontentloaded");

      const secondInstance = spawn(
        findPackagedExecutable(),
        [
          `--user-data-dir=${path.join(userDataDirectory, "alternate-user-data")}`,
        ],
        { env: environment, stdio: "ignore" },
      );
      await waitForExit(secondInstance, 5_000);
      expect(secondInstance.exitCode).toBe(0);

      const status = await page.evaluate(() =>
        window.electronAPI.getCursorStatus(),
      );
      expect(status).toMatchObject({
        previewMode: false,
        bridgeAvailable: true,
        statusAvailable: true,
      });

      const themes = await page.evaluate(() =>
        window.electronAPI.listCursorThemes(),
      );
      expect(themes.length).toBeGreaterThanOrEqual(bundledThemeIds.length);
      expect(new Set(themes.map((theme) => theme.nativeThemeId)).size).toBe(
        themes.length,
      );

      const bundledThemes = themes.filter((theme) =>
        bundledThemeIdSet.has(theme.nativeThemeId),
      );
      expect(
        bundledThemes.map((theme) => theme.nativeThemeId).toSorted(),
      ).toEqual(bundledThemeIds);
      for (const theme of bundledThemes) {
        expect(theme).toMatchObject({
          availability: "bundled",
          canApply: true,
          imported: false,
          nativeListed: true,
          resourceInstalled: true,
        });
        expect(theme.rolePreviews).toHaveLength(47);
      }

      const importedThemes = themes.filter(
        (theme) => !bundledThemeIdSet.has(theme.nativeThemeId),
      );
      for (const theme of importedThemes) {
        expect(theme).toMatchObject({
          availability: "imported",
          canApply: true,
          imported: true,
          nativeListed: true,
          resourceInstalled: true,
        });
        expect(theme.rolePreviews).toHaveLength(47);
        expect(theme.preview).toMatch(/^cursor-preview:\/\/asset\//);
      }

      const animatedWait = bundledThemes
        .find((theme) => theme.nativeThemeId === "BibataExtraModernDarkRed")
        ?.rolePreviews.find(
          (role) => role.macIdentifier === "com.apple.coregraphics.Wait",
        );
      expect(animatedWait).toMatchObject({ frameCount: 24 });
      expect(animatedWait.frameCount * animatedWait.frameDuration).toBeCloseTo(
        3.03,
        2,
      );
      const encodedFrameDuration =
        Math.round(animatedWait.frameDuration * 1_000) / 1_000;
      const animation = await page.evaluate(async (source) => {
        const response = await fetch(source);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const expectedSignature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (expectedSignature.some((byte, index) => bytes[index] !== byte)) {
          throw new Error("Animated preview does not have a PNG signature.");
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const chunkTypes = [];
        const frameControls = [];
        let animationControl = null;
        let canvas = null;
        let offset = expectedSignature.length;
        while (offset < bytes.length) {
          if (offset + 12 > bytes.length) {
            throw new Error("Truncated PNG chunk header.");
          }
          const length = view.getUint32(offset);
          const type = String.fromCharCode(
            ...bytes.slice(offset + 4, offset + 8),
          );
          const dataOffset = offset + 8;
          const nextOffset = dataOffset + length + 4;
          if (nextOffset > bytes.length) {
            throw new Error(`Truncated ${type} PNG chunk.`);
          }
          chunkTypes.push(type);

          if (type === "IHDR") {
            if (length !== 13 || canvas) {
              throw new Error("Invalid PNG image header chunk.");
            }
            canvas = {
              height: view.getUint32(dataOffset + 4),
              width: view.getUint32(dataOffset),
            };
          } else if (type === "acTL") {
            if (length !== 8 || animationControl) {
              throw new Error("Invalid APNG animation control chunk.");
            }
            animationControl = {
              frameCount: view.getUint32(dataOffset),
              playCount: view.getUint32(dataOffset + 4),
            };
          } else if (type === "fcTL") {
            if (length !== 26) {
              throw new Error("Invalid APNG frame control chunk.");
            }
            const delayNumerator = view.getUint16(dataOffset + 20);
            const encodedDenominator = view.getUint16(dataOffset + 22);
            const delayDenominator = encodedDenominator || 100;
            frameControls.push({
              delay: delayNumerator / delayDenominator,
              height: view.getUint32(dataOffset + 8),
              sequenceNumber: view.getUint32(dataOffset),
              width: view.getUint32(dataOffset + 4),
              xOffset: view.getUint32(dataOffset + 12),
              yOffset: view.getUint32(dataOffset + 16),
            });
          }
          offset = nextOffset;
        }

        return {
          ok: response.ok,
          animationControl,
          canvas,
          chunkTypes,
          frameControls,
        };
      }, animatedWait.src);
      expect(animation.ok).toBe(true);
      expect(animation.animationControl).toEqual({
        frameCount: animatedWait.frameCount,
        playCount: 0,
      });
      expect(animation.canvas).toEqual({ height: 96, width: 96 });
      expect(animation.chunkTypes[0]).toBe("IHDR");
      expect(animation.chunkTypes.at(-1)).toBe("IEND");
      expect(animation.chunkTypes).toContain("IDAT");
      expect(animation.chunkTypes).toContain("fdAT");
      expect(animation.chunkTypes.indexOf("acTL")).toBeLessThan(
        animation.chunkTypes.indexOf("IDAT"),
      );
      expect(animation.frameControls).toHaveLength(animatedWait.frameCount);
      expect(animation.frameControls[0].sequenceNumber).toBe(0);
      for (const [index, frame] of animation.frameControls.entries()) {
        expect(frame.height).toBeGreaterThan(0);
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.xOffset + frame.width).toBeLessThanOrEqual(
          animation.canvas.width,
        );
        expect(frame.yOffset + frame.height).toBeLessThanOrEqual(
          animation.canvas.height,
        );
        expect(frame.delay).toBeCloseTo(encodedFrameDuration, 3);
        if (index > 0) {
          expect(frame.sequenceNumber).toBeGreaterThan(
            animation.frameControls[index - 1].sequenceNumber,
          );
        }
      }
      expect(
        animation.frameControls.reduce(
          (total, frame) => total + frame.delay,
          0,
        ),
      ).toBeCloseTo(animatedWait.frameCount * encodedFrameDuration, 3);
      await page.evaluate(
        (source) =>
          new Promise((resolve, reject) => {
            const image = document.createElement("img");
            image.dataset.animationSmoke = "true";
            image.alt = "Animated cursor playback smoke test";
            image.style.cssText =
              "position:fixed;left:0;top:0;width:96px;height:96px;background:white;z-index:2147483647";
            image.onload = resolve;
            image.onerror = () =>
              reject(new Error("APNG preview did not load."));
            image.src = source;
            document.body.append(image);
          }),
        animatedWait.src,
      );
      const animatedImage = page.locator('img[data-animation-smoke="true"]');
      const playbackFrameA = await animatedImage.screenshot();
      await page.waitForTimeout(encodedFrameDuration * 1_000 * 5);
      const playbackFrameB = await animatedImage.screenshot();
      expect(playbackFrameA.equals(playbackFrameB)).toBe(false);
      await animatedImage.evaluate((image) => image.remove());
      const previewSources = [
        "OreoWhite",
        "BibataModernClassic",
        "MogaClassic",
        "Qogir",
        "Nordzy",
      ].map(
        (identifier) =>
          themes.find((theme) => theme.nativeThemeId === identifier)?.preview,
      );
      expect(previewSources).toEqual(
        previewSources.map(() =>
          expect.stringMatching(/^cursor-preview:\/\/asset\//),
        ),
      );
      const decodedPreviews = await page.evaluate(
        (sources) =>
          Promise.all(
            sources.map(
              (source) =>
                new Promise((resolve) => {
                  const image = new Image();
                  image.onload = () =>
                    resolve({
                      height: image.naturalHeight,
                      loaded: true,
                      width: image.naturalWidth,
                    });
                  image.onerror = () => resolve({ loaded: false });
                  image.src = source;
                }),
            ),
          ),
        previewSources,
      );
      for (const preview of decodedPreviews) {
        expect(preview).toMatchObject({
          height: 96,
          loaded: true,
          width: 96,
        });
      }

      await page.waitForFunction(() =>
        [...document.querySelectorAll("figure img")]
          .slice(0, 5)
          .every((image) => image.complete && image.naturalWidth > 0),
      );
      const rolePreviewLayout = await page.evaluate(() =>
        [...document.querySelectorAll("figure img")]
          .slice(0, 5)
          .map((image) => {
            const bounds = image.getBoundingClientRect();
            return {
              naturalWidth: image.naturalWidth,
              physicalLeft: bounds.left * window.devicePixelRatio,
              physicalWidth: bounds.width * window.devicePixelRatio,
            };
          }),
      );
      expect(rolePreviewLayout).toHaveLength(5);
      for (const preview of rolePreviewLayout) {
        expect(preview.naturalWidth).toBeGreaterThanOrEqual(
          preview.physicalWidth,
        );
        expect(preview.physicalLeft).toBeCloseTo(
          Math.round(preview.physicalLeft),
          6,
        );
      }
    } finally {
      await browser?.close();
      if (app.exitCode === null && app.signalCode === null) {
        app.kill("SIGTERM");
      }
      await waitForExit(app);
      await removeTemporaryUserData(userDataDirectory);
    }
  });
});
