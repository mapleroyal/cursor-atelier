import { describe, expect, it, vi } from "vitest";
import { createLinuxCursorDesktop } from "./linux-cursor-desktop.js";

describe("Linux desktop integration", () => {
  it("uses GNOME's cursor-only settings and restores the exact prior values", async () => {
    const values = { "cursor-theme": "'User Theme'", "cursor-size": "24" };
    const runCommand = vi.fn(async (command, args) => {
      expect(command).toBe("gsettings");
      if (args[0] === "get") {
        return values[args[2]];
      }
      values[args[2]] = args[3];
      return "";
    });
    const desktop = createLinuxCursorDesktop({
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      runCommand,
    });
    const snapshot = await desktop.capture();
    await desktop.apply({ name: "generated-test", size: 40 });
    expect(values).toEqual({
      "cursor-theme": "'generated-test'",
      "cursor-size": "40",
    });
    await desktop.restore(snapshot);
    expect(values).toEqual({
      "cursor-theme": "'User Theme'",
      "cursor-size": "24",
    });
  });

  it("reads Hyprland's live environment instead of the app's inherited values", async () => {
    const runCommand = vi.fn(async (command, args) => {
      if (command === "gsettings") {
        return args[2] === "cursor-theme" ? "'Gtk Original'" : "24";
      }
      if (args[0] === "repl") {
        if (args[1].includes("omarchy_startup_cursor_pending")) {
          return "false";
        }
        return "XCURSOR_THEME=Live Xcursor\nXCURSOR_SIZE=36\nHYPRCURSOR_THEME=Live Hyprcursor\nHYPRCURSOR_SIZE=48";
      }
      throw new Error("Unexpected mutation");
    });
    const desktop = createLinuxCursorDesktop({
      env: {
        XDG_CURRENT_DESKTOP: "Hyprland",
        XCURSOR_THEME: "Stale inherited",
        HYPRLAND_INSTANCE_SIGNATURE: "session",
      },
      runCommand,
    });
    expect(await desktop.capture()).toMatchObject({
      compositorTheme: "Live Hyprcursor",
      compositorSize: 48,
      cursorEnvironment: { XCURSOR_THEME: "Live Xcursor", XCURSOR_SIZE: "36" },
    });
    expect(
      await desktop.matches({
        name: "Gtk Original",
        size: 24,
        session: "session",
      }),
    ).toBe(false);
  });

  it("uses Plasma's native tools and verifies the persisted cursor size", async () => {
    let theme = "breeze_cursors";
    let size = "24";
    const runCommand = vi.fn(async (command, args) => {
      if (command === "kreadconfig6") {
        return args[5] === "cursorTheme" ? theme : size;
      }
      if (command === "kwriteconfig6") {
        size = args[6];
        return "";
      }
      if (command === "plasma-apply-cursortheme") {
        theme = args[2];
        return "";
      }
      throw new Error("Unexpected command");
    });
    const desktop = createLinuxCursorDesktop({
      env: { XDG_CURRENT_DESKTOP: "KDE" },
      runCommand,
    });
    const original = await desktop.capture();
    await desktop.apply({ name: "generated-test", size: 40 });
    expect(await desktop.read()).toEqual({ theme: "generated-test", size: 40 });
    await desktop.restore(original);
    expect(await desktop.read()).toEqual({ theme: "breeze_cursors", size: 24 });
  });
});

describe("Hyprland activation environment", () => {
  it("waits for startup restoration before capturing or applying a cursor", async () => {
    vi.useFakeTimers();
    let pending = true;
    const gtk = { "cursor-theme": "'Previous'", "cursor-size": "24" };
    const live = {
      XCURSOR_THEME: "Previous",
      XCURSOR_SIZE: "24",
      HYPRCURSOR_THEME: "Previous",
      HYPRCURSOR_SIZE: "24",
    };
    const mutations = [];
    const runCommand = vi.fn(async (command, args) => {
      if (command === "hyprctl" && args[0] === "repl") {
        if (args[1].includes("omarchy_startup_cursor_pending")) {
          return String(pending);
        }
        return Object.entries(live)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
      }
      expect(pending).toBe(false);
      if (command === "gsettings" && args[0] === "get") {
        return gtk[args[2]];
      }
      mutations.push([command, args]);
      if (command === "gsettings") {
        gtk[args[2]] = args[3];
      } else if (args[0] === "eval") {
        for (const match of args[1].matchAll(
          /hl.env\("([A-Z_]+)", "([^"]*)"\)/g,
        )) {
          live[match[1]] = match[2];
        }
      }
      return command === "hyprctl" ? "ok" : "";
    });
    const desktop = createLinuxCursorDesktop({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "session" },
      systemdUserManager: false,
      runCommand,
    });
    try {
      const snapshot = desktop.capture();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mutations).toEqual([]);
      pending = false;
      await vi.advanceTimersByTimeAsync(250);
      expect(await snapshot).toMatchObject({ theme: "Previous", size: 24 });

      // A reload can start another restoration between snapshot and mutation.
      pending = true;
      const applying = desktop.apply({ name: "Selected", size: 32 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mutations).toEqual([]);
      pending = false;
      await vi.advanceTimersByTimeAsync(250);
      await applying;
      expect(gtk).toEqual({
        "cursor-theme": "'Selected'",
        "cursor-size": "32",
      });
      expect(live.XCURSOR_THEME).toBe("Selected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stuck startup without changing desktop settings", async () => {
    vi.useFakeTimers();
    const runCommand = vi.fn(async (command, args) => {
      expect(command).toBe("hyprctl");
      expect(args[0]).toBe("repl");
      return "true";
    });
    const desktop = createLinuxCursorDesktop({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "session" },
      runCommand,
    });
    try {
      const result = desktop
        .apply({ name: "Selected", size: 32 })
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await result).message).toBe(
        "Hyprland's startup cursor restoration did not finish.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps UWSM-launched applications consistent and restores distinct manager values and unset variables", async () => {
    const gtk = { "cursor-theme": "'GTK Original'", "cursor-size": "24" };
    const compositor = {
      XCURSOR_THEME: "Compositor Original",
      XCURSOR_SIZE: "24",
      HYPRCURSOR_THEME: "Hypr Original",
      HYPRCURSOR_SIZE: "32",
    };
    const manager = {
      XCURSOR_THEME: "Manager Original",
      XCURSOR_SIZE: "18",
      UNRELATED_SETTING: "keep me",
    };
    const initialCompositor = { ...compositor };
    const initialManager = { ...manager };
    const runCommand = vi.fn(async (command, args) => {
      if (command === "gsettings") {
        if (args[0] === "get") {
          return gtk[args[2]];
        }
        gtk[args[2]] = args[3];
        return "";
      }
      if (command === "hyprctl") {
        if (args[0] === "repl") {
          if (args[1].includes("omarchy_startup_cursor_pending")) {
            return "false";
          }
          return Object.entries(compositor)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");
        }
        if (args[0] === "eval") {
          for (const match of args[1].matchAll(
            /hl.env\("([A-Z_]+)", "([^"]*)"\)/g,
          )) {
            compositor[match[1]] = match[2];
          }
        }
        return "ok";
      }
      if (command === "systemctl") {
        if (args[1] === "show-environment") {
          return JSON.stringify(manager);
        }
        if (args[1] === "set-environment") {
          for (const pair of args.slice(2)) {
            const index = pair.indexOf("=");
            manager[pair.slice(0, index)] = pair.slice(index + 1);
          }
        } else if (args[1] === "unset-environment") {
          for (const key of args.slice(2)) {
            delete manager[key];
          }
        }
        return "";
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const desktop = createLinuxCursorDesktop({
      env: {
        XDG_CURRENT_DESKTOP: "Hyprland",
        HYPRLAND_INSTANCE_SIGNATURE: "session",
      },
      systemdUserManager: true,
      runCommand,
    });
    const snapshot = await desktop.capture();
    expect(snapshot.activationEnvironment).toEqual({
      XCURSOR_THEME: "Manager Original",
      XCURSOR_SIZE: "18",
      HYPRCURSOR_THEME: null,
      HYPRCURSOR_SIZE: null,
    });
    await desktop.apply({ name: "generated-test", size: 40 });
    expect(manager).toEqual({
      XCURSOR_THEME: "generated-test",
      XCURSOR_SIZE: "40",
      HYPRCURSOR_THEME: "generated-test",
      HYPRCURSOR_SIZE: "40",
      UNRELATED_SETTING: "keep me",
    });
    manager.XCURSOR_SIZE = "24";
    expect(
      await desktop.matches({
        name: "generated-test",
        size: 40,
        session: "session",
      }),
    ).toBe(false);
    await desktop.restore(snapshot);
    expect(manager).toEqual(initialManager);
    expect(compositor).toEqual(initialCompositor);
  });
});
