import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinuxCursorBackend } from "./linux-cursor-backend.js";
import { isVerifiedRestoredStatus } from "./cursor-state-service.js";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "linux-cursor-backend-"),
  );
  directories.push(directory);
  let current = { theme: "User Original", size: 24 };
  const desktop = {
    kind: "hyprland",
    session: "session-one",
    requireSupported() {},
    read: vi.fn(async () => ({ ...current })),
    capture: vi.fn(async () => ({ kind: "hyprland", ...current })),
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
    homeDirectory: directory,
    desktop,
    installTheme,
  };
  const backend = createLinuxCursorBackend(options);
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

describe("Linux cursor state transactions", () => {
  it.each(["--apply-theme", "--reconcile-login-items"])(
    "refuses %s in another desktop before changing its original settings",
    async (command) => {
      const { run, options, desktop, installTheme } = await fixture();
      await run("--apply-theme", "Test");
      const kde = {
        ...desktop,
        kind: "kde",
        session: null,
        matches: vi.fn(async () => false),
        capture: vi.fn(async () => ({
          kind: "kde",
          theme: "breeze_cursors",
          size: 24,
        })),
        apply: vi.fn(),
        restore: vi.fn(),
      };
      const restarted = createLinuxCursorBackend({ ...options, desktop: kde });
      await expect(
        restarted.commandRunner({ command, arguments: ["Test"] }),
      ).rejects.toMatchObject({ code: "LINUX_DESKTOP_CHANGED" });
      expect(kde.capture).not.toHaveBeenCalled();
      expect(kde.apply).not.toHaveBeenCalled();
      expect(kde.restore).not.toHaveBeenCalled();
      expect(installTheme).toHaveBeenCalledTimes(1);
      const originalSession = createLinuxCursorBackend(options);
      await originalSession.commandRunner({ command: "--teardown" });
      expect(desktop.restore).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "hyprland",
          theme: "User Original",
          size: 24,
        }),
      );
    },
  );

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
    const restarted = createLinuxCursorBackend(options);
    await restarted.commandRunner({ command: "--reconcile-login-items" });
    expect(
      await restarted.commandRunner({ command: "--status" }),
    ).toMatchObject({ transactionPending: false, desiredEnabled: false });
  });

  it("reapplies the selected cursor on a new Hyprland session without losing the original snapshot", async () => {
    const { run, desktop, options } = await fixture();
    await run("--apply-theme", "Test");
    desktop.session = "session-two";
    const restarted = createLinuxCursorBackend(options);
    await restarted.commandRunner({ command: "--reconcile-login-items" });
    expect(desktop.apply).toHaveBeenCalledTimes(2);
    await restarted.commandRunner({ command: "--teardown" });
    expect(desktop.restore).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "User Original", size: 24 }),
    );
  });
});
