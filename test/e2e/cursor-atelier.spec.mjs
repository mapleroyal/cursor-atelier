import { test as base, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packagedOutput = path.join(projectRoot, "out.noindex");
const profilePrefix = "cursor-atelier-e2e-";

const completedOnboardingState = Object.freeze({
  version: 2,
  completed: true,
  jobs: [],
  error: null,
});

function findPackagedAsar() {
  if (process.env.CURSOR_ATELIER_ASAR) {
    return path.resolve(process.env.CURSOR_ATELIER_ASAR);
  }

  const expectedAsar = path.join(
    packagedOutput,
    `Cursor Atelier-darwin-${process.arch}`,
    "Cursor Atelier.app",
    "Contents",
    "Resources",
    "app.asar",
  );
  if (!fs.existsSync(expectedAsar)) {
    throw new Error(
      "No packaged Cursor Atelier app.asar was found. Run `npm run package` before the e2e suite.",
    );
  }
  return expectedAsar;
}

function applicationDataDirectory(profileDirectory) {
  return path.join(
    profileDirectory,
    "Library",
    "Application Support",
    "Cursor Atelier",
  );
}

async function seedOnboarding(profileDirectory, state) {
  if (!state) {
    return;
  }
  const directory = applicationDataDirectory(profileDirectory);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(directory, "onboarding.json"),
    JSON.stringify({ state }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
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

async function waitForElectronExit(application, timeoutMs = 3_000) {
  const child = application.process();
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("error", handleError);
      callback(value);
    };
    const handleExit = () => finish(resolve);
    const handleError = (error) => finish(reject, error);
    const timeout = setTimeout(
      () =>
        finish(
          reject,
          new Error(`Electron did not quit within ${timeoutMs}ms.`),
        ),
      timeoutMs,
    );
    child.once("exit", handleExit);
    child.once("error", handleError);
  });
}

async function launchCursorAtelier({
  onboardingState = completedOnboardingState,
} = {}) {
  const asarPath = findPackagedAsar();
  const profileDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), profilePrefix),
  );
  await seedOnboarding(profileDirectory, onboardingState);

  const environment = { ...process.env };
  delete environment.CURSOR_NATIVE_BRIDGE;
  delete environment.CURSOR_PACK_MANIFEST;
  delete environment.CURSOR_ATELIER_CURATED_ARCHIVE_ROOT;
  environment.CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION = "1";
  environment.HOME = profileDirectory;
  environment.CFFIXED_USER_HOME = profileDirectory;

  // Launching app.asar directly gives it Electron's temporary resources
  // directory instead of the packaged native bundle. Cursor mutation controls
  // must therefore remain unavailable throughout this UI-only suite.
  const app = await electron.launch({
    args: [`--user-data-dir=${profileDirectory}`, asarPath],
    cwd: os.tmpdir(),
    env: environment,
  });

  return {
    app,
    profileDirectory,
    async cleanup() {
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        await app.close();
      }
      await removeTemporaryProfile(profileDirectory);
    },
  };
}

async function firstWindow(app) {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("Cursor Atelier");
  return page;
}

const test = base.extend({
  cursorLaunch: async ({ browserName: _browserName }, use) => {
    const launch = await launchCursorAtelier();
    try {
      await use(launch);
    } finally {
      await launch.cleanup();
    }
  },
  cursorApp: async ({ cursorLaunch }, use) => {
    await use(cursorLaunch.app);
  },
  cursorPage: async ({ cursorApp }, use) => {
    const page = await firstWindow(cursorApp);
    await expect(
      page.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
    await use(page);
  },
});

test.describe("Cursor Atelier packaged UI", () => {
  test.skip(
    process.platform !== "darwin",
    "The production cursor manager is a macOS app; run this suite on macOS.",
  );

  test("starts with 15 selected families and makes the whole row selectable", async () => {
    const launch = await launchCursorAtelier({ onboardingState: null });
    try {
      const page = await firstWindow(launch.app);
      await expect(
        page.getByRole("heading", { name: "Start with any cursor packs?" }),
      ).toBeVisible();

      const chooser = page.getByRole("group", {
        name: "Starter cursor packs",
      });
      const rows = chooser.getByRole("button");
      await expect(rows).toHaveCount(15);
      expect(
        await rows.evaluateAll((entries) =>
          entries.every(
            (entry) => entry.getAttribute("aria-pressed") === "true",
          ),
        ),
      ).toBe(true);
      expect(
        await rows.evaluateAll((entries) =>
          entries.every((entry) => entry.querySelectorAll("img").length === 3),
        ),
      ).toBe(true);

      const future = rows.filter({ hasText: "Future" });
      await expect(future).toHaveCount(1);
      // Click the row's family label, far away from its selection glyph.
      await future.getByText("Future", { exact: true }).click();
      await expect(future).toHaveAttribute("aria-pressed", "false");

      await page
        .getByRole("button", { name: "Select all", exact: true })
        .click();
      expect(
        await rows.evaluateAll((entries) =>
          entries.every(
            (entry) => entry.getAttribute("aria-pressed") === "true",
          ),
        ),
      ).toBe(true);

      await page.getByRole("button", { name: "Deselect all" }).click();
      expect(
        await rows.evaluateAll((entries) =>
          entries.every(
            (entry) => entry.getAttribute("aria-pressed") === "false",
          ),
        ),
      ).toBe(true);

      await expect(future.getByText("Default", { exact: true })).toHaveCount(0);
      await future.getByText("Future", { exact: true }).click();
      await expect(future).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
    } finally {
      await launch.cleanup();
    }
  });

  test("continues with no selections into a persistent empty library", async () => {
    const launch = await launchCursorAtelier({ onboardingState: null });
    try {
      const page = await firstWindow(launch.app);
      await page.getByRole("button", { name: "Deselect all" }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();

      await expect(
        page.getByText("Cursor packs", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByTestId("pack-rail-scroll")
          .getByText("No cursor packs", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => window.electronAPI.getOnboardingState()),
        )
        .toEqual(completedOnboardingState);

      await page.reload();
      await expect(
        page
          .getByTestId("pack-rail-scroll")
          .getByText("No cursor packs", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Start with any cursor packs?" }),
      ).toHaveCount(0);
    } finally {
      await launch.cleanup();
    }
  });

  test("renders a fixed split-pane shell and switches appearance modes", async ({
    cursorPage: page,
  }) => {
    await expect(page.getByText("Cursor packs", { exact: true })).toBeVisible();
    await expect(
      page
        .getByTestId("pack-rail-scroll")
        .getByText("No cursor packs", { exact: true }),
    ).toBeVisible();
    const shellBounds = await page.evaluate(() => ({
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      railClientWidth: document.querySelector("aside")?.clientWidth ?? 0,
      railScrollWidth: document.querySelector("aside")?.scrollWidth ?? 0,
    }));
    expect(shellBounds.bodyScrollHeight).toBe(shellBounds.bodyClientHeight);
    expect(shellBounds.bodyScrollWidth).toBe(shellBounds.bodyClientWidth);
    expect(shellBounds.railScrollWidth).toBeLessThanOrEqual(
      shellBounds.railClientWidth,
    );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    for (const label of ["Light", "System", "Dark"]) {
      await expect(page.getByRole("radio", { name: label })).toBeVisible();
    }

    const dark = page.getByRole("radio", { name: "Dark" });
    await dark.click();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.getByRole("radio", { name: "System" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page
        .getByTestId("pack-rail-scroll")
        .getByText("No cursor packs", { exact: true }),
    ).toBeVisible();
  });

  test("keeps cursor-changing actions unavailable without the native bundle", async ({
    cursorPage: page,
  }) => {
    const status = await page.evaluate(() =>
      window.electronAPI.getCursorStatus(),
    );
    expect(status).toMatchObject({
      previewMode: true,
      bridgeAvailable: false,
      effectiveVariantId: null,
      effectiveApplied: false,
    });
    expect(
      await page.evaluate(() => window.electronAPI.listCursorThemes()),
    ).toEqual([]);

    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");

    await expect(
      page.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "About cursor imports" }),
    ).toHaveCount(0);
  });

  test("uses the pack drawer at the supported minimum window width", async ({
    cursorPage: page,
  }) => {
    await page.setViewportSize({ width: 760, height: 560 });
    await expect(page.locator("aside")).toBeHidden();
    await page.getByRole("button", { name: "Packs" }).click();

    const drawer = page.getByRole("dialog", {
      name: "Choose a cursor pack",
    });
    await expect(drawer).toBeVisible();
    const drawerHeading = drawer.getByText("Cursor packs", { exact: true });
    await expect(drawerHeading).toBeVisible();
    expect((await drawerHeading.boundingBox())?.y).toBeGreaterThanOrEqual(48);
    await expect(
      drawer.getByRole("textbox", { name: "Search cursor packs" }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Close cursor packs" }).click();
    await expect(drawer).toBeHidden();

    await page.setViewportSize({ width: 960, height: 560 });
    await expect(page.locator("aside")).toBeVisible();
    await expect(page.getByRole("button", { name: "Packs" })).toBeHidden();
  });

  test("persists settings and reopens after the last window closes", async ({
    cursorApp,
    cursorPage: page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const appearanceSwitch = page.getByRole("switch", {
      name: "Switch Cursors with System Appearance",
    });
    await appearanceSwitch.click();
    const menuBarSwitch = page.getByRole("switch", {
      name: "Show in Menu Bar",
    });
    if (await menuBarSwitch.isChecked()) {
      await menuBarSwitch.click();
    }
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return {
            automaticSwitching: preferences.appearance.automaticSwitching,
            menuBarVisible: preferences.menuBar.visible,
          };
        }),
      )
      .toEqual({ automaticSwitching: true, menuBarVisible: false });

    await cursorApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(() => cursorApp.windows().length).toBe(0);

    const reopenedWindow = cursorApp.waitForEvent("window");
    await cursorApp.evaluate(({ app }) => app.emit("activate"));
    const reopenedPage = await reopenedWindow;
    await reopenedPage.waitForLoadState("domcontentloaded");
    await expect(reopenedPage).toHaveTitle("Cursor Atelier");
    await expect(
      reopenedPage.getByText("Cursor packs", { exact: true }),
    ).toBeVisible();
  });

  test("registers Command-Q and fully exits through native Quit", async () => {
    const launch = await launchCursorAtelier();
    try {
      await firstWindow(launch.app);
      const quitItem = await launch.app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          .items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.role === "quit");
        return item ? { role: item.role, accelerator: item.accelerator } : null;
      });
      expect(quitItem).toEqual({
        role: "quit",
        accelerator: "CommandOrControl+Q",
      });

      // Playwright renderer key events do not traverse AppKit's native menu
      // accelerator dispatch. Verify the binding above, then exercise the same
      // app.quit() path used by the native Quit role.
      await Promise.all([
        waitForElectronExit(launch.app),
        launch.app.evaluate(({ app }) => app.quit()).catch(() => undefined),
      ]);
    } finally {
      await launch.cleanup();
    }
  });
});
