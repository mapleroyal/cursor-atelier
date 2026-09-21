import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Windows builds require native x64 or ARM64 Windows.");
}
if (Number(process.versions.node.split(".")[0]) !== 22) {
  throw new Error("Use Node.js 22 for this repository.");
}
execFileSync(
  process.env.CURSOR_ATELIER_PYTHON || "python.exe",
  [path.join(root, "scripts", "build-windows-converter.py")],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
const output = path.join(root, "native", "cursor-packs", "build", "windows");
fs.mkdirSync(output, { recursive: true });
const python = path.join(
  root,
  "native",
  "cursor-packs",
  "build",
  "curated-converter",
  `tooling-Windows-${process.arch}`,
  "Scripts",
  "python.exe",
);
execFileSync(
  python,
  [
    "-c",
    "from PIL import Image; import sys; image=Image.open(sys.argv[1]).convert('RGBA'); image.thumbnail((512,512)); image.save(sys.argv[2]); image.save(sys.argv[3],sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])",
    path.join(root, "assets", "AppIcon.icns"),
    path.join(output, "AppIcon.png"),
    path.join(output, "AppIcon.ico"),
  ],
  { windowsHide: true },
);
process.stdout.write(
  `Windows converter and application icons built for ${process.arch}.\n`,
);
