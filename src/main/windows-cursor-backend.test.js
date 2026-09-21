import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowsCursorBackend } from "./windows-cursor-backend.js";
import { WINDOWS_CURSOR_ROLES } from "./windows-cursor-theme.js";
import { isVerifiedRestoredStatus } from "./cursor-state-service.js";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "windows-cursor-backend-"),
  );
  directories.push(directory);
  let current = { theme: "User Original", size: 24 };
  const desktop = {
    kind: "windows",
    session: 1,
    requireSupported() {},
    read: vi.fn(async () => ({ ...current, supported: true, cursorSize: 32 })),
    capture: vi.fn(async () => ({
      kind: "windows",
      session: desktop.session,
      cursorSize: 32,
      values: [...Object.keys(WINDOWS_CURSOR_ROLES), "", "Scheme Source"].map(
        (name) => ({ name, exists: false, kind: null, value: null }),
      ),
      sizes: Object.fromEntries(
        Object.keys(WINDOWS_CURSOR_ROLES).map((name) => [name, current.size]),
      ),
      fingerprints: Object.fromEntries(
        ["Arrow", "IBeam", "Hand"].map((name) => [
          name,
          `32:32:0:0:${Buffer.alloc(32).toString("base64")}`,
        ]),
      ),
      ...current,
    })),
    apply: vi.fn(async ({ name, size }) => {
      current = { theme: name, size };
    }),
    restore: vi.fn(async ({ theme, size }) => {
      current = { theme, size };
    }),
    matches: vi.fn(
      async ({ name, size, session }) =>
        current.theme === name &&
        current.size === size &&
        (!session || session === desktop.session),
    ),
  };
  const installTheme = vi.fn(async ({ theme, sizePercentage }) => ({
    name: `generated-${theme.identifier}-${sizePercentage}`,
    size: Math.round((32 * sizePercentage) / 100),
    directory: path.join(directory, "generated"),
    files: Object.fromEntries(
      Object.keys(WINDOWS_CURSOR_ROLES).map((name) => [
        name,
        path.join(directory, "generated", `${name}.cur`),
      ]),
    ),
  }));
  const options = {
    getThemes: () => [
      {
        identifier: "Test",
        displayName: "Test",
        resourcePath: "/unused/Test.cursor",
      },
    ],
    stateDirectory: path.join(directory, "state"),
    verifyInstalledTheme: vi.fn(async () => ({})),
    readTheme: vi.fn(async () => ({})),
    removeThemes: vi.fn(async () => {}),
    desktop,
    installTheme,
  };
  const backend = createWindowsCursorBackend(options);
  const run = (command, ...args) =>
    backend.commandRunner({ command, arguments: args });
  return {
    directory,
    options,
    desktop,
    installTheme,
    run,
    current: () => current,
  };
}

describe("Windows cursor state transactions", () => {
  it("preserves the original cursor across multiple applies and saves size until reapplied", async () => {
    const { run, current, installTheme } = await fixture();
    await run("--apply-theme", "Test");
    await run("--set-theme-size", "Test", "125");
    expect(installTheme).toHaveBeenCalledTimes(1);
    expect(current()).toEqual({ theme: "generated-Test-100", size: 32 });
    await run("--apply-theme", "Test");
    expect(current()).toEqual({ theme: "generated-Test-125", size: 40 });
    expect(await run("--status")).toMatchObject({
      currentSentinelsMatchTheme: true,
      desiredEnabled: true,
    });
    const restored = await run("--teardown");
    expect(
      isVerifiedRestoredStatus({
        ...restored,
        bridgeAvailable: true,
        previewMode: false,
        statusAvailable: true,
        persistedEffectiveApplied: restored.effectiveApplied,
      }),
    ).toBe(true);
    expect(current()).toEqual({ theme: "User Original", size: 24 });
    expect(await run("--portable-preferences")).toMatchObject({
      selectedThemeIdentifier: "Test",
      themeSizePercentages: { Test: 125 },
    });
  });

  it("rolls back desktop changes and preferences when activation fails", async () => {
    const { run, desktop, current } = await fixture();
    desktop.apply.mockImplementationOnce(async () => {
      throw new Error("Compositor disconnected");
    });
    await expect(run("--apply-theme", "Test")).rejects.toThrow(
      "Compositor disconnected",
    );
    expect(current()).toEqual({ theme: "User Original", size: 24 });
    expect(await run("--status")).toMatchObject({
      desiredEnabled: false,
      transactionPending: false,
      effectiveApplied: false,
    });
  });

  it("retains and recovers the journal after failed rollback across process restart", async () => {
    const { run, desktop, options } = await fixture();
    desktop.apply.mockRejectedValueOnce(new Error("Activation failed"));
    desktop.restore.mockRejectedValueOnce(new Error("Session unavailable"));
    await expect(run("--apply-theme", "Test")).rejects.toThrow(
      "could not be fully restored",
    );
    expect(await run("--status")).toMatchObject({ transactionPending: true });
    const restarted = createWindowsCursorBackend(options);
    await restarted.commandRunner({ command: "--reconcile-login-items" });
    expect(
      await restarted.commandRunner({ command: "--status" }),
    ).toMatchObject({ transactionPending: false, desiredEnabled: false });
  });

  it("reapplies the selected cursor on a new Windows session without losing the original snapshot", async () => {
    const { run, desktop, options } = await fixture();
    await run("--apply-theme", "Test");
    desktop.session = 2;
    const restarted = createWindowsCursorBackend(options);
    await restarted.commandRunner({ command: "--reconcile-login-items" });
    expect(desktop.apply).toHaveBeenCalledTimes(2);
    await restarted.commandRunner({ command: "--teardown" });
    expect(desktop.restore).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "User Original", size: 24 }),
    );
  });
  it("keeps imported portable preferences inactive and rejects replacement while applied", async () => {
    const { run, options, desktop } = await fixture();
    const portable = {
      schemaVersion: 1,
      selectedThemeIdentifier: "Test",
      themeSizePercentages: { Test: 175 },
    };
    await run("--replace-portable-preferences", JSON.stringify(portable));
    expect(desktop.apply).not.toHaveBeenCalled();
    expect(await run("--portable-preferences")).toEqual(portable);
    await run("--apply-theme", "Test");
    await expect(
      run("--replace-portable-preferences", JSON.stringify(portable)),
    ).rejects.toThrow("Restore");
    await run("--reset-preferences");
    expect(options.removeThemes).toHaveBeenCalled();
    expect(await run("--status")).toMatchObject({
      desiredEnabled: false,
      effectiveApplied: false,
      selectedThemeIdentifier: "",
    });
  });

  it("does not report a configured scheme as live when native sentinel checks disagree", async () => {
    const { run, desktop } = await fixture();
    await run("--apply-theme", "Test");
    desktop.matches.mockResolvedValue(false);
    expect(await run("--status")).toMatchObject({
      desiredEnabled: true,
      effectiveApplied: true,
      currentSentinelsMatchTheme: false,
    });
    desktop.read.mockResolvedValue({ supported: false, cursorSize: 32 });
    expect(await run("--status")).toMatchObject({ supported: false });
  });
});

describe("Windows cursor persisted metadata", () => {
  it.each([
    null,
    {},
    {
      schemaVersion: 1,
      selectedThemeIdentifier: null,
      themeSizePercentages: {},
      desiredEnabled: false,
    },
  ])(
    "rejects incomplete state %j before reading the desktop",
    async (state) => {
      const { options, desktop } = await fixture();
      await fs.mkdir(options.stateDirectory);
      await fs.writeFile(
        path.join(options.stateDirectory, "state.json"),
        JSON.stringify(state),
      );
      const restarted = createWindowsCursorBackend(options);
      await expect(
        restarted.commandRunner({ command: "--reconcile-login-items" }),
      ).rejects.toThrow(/invalid/);
      expect(desktop.read).not.toHaveBeenCalled();
      expect(desktop.restore).not.toHaveBeenCalled();
    },
  );

  it.each(["hard link", "symbolic link"])(
    "rejects a state file replaced with a %s before reading the desktop",
    async (linkType) => {
      const { run, directory, desktop, options } = await fixture();
      await run("--select-theme", "Test");
      const statePath = path.join(options.stateDirectory, "state.json");
      const backingPath = path.join(directory, "linked-state.json");
      await fs.rename(statePath, backingPath);
      const contents = await fs.readFile(backingPath, "utf8");
      if (linkType === "hard link") {
        await fs.link(backingPath, statePath);
      } else {
        await fs.symlink(backingPath, statePath, "file");
      }
      desktop.read.mockClear();
      const restarted = createWindowsCursorBackend(options);
      await expect(
        restarted.commandRunner({ command: "--reconcile-login-items" }),
      ).rejects.toThrow("state file is unsafe");
      expect(desktop.read).not.toHaveBeenCalled();
      expect(desktop.restore).not.toHaveBeenCalled();
      expect(await fs.readFile(backingPath, "utf8")).toBe(contents);
    },
  );

  it.each([
    [
      "missing previous state",
      (journal) => {
        journal.previousState = null;
      },
    ],
    [
      "invalid preferences",
      (journal) => {
        journal.previousState.themeSizePercentages.Test = 0;
      },
    ],
    [
      "invalid enabled flag",
      (journal) => {
        journal.previousState.desiredEnabled = "yes";
      },
    ],
    [
      "invalid applied theme",
      (journal) => {
        journal.previousState.effectiveTheme.files = {};
      },
    ],
    [
      "damaged original snapshot",
      (journal) => {
        journal.previousState.desktopSnapshot.fingerprints = {};
      },
    ],
    [
      "nested journal",
      (journal) => {
        journal.previousState.transaction = {};
      },
    ],
    [
      "damaged recovery snapshot",
      (journal) => {
        journal.snapshot.values.pop();
      },
    ],
  ])("rejects a journal with %s before restoration", async (_, damage) => {
    const { run, desktop, options } = await fixture();
    await run("--apply-theme", "Test");
    desktop.apply.mockRejectedValueOnce(new Error("Activation failed"));
    desktop.restore.mockRejectedValueOnce(new Error("Session unavailable"));
    await expect(run("--apply-theme", "Test")).rejects.toThrow(
      "could not be fully restored",
    );
    const statePath = path.join(options.stateDirectory, "state.json");
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    damage(persisted.transaction);
    const damaged = JSON.stringify(persisted);
    await fs.writeFile(statePath, damaged);
    desktop.restore.mockClear();
    desktop.apply.mockClear();
    desktop.read.mockClear();
    const restarted = createWindowsCursorBackend(options);
    await expect(
      restarted.commandRunner({ command: "--reconcile-login-items" }),
    ).rejects.toThrow(/invalid/);
    expect(desktop.restore).not.toHaveBeenCalled();
    expect(desktop.apply).not.toHaveBeenCalled();
    expect(desktop.read).not.toHaveBeenCalled();
    expect(await fs.readFile(statePath, "utf8")).toBe(damaged);
  });
});
