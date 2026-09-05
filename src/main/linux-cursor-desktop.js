import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const SCHEMA = "org.gnome.desktop.interface";
const CURSOR_ENVIRONMENT_KEYS = [
  "XCURSOR_THEME",
  "XCURSOR_SIZE",
  "HYPRCURSOR_THEME",
  "HYPRCURSOR_SIZE",
];
// Lua string literals, independent of shell quoting. Values remain data even
// when a theme name contains quotes, control characters, or Lua source text.
function luaString(value) {
  return `"${[...String(value)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 ||
        code === 127 ||
        character === "\\" ||
        character === '"'
        ? `\\${code.toString().padStart(3, "0")}`
        : character;
    })
    .join("")}"`;
}

export async function runLinuxCursorCommand(command, arguments_, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, arguments_, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      ...options,
    });
    return stdout.trim();
  } catch (cause) {
    const detail = String(cause.stderr ?? "").trim();
    const error = new Error(
      cause.code === "ENOENT"
        ? `Linux cursor support requires ${command}. Install the Linux desktop dependencies listed in the README.`
        : `${command} could not update the desktop cursor${detail ? `: ${detail}` : "."}`,
      { cause },
    );
    error.code =
      cause.code === "ENOENT"
        ? "LINUX_DEPENDENCY_MISSING"
        : "LINUX_DESKTOP_ERROR";
    throw error;
  }
}

export function detectLinuxCursorDesktop(env = process.env) {
  const desktop =
    `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.XDG_SESSION_DESKTOP ?? ""}`.toLowerCase();
  if (env.HYPRLAND_INSTANCE_SIGNATURE || desktop.includes("hyprland")) {
    return "hyprland";
  }
  if (desktop.includes("kde") || desktop.includes("plasma")) {
    return "kde";
  }
  if (
    desktop.includes("gnome") ||
    desktop.includes("ubuntu") ||
    desktop.includes("unity")
  ) {
    return "gnome";
  }
  return null;
}

function gvariantString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function parseGvariantString(value) {
  const text = String(value).trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1).replace(/\\([\\'"])/g, "$1");
  }
  throw new Error("The desktop returned an invalid cursor theme setting.");
}

export function createLinuxCursorDesktop({
  env = process.env,
  runCommand = runLinuxCursorCommand,
  systemdUserManager = Boolean(
    env.XDG_RUNTIME_DIR &&
    existsSync(path.join(env.XDG_RUNTIME_DIR, "systemd", "private")),
  ),
} = {}) {
  const kind = detectLinuxCursorDesktop(env);
  const command = (name, args) => runCommand(name, args, { env });
  const requireSupported = () => {
    if (!kind) {
      const error = new Error(
        "Cursor application is available on GNOME, KDE Plasma, and Hyprland Linux sessions.",
      );
      error.code = "LINUX_DESKTOP_UNSUPPORTED";
      throw error;
    }
  };
  const readGtk = async () => {
    const theme = await command("gsettings", ["get", SCHEMA, "cursor-theme"]);
    const size = await command("gsettings", ["get", SCHEMA, "cursor-size"]);
    return {
      theme: parseGvariantString(theme),
      size: Number(size),
      rawTheme: theme,
      rawSize: size,
    };
  };
  const readKde = async () => {
    const theme = await command("kreadconfig6", [
      "--file",
      "kcminputrc",
      "--group",
      "Mouse",
      "--key",
      "cursorTheme",
      "--default",
      "breeze_cursors",
    ]);
    const size = await command("kreadconfig6", [
      "--file",
      "kcminputrc",
      "--group",
      "Mouse",
      "--key",
      "cursorSize",
      "--default",
      "24",
    ]);
    return { theme, size: Number(size) };
  };
  const read = async () => {
    requireSupported();
    const result = kind === "kde" ? await readKde() : await readGtk();
    if (
      !result.theme ||
      !Number.isInteger(result.size) ||
      result.size < 0 ||
      result.size > 4096
    ) {
      throw new Error("The desktop returned invalid cursor settings.");
    }
    return result;
  };
  const readHyprEnvironment = async () => {
    const expression = CURSOR_ENVIRONMENT_KEYS.map(
      (key) =>
        `${luaString(`${key}=`)} .. (os.getenv(${luaString(key)}) or "")`,
    ).join(' .. "\\n" .. ');
    const output = await command("hyprctl", ["repl", `return ${expression}`]);
    const lines = output.split("\n");
    const result = {};
    for (const key of CURSOR_ENVIRONMENT_KEYS) {
      const line = lines.find((line) => line.startsWith(`${key}=`));
      if (line === undefined) {
        throw new Error(
          "Cursor Atelier requires Hyprland 0.55 or newer with its Lua configuration API.",
        );
      }
      result[key] = line.slice(key.length + 1);
    }
    return result;
  };
  const writeHyprEnvironment = async (values) => {
    const code = CURSOR_ENVIRONMENT_KEYS.map(
      (key) => `hl.env(${luaString(key)}, ${luaString(values[key] ?? "")})`,
    ).join("; ");
    const output = await command("hyprctl", ["eval", code]);
    if (output !== "ok") {
      throw new Error(
        `Hyprland could not update cursor environment: ${output}`,
      );
    }
  };
  const readActivationEnvironment = async () => {
    if (kind !== "hyprland" || !systemdUserManager) {
      return null;
    }
    const output = await command("systemctl", [
      "--user",
      "show-environment",
      "--output=json",
    ]);
    const values = JSON.parse(output);
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(
        "The user session returned an invalid activation environment.",
      );
    }
    return Object.fromEntries(
      CURSOR_ENVIRONMENT_KEYS.map((key) => {
        const value = values[key];
        if (value !== undefined && typeof value !== "string") {
          throw new Error(
            "The user session returned an invalid cursor environment value.",
          );
        }
        return [key, value ?? null];
      }),
    );
  };
  const writeActivationEnvironment = async (values) => {
    if (!systemdUserManager || !values) {
      return;
    }
    const set = CURSOR_ENVIRONMENT_KEYS.filter(
      (key) => values[key] !== null,
    ).map((key) => `${key}=${values[key]}`);
    const unset = CURSOR_ENVIRONMENT_KEYS.filter((key) => values[key] === null);
    // UWSM launches applications as user services. On the dbus-broker user bus
    // used by Omarchy, D-Bus activation also delegates to this same manager.
    // Preserve absent variables with unset-environment when restoring.
    if (set.length) {
      await command("systemctl", ["--user", "set-environment", ...set]);
    }
    if (unset.length) {
      await command("systemctl", ["--user", "unset-environment", ...unset]);
    }
  };
  const capture = async () => {
    const current = await read();
    const cursorEnvironment =
      kind === "hyprland" ? await readHyprEnvironment() : null;
    const activationEnvironment = await readActivationEnvironment();
    return {
      kind,
      ...current,
      ...(kind === "hyprland"
        ? {
            compositorTheme:
              cursorEnvironment.HYPRCURSOR_THEME ||
              cursorEnvironment.XCURSOR_THEME ||
              current.theme,
            compositorSize:
              Number(
                cursorEnvironment.HYPRCURSOR_SIZE ||
                  cursorEnvironment.XCURSOR_SIZE,
              ) || current.size,
            cursorEnvironment,
            activationEnvironment,
          }
        : {}),
    };
  };
  const writeGtk = async (theme, size) => {
    await command("gsettings", ["set", SCHEMA, "cursor-size", String(size)]);
    await command("gsettings", [
      "set",
      SCHEMA,
      "cursor-theme",
      gvariantString(theme),
    ]);
  };
  const setHyprCursor = async (theme, size) => {
    const output = await command("hyprctl", ["setcursor", theme, String(size)]);
    if (output.trim() !== "ok") {
      throw new Error(`Hyprland could not apply the cursor: ${output}`);
    }
  };
  const apply = async ({ name, size }) => {
    requireSupported();
    if (kind === "kde") {
      // KConfig's native CLI preserves unrelated settings. Writing the size also
      // covers Plasma releases where apply-cursortheme ignores its --size option.
      await command("kwriteconfig6", [
        "--file",
        "kcminputrc",
        "--group",
        "Mouse",
        "--key",
        "cursorSize",
        String(size),
      ]);
      await command("plasma-apply-cursortheme", ["--size", String(size), name]);
    } else {
      if (kind === "hyprland") {
        const values = {
          XCURSOR_THEME: name,
          XCURSOR_SIZE: String(size),
          HYPRCURSOR_THEME: name,
          HYPRCURSOR_SIZE: String(size),
        };
        await writeHyprEnvironment(values);
        await writeActivationEnvironment(values);
        await setHyprCursor(name, size);
      }
      await writeGtk(name, size);
    }
    if (
      !(await matches({
        name,
        size,
        session: kind === "hyprland" ? env.HYPRLAND_INSTANCE_SIGNATURE : null,
      }))
    ) {
      throw new Error(
        "The desktop did not retain the requested cursor settings.",
      );
    }
  };
  const restore = async (snapshot) => {
    requireSupported();
    if (snapshot?.kind !== kind) {
      throw new Error(
        "Restore the cursor in the desktop session where it was applied before switching desktop environments.",
      );
    }
    if (kind === "kde") {
      await apply({ name: snapshot.theme, size: snapshot.size });
    } else {
      if (kind === "hyprland") {
        await writeHyprEnvironment(snapshot.cursorEnvironment);
        await writeActivationEnvironment(snapshot.activationEnvironment);
        await setHyprCursor(
          snapshot.compositorTheme || snapshot.theme,
          snapshot.compositorSize || snapshot.size,
        );
      }
      await command("gsettings", [
        "set",
        SCHEMA,
        "cursor-size",
        snapshot.rawSize,
      ]);
      await command("gsettings", [
        "set",
        SCHEMA,
        "cursor-theme",
        snapshot.rawTheme,
      ]);
    }
    const activationMatches =
      !snapshot.activationEnvironment ||
      JSON.stringify(snapshot.activationEnvironment) ===
        JSON.stringify(await readActivationEnvironment());
    if (
      !activationMatches ||
      !(await matches({ name: snapshot.theme, size: snapshot.size }))
    ) {
      throw new Error(
        "The previous desktop cursor could not be verified after restoring it.",
      );
    }
  };
  const matches = async ({ name, size, session } = {}) => {
    const current = await read();
    if (current.theme !== name || current.size !== size) {
      return false;
    }
    if (kind === "hyprland" && session) {
      const liveEnvironment = await readHyprEnvironment();
      const activationEnvironment = await readActivationEnvironment();
      const activationMatches =
        !activationEnvironment ||
        (activationEnvironment.XCURSOR_THEME === name &&
          Number(activationEnvironment.XCURSOR_SIZE) === size &&
          activationEnvironment.HYPRCURSOR_THEME === name &&
          Number(activationEnvironment.HYPRCURSOR_SIZE) === size);
      return (
        activationMatches &&
        session === env.HYPRLAND_INSTANCE_SIGNATURE &&
        liveEnvironment.XCURSOR_THEME === name &&
        Number(liveEnvironment.XCURSOR_SIZE) === size &&
        liveEnvironment.HYPRCURSOR_THEME === name &&
        Number(liveEnvironment.HYPRCURSOR_SIZE) === size
      );
    }
    return true;
  };
  return {
    kind,
    requireSupported,
    read,
    capture,
    apply,
    restore,
    matches,
    session:
      kind === "hyprland" ? (env.HYPRLAND_INSTANCE_SIGNATURE ?? "") : null,
  };
}
