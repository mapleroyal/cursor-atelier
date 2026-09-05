import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "native", "cursor-packs", "build", "linux");
const python = path.join(
  root,
  "native",
  "cursor-packs",
  "build",
  "curated-converter",
  `tooling-Linux-${process.arch}`,
  "bin",
  "python",
);
fs.mkdirSync(output, { recursive: true });
// Export the checked-in macOS artwork. Pillow reads ICNS directly; no redesign
// or platform-specific Apple tooling is needed to retain the app's identity.
execFileSync(python, [
  "-c",
  "from PIL import Image; import sys; image = Image.open(sys.argv[1]); image.thumbnail((512, 512)); image.save(sys.argv[2])",
  path.join(root, "assets", "AppIcon.icns"),
  path.join(output, "AppIcon.png"),
]);
process.stdout.write(`${path.join(output, "AppIcon.png")}\n`);
