import { test as base, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packagedOutput = path.join(projectRoot, "out");

function packList(scope) {
  return scope.getByRole("navigation", { name: "Cursor packs" });
}

function packButtons(scope) {
  return packList(scope).locator("button[data-pack-option]");
}

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

async function launchCursorAtelier() {
  const asarPath = findPackagedAsar();
  const environment = { ...process.env };
  delete environment.CURSOR_NATIVE_BRIDGE;
  delete environment.CURSOR_PACK_MANIFEST;
  const userDataDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cursor-atelier-e2e-"),
  );
  environment.HOME = userDataDirectory;
  environment.CFFIXED_USER_HOME = userDataDirectory;
  // Launching the renderer archive directly gives it Electron's temporary
  // resources directory rather than the packaged native bundle. The bridge
  // therefore stays unavailable and these UI checks cannot mutate the system.
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDirectory}`, asarPath],
    cwd: os.tmpdir(),
    env: environment,
  });

  return {
    app,
    async cleanup() {
      await app.close();
      await fs.promises.rm(userDataDirectory, { recursive: true, force: true });
    },
  };
}

const test = base.extend({
  cursorApp: async ({ browserName: _browserName }, use) => {
    const launch = await launchCursorAtelier();
    try {
      await use(launch.app);
    } finally {
      await launch.cleanup();
    }
  },
  cursorPage: async ({ cursorApp }, use) => {
    const page = await cursorApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveTitle("Cursor Atelier");
    await expect(
      page.getByRole("heading", { name: "Cursor Atelier", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
    await use(page);
  },
});

test.describe("Cursor Atelier packaged app", () => {
  test.skip(
    process.platform !== "darwin",
    "The production cursor manager is a macOS app; run this suite on macOS.",
  );

  test("renders the split-pane shell and switches appearance modes in Settings", async ({
    cursorPage: page,
  }) => {
    await expect(page.getByText("Cursor packs", { exact: true })).toBeVisible();
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
      page.getByRole("button", { name: "Appearance", exact: true }),
    ).toHaveCount(0);
    for (const label of ["Light", "System", "Dark"]) {
      await expect(page.getByRole("radio", { name: label })).toBeVisible();
    }

    const dark = page.getByRole("radio", { name: "Dark" });
    await dark.click();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Restore the default so this test remains friendly to local runs even if
    // the app's persisted user-data directory behavior changes in the future.
    await page.getByRole("radio", { name: "System" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
  });

  test("filters the catalogue by family and variant", async ({
    cursorPage: page,
  }) => {
    const search = page.getByRole("textbox", { name: "Search cursor packs" });
    await search.fill("Moga Neon");

    await expect(
      packList(page)
        .getByRole("button", { name: /^Moga Neon/ })
        .first(),
    ).toBeVisible();
    await expect(
      packList(page).getByRole("button", { name: /^Moga Classic/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Neon" })).toBeVisible();
    await expect(page.getByText("Moga", { exact: true }).last()).toBeVisible();
  });

  test("dismisses tooltips as soon as the pointer leaves their trigger", async ({
    cursorPage: page,
  }) => {
    const trigger = page.getByRole("button", { name: "About cursor imports" });
    const triggerBounds = await trigger.boundingBox();
    expect(triggerBounds).not.toBeNull();

    // This top-bar tooltip collision-flips below its trigger. Approach from
    // that side and stop just inside the trigger, where a hit-testable popup
    // would steal hover and immediately close itself.
    const triggerCenterX = triggerBounds.x + triggerBounds.width / 2;
    await page.mouse.move(triggerCenterX, triggerBounds.y + 100);
    await page.mouse.move(
      triggerCenterX,
      triggerBounds.y + triggerBounds.height - 1,
      { steps: 12 },
    );
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText(
      "If an import looks soft, try the author's github repo for the original SVG source instead of theme aggregators like pling.com, gnome-look.org, or opendesktop.org.",
    );
    await expect(tooltip).toHaveAttribute("data-side", "bottom");
    await page.waitForTimeout(150);
    await expect(tooltip).toBeVisible();
    await expect
      .poll(() => trigger.evaluate((element) => element.matches(":hover")))
      .toBe(true);

    const bounds = await tooltip.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(tooltip).toBeHidden();

    // The unavailable action remains focusable as aria-disabled so keyboard
    // users can discover the explanation without activating it.
    const restoreButton = page.getByRole("button", {
      name: "Restore",
      exact: true,
    });
    await restoreButton.focus();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Restore the cursor macOS was using before Cursor Atelier",
    );
  });

  test("uses one tab stop and arrow-key navigation for the pack list", async ({
    cursorPage: page,
  }) => {
    const firstFamily = packList(page).locator("button[aria-expanded]").first();
    await expect(firstFamily).toHaveAttribute("aria-expanded", "false");
    await expect(packButtons(page)).toHaveCount(0);
    await firstFamily.click();
    await expect(firstFamily).toHaveAttribute("aria-expanded", "true");

    const options = packButtons(page);
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThan(1);
    expect(
      await options.evaluateAll(
        (entries) => entries.filter((entry) => entry.tabIndex === 0).length,
      ),
    ).toBe(1);

    await options.first().focus();
    await options.first().press("ArrowDown");
    await expect(options.nth(1)).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute("aria-current", "true");

    await options.nth(1).press("End");
    await expect(options.last()).toBeFocused();
    await expect(options.last()).toHaveAttribute("aria-current", "true");
    expect(
      await options.evaluateAll(
        (entries) => entries.filter((entry) => entry.tabIndex === 0).length,
      ),
    ).toBe(1);
  });

  test("shows separate ordered light and dark randomization pools", async ({
    cursorPage: page,
  }) => {
    for (const appearance of ["Light", "Dark"]) {
      await expect(
        page.getByRole("region", {
          name: `${appearance} mode randomization pool`,
        }),
      ).toContainText("All from source");
    }

    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        randomization: {
          pools: {
            light: ["OreoBlack", "OreoBlue"],
            dark: ["OreoBlue", "OreoBlack"],
          },
        },
      }),
    );

    const lightPool = page.getByRole("region", {
      name: "Light mode randomization pool",
    });
    const darkPool = page.getByRole("region", {
      name: "Dark mode randomization pool",
    });
    await expect(lightPool).toBeVisible();
    await expect(darkPool).toBeVisible();

    const poolIds = async (name) =>
      page
        .getByRole("list", { name })
        .getByRole("listitem")
        .evaluateAll((items) => items.map((item) => item.dataset.poolCursorId));
    await expect
      .poll(() => poolIds("Light mode cursor pool"))
      .toEqual(["OreoBlack", "OreoBlue"]);
    await expect
      .poll(() => poolIds("Dark mode cursor pool"))
      .toEqual(["OreoBlue", "OreoBlack"]);

    const firstLightCursor = page
      .getByRole("list", { name: "Light mode cursor pool" })
      .getByRole("button")
      .first();
    await firstLightCursor.focus();
    await firstLightCursor.press("Enter");
    await expect(page.getByRole("heading", { name: "Black" })).toBeVisible();

    const darkTrigger = darkPool.getByRole("button", {
      name: /Dark mode 2/,
    });
    await darkTrigger.focus();
    await darkTrigger.press("Enter");
    await expect(darkTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("list", { name: "Dark mode cursor pool" }),
    ).toBeHidden();
  });

  test("uses the pack drawer at the supported minimum window width", async ({
    cursorPage: page,
  }) => {
    await page.setViewportSize({ width: 760, height: 560 });

    await expect(page.locator("aside")).toBeHidden();
    await expect(page.getByRole("button", { name: "Packs" })).toBeVisible();
    await page.getByRole("button", { name: "Packs" }).click();

    const drawer = page.getByRole("dialog", {
      name: "Choose a cursor pack",
    });
    await expect(drawer).toBeVisible();
    await drawer
      .getByRole("textbox", { name: "Search cursor packs" })
      .fill("Moga Neon");
    await packList(drawer)
      .getByRole("button", { name: /^Moga Neon/ })
      .first()
      .click();

    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { name: "Neon" })).toBeVisible();
    const bounds = await page.evaluate(() => ({
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }));
    expect(bounds.bodyClientHeight).toBe(bounds.viewportHeight);
    expect(bounds.bodyScrollHeight).toBe(bounds.bodyClientHeight);
    expect(bounds.bodyClientWidth).toBe(bounds.viewportWidth);
    expect(bounds.bodyScrollWidth).toBe(bounds.bodyClientWidth);

    await page.setViewportSize({ width: 959, height: 560 });
    await expect(page.locator("aside")).toBeHidden();
    await expect(page.getByRole("button", { name: "Packs" })).toBeVisible();

    await page.setViewportSize({ width: 960, height: 560 });
    await expect(page.locator("aside")).toBeVisible();
    await expect(page.getByRole("button", { name: "Packs" })).toBeHidden();
  });

  test("keeps the document fixed while both panes remain user-scrollable", async ({
    cursorPage: page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 360 });

    const detail = page.getByTestId("detail-scroll");
    const rail = page.getByTestId("pack-rail-scroll");
    for (const pane of [detail, rail]) {
      const dimensions = await pane.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

      await pane.hover();
      await page.mouse.wheel(0, 1_000);
      await expect
        .poll(() => pane.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }

    const documentBounds = await page.evaluate(() => ({
      clientHeight: document.body.clientHeight,
      scrollHeight: document.body.scrollHeight,
      clientWidth: document.body.clientWidth,
      scrollWidth: document.body.scrollWidth,
    }));
    expect(documentBounds.scrollHeight).toBe(documentBounds.clientHeight);
    expect(documentBounds.scrollWidth).toBe(documentBounds.clientWidth);
  });

  test("exposes a safe preview-mode status through the preload bridge", async ({
    cursorPage: page,
  }) => {
    const status = await page.evaluate(() =>
      window.electronAPI.getCursorStatus(),
    );
    expect(status).toMatchObject({
      previewMode: true,
      bridgeAvailable: false,
      effectiveVariantId: null,
    });

    const themes = await page.evaluate(() =>
      window.electronAPI.listCursorThemes(),
    );
    expect(themes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nativeThemeId: "OreoBlue" }),
      ]),
    );
  });

  test("does not present preview-only selection as a live cursor", async ({
    cursorPage: page,
  }) => {
    await page
      .getByRole("textbox", { name: "Search cursor packs" })
      .fill("Oreo Blue");
    await packList(page)
      .getByRole("button", { name: /^Oreo Blue/ })
      .click();

    await expect(page.getByText("In use", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Source" })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Set Blue as the default light mode cursor",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: "Set Blue as the default dark mode cursor",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Randomization…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");

    const status = await page.evaluate(() =>
      window.electronAPI.getCursorStatus(),
    );
    expect(status).toMatchObject({
      selectedVariantId: null,
      effectiveVariantId: null,
      effectiveApplied: false,
    });
  });

  test("labels configured defaults separately from the live cursor", async ({
    cursorPage: page,
  }) => {
    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        appearance: { lightCursorId: "OreoBlue" },
      }),
    );

    await expect(page.getByText("Defaults", { exact: true })).toBeVisible();
    await expect(page.getByText("Current", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Light · Oreo", { exact: true })).toBeVisible();
  });

  test("persists a cursor favorite and exposes the focused settings screen", async ({
    cursorApp,
    cursorPage: page,
  }) => {
    const search = page.getByRole("textbox", { name: "Search cursor packs" });
    await search.fill("Oreo Blue");
    await packList(page)
      .getByRole("button", { name: /^Oreo Blue/ })
      .click();

    await page.getByRole("button", { name: "Add to Favorites" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return preferences.favorites.cursorIds.includes("OreoBlue");
        }),
      )
      .toBe(true);
    await expect(page.getByText("Favorites", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove from Favorites" }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByText("Favorites", { exact: true })).toBeVisible();

    const settingsAccelerator = await cursorApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("settings");
      item?.click();
      return item?.accelerator ?? null;
    });
    expect(settingsAccelerator).toBe("CommandOrControl+,");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    const appearanceSwitch = page.getByRole("switch", {
      name: "Switch Cursors with System Appearance",
    });
    await expect(appearanceSwitch).toBeVisible();
    await expect(appearanceSwitch).not.toBeChecked();
    await appearanceSwitch.click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return preferences.appearance.automaticSwitching;
        }),
      )
      .toBe(true);
    const menuBarSwitch = page.getByRole("switch", {
      name: "Show in Menu Bar",
    });
    await expect(menuBarSwitch).toBeVisible();
    await expect(menuBarSwitch).toBeChecked();
    await menuBarSwitch.click();
    await expect(menuBarSwitch).not.toBeChecked();
    await expect(appearanceSwitch).toBeChecked();
    await expect(
      page.getByRole("switch", { name: "Show in Dock" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Randomize Now", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#random-source")).toHaveText(
      "Light & Dark Pools",
    );
    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        randomization: { schedule: { mode: "interval" } },
      }),
    );
    const interval = page.locator("#random-interval");
    await expect(interval).toHaveValue("1");
    await interval.fill("5");
    await interval.press("Escape");
    await expect(interval).toHaveValue("1");
    await interval.fill("");
    await interval.blur();
    await expect(interval).toHaveValue("");
    await expect(page.getByText("Enter 0.25–720 hours.")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return preferences.randomization.schedule.intervalHours;
        }),
      )
      .toBe(1);
    await interval.press("Escape");

    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        randomization: { schedule: { mode: "daily" } },
      }),
    );
    const dailyTime = page.locator("#random-daily-time");
    await expect(dailyTime).toHaveValue("09:00");
    await dailyTime.fill("18:30");
    await dailyTime.press("Escape");
    await expect(dailyTime).toHaveValue("09:00");
    await dailyTime.fill("");
    await dailyTime.blur();
    await expect(dailyTime).toHaveValue("");
    await expect(page.getByText("Enter a valid time.")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return preferences.randomization.schedule.dailyTime;
        }),
      )
      .toBe("09:00");
    await dailyTime.press("Escape");

    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        randomization: {
          schedule: { mode: "times", times: ["09:00", "17:00"] },
        },
      }),
    );
    const firstTime = page.getByLabel("Random cursor time 1");
    const secondTime = page.getByLabel("Random cursor time 2");
    await secondTime.fill("09:00");
    await secondTime.blur();
    await expect(secondTime).toHaveValue("09:00");
    await expect(page.getByText("Times must be unique.")).toBeVisible();
    await secondTime.press("Escape");
    await expect(firstTime).toHaveValue("09:00");
    await expect(secondTime).toHaveValue("17:00");
    await page.getByRole("button", { name: "Add Time", exact: true }).click();
    const thirdTime = page.getByLabel("Random cursor time 3");
    await expect(thirdTime).toHaveValue("17:15");
    await expect(thirdTime).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const preferences = await window.electronAPI.getCursorPreferences();
          return preferences.randomization.schedule.times;
        }),
      )
      .toEqual(["09:00", "17:00", "17:15"]);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Cursor packs", { exact: true })).toBeVisible();
  });

  test("stays resident without a menu bar item when appearance switching is enabled", async ({
    cursorApp,
    cursorPage: page,
  }) => {
    await page.evaluate(() =>
      window.electronAPI.updateCursorPreferences({
        appearance: { automaticSwitching: true },
        menuBar: { visible: false },
      }),
    );
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
    await expect
      .poll(() =>
        cursorApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(0);

    const reopenedWindow = cursorApp.waitForEvent("window");
    await cursorApp.evaluate(({ app }) => app.emit("activate"));
    const reopenedPage = await reopenedWindow;
    await reopenedPage.waitForLoadState("domcontentloaded");
    await expect(reopenedPage).toHaveTitle("Cursor Atelier");
    await expect(
      reopenedPage.getByText("Cursor packs", { exact: true }),
    ).toBeVisible();
  });

  test("keeps every requested external family visible but non-mutating", async ({
    cursorPage: page,
  }) => {
    const requestedFamilies = [
      "Remus",
      "Drop",
      "Moga Classic",
      "Moga Candy",
      "Moga Colors",
      "Moga Neon",
      "Moga Light",
      "Volantes",
      "Vimix",
      "Qogir",
      "Bibata Extra",
      "Google",
      "Simp1e",
      "Capitaine",
      "Future",
      "Nordzy",
      "Colloid",
      "Bibata",
    ];

    const themes = await page.evaluate(() =>
      window.electronAPI.listCursorThemes(),
    );

    for (const family of requestedFamilies) {
      expect(
        themes.some((theme) =>
          `${theme.Group ?? theme.family ?? ""} ${theme.DisplayName ?? theme.displayName ?? ""}`.includes(
            family,
          ),
        ),
        `${family} should be in the generated catalogue`,
      ).toBe(true);
    }

    expect(themes.every((theme) => theme.canApply === false)).toBe(true);
  });
});
