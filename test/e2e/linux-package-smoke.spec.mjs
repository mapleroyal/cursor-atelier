import { chromium, expect, test } from "@playwright/test";
import { listPackage } from "@electron/asar";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packagedRoot = process.env.CURSOR_ATELIER_EXECUTABLE
  ? path.dirname(path.resolve(process.env.CURSOR_ATELIER_EXECUTABLE))
  : path.join(
      projectRoot,
      "out.noindex",
      `Cursor Atelier-linux-${process.arch}`,
    );
const resources = path.join(packagedRoot, "resources");
const executable = process.env.CURSOR_ATELIER_EXECUTABLE
  ? path.resolve(process.env.CURSOR_ATELIER_EXECUTABLE)
  : path.join(packagedRoot, "cursor-atelier");
const liveCursorSmoke = process.env.CURSOR_ATELIER_LIVE_PACKAGE_SMOKE === "1";
const profilePrefix = "cursor-atelier-linux-smoke-";
const sourceCatalog = JSON.parse(
  fs.readFileSync(
    path.join(
      projectRoot,
      "native/cursor-packs/sources/curated-source-catalog.json",
    ),
    "utf8",
  ),
);
const familyCatalog = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "native/cursor-packs/curated-family-catalog.json"),
    "utf8",
  ),
);

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function removeProfile(directory) {
  const canonical = await fs.promises.realpath(directory);
  const temporary = await fs.promises.realpath(os.tmpdir());
  if (
    path.dirname(canonical) !== temporary ||
    !path.basename(canonical).startsWith(profilePrefix)
  ) {
    throw new Error(`Refusing unexpected smoke-test cleanup: ${canonical}`);
  }
  await fs.promises.rm(canonical, { recursive: true });
}

async function launchPackage() {
  if (!fs.existsSync(executable)) {
    throw new Error(
      "Run `npm run package` before the Linux package smoke test.",
    );
  }
  const profile = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), profilePrefix),
  );
  const archiveRoot = path.join(profile, "curated-archives");
  await fs.promises.mkdir(archiveRoot, { mode: 0o700 });
  const oreo = sourceCatalog.sources.find((source) => source.id === "oreo");
  const archivePath = path.join(archiveRoot, "oreo.tar.gz");
  const pinnedSource = path.join(
    projectRoot,
    "native/cursor-packs/sources",
    oreo.directory,
  );
  if (fs.existsSync(pinnedSource)) {
    await tar.create(
      {
        cwd: pinnedSource,
        file: archivePath,
        gzip: true,
        noMtime: true,
        portable: true,
        prefix: `oreo-cursors-${oreo.revision}/`,
      },
      oreo.inputRoots,
    );
  } else {
    const response = await fetch(oreo.archiveUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not acquire the pinned Oreo smoke input: ${response.status}`,
      );
    }
    await fs.promises.writeFile(
      archivePath,
      Buffer.from(await response.arrayBuffer()),
      { mode: 0o600 },
    );
  }
  const environment = { ...process.env };
  delete environment.CURSOR_NATIVE_BRIDGE;
  delete environment.CURSOR_PACK_MANIFEST;
  Object.assign(environment, {
    CURSOR_ATELIER_USER_DATA: path.join(profile, "user-data"),
    CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION: "1",
    CURSOR_ATELIER_CURATED_ARCHIVE_ROOT: archiveRoot,
  });
  if (!liveCursorSmoke) {
    Object.assign(environment, {
      XDG_CONFIG_HOME: path.join(profile, "config"),
      XDG_DATA_HOME: path.join(profile, "data"),
      XDG_CACHE_HOME: path.join(profile, "cache"),
    });
  }
  const port = await reserveLoopbackPort();
  const debugUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  let browser;
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(output.join(""));
          }
          try {
            return (await fetch(`${debugUrl}/json/version`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    browser = await chromium.connectOverCDP(debugUrl);
    const context = browser.contexts()[0];
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    await expect(page).toHaveTitle("Cursor Atelier");
    return {
      page,
      child,
      output,
      profile,
      environment,
      async cleanup() {
        await browser.close().catch(() => undefined);
        await stopChild(child);
        await removeProfile(profile);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopChild(child);
    await removeProfile(profile);
    throw error;
  }
}

test.describe("Linux packaged integration", () => {
  test.skip(process.platform !== "linux", "Requires the Linux package.");

  test("ships a self-contained converter and no converted cursor corpus", () => {
    expect(
      listPackage(path.join(resources, "app.asar")).filter(
        (entry) => path.extname(entry) === ".cursor",
      ),
    ).toEqual([]);
    const converter = path.join(
      resources,
      "curated-cursor-converter",
      "curated-cursor-converter",
    );
    const result = spawnSync(converter, ["self-test"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "self-test",
      ok: true,
      themeCount: 240,
      roleCount: 47,
      catalogSha256: familyCatalog.sha256,
    });
  });

  test("opens the Linux backend and converts all pinned Oreo variants locally", async () => {
    test.setTimeout(600_000);
    const launch = await launchPackage();
    try {
      const { page, profile, output } = launch;
      await expect(
        page.getByRole("heading", { name: "Start with any cursor packs?" }),
      ).toBeVisible();
      await page.setViewportSize({ width: 621, height: 760 });
      const continueButton = page.getByRole("button", {
        name: "Continue",
        exact: true,
      });
      await expect(continueButton).toBeVisible();
      const continueBounds = await continueButton.boundingBox();
      expect(continueBounds.x).toBeGreaterThanOrEqual(0);
      expect(continueBounds.x + continueBounds.width).toBeLessThanOrEqual(621);
      expect(continueBounds.y + continueBounds.height).toBeLessThanOrEqual(760);
      expect(
        await page.evaluate(() => window.electronAPI.getCursorStatus()),
      ).toMatchObject({
        previewMode: false,
        bridgeAvailable: true,
        statusAvailable: true,
        effectiveApplied: false,
      });
      expect(
        await page.evaluate(() => window.electronAPI.listCursorThemes()),
      ).toEqual([]);
      await page.getByRole("button", { name: "Select none" }).click();
      const oreo = page
        .getByRole("group", { name: "Starter cursor packs" })
        .getByRole("button")
        .filter({ hasText: "Oreo" });
      await oreo.click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect
        .poll(
          async () => {
            const state = await page.evaluate(() =>
              window.electronAPI.getOnboardingState(),
            );
            return state.jobs.find((job) => job.familyId === "oreo")?.status;
          },
          { timeout: 540_000 },
        )
        .toMatch(/^(completed|failed)$/);
      const state = await page.evaluate(() =>
        window.electronAPI.getOnboardingState(),
      );
      const job = state.jobs.find((entry) => entry.familyId === "oreo");
      expect(job.status, `${job.error ?? ""}\n${output.join("")}`).toBe(
        "completed",
      );
      const expectedIds = familyCatalog.families
        .find((family) => family.id === "oreo")
        .variants.map((variant) => variant.identifier)
        .sort();
      expect(job.installedVariantIds.toSorted()).toEqual(expectedIds);
      const themes = await page.evaluate(() =>
        window.electronAPI.listCursorThemes(),
      );
      expect(themes.map((theme) => theme.nativeThemeId).sort()).toEqual(
        expectedIds,
      );
      for (const theme of themes) {
        expect(theme).toMatchObject({
          imported: true,
          nativeListed: true,
          resourceAvailable: true,
        });
        expect(theme.rolePreviews).toHaveLength(47);
      }
      expect(
        await fs.promises.readdir(
          path.join(profile, "user-data", "ImportedPacks"),
        ),
      ).toHaveLength(19);
      expect(
        await page.evaluate(() => window.electronAPI.getCursorStatus()),
      ).toMatchObject({ effectiveApplied: false });
      if (liveCursorSmoke) {
        // Explicit opt-in only: this changes the current desktop cursor and
        // restores the baseline even if an assertion fails.
        try {
          await page.evaluate(
            (identifier) => window.electronAPI.applyCursorTheme(identifier),
            themes[0].nativeThemeId,
          );
          expect(
            await page.evaluate(() => window.electronAPI.getCursorStatus()),
          ).toMatchObject({ effectiveApplied: true });
          await page.evaluate(
            (identifier) =>
              window.electronAPI.setCursorThemeSize(identifier, 125),
            themes[0].nativeThemeId,
          );
          expect(
            await page.evaluate(() => window.electronAPI.getCursorStatus()),
          ).toMatchObject({ effectiveApplied: true });
        } finally {
          await page.evaluate(() => window.electronAPI.restoreCursorState());
        }
        expect(
          await page.evaluate(() => window.electronAPI.getCursorStatus()),
        ).toMatchObject({
          desiredEnabled: false,
          effectiveApplied: false,
          loginItemRegistrationCurrent: false,
        });
        await page.evaluate(
          (identifier) => window.electronAPI.deleteImportedCursor(identifier),
          themes[0].nativeThemeId,
        );
      }
      expect(
        fs.existsSync(
          path.join(profile, "config", "autostart", "cursor-atelier.desktop"),
        ),
      ).toBe(false);
    } finally {
      await launch.cleanup();
    }
  });
});
