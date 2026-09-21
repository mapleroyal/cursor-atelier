import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageTools from "./windows-package.cjs";
import {
  desktopContext,
  recycleDirectory,
  runningIdentityMatches,
  sameWindowsPath,
  windowsInstallPaths,
} from "./windows-install-support.mjs";

if (process.platform !== "win32") {
  throw new Error("This cleanup requires Windows.");
}
const { executableName, verifyWindowsPackage, runningPackageProcesses } =
  packageTools;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--include-legacy"].includes(arg))) {
  throw new Error("Expected only --dry-run and/or --include-legacy.");
}
const dryRun = args.includes("--dry-run");
const { installed, runtimeFile } = windowsInstallPaths();
const info = verifyWindowsPackage(installed);
const executable = path.join(installed, executableName);
const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
if (
  !runningIdentityMatches(
    runtime,
    info.buildVersion,
    executable,
    runningPackageProcesses(installed),
    desktopContext().sessions,
  )
) {
  throw new Error(
    "The installed app must be running and verified in the Windows desktop before cleanup.",
  );
}
const output = path.join(root, "out.noindex");
const candidates = [
  output,
  ...(args.includes("--include-legacy") ? [path.join(root, "out")] : []),
].filter((candidate) => fs.existsSync(candidate));
for (const candidate of candidates) {
  const stat = fs.lstatSync(candidate);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameWindowsPath(
      path.dirname(fs.realpathSync(candidate)),
      fs.realpathSync(root),
    )
  ) {
    throw new Error(`Refusing unsafe package output: ${candidate}`);
  }
  const entries = fs.readdirSync(candidate, { withFileTypes: true });
  const packages = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      /^Cursor Atelier-win32-(?:x64|arm64)$/.test(entry.name),
  );
  if (!packages.length) {
    throw new Error(
      `No verified Windows package owns this output: ${candidate}`,
    );
  }
  let matchesInstalled = false;
  for (const entry of packages) {
    const staged = verifyWindowsPackage(path.join(candidate, entry.name), {
      selfTest: false,
    });
    if (
      staged.buildVersion === info.buildVersion &&
      staged.arch === info.arch
    ) {
      matchesInstalled = true;
    }
  }
  if (candidate === output && !matchesInstalled) {
    throw new Error(
      "The installed build does not match the current staged package; refusing cleanup.",
    );
  }
}
const owner = path.dirname(installed);
for (const entry of fs.readdirSync(owner, { withFileTypes: true })) {
  if (!/^Cursor Atelier\.previous-\d+-[a-f0-9-]+$/.test(entry.name)) {
    continue;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Refusing unexpected recovery path: ${entry.name}`);
  }
  const candidate = path.join(owner, entry.name);
  const previous = verifyWindowsPackage(candidate, { selfTest: false });
  if (BigInt(previous.buildVersion) > BigInt(info.buildVersion)) {
    throw new Error(
      "A recovery copy is newer than the installed app; refusing cleanup.",
    );
  }
  candidates.push(candidate);
}
for (const candidate of candidates) {
  const running = runningPackageProcesses(candidate);
  if (running.length) {
    throw new Error(
      `Refusing to recycle ${candidate} while these processes run from it: ${running.map((entry) => entry.pid).join(", ")}.`,
    );
  }
}
for (const candidate of candidates) {
  process.stdout.write(
    `${dryRun ? "Would move to Recycle Bin" : "Moving to Recycle Bin"}: ${candidate}\n`,
  );
  if (!dryRun) {
    await recycleDirectory(candidate);
  }
}
process.stdout.write(
  `Package cleanup ${dryRun ? "dry run " : ""}complete; ${executable} (${info.buildVersion}) remains installed.\n`,
);
