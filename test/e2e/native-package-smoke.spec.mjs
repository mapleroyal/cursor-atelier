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
const packagedApp = path.join(
  projectRoot,
  "out.noindex",
  `Cursor Atelier-darwin-${process.arch}`,
  "Cursor Atelier.app",
);
const packagedExecutable = path.join(
  packagedApp,
  "Contents",
  "MacOS",
  "Cursor Atelier",
);
const packagedResources = path.join(packagedApp, "Contents", "Resources");
const nativeApp = path.join(packagedResources, "Oreo Cursor.app");
const converterExecutable = path.join(
  packagedResources,
  "curated-cursor-converter",
  "curated-cursor-converter",
);
const outerBundleId = "com.cursoratelier.CursorAtelier";
const profilePrefix = "cursor-atelier-native-smoke-";
const futureRevision = "587c14d2f5bd2dc34095a4efbb1a729eb72a1d36";

function requirePackagedApp() {
  if (!fs.existsSync(packagedExecutable)) {
    throw new Error(
      "No packaged Cursor Atelier executable was found. Run `npm run package` first.",
    );
  }
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

function waitForExit(child, timeout = 10_000, output = []) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(
        new Error(
          `The packaged app did not exit after the quit request.\n${output.join("")}`,
        ),
      );
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function removeTemporaryProfile(directory) {
  const resolvedDirectory = fs.realpathSync(directory);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (
    path.dirname(resolvedDirectory) !== temporaryRoot ||
    !path.basename(resolvedDirectory).startsWith(profilePrefix)
  ) {
    throw new Error(`Refusing to remove unexpected path: ${resolvedDirectory}`);
  }
  await fs.promises.rm(resolvedDirectory, { recursive: true });
}

async function collectBundleEntries(root, predicate, entries = []) {
  for (const entry of await fs.promises.readdir(root, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (predicate(entryPath, entry)) {
      entries.push(entryPath);
    }
    if (entry.isDirectory()) {
      await collectBundleEntries(entryPath, predicate, entries);
    }
  }
  return entries;
}

async function launchPackagedApp({
  profileDirectory,
  environment: environmentOverrides = {},
} = {}) {
  requirePackagedApp();
  const ownedProfile = !profileDirectory;
  const profile =
    profileDirectory ??
    (await fs.promises.mkdtemp(path.join(os.tmpdir(), profilePrefix)));
  const environment = { ...process.env };
  delete environment.CURSOR_NATIVE_BRIDGE;
  delete environment.CURSOR_PACK_MANIFEST;
  delete environment.CURSOR_ATELIER_CURATED_ARCHIVE_ROOT;
  environment.CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION = "1";
  environment.HOME = profile;
  environment.CFFIXED_USER_HOME = profile;
  Object.assign(environment, environmentOverrides);

  const debuggingPort = await reserveLoopbackPort();
  const debugUrl = `http://127.0.0.1:${debuggingPort}`;
  const output = [];
  const child = spawn(
    packagedExecutable,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
    ],
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
    await expect(page).toHaveTitle("Cursor Atelier");

    return {
      browser,
      child,
      environment,
      output,
      page,
      profileDirectory: profile,
      async cleanup() {
        if (child.exitCode === null && child.signalCode === null) {
          const quit = spawnSync(
            "/usr/bin/osascript",
            ["-e", `tell application id "${outerBundleId}" to quit`],
            { encoding: "utf8", timeout: 5_000 },
          );
          if (quit.status !== 0) {
            throw new Error(
              `Could not request a normal application quit: ${quit.stderr.trim()}`,
            );
          }
        }
        await waitForExit(child, 10_000, output);
        await browser?.close().catch(() => undefined);
        if (ownedProfile) {
          await removeTemporaryProfile(profile);
        }
      },
    };
  } catch (error) {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await waitForExit(child, 10_000, output).catch(() => undefined);
    if (ownedProfile) {
      await removeTemporaryProfile(profile);
    }
    throw error;
  }
}

async function createFutureArchiveRoot(profileDirectory) {
  const sourceDirectory = path.join(
    projectRoot,
    "native",
    "cursor-packs",
    "sources",
    "Future-cursors",
  );
  for (const requiredPath of [
    "LICENSE",
    "src/config",
    "src/svg",
    "src/svg-cyan",
  ]) {
    if (!fs.existsSync(path.join(sourceDirectory, requiredPath))) {
      throw new Error(
        "The pinned Future source cache is unavailable. Run the source acquisition step before the packaged conversion smoke.",
      );
    }
  }

  const archiveRoot = path.join(profileDirectory, "curated-archives");
  await fs.promises.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  const archivePath = path.join(archiveRoot, "future.tar.gz");
  await tar.create(
    {
      cwd: sourceDirectory,
      file: archivePath,
      gzip: true,
      noMtime: true,
      portable: true,
      prefix: `Future-cursors-${futureRevision}/`,
    },
    ["LICENSE", "src/config", "src/svg", "src/svg-cyan"],
  );
  await fs.promises.chmod(archivePath, 0o600);
  return archiveRoot;
}

function onboardingRows(page) {
  return page
    .getByRole("group", { name: "Starter cursor packs" })
    .getByRole("button");
}

async function chooseOnlyFuture(page) {
  await page.getByRole("button", { name: "Select none" }).click();
  const future = onboardingRows(page).filter({ hasText: "Future" });
  await future.getByText("Future", { exact: true }).click();
  await expect(future).toHaveAttribute("aria-pressed", "true");
}

test.describe("packaged native integration", () => {
  test.skip(process.platform !== "darwin", "Cursor Atelier is macOS-only.");

  test("packages the converter but no converted cursor payload", async () => {
    requirePackagedApp();
    const cursorFiles = await collectBundleEntries(
      packagedResources,
      (entryPath, entry) =>
        entry.isFile() && path.extname(entryPath).toLowerCase() === ".cursor",
    );
    expect(cursorFiles).toEqual([]);
    expect(
      listPackage(path.join(packagedResources, "app.asar")).filter(
        (entry) => path.extname(entry).toLowerCase() === ".cursor",
      ),
    ).toEqual([]);
    expect(
      fs.existsSync(path.join(nativeApp, "Contents", "Resources", "Themes")),
    ).toBe(false);

    const converterStat = fs.statSync(converterExecutable);
    expect(converterStat.isFile()).toBe(true);
    expect(converterStat.size).toBeGreaterThan(0);
    expect(converterStat.mode & 0o111).not.toBe(0);
  });

  test("discovers a valid empty native library without changing cursors", async () => {
    const launch = await launchPackagedApp();
    try {
      const { child, environment, page, profileDirectory } = launch;
      await expect(
        page.getByRole("heading", { name: "Start with any cursor packs?" }),
      ).toBeVisible();
      await expect(onboardingRows(page)).toHaveCount(15);

      const statusBefore = await page.evaluate(() =>
        window.electronAPI.getCursorStatus(),
      );
      expect(statusBefore).toMatchObject({
        previewMode: false,
        bridgeAvailable: true,
        statusAvailable: true,
        effectiveApplied: false,
      });
      const restoreAvailable = [
        "desiredEnabled",
        "persistedEffectiveApplied",
        "effectiveApplied",
        "launchAtLoginDesired",
        "loginItemRegistrationCurrent",
        "transactionPending",
      ].some((key) => statusBefore[key] === true || statusBefore[key] === 1);
      expect(
        await page.evaluate(() => window.electronAPI.listCursorThemes()),
      ).toEqual([]);

      await page.getByRole("button", { name: "Select none" }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page
          .getByTestId("pack-rail-scroll")
          .getByText("No cursor packs", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Apply", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Restore", exact: true }),
      ).toHaveAttribute("aria-disabled", String(!restoreAvailable));

      const statusAfter = await page.evaluate(() =>
        window.electronAPI.getCursorStatus(),
      );
      expect({
        effectiveApplied: statusAfter.effectiveApplied,
        effectiveVariantId: statusAfter.effectiveVariantId,
        selectedVariantId: statusAfter.selectedVariantId,
      }).toEqual({
        effectiveApplied: statusBefore.effectiveApplied,
        effectiveVariantId: statusBefore.effectiveVariantId,
        selectedVariantId: statusBefore.selectedVariantId,
      });

      const secondInstance = spawn(
        packagedExecutable,
        [
          `--user-data-dir=${path.join(profileDirectory, "alternate-user-data")}`,
        ],
        { env: environment, stdio: "ignore" },
      );
      await waitForExit(secondInstance, 5_000);
      expect(secondInstance.exitCode).toBe(0);
      expect(child.exitCode).toBeNull();
    } finally {
      await launch.cleanup();
    }
  });

  test("converts every Future variant locally into one collapsed family", async () => {
    test.setTimeout(360_000);
    const profileDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), profilePrefix),
    );
    let launch;
    try {
      const archiveRoot = await createFutureArchiveRoot(profileDirectory);
      launch = await launchPackagedApp({
        profileDirectory,
        environment: {
          CURSOR_ATELIER_CURATED_ARCHIVE_ROOT: archiveRoot,
        },
      });
      const { page } = launch;
      await page.evaluate(() => {
        window.__cursorAtelierOnboardingStates = [];
        window.__cursorAtelierUnsubscribe =
          window.electronAPI.onOnboardingChanged((state) => {
            window.__cursorAtelierOnboardingStates.push(state);
          });
      });
      await chooseOnlyFuture(page);
      await page.getByRole("button", { name: "Continue", exact: true }).click();

      const rail = page.getByRole("navigation", { name: "Cursor packs" });
      const futureFamily = rail
        .locator("button[aria-expanded]")
        .filter({ hasText: "Future" })
        .first();
      await expect(futureFamily).toBeVisible();
      await expect(futureFamily).toHaveAttribute("aria-expanded", "false");
      await expect(rail.locator("button[data-pack-option]")).toHaveCount(0);

      await expect
        .poll(
          async () => {
            const state = await page.evaluate(() =>
              window.electronAPI.getOnboardingState(),
            );
            return state.jobs.find((job) => job.familyId === "future")?.status;
          },
          { timeout: 300_000 },
        )
        .toMatch(/^(completed|failed)$/);
      const state = await page.evaluate(() =>
        window.electronAPI.getOnboardingState(),
      );
      const futureJob = state.jobs.find((job) => job.familyId === "future");
      expect(
        futureJob?.status,
        `${futureJob?.error ?? "Future conversion failed"}\n${launch.output.join("")}`,
      ).toBe("completed");
      expect(futureJob?.installedVariantIds.toSorted()).toEqual([
        "Future",
        "FutureCyan",
      ]);

      const stateHistory = await page.evaluate(
        () => window.__cursorAtelierOnboardingStates,
      );
      const futureHistory = stateHistory
        .map((snapshot) =>
          snapshot.jobs.find((job) => job.familyId === "future"),
        )
        .filter(Boolean);
      expect(
        futureHistory.some((job) =>
          ["downloading", "converting", "installing"].includes(job.status),
        ),
      ).toBe(true);

      await expect
        .poll(() => page.evaluate(() => window.electronAPI.listCursorThemes()))
        .toHaveLength(2);
      await expect(
        page.getByTestId("cursor-size-preview").getByText("100%", {
          exact: true,
        }),
      ).toBeVisible();
      const sizeHelp = page.getByRole("button", {
        name: "About cursor sizing",
      });
      await sizeHelp.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(sizeHelp).toBeFocused();
      await expect(
        page
          .getByRole("tooltip")
          .getByText(
            "For the applied size to match this preview, set the system slider in System Settings → Accessibility → Display → Pointer → Pointer Size all the way to its leftmost position.",
            { exact: true },
          ),
      ).toBeVisible();
      const themes = await page.evaluate(() =>
        window.electronAPI.listCursorThemes(),
      );
      expect(themes.map((theme) => theme.nativeThemeId).toSorted()).toEqual([
        "Future",
        "FutureCyan",
      ]);
      for (const theme of themes) {
        expect(theme).toMatchObject({
          family: "Future",
          availability: "imported",
          canApply: true,
          imported: true,
          nativeListed: true,
          resourceAvailable: true,
        });
        expect(theme.rolePreviews).toHaveLength(47);
      }

      await expect(futureFamily).toHaveAttribute("aria-expanded", "false");
      await expect(rail.locator(":scope > section")).toHaveCount(1);
      await futureFamily.click();
      const variants = rail.locator("button[data-pack-option]");
      await expect(variants).toHaveCount(2);
      await expect(variants.filter({ hasText: "Default" })).toHaveCount(1);
      await expect(variants.filter({ hasText: "Cyan" })).toHaveCount(1);

      const status = await page.evaluate(() =>
        window.electronAPI.getCursorStatus(),
      );
      expect(status.effectiveApplied).toBe(false);
    } finally {
      try {
        await launch?.cleanup();
      } finally {
        await removeTemporaryProfile(profileDirectory);
      }
    }
  });
});
