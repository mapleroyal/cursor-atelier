import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Linux builds require an x86-64 or ARM64 Linux host.");
}
if (!process.report.getReport().header.glibcVersionRuntime) {
  throw new Error(
    "Electron and the frozen converter require glibc Linux (musl/Alpine is unsupported).",
  );
}
const python = process.env.CURSOR_ATELIER_PYTHON || "python3";
const check = spawnSync(
  python,
  [
    "-c",
    "import sys, venv; assert sys.version_info >= (3, 10), 'Python 3.10 or newer is required'",
  ],
  { encoding: "utf8" },
);
if (check.status !== 0) {
  throw new Error(
    `Install Python 3 with venv support, or set CURSOR_ATELIER_PYTHON. ${check.stderr || check.error?.message || ""}`,
  );
}
for (const command of ["ldd", "objdump"]) {
  if (spawnSync(command, ["--version"], { encoding: "utf8" }).status !== 0) {
    throw new Error(
      `Missing ${command}; install your distribution's glibc tools and binutils.`,
    );
  }
}
if (spawnSync("xcursorgen", ["-help"], { encoding: "utf8" }).error) {
  throw new Error(
    "Install xcursorgen (Debian/Ubuntu: x11-apps; Fedora: xcursorgen; Arch: xorg-xcursorgen) to write Linux cursor themes.",
  );
}
if (spawnSync("gdbus", ["help"], { encoding: "utf8" }).error) {
  throw new Error(
    "Install GLib's gdbus command to follow the desktop appearance portal.",
  );
}
const electron = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "electron",
);
if (fs.existsSync(electron)) {
  const dependencies = spawnSync("ldd", [electron], { encoding: "utf8" });
  const missing =
    dependencies.stdout
      ?.split("\n")
      .filter((line) => line.includes("not found")) || [];
  if (dependencies.status !== 0 || missing.length) {
    throw new Error(
      `Install the Electron desktop runtime libraries listed in README.md.\n${missing.join("\n") || dependencies.stderr}`,
    );
  }
}
process.stdout.write(
  `Linux preflight passed: glibc ${process.report.getReport().header.glibcVersionRuntime}, ${process.arch}, Python and Electron dependencies.\n`,
);
