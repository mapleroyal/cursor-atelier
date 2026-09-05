import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "darwin") {
  execFileSync(path.join(root, "native", "oreo", "build.sh"), [], {
    stdio: "inherit",
    cwd: root,
  });
} else if (process.platform === "linux") {
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "linux-preflight.mjs")],
    { stdio: "inherit", cwd: root },
  );
  execFileSync(path.join(root, "scripts", "build-curated-converter.sh"), [], {
    stdio: "inherit",
    cwd: root,
  });
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "build-linux-assets.mjs")],
    { stdio: "inherit", cwd: root },
  );
} else {
  throw new Error("Cursor Atelier supports macOS and Linux.");
}
