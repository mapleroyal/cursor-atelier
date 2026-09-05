import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import packageTools from "./linux-package.cjs";

const {
  applicationId,
  executableName,
  verifyLinuxPackage,
  readBuildInfo,
  runningPackageProcesses,
} = packageTools;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux") {
  throw new Error(
    "app:install is the Linux user-local installer. On macOS install the signed app at /Applications/Cursor Atelier.app as described in README.md.",
  );
}
if (process.argv.length !== 2) {
  throw new Error("app:install does not accept arguments.");
}
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  throw new Error(
    "Install from your graphical desktop session so the installed app can be verified.",
  );
}
if (spawnSync("gio", ["help", "trash"], { encoding: "utf8" }).status !== 0) {
  throw new Error("Install GLib's gio command for recoverable cleanup.");
}

const home = os.homedir();
function xdg(name, fallback) {
  const value = process.env[name];
  return value && path.isAbsolute(value) ? value : fallback;
}
const data = xdg("XDG_DATA_HOME", path.join(home, ".local", "share"));
const config = xdg("XDG_CONFIG_HOME", path.join(home, ".config"));
const owner = path.join(data, "cursor-atelier");
const installed = path.join(owner, "app");
const executable = path.join(installed, executableName);
const staged = path.join(
  root,
  "out.noindex",
  `Cursor Atelier-linux-${process.arch}`,
);
const build = verifyLinuxPackage(staged);
const applicationFile = path.join(
  data,
  "applications",
  `${applicationId}.desktop`,
);
const startupFile = path.join(config, "autostart", `${applicationId}.desktop`);
const launcher = path.join(home, ".local", "bin", executableName);
const hookFile = path.join(
  home,
  ".config",
  "omarchy",
  "hooks",
  "theme-set.d",
  "cursor-atelier",
);
const userData =
  process.env.CURSOR_ATELIER_USER_DATA || path.join(config, "Cursor Atelier");
const runtimeFile = path.join(userData, "runtime.json");

function ordinaryDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing an unexpected install directory: ${directory}`);
  }
}
ordinaryDirectory(owner);
for (const file of [applicationFile, startupFile, launcher]) {
  ordinaryDirectory(path.dirname(file));
}

function savedRegistration(filename, kind) {
  if (
    !fs.existsSync(filename) &&
    !fs.lstatSync(filename, { throwIfNoEntry: false })
  ) {
    return null;
  }
  const stat = fs.lstatSync(filename);
  if (
    kind === "launcher" &&
    stat.isSymbolicLink() &&
    fs.readlinkSync(filename) === executable
  ) {
    return { link: executable };
  }
  if (kind !== "launcher" && stat.isFile() && !stat.isSymbolicLink()) {
    const content = fs.readFileSync(filename, "utf8");
    if (
      content.includes(`X-CursorAtelier-ApplicationId=${applicationId}`) ||
      (kind === "startup" &&
        content.split(/\r?\n/).includes("X-CursorAtelier-Owned=true")) ||
      (kind === "hook" &&
        content.split(/\r?\n/).includes("# Cursor Atelier managed theme hook"))
    ) {
      return { content, mode: stat.mode & 0o777 };
    }
  }
  throw new Error(
    `Refusing to replace an unrecognized registration: ${filename}`,
  );
}
const registrations = [
  [applicationFile, savedRegistration(applicationFile, "application")],
  [startupFile, savedRegistration(startupFile, "startup")],
  [launcher, savedRegistration(launcher, "launcher")],
  [hookFile, savedRegistration(hookFile, "hook")],
];
function restoreRegistrations() {
  for (const [filename, saved] of registrations) {
    fs.rmSync(filename, { force: true });
    if (saved?.link) {
      fs.symlinkSync(saved.link, filename);
    } else if (saved) {
      fs.writeFileSync(filename, saved.content, { mode: saved.mode });
    }
  }
}

function installedProcesses() {
  return runningPackageProcesses(installed)
    .filter((process) => process.main)
    .map((process) => process.pid);
}
async function stopInstalledApp() {
  for (const pid of installedProcesses()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  const deadline = Date.now() + 15000;
  let remaining = runningPackageProcesses(installed);
  while (remaining.length && Date.now() < deadline) {
    await delay(100);
    remaining = runningPackageProcesses(installed);
  }
  if (remaining.length) {
    throw new Error(
      `Cursor Atelier still has processes running from ${installed}: ${remaining.map((process) => `${process.pid} (${path.basename(process.executable)})`).join(", ")}. The installation was left in place; let those processes exit before retrying.`,
    );
  }
}
function desktopValue(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
function desktopExec(value) {
  if (!path.isAbsolute(value) || /[\r\n\0=]/.test(value)) {
    throw new Error("An absolute desktop executable path is required.");
  }
  return `"${value
    .replaceAll("%", "%%")
    .replace(/[\\"`$]/g, "\\$&")
    .replaceAll("\\", "\\\\")}"`;
}
function writeAtomic(filename, content) {
  const temporary = `${filename}.cursor-atelier-${process.pid}`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o644 });
  fs.renameSync(temporary, filename);
}
async function inspectInstalledApp() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-install-check-"),
  );
  const resultPath = path.join(temporary, "result.json");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--installation-check=${resultPath}`], {
        env: {
          ...process.env,
          CURSOR_ATELIER_USER_DATA: path.join(temporary, "data"),
          CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Installed app inspection timed out. ${stderr}`));
      }, 45000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              new Error(`Installed app inspection failed (${code}). ${stderr}`),
            );
      });
    });
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    if (
      result.executablePath !== executable ||
      result.buildVersion !== build.buildVersion ||
      result.rendererReady !== true
    ) {
      throw new Error(
        "The installed app did not confirm the expected build and renderer.",
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
}
async function launchInstalledApp(expectedBuild) {
  const child = spawn(executable, [], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  const deadline = Date.now() + 45000;
  let lastObservation;
  while (Date.now() < deadline) {
    if (launchError) {
      throw launchError;
    }
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
      const resolvedExecutable = fs.readlinkSync(`/proc/${runtime.pid}/exe`);
      const pids = installedProcesses();
      const observation = JSON.stringify({
        runtime,
        expectedBuild,
        executable,
        resolvedExecutable,
        pids,
      });
      if (observation !== lastObservation) {
        process.stdout.write(
          `Installation process verification: ${observation}\n`,
        );
        lastObservation = observation;
      }
      if (
        runtime.buildVersion === expectedBuild &&
        runtime.executablePath === executable &&
        runtime.rendererReady === true &&
        resolvedExecutable === executable &&
        pids.length === 1
      ) {
        return runtime;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.message !== lastObservation) {
        process.stderr.write(
          `Waiting for runtime identity: ${error.message}\n`,
        );
        lastObservation = error.message;
      }
    }
    await delay(100);
  }
  throw new Error(
    "The installed app did not confirm its running build. The previous installation will be restored.",
  );
}

const previous = fs.existsSync(installed)
  ? // Its own inventory verifies the recoverable prior build. Runtime checks
    // describe the new converter and apply only to the staged/installed update.
    verifyLinuxPackage(installed, { selfTest: false })
  : null;
if (previous && BigInt(build.buildVersion) < BigInt(previous.buildVersion)) {
  throw new Error(
    "Refusing to install an older build over the current installation.",
  );
}
const runningBefore = installedProcesses();
process.stdout.write(
  `${JSON.stringify({ installed, previousBuild: previous?.buildVersion || null, runningProcesses: runningBefore, startupRegistration: Boolean(registrations[1][1]), omarchyHook: Boolean(registrations[3][1]), stagedBuild: build.buildVersion }, null, 2)}\n`,
);
const incoming = fs.mkdtempSync(path.join(owner, ".incoming-"));
const recovery = path.join(
  owner,
  `.previous-${previous?.buildVersion || "none"}-${Date.now()}`,
);
let previousMoved = false;
let activated = false;
try {
  fs.cpSync(staged, incoming, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  verifyLinuxPackage(incoming);
  await stopInstalledApp();
  if (previous) {
    fs.renameSync(installed, recovery);
    previousMoved = true;
  }
  fs.renameSync(incoming, installed);
  activated = true;
  await inspectInstalledApp();
  writeAtomic(
    applicationFile,
    `[Desktop Entry]\nType=Application\nName=Cursor Atelier\nComment=Cursor pack manager\nExec=${desktopExec(executable)}\nIcon=${desktopValue(path.join(installed, "resources", "AppIcon.png"))}\nTerminal=false\nCategories=Utility;Settings;\nStartupWMClass=cursor-atelier\nX-CursorAtelier-ApplicationId=${applicationId}\n`,
  );
  if (
    fs.existsSync(launcher) ||
    fs.lstatSync(launcher, { throwIfNoEntry: false })
  ) {
    fs.unlinkSync(launcher);
  }
  fs.symlinkSync(executable, launcher);
  spawnSync("update-desktop-database", [path.dirname(applicationFile)], {
    stdio: "ignore",
  });
  const runtime = await launchInstalledApp(build.buildVersion);
  process.stdout.write(
    `Installed and running Cursor Atelier ${build.version} (${build.buildVersion}), PID ${runtime.pid}: ${executable}\n`,
  );
} catch (error) {
  if (activated) {
    await stopInstalledApp();
    const failed = path.join(
      owner,
      `.failed-${build.buildVersion}-${Date.now()}`,
    );
    fs.renameSync(installed, failed);
    process.stderr.write(
      `Retained failed installation for diagnosis: ${failed}\n`,
    );
  }
  if (previousMoved) {
    fs.renameSync(recovery, installed);
  }
  restoreRegistrations();
  if (runningBefore.length && previous) {
    await launchInstalledApp(previous.buildVersion);
  }
  throw error;
} finally {
  if (fs.existsSync(incoming)) {
    fs.rmSync(incoming, { recursive: true });
  }
}
// Keep the prior app recoverable until activation, process identity, and the
// current package cleanup are all verified. package:clean moves it to Trash.
if (previousMoved) {
  process.stdout.write(`Recoverable previous installation: ${recovery}\n`);
}
if (readBuildInfo(installed).buildVersion !== build.buildVersion) {
  throw new Error("Installed identity changed unexpectedly.");
}
process.stdout.write(
  "After verification, run npm run package:clean -- --dry-run, then npm run package:clean.\n",
);
