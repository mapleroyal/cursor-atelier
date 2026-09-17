import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createLinuxCursorBackend } from "./linux-cursor-backend.js";
import { createLinuxCursorDesktop } from "./linux-cursor-desktop.js";
import { createLinuxCursorReconciler } from "./linux-cursor-reconciler.js";

it("recovers a directly selected cursor after reload races without shrinking it or losing Restore", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-reload-"));
  const gtk = { "cursor-theme": "'default'", "cursor-size": "24" };
  const live = {
    XCURSOR_THEME: "default",
    XCURSOR_SIZE: "24",
    HYPRCURSOR_THEME: "default",
    HYPRCURSOR_SIZE: "24",
  };
  const manager = { ...live };
  const appliedSizes = [];
  let reloadDuringApply = false;
  const reload = () => {
    live.XCURSOR_SIZE = live.HYPRCURSOR_SIZE = "24";
  };
  const runCommand = async (program, args) => {
    if (program === "gsettings") {
      if (args[0] === "get") {
        return gtk[args[2]];
      }
      gtk[args[2]] = args[3];
      if (args[2] === "cursor-theme" && reloadDuringApply) {
        reloadDuringApply = false;
        reload();
      }
      return "";
    }
    if (program === "hyprctl") {
      if (args[0] === "repl") {
        return Object.entries(live)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n");
      }
      if (args[0] === "eval") {
        for (const match of args[1].matchAll(
          /hl.env\("([A-Z_]+)", "([^"]*)"\)/g,
        )) {
          live[match[1]] = match[2];
        }
      }
      if (args[0] === "setcursor") {
        appliedSizes.push(Number(args[2]));
      }
      return "ok";
    }
    if (program === "systemctl") {
      if (args[1] === "show-environment") {
        return JSON.stringify(manager);
      }
      for (const pair of args.slice(2)) {
        const [key, ...value] = pair.split("=");
        manager[key] = value.join("=");
      }
      return "";
    }
    throw new Error(`Unexpected command: ${program}`);
  };
  const desktop = createLinuxCursorDesktop({
    env: { HYPRLAND_INSTANCE_SIGNATURE: "private" },
    systemdUserManager: true,
    runCommand,
  });
  const backend = createLinuxCursorBackend({
    stateDirectory: directory,
    desktop,
    getThemes: () => [
      {
        identifier: "Test",
        displayName: "Test",
        resourcePath: "/fixture.cursor",
      },
    ],
    installTheme: async () => ({ name: "generated-test", size: 32 }),
  });
  const run = (command, ...args) =>
    backend.commandRunner({ command, arguments: args });
  const onReconciled = vi.fn();
  const onError = vi.fn();
  const attempts = [];
  const reconciler = createLinuxCursorReconciler({
    env: {},
    settleDelayMs: 1,
    retryDelaysMs: [1, 1],
    onReconciled,
    onError,
    reconcile: async () => {
      try {
        const status = await run("--reconcile-login-items");
        attempts.push("ok");
        return status;
      } catch (error) {
        attempts.push(error.message);
        throw error;
      }
    },
  });
  try {
    await run("--apply-theme", "Test");
    reload();
    reloadDuringApply = true;
    reconciler.request();
    await expect.poll(() => onReconciled.mock.calls.length).toBe(1);
    expect(attempts).toEqual([
      "The desktop did not retain the requested cursor settings.",
      "ok",
    ]);
    expect(appliedSizes).toEqual([32, 32, 32]);
    expect(live.XCURSOR_SIZE).toBe("32");
    expect(live.HYPRCURSOR_SIZE).toBe("32");
    expect(await run("--status")).toMatchObject({
      currentSentinelsMatchTheme: true,
      actionError: null,
      desiredEnabled: true,
    });
    expect(onError).not.toHaveBeenCalled();

    // A later monitor/config reload remains recoverable, without an appearance
    // assignment or a theme switch to restart the app.
    reload();
    reconciler.request();
    await expect.poll(() => onReconciled.mock.calls.length).toBe(2);
    expect(appliedSizes.at(-1)).toBe(32);
    await run("--teardown");
    expect(appliedSizes.at(-1)).toBe(24);
    expect(gtk).toEqual({ "cursor-theme": "'default'", "cursor-size": "24" });
    reconciler.request();
    await expect.poll(() => onReconciled.mock.calls.length).toBe(3);
    expect(appliedSizes.at(-1)).toBe(24);
    expect(await run("--status")).toMatchObject({
      desiredEnabled: false,
      actionError: null,
    });
  } finally {
    reconciler.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
