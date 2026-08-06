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
    ).toBeVisible();
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

  test("renders the split-pane shell and switches appearance modes", async ({
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
  });

  test("filters the catalogue by family and variant", async ({
    cursorPage: page,
  }) => {
    const search = page.getByRole("textbox", { name: "Search cursor packs" });
    await search.fill("Moga Neon");

    await expect(
      page.getByRole("option", { name: /^Moga Neon/ }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /^Moga Classic/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Neon" })).toBeVisible();
    await expect(page.getByText("Moga", { exact: true }).last()).toBeVisible();
  });

  test("uses one tab stop and arrow-key navigation for the pack list", async ({
    cursorPage: page,
  }) => {
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThan(20);
    expect(
      await options.evaluateAll(
        (entries) => entries.filter((entry) => entry.tabIndex === 0).length,
      ),
    ).toBe(1);

    await options.first().focus();
    await options.first().press("ArrowDown");
    await expect(options.nth(1)).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");

    await options.nth(1).press("End");
    await expect(options.last()).toBeFocused();
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    expect(
      await options.evaluateAll(
        (entries) => entries.filter((entry) => entry.tabIndex === 0).length,
      ),
    ).toBe(1);
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
    await drawer
      .getByRole("textbox", { name: "Search cursor packs" })
      .fill("Moga Neon");
    await drawer
      .getByRole("option", { name: /^Moga Neon/ })
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
  });

  test("keeps the document fixed while both panes remain user-scrollable", async ({
    cursorPage: page,
  }) => {
    await page.setViewportSize({ width: 800, height: 360 });

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
    await page.getByRole("option", { name: /^Oreo Blue/ }).click();

    await expect(page.getByText("In use", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toHaveCount(0);

    const status = await page.evaluate(() =>
      window.electronAPI.getCursorStatus(),
    );
    expect(status).toMatchObject({
      selectedVariantId: null,
      effectiveVariantId: null,
      effectiveApplied: false,
    });
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
