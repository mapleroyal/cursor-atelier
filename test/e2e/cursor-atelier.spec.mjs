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

function failedMogaOnboardingState(code) {
  return {
    ...completedOnboardingState,
    jobs: [
      {
        familyId: "moga",
        status: "failed",
        progress: null,
        error: "Moga could not be added.",
        failure: {
          code,
          message: "Moga-Neon-Blue.zip differs from its pinned archive.",
        },
        installedVariantIds: [],
        currentVariant: null,
      },
    ],
  };
}

function findPackagedAsar() {
  if (process.env.CURSOR_ATELIER_ASAR) {
    return path.resolve(process.env.CURSOR_ATELIER_ASAR);
  }

  const expectedAsar = path.join(
    packagedOutput,
    `Cursor Atelier-${process.platform}-${process.arch}`,
    ...(process.platform === "darwin"
      ? ["Cursor Atelier.app", "Contents", "Resources"]
      : ["resources"]),
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
  if (process.platform !== "darwin") {
    return path.join(profileDirectory, "config", "Cursor Atelier");
  }
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
  environment.CURSOR_ATELIER_USER_DATA =
    applicationDataDirectory(profileDirectory);
  environment.XDG_CONFIG_HOME = path.join(profileDirectory, "config");
  environment.XDG_DATA_HOME = path.join(profileDirectory, "data");
  if (process.platform === "darwin") {
    environment.HOME = profileDirectory;
    environment.CFFIXED_USER_HOME = profileDirectory;
  }

  // Launching app.asar directly gives it Electron's temporary resources
  // directory instead of the packaged native bundle. Cursor mutation controls
  // must therefore remain unavailable throughout this UI-only suite.
  const app = await electron.launch({
    args: [`--user-data-dir=${profileDirectory}`, asarPath],
    cwd: os.tmpdir(),
    env: environment,
  });
  const child = app.process();

  return {
    app,
    profileDirectory,
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        await app.close();
      }
      await removeTemporaryProfile(profileDirectory);
    },
  };
}

async function firstWindow(app) {
  const page = await app.firstWindow();
  if (process.platform === "linux") {
    // A tiling Linux compositor may resize the native window at launch. Keep
    // desktop-shell assertions independent of that user's workspace layout.
    await page.setViewportSize({ width: 1080, height: 760 });
  }
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
    !["darwin", "linux"].includes(process.platform),
    "Run the packaged UI suite on macOS or Linux.",
  );

  test("starts with 15 selected families and makes the whole row selectable", async () => {
    const launch = await launchCursorAtelier({ onboardingState: null });
    try {
      const page = await firstWindow(launch.app);
      await expect(
        page.getByRole("heading", { name: "Start with any cursor packs?" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "All are selected by default. Click any pack to deselect it.",
          { exact: true },
        ),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Skip", exact: true }),
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

      await page.getByRole("button", { name: "Select none" }).click();
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

  test("skips into a persistent empty library", async () => {
    const launch = await launchCursorAtelier({ onboardingState: null });
    try {
      const page = await firstWindow(launch.app);
      await page.getByRole("button", { name: "Skip", exact: true }).click();

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
    cursorApp: app,
  }) => {
    await expect(page.getByText("Cursor packs", { exact: true })).toBeVisible();
    const randomize = page.getByRole("button", {
      name: "Randomize",
      exact: true,
    });
    await expect(randomize).toBeVisible();
    await expect(randomize.locator("svg")).toHaveCount(1);
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
    if (process.platform === "darwin") {
      await expect(page.getByText("App Icon", { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          "Follows System Settings → Appearance → Icon & widget style → Dark → Auto",
          { exact: true },
        ),
      ).toBeVisible();
    }

    const desktopAppearance = await page.evaluate(() => {
      window.appearanceNotifications = [];
      window.electronAPI.onAppAppearanceChanged((mode) =>
        window.appearanceNotifications.push(mode),
      );
      return window.electronAPI.getSystemAppearance();
    });
    const dark = page.getByRole("radio", { name: "Dark" });
    await dark.click();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect
      .poll(() =>
        page.evaluate(() => window.electronAPI.getAppAppearanceMode()),
      )
      .toBe("dark");
    expect(
      await page.evaluate(() => window.electronAPI.getSystemAppearance()),
    ).toBe(desktopAppearance);
    // A local save is confirmed by its reply, not an event that could
    // overtake another queued choice in the same renderer.
    expect(await page.evaluate(() => window.appearanceNotifications)).toEqual(
      [],
    );

    // Import and rollback publish this authoritative main-process event.
    // Verify the open selector and document consume it without a reload.
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "light";
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:appearance-changed", "light");
      }
    });
    await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.getByRole("radio", { name: "System" }).click();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
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

  test("keeps the rail and settings reachable across narrow and desktop widths", async ({
    cursorPage: page,
  }) => {
    const widths =
      process.platform === "linux"
        ? [320, 480, 760, 959, 960, 1080]
        : [760, 959, 960, 1080];
    const railTrigger = page.getByRole("button", {
      name: "Cursor packs",
      exact: true,
    });
    const settingsTrigger = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    const drawer = page.getByRole("dialog", { name: "Choose a cursor pack" });
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });

    for (const width of widths) {
      await page.setViewportSize({ width, height: 560 });
      await expect(settingsTrigger).toBeInViewport();
      if (width < 960) {
        await expect(page.locator("aside")).toBeHidden();
        await expect(railTrigger).toBeInViewport();
        expect((await railTrigger.boundingBox()).x).toBeLessThan(
          process.platform === "linux" ? 48 : 112,
        );
        await railTrigger.click();
        await expect(drawer).toBeVisible();
        const drawerHeading = drawer.getByText("Cursor packs", { exact: true });
        await expect(drawerHeading).toBeVisible();
        expect((await drawerHeading.boundingBox()).y).toBeGreaterThanOrEqual(
          48,
        );
        await expect(
          drawer.getByRole("textbox", { name: "Search cursor packs" }),
        ).toBeVisible();
        await drawer
          .getByRole("button", { name: "Close cursor packs" })
          .click();
        await expect(drawer).toBeHidden();
      } else {
        await expect(page.locator("aside")).toBeVisible();
        await expect(railTrigger).toBeHidden();
      }

      await settingsTrigger.click();
      await expect(settings).toBeVisible();
      await expect
        .poll(async () => {
          const bounds = await settings.boundingBox();
          return Math.round(bounds.x + bounds.width);
        })
        .toBe(width);
      expect((await settings.boundingBox()).width).toBeLessThanOrEqual(
        Math.min(width, 672),
      );
      const settingsOverflow = await settings.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(settingsOverflow).toBe(0);
      await settings.getByRole("button", { name: "Close settings" }).click();
      await expect(settings).toBeHidden();
      await expect(settingsTrigger).toBeFocused();
      const overflow = await page.evaluate(
        () => document.body.scrollWidth - document.body.clientWidth,
      );
      expect(overflow).toBe(0);
    }

    await page.setViewportSize({ width: 760, height: 560 });
    await railTrigger.click();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 960, height: 560 });
    await expect(drawer).toBeHidden();
    await expect(page.locator("aside")).toBeVisible();
    await page.setViewportSize({ width: 760, height: 560 });
    await expect(railTrigger).toBeInViewport();
    await expect(drawer).toBeHidden();
  });

  for (const code of ["SOURCE_UNAVAILABLE", "INTEGRITY_FAILED"]) {
    test(`dismisses a failed Moga import persistently (${code})`, async () => {
      const launch = await launchCursorAtelier({
        onboardingState: failedMogaOnboardingState(code),
      });
      try {
        const page = await firstWindow(launch.app);
        const narrow = code === "SOURCE_UNAVAILABLE";
        if (narrow) {
          await page.setViewportSize({ width: 760, height: 560 });
          await page
            .getByRole("button", { name: "Cursor packs", exact: true })
            .click();
        }
        const rail = page.getByTestId("pack-rail-scroll");
        await expect(rail.getByText("Moga", { exact: true })).toBeVisible();
        const retry = rail.getByRole("button", {
          name: "Retry Moga",
          exact: true,
        });
        if (code === "INTEGRITY_FAILED") {
          await expect(retry).toBeVisible();
        } else {
          await expect(retry).toHaveCount(0);
        }
        await rail.getByRole("button", { name: "Dismiss Moga import" }).click();
        await expect(rail.getByText("Moga", { exact: true })).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() => window.electronAPI.getOnboardingState()),
          )
          .toEqual(completedOnboardingState);
        await page.reload();
        if (narrow) {
          await page
            .getByRole("button", { name: "Cursor packs", exact: true })
            .click();
        }
        await expect(
          rail.getByText("No cursor packs", { exact: true }),
        ).toBeVisible();
        await expect(rail.getByText("Moga", { exact: true })).toHaveCount(0);
      } finally {
        await launch.cleanup();
      }
    });
  }

  test("shows a dismissal failure in the collapsed narrow pack rail", async () => {
    const state = failedMogaOnboardingState("SOURCE_UNAVAILABLE");
    const launch = await launchCursorAtelier({ onboardingState: state });
    try {
      const page = await firstWindow(launch.app);
      await launch.app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("onboarding:dismiss");
        ipcMain.handle("onboarding:dismiss", () => {
          throw new Error("Write failed");
        });
      });
      await page.setViewportSize({ width: 760, height: 560 });
      await page
        .getByRole("button", { name: "Cursor packs", exact: true })
        .click();
      const rail = page.getByTestId("pack-rail-scroll");
      const family = rail.getByRole("button", { name: /^Moga/ });
      await expect(family).toHaveAttribute("aria-expanded", "false");
      const dismiss = rail.getByRole("button", { name: "Dismiss Moga import" });
      await dismiss.click();
      await expect(rail.getByRole("alert")).toHaveText("Write failed");
      await expect(family).toBeVisible();
      await expect(family).toHaveAttribute("aria-expanded", "false");
      await expect(dismiss).toBeEnabled();
      expect(
        await page.evaluate(() => window.electronAPI.getOnboardingState()),
      ).toEqual(state);
    } finally {
      await launch.cleanup();
    }
  });

  test("shows import errors when the library is empty", async ({
    cursorApp,
    cursorPage: page,
  }) => {
    await cursorApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("cursor:import-pack");
      ipcMain.handle("cursor:import-pack", () => {
        throw new Error("The cursor archive is invalid.");
      });
    });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    if (process.platform === "linux") {
      await page
        .getByRole("button", { name: "Import File…", exact: true })
        .click();
    }
    await expect(page.getByRole("alert")).toContainText(
      "The cursor archive is invalid.",
    );
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
      name:
        process.platform === "darwin"
          ? "Show in Menu Bar"
          : "Show in System Tray",
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
    await reopenedPage.setViewportSize({ width: 1080, height: 760 });
    await reopenedPage.waitForLoadState("domcontentloaded");
    await expect(reopenedPage).toHaveTitle("Cursor Atelier");
    await expect(
      reopenedPage.getByText("Cursor packs", { exact: true }),
    ).toBeVisible();
  });

  test("registers the platform quit shortcut and fully exits through Quit", async () => {
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

// This interaction test supplies a catalog through the real preload boundary.
// It never invokes the native cursor engine or writes the user's preferences.
test("keeps the rail selection, preview, and toolbar consistent while browsing", async ({
  cursorPage: page,
  cursorApp: app,
}) => {
  const resizeWindow = async (size) => {
    if (process.platform !== "win32") {
      await page.setViewportSize(size);
      return;
    }
    await app.evaluate(({ BrowserWindow }, dimensions) => {
      BrowserWindow.getAllWindows()[0].setContentSize(
        dimensions.width,
        dimensions.height,
      );
    }, size);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
      )
      .toEqual(size);
  };
  test.setTimeout(90_000);
  await app.evaluate(({ ipcMain }) => {
    const packs = [
      { id: "alpha-first", family: "Alpha", variant: "Alpha First" },
      { id: "alpha-second", family: "Alpha", variant: "Alpha Second" },
      { id: "beta-first", family: "Beta", variant: "Beta First" },
    ].map((pack) => ({
      ...pack,
      nativeThemeId: pack.id,
      resourceAvailable: true,
      canApply: true,
      imported: true,
    }));
    const snapshots = {
      "cursor:list-themes": packs,
      "cursor:status": {
        bridgeAvailable: true,
        supported: true,
        statusAvailable: true,
        previewMode: false,
        desiredEnabled: false,
        effectiveApplied: false,
      },
      "preferences:get": {
        favorites: { cursorIds: ["alpha-second"], families: [] },
        appearance: {
          lightCursorId: "alpha-first",
          darkCursorId: "beta-first",
          automaticSwitching: false,
        },
        randomization: {
          pools: {
            light: ["alpha-first", "alpha-second"],
            dark: ["beta-first"],
          },
        },
      },
    };
    globalThis.railNavigationFixtures = snapshots;
    for (const [channel, snapshot] of Object.entries(snapshots)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => snapshot);
    }
  });
  await resizeWindow({ width: 1080, height: 760 });
  await page.reload();
  const rail = page.getByTestId("pack-rail-scroll");
  const families = rail.getByRole("navigation", {
    name: "Cursor packs",
    exact: true,
  });
  const shortcuts = rail.getByRole("navigation", { name: "Cursor shortcuts" });
  const alpha = families.getByRole("button", { name: "Alpha 2", exact: true });
  const beta = families.getByRole("button", { name: "Beta 1", exact: true });
  const favorite = shortcuts.getByRole("button", {
    name: "Alpha Second Alpha",
    exact: true,
  });
  const heading = page.getByRole("heading", { level: 1 });
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  const expectSelection = async (variant) => {
    await expect(heading).toHaveText(variant);
    await expect(rail.locator('button[aria-current="true"]')).toHaveCount(1);
    await expect(rail.locator('button[aria-expanded="true"]')).toHaveCount(1);
  };

  await expectSelection("Alpha First");
  await families
    .getByRole("button", { name: "Alpha Alpha Second", exact: true })
    .click();
  await expectSelection("Alpha Second");
  await alpha.click();
  await expect(heading).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Cursor preview" }),
  ).toBeEmpty();
  await expect(apply).toBeDisabled();
  await alpha.click();
  await expectSelection("Alpha First");
  await beta.click();
  await expectSelection("Beta First");
  await expect(alpha).toHaveAttribute("aria-expanded", "false");

  // A shortcut remains the preview's owner when an unrelated family closes.
  await favorite.click();
  await expectSelection("Alpha Second");
  await beta.click();
  await expect(heading).toHaveText("Alpha Second");
  await expect(favorite).toHaveAttribute("aria-current", "true");
  await expect(rail.locator('button[aria-expanded="true"]')).toHaveCount(0);
  await expect(
    shortcuts.getByText("Light \u00b7 Alpha", { exact: true }),
  ).toBeVisible();
  await expect(
    shortcuts.getByText("Dark \u00b7 Beta", { exact: true }),
  ).toBeVisible();

  const lightPool = shortcuts.getByRole("button", {
    name: "Light mode 2",
    exact: true,
  });
  await lightPool.click();
  await expectSelection("Alpha First");
  await lightPool.click();
  await expect(heading).toHaveCount(0);

  const search = page.getByRole("textbox", { name: "Search cursor packs" });
  await search.fill("First");
  await expectSelection("Alpha First");
  await expect(families.locator('button[aria-expanded="true"]')).toHaveCount(1);
  await search.fill("");
  await families
    .getByRole("button", { name: "Alpha Alpha First", exact: true })
    .press("End");
  await expectSelection("Alpha Second");
  await alpha.click();

  // Repeated section and shortcut changes must keep one owner and clear the
  // details on every collapse, rather than accumulating mounted previews.
  for (let index = 0; index < 25; index += 1) {
    await alpha.click();
    await expectSelection("Alpha First");
    await favorite.click();
    await expectSelection("Alpha Second");
    await beta.click();
    await expectSelection("Beta First");
    await beta.click();
    await expect(heading).toHaveCount(0);
  }
  await alpha.click();
  const toolbar = page.locator("main > header");
  const orderedButtons = [
    "Settings",
    "Import",
    "Restore",
    "Randomize",
    "Apply",
  ];
  const bounds = await Promise.all(
    orderedButtons.map((name) =>
      toolbar.getByRole("button", { name, exact: true }).boundingBox(),
    ),
  );
  for (let index = 1; index < bounds.length; index += 1) {
    expect(bounds[index].x).toBeGreaterThan(bounds[index - 1].x);
  }
  expect(bounds.at(-1).x).toBeGreaterThan(900);
  await page.screenshot({ path: test.info().outputPath("rail-desktop.png") });

  if (process.platform !== "darwin") {
    await resizeWindow({ width: 320, height: 560 });
    await expect
      .poll(() =>
        apply.evaluate((element) => element.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(320);
    const narrowBounds = await Promise.all(
      ["Cursor packs", ...orderedButtons].map((name) =>
        toolbar
          .getByRole("button", { name, exact: true })
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              left: bounds.left,
              right: bounds.right,
            };
          }),
      ),
    );
    for (let index = 0; index < narrowBounds.length; index += 1) {
      const bounds = narrowBounds[index];
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(
        bounds.right,
        `${orderedButtons[index - 1] ?? "Cursor packs"} stays inside the toolbar (${bounds.left}, ${bounds.right})`,
      ).toBeLessThanOrEqual(320);
      if (index > 0) {
        const previous = narrowBounds[index - 1];
        expect(bounds.left).toBeGreaterThanOrEqual(previous.right);
      }
    }
    await page.screenshot({ path: test.info().outputPath("rail-mobile.png") });
  }
  await resizeWindow({ width: 760, height: 560 });
  await page.getByRole("button", { name: "Cursor packs", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Choose a cursor pack" });
  await expect(
    drawer.getByRole("button", { name: "Alpha 2", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await drawer
    .getByRole("button", { name: "Alpha Alpha Second", exact: true })
    .click();
  await expect(drawer).toBeHidden();
  await expect(heading).toHaveText("Alpha Second");
  await expect(apply).toBeInViewport();

  await resizeWindow({ width: 1080, height: 760 });
  await favorite.click();
  await app.evaluate(({ BrowserWindow }) => {
    const preferences = globalThis.railNavigationFixtures["preferences:get"];
    preferences.favorites.cursorIds = [];
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("preferences:changed", preferences);
    }
  });
  await expect(heading).toHaveCount(0);
  await expect(rail.locator('button[aria-current="true"]')).toHaveCount(0);
  await shortcuts
    .getByRole("button", {
      name: "Alpha First Light \u00b7 Alpha",
      exact: true,
    })
    .click();
  await app.evaluate(({ BrowserWindow }) => {
    const preferences = globalThis.railNavigationFixtures["preferences:get"];
    preferences.appearance.lightCursorId = null;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("preferences:changed", preferences);
    }
  });
  await expect(heading).toHaveCount(0);
  await expect(rail.locator('button[aria-current="true"]')).toHaveCount(0);

  // Reorganizing the selected cursor moves its visible owner to the new family.
  await alpha.click();
  await alpha.click();
  await expectSelection("Alpha First");
  await app.evaluate(({ BrowserWindow }) => {
    const packs = globalThis.railNavigationFixtures["cursor:list-themes"];
    packs.find((pack) => pack.id === "alpha-first").family = "Gamma";
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("cursor:library-changed", {
        reason: "test-family-move",
      });
    }
  });
  await expect(
    families.getByRole("button", { name: "Gamma 1", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    families.getByRole("button", { name: "Gamma Alpha First", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expectSelection("Alpha First");

  // Applying keeps one visible busy state even if the user browses elsewhere.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cursor:apply-theme");
    globalThis.pendingApplyTheme = {};
    ipcMain.handle("cursor:apply-theme", (_event, identifier) => {
      globalThis.pendingApplyTheme.identifier = identifier;
      return new Promise((resolve) => {
        globalThis.pendingApplyTheme.resolve = resolve;
      });
    });
  });
  const readyApplyButton = page.getByRole("button", {
    name: "Apply",
    exact: true,
  });
  const readyApplyBounds = await readyApplyButton.boundingBox();
  await readyApplyButton.click();
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.pendingApplyTheme?.identifier ?? null),
    )
    .toBe("alpha-first");
  const applyingButton = page.getByRole("button", {
    name: "Applying\u2026",
    exact: true,
  });
  await expect(applyingButton).toBeDisabled();
  await expect(applyingButton).toHaveAttribute("aria-busy", "true");
  await expect(
    applyingButton.locator('[aria-hidden="true"].animate-spin'),
  ).toHaveCount(1);
  expect((await applyingButton.boundingBox()).width).toBe(
    readyApplyBounds.width,
  );
  await page.screenshot({
    path: test.info().outputPath("apply-progress.png"),
  });
  await beta.click();
  await expectSelection("Beta First");
  await expect(applyingButton).toBeVisible();

  await app.evaluate(() => {
    globalThis.pendingApplyTheme.resolve({
      bridgeAvailable: true,
      supported: true,
      statusAvailable: true,
      previewMode: false,
      desiredEnabled: true,
      effectiveApplied: true,
      effectiveVariantId: "alpha-first",
      selectedVariantId: "alpha-first",
      currentSentinelsMatchTheme: true,
    });
  });
  const idleApplyButton = page.getByRole("button", {
    name: "Apply",
    exact: true,
  });
  await expect(idleApplyButton).toBeEnabled();
  await expect(idleApplyButton).not.toHaveAttribute("aria-busy", "true");
  await expect(
    idleApplyButton.locator('[aria-hidden="true"].animate-spin'),
  ).toHaveCount(0);
  expect((await idleApplyButton.boundingBox()).width).toBe(
    readyApplyBounds.width,
  );
  await shortcuts
    .getByRole("button", {
      name: "Alpha First Gamma",
      exact: true,
    })
    .click();
  await expectSelection("Alpha First");
  const reapplyButton = page.getByRole("button", {
    name: "Reapply",
    exact: true,
  });
  expect((await reapplyButton.boundingBox()).width).toBe(
    readyApplyBounds.width,
  );
  await resizeWindow({ width: 320, height: 560 });
  await expect(reapplyButton).toBeInViewport();
  await expect
    .poll(() =>
      reapplyButton.evaluate(
        (element) => element.getBoundingClientRect().right,
      ),
    )
    .toBeLessThanOrEqual(320);
});
