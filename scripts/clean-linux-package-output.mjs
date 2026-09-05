import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import packageTools from "./linux-package.cjs";

const { verifyLinuxPackage, runningPackageProcesses } = packageTools;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--include-legacy"].includes(arg))) {
  throw new Error("Expected only --dry-run and/or --include-legacy.");
}
const data =
  process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
const config =
  process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
const owner = path.join(data, "cursor-atelier");
const installed = path.join(owner, "app");
const info = verifyLinuxPackage(installed);
const executable = path.join(installed, "cursor-atelier");
const runtime = JSON.parse(
  fs.readFileSync(
    path.join(
      process.env.CURSOR_ATELIER_USER_DATA ||
        path.join(config, "Cursor Atelier"),
      "runtime.json",
    ),
    "utf8",
  ),
);
if (
  runtime.buildVersion !== info.buildVersion ||
  runtime.executablePath !== executable ||
  fs.readlinkSync(`/proc/${runtime.pid}/exe`) !== executable ||
  runtime.rendererReady !== true
) {
  throw new Error(
    "The installed app must be running and verified before package cleanup.",
  );
}
const output = path.join(root, "out.noindex");
const candidates = [
  output,
  ...(args.includes("--include-legacy") ? [path.join(root, "out")] : []),
].filter((filename) => fs.existsSync(filename));
for (const candidate of candidates) {
  if (
    fs.lstatSync(candidate).isSymbolicLink() ||
    !fs.statSync(candidate).isDirectory() ||
    path.dirname(fs.realpathSync(candidate)) !== fs.realpathSync(root)
  ) {
    throw new Error(`Refusing unsafe package output: ${candidate}`);
  }
  if (candidate === output) {
    const staged = verifyLinuxPackage(
      path.join(candidate, `Cursor Atelier-linux-${process.arch}`),
    );
    if (staged.buildVersion !== info.buildVersion) {
      throw new Error(
        "The installed build does not match the staged package; refusing cleanup.",
      );
    }
  }
}
for (const entry of fs.readdirSync(owner, { withFileTypes: true })) {
  if (!entry.name.startsWith(".previous-")) {
    continue;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Refusing unexpected recovery path: ${entry.name}`);
  }
  const candidate = path.join(owner, entry.name);
  const previous = verifyLinuxPackage(candidate, { selfTest: false });
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
      `Refusing to move ${candidate} to Trash while processes run from it: ${running.map((process) => `${process.pid} (${path.basename(process.executable)})`).join(", ")}. Close those processes and retry cleanup.`,
    );
  }
}
for (const candidate of candidates) {
  process.stdout.write(
    `${args.includes("--dry-run") ? "Would move to Trash" : "Moving to Trash"}: ${candidate}\n`,
  );
  if (!args.includes("--dry-run")) {
    execFileSync("gio", ["trash", "--", candidate], { stdio: "inherit" });
  }
}
process.stdout.write(
  `Package cleanup ${args.includes("--dry-run") ? "dry run " : ""}complete; ${executable} (${info.buildVersion}) remains installed.\n`,
);
