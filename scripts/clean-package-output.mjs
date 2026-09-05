import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  await import("./clean-linux-package-output.mjs");
  process.exit(0);
}

const expectedBundleId = "com.cursoratelier.CursorAtelier";
const expectedNativeBundleId = "com.cursoratelier.CursorAtelier.NativeCursor";
const expectedHelperBundleId =
  "com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper";
const installedApp = "/Applications/Cursor Atelier.app";
const launchServices =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const arguments_ = process.argv.slice(2);
const includeLegacy = arguments_.includes("--include-legacy");
const dryRun = arguments_.includes("--dry-run");
const unexpectedArguments = arguments_.filter(
  (argument) => !["--include-legacy", "--dry-run"].includes(argument),
);

if (unexpectedArguments.length > 0) {
  throw new Error(`Unexpected argument: ${unexpectedArguments[0]}`);
}

function plistValue(appPath, key) {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, path.join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not read ${key} from ${appPath}.`);
  }
  return result.stdout.trim();
}

function verifyInstalledApp() {
  const installedStat = fs.lstatSync(installedApp);
  if (!installedStat.isDirectory() || installedStat.isSymbolicLink()) {
    throw new Error(
      `Refusing to use an unexpected installed path: ${installedApp}`,
    );
  }
  if (plistValue(installedApp, "CFBundleIdentifier") !== expectedBundleId) {
    throw new Error(`The installed app has an unexpected bundle identifier.`);
  }
  const buildVersion = plistValue(installedApp, "CFBundleVersion");
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildVersion)) {
    throw new Error(`The installed app has an invalid build identity.`);
  }
  const signature = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", installedApp],
    { encoding: "utf8" },
  );
  if (signature.status !== 0) {
    throw new Error(`The installed app did not pass signature verification.`);
  }
  return buildVersion;
}

function validateOutputRoot(outputRoot) {
  if (
    path.dirname(outputRoot) !== projectRoot ||
    !["out.noindex", "out"].includes(path.basename(outputRoot))
  ) {
    throw new Error(
      `Refusing to clean an unexpected output path: ${outputRoot}`,
    );
  }
  const outputStat = fs.lstatSync(outputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error(
      `Refusing to clean an unexpected output path: ${outputRoot}`,
    );
  }
  if (
    path.dirname(fs.realpathSync(outputRoot)) !== fs.realpathSync(projectRoot)
  ) {
    throw new Error(
      `The package output escaped the project root: ${outputRoot}`,
    );
  }
}

function topLevelProductApps(outputRoot) {
  const apps = [];
  for (const target of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!target.isDirectory() || target.isSymbolicLink()) {
      continue;
    }
    const targetPath = path.join(outputRoot, target.name);
    for (const candidate of fs.readdirSync(targetPath, {
      withFileTypes: true,
    })) {
      if (
        !candidate.isDirectory() ||
        candidate.isSymbolicLink() ||
        path.extname(candidate.name).toLowerCase() !== ".app"
      ) {
        continue;
      }
      const appPath = path.join(targetPath, candidate.name);
      try {
        if (plistValue(appPath, "CFBundleIdentifier") === expectedBundleId) {
          apps.push(appPath);
        }
      } catch {
        // Unrelated or incomplete generated bundles are moved with their
        // output root but are never passed to LaunchServices.
      }
    }
  }
  return apps;
}

function stagedProductApps(appPath) {
  const nativeApp = path.join(
    appPath,
    "Contents",
    "Resources",
    "Oreo Cursor.app",
  );
  const helperApp = path.join(
    nativeApp,
    "Contents",
    "Library",
    "LoginItems",
    "Oreo Cursor Login Helper.app",
  );
  const apps = [
    [helperApp, expectedHelperBundleId],
    [nativeApp, expectedNativeBundleId],
    [appPath, expectedBundleId],
  ];

  for (const [candidate, expectedIdentifier] of apps) {
    const candidateStat = fs.lstatSync(candidate);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new Error(`Refusing an unexpected staged app: ${candidate}`);
    }
    if (plistValue(candidate, "CFBundleIdentifier") !== expectedIdentifier) {
      throw new Error(
        `The staged app has an unexpected bundle identifier: ${candidate}`,
      );
    }
  }
  return apps.map(([candidate]) => candidate);
}

function registeredApplicationPaths() {
  const result = spawnSync(launchServices, ["-dump"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Inspecting LaunchServices registrations failed: ${result.stderr.trim()}`,
    );
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^path:\s+(.+) \([^)]*\)$/)?.[1])
      .filter(Boolean),
  );
}

function runLaunchServices(args, description) {
  const result = spawnSync(launchServices, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${description} failed: ${result.stderr.trim()}`);
  }
}

function trashDestination(outputRoot) {
  const trash = path.join(os.homedir(), ".Trash");
  const trashStat = fs.lstatSync(trash);
  if (!trashStat.isDirectory() || trashStat.isSymbolicLink()) {
    throw new Error(`Refusing to use an unexpected Trash directory: ${trash}`);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const base = `Cursor Atelier ${path.basename(outputRoot)} ${timestamp}`;
  let destination = path.join(trash, base);
  for (let suffix = 2; fs.existsSync(destination); suffix += 1) {
    destination = path.join(trash, `${base} ${suffix}`);
  }
  return destination;
}

const requestedRoots = [path.join(projectRoot, "out.noindex")];
if (includeLegacy) {
  requestedRoots.push(path.join(projectRoot, "out"));
}
const outputRoots = requestedRoots.filter((outputRoot) =>
  fs.existsSync(outputRoot),
);

if (outputRoots.length === 0) {
  process.stdout.write("No Cursor Atelier package output needed cleanup.\n");
  process.exit(0);
}

const installedBuildVersion = verifyInstalledApp();
const candidates = [];
for (const outputRoot of outputRoots) {
  validateOutputRoot(outputRoot);
  candidates.push(...topLevelProductApps(outputRoot));
}
const stagedApps = candidates.flatMap(stagedProductApps);
const registeredApps = registeredApplicationPaths();

const currentOutput = path.join(projectRoot, "out.noindex");
if (
  outputRoots.includes(currentOutput) &&
  !candidates.some(
    (appPath) =>
      appPath.startsWith(`${currentOutput}${path.sep}`) &&
      plistValue(appPath, "CFBundleVersion") === installedBuildVersion,
  )
) {
  throw new Error(
    "The installed build does not match the current staged package; refusing cleanup.",
  );
}

for (const outputRoot of outputRoots) {
  process.stdout.write(`Validated package output for cleanup: ${outputRoot}\n`);
}
for (const appPath of stagedApps) {
  if (!registeredApps.has(appPath)) {
    process.stdout.write(`Staged app is already unregistered: ${appPath}\n`);
    continue;
  }
  if (dryRun) {
    process.stdout.write(`Would unregister staged app: ${appPath}\n`);
    continue;
  }
  process.stdout.write(`Unregistering staged app: ${appPath}\n`);
  runLaunchServices(["-u", appPath], `Unregistering ${appPath}`);
}
if (dryRun) {
  process.stdout.write(
    `Dry run complete; no registrations or files were changed. ${installedApp} (${installedBuildVersion}) matches the staged build.\n`,
  );
  process.exit(0);
}
process.stdout.write(`Registering authoritative app: ${installedApp}\n`);
runLaunchServices(["-f", installedApp], "Registering the installed app");

for (const outputRoot of outputRoots) {
  const destination = trashDestination(outputRoot);
  fs.renameSync(outputRoot, destination);
  process.stdout.write(`Moved ${outputRoot} to ${destination}.\n`);
}
process.stdout.write(
  `Package cleanup complete; ${installedApp} (${installedBuildVersion}) remains authoritative.\n`,
);
