import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as plist from "plist";
import { expect, it } from "vitest";
import { createLinuxCursorBackend } from "./linux-cursor-backend.js";
import {
  createLinuxCursorDesktop,
  runLinuxCursorCommand,
} from "./linux-cursor-desktop.js";
import { removeLinuxCursorThemes } from "./linux-cursor-theme.js";

// Explicit opt-in: this integration test briefly changes the live desktop cursor
// and restores it in finally. Ordinary unit-test runs never mutate the desktop.
it.skipIf(process.env.CURSOR_LINUX_LIVE_SMOKE !== "1")(
  "applies, resizes, reconciles a Hyprland reload, and restores a real converted theme",
  async () => {
    const resourcePath = path.resolve(
      process.env.CURSOR_LINUX_SMOKE_THEME ||
        "native/oreo/Resources/Themes/OreoWhite.cursor",
    );
    const data = plist.parseBinary(await fs.readFile(resourcePath));
    const theme = {
      identifier: data.Identifier,
      uuid: data.UUID,
      displayName: data.ThemeName,
      resourcePath,
    };
    const stateDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-linux-live-"),
    );
    const iconsDirectory = path.join(os.homedir(), ".icons");
    const initialIcons = await fs.readdir(iconsDirectory).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const runCommand = async (command, args, options) => {
      const result = await runLinuxCursorCommand(command, args, options);
      if (!args.includes("encode-xcursor")) {
        const loggedResult =
          command === "systemctl" && args.includes("show-environment")
            ? JSON.stringify(
                Object.fromEntries(
                  Object.entries(JSON.parse(result)).filter(([key]) =>
                    /^(?:XCURSOR|HYPRCURSOR)_/.test(key),
                  ),
                ),
              )
            : result;
        console.warn(command, JSON.stringify(args), loggedResult);
      }
      return result;
    };
    const desktop = createLinuxCursorDesktop({ runCommand });
    const original = await desktop.capture();
    const backend = createLinuxCursorBackend({
      stateDirectory,
      getThemes: () => [theme],
      desktop,
      runCommand,
      encoderExecutable: path.resolve(
        "native/cursor-packs/build/curated-converter/curated-cursor-converter/curated-cursor-converter",
      ),
    });
    const run = (command, ...args) =>
      backend.commandRunner({ command, arguments: args });
    try {
      expect(await run("--validate-theme", theme.identifier)).toMatchObject({
        valid: true,
      });
      expect(await run("--apply-theme", theme.identifier)).toMatchObject({
        currentSentinelsMatchTheme: true,
        desiredEnabled: true,
      });
      await run("--set-theme-size", theme.identifier, "125");
      expect(await run("--apply-theme", theme.identifier)).toMatchObject({
        currentSentinelsMatchTheme: true,
        themeSizePercentage: 125,
      });
      if (desktop.kind === "hyprland") {
        if (original.activationEnvironment) {
          const launchedEnvironment = JSON.parse(
            await runCommand("systemd-run", [
              "--user",
              "--quiet",
              "--wait",
              "--pipe",
              "--collect",
              "/usr/bin/python3",
              "-c",
              'import os,json; print(json.dumps({k:os.environ.get(k) for k in ("XCURSOR_THEME","XCURSOR_SIZE","HYPRCURSOR_THEME","HYPRCURSOR_SIZE")}))',
            ]),
          );
          expect(launchedEnvironment).toMatchObject({
            XCURSOR_SIZE: "40",
            HYPRCURSOR_SIZE: "40",
          });
          expect(launchedEnvironment.XCURSOR_THEME).toMatch(
            /^cursor-atelier-.*-125$/,
          );
          expect(launchedEnvironment.HYPRCURSOR_THEME).toBe(
            launchedEnvironment.XCURSOR_THEME,
          );
        }
        await runCommand("hyprctl", ["reload"]);
        expect(await run("--status")).toMatchObject({
          currentSentinelsMatchTheme: false,
        });
        expect(await run("--reconcile-login-items")).toMatchObject({
          currentSentinelsMatchTheme: true,
        });
      }
      expect(await run("--teardown")).toMatchObject({
        desiredEnabled: false,
        effectiveApplied: false,
      });
      expect(await desktop.capture()).toEqual(original);
    } finally {
      await desktop.restore(original);
      await removeLinuxCursorThemes({
        iconsDirectory,
        identifier: theme.identifier,
        keepNames: initialIcons,
      });
      await fs.rm(stateDirectory, { recursive: true, force: true });
    }
  },
  120_000,
);
