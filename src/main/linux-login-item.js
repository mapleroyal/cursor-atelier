import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESKTOP_ID = "com.cursoratelier.CursorAtelier.desktop";
const OWNER = "X-CursorAtelier-Owned=true";

function xdgDirectory(value, fallback) {
  return value && path.isAbsolute(value) ? value : fallback;
}

// Desktop Entry Exec quoting has both a string-escape and argument-escape layer.
export function quoteDesktopExecutable(value) {
  if (!path.isAbsolute(value) || /[\r\n\0=]/.test(value)) {
    throw new TypeError("An absolute desktop executable path is required.");
  }
  return `"${value
    .replaceAll("%", "%%")
    .replace(/[\\"`$]/g, "\\$&")
    .replaceAll("\\", "\\\\")}"`;
}

export function createLinuxLoginItem({
  executablePath = process.execPath,
  homeDirectory = os.homedir(),
  env = process.env,
  buildVersion,
  omarchy = fs.existsSync("/usr/share/omarchy"),
} = {}) {
  const dataDirectory = xdgDirectory(
    env.XDG_DATA_HOME,
    path.join(homeDirectory, ".local", "share"),
  );
  const configDirectory = xdgDirectory(
    env.XDG_CONFIG_HOME,
    path.join(homeDirectory, ".config"),
  );
  const installedExecutable = path.join(
    dataDirectory,
    "cursor-atelier",
    "app",
    "cursor-atelier",
  );
  const available = path.resolve(executablePath) === installedExecutable;
  const desktopPath = path.join(configDirectory, "autostart", DESKTOP_ID);
  const hookPath = path.join(
    homeDirectory,
    ".config",
    "omarchy",
    "hooks",
    "theme-set.d",
    "cursor-atelier",
  );
  const hookMarker = "# Cursor Atelier managed theme hook";
  const shellExecutable = `'${executablePath.replaceAll("'", "'\\''")}'`;
  const hook = `#!/bin/sh\n${hookMarker}\nexec ${shellExecutable} --background\n`;
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cursor Atelier",
    `Exec=${quoteDesktopExecutable(executablePath)} --background`,
    "Terminal=false",
    OWNER,
    `X-CursorAtelier-Build=${String(buildVersion ?? "").replace(/[\r\n]/g, "")}`,
    "",
  ].join("\n");

  function read() {
    try {
      const stat = fs.lstatSync(desktopPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
        throw new Error(
          "The Cursor Atelier autostart entry is not a regular file.",
        );
      }
      const text = fs.readFileSync(desktopPath, "utf8");
      if (!text.split(/\r?\n/).includes(OWNER)) {
        throw new Error(
          "The Cursor Atelier autostart path belongs to another entry.",
        );
      }
      return text;
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  return {
    available,
    syncCursorHook(enabled) {
      if (!available || !omarchy) {
        return;
      }
      let previous = null;
      try {
        const stat = fs.lstatSync(hookPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
          throw new Error(
            "The Cursor Atelier theme hook is not a regular file.",
          );
        }
        previous = fs.readFileSync(hookPath, "utf8");
        if (!previous.split("\n").includes(hookMarker)) {
          throw new Error(
            "The Cursor Atelier theme hook path belongs to another script.",
          );
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      if (!enabled) {
        if (previous !== null) {
          fs.unlinkSync(hookPath);
        }
        return;
      }
      if (previous === hook) {
        return;
      }
      fs.mkdirSync(path.dirname(hookPath), { recursive: true, mode: 0o700 });
      const temporary = `${hookPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, hook, { flag: "wx", mode: 0o700 });
        fs.renameSync(temporary, hookPath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    setLoginItemSettings({ openAtLogin }) {
      if (!available) {
        return;
      }
      const previous = read();
      if (!openAtLogin) {
        if (previous !== null) {
          fs.unlinkSync(desktopPath);
        }
        return;
      }
      if (previous === content) {
        return;
      }
      fs.mkdirSync(path.dirname(desktopPath), { recursive: true, mode: 0o700 });
      const temporary = `${desktopPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, desktopPath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    getLoginItemSettings() {
      const current = read();
      return {
        status:
          current === null
            ? "not-registered"
            : current === content
              ? "enabled"
              : "stale",
      };
    },
  };
}
