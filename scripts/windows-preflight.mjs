import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageTools from "./windows-package.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Windows preflight requires native x64 or ARM64 Windows.");
}
if (Number(process.versions.node.split(".")[0]) !== 22) {
  throw new Error("Use Node.js 22 for this repository.");
}
const build = path.join(root, "native", "cursor-packs", "build");
const converter = path.join(
  build,
  "curated-converter",
  "curated-cursor-converter",
  "curated-cursor-converter.exe",
);
if (!fs.existsSync(converter)) {
  throw new Error(
    "The Windows converter is missing. Run npm run native:build.",
  );
}
const result = packageTools.verifyWindowsConverter(converter);
for (const name of ["AppIcon.ico", "AppIcon.png"]) {
  if (!fs.statSync(path.join(build, "windows", name)).isFile()) {
    throw new Error(
      `The Windows icon ${name} is missing. Run npm run native:build.`,
    );
  }
}
console.warn(
  `Windows native preflight passed: ${process.arch}, ${result.themeCount} catalogue variants, ${result.roleCount} roles, native CUR/ANI encoder.`,
);
