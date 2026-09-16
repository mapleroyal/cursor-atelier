import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxLoginItem } from "./linux-login-item.js";

const roots = [];
const execFileAsync = promisify(execFile);
const hasUserManager =
  process.platform === "linux" &&
  Boolean(process.env.XDG_RUNTIME_DIR) &&
  fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR, "systemd/private"));
function fixture(buildVersion = "1") {
  const homeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-login-test-"),
  );
  roots.push(homeDirectory);
  const executablePath = path.join(
    homeDirectory,
    ".local/share/cursor-atelier/app/cursor-atelier",
  );
  const options = {
    homeDirectory,
    executablePath,
    env: {},
    buildVersion,
    omarchy: true,
  };
  return {
    options,
    item: createLinuxLoginItem(options),
    desktop: path.join(
      homeDirectory,
      ".config/autostart/com.cursoratelier.CursorAtelier.desktop",
    ),
    hook: path.join(
      homeDirectory,
      ".config/omarchy/hooks/theme-set.d/cursor-atelier",
    ),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true });
  }
});

describe("Linux installed background integration", () => {
  it("reconciles an older or disabled registration to the installed build, and removes owned integration on restore", () => {
    const { item, options, desktop, hook } = fixture();
    item.setLoginItemSettings({ openAtLogin: true });
    item.syncCursorHook(true);
    expect(item.getLoginItemSettings().status).toBe("enabled");
    expect(fs.statSync(hook).mode & 0o111).toBeGreaterThan(0);
    fs.appendFileSync(desktop, "Hidden=true\n");
    const updated = createLinuxLoginItem({ ...options, buildVersion: "2" });
    updated.setLoginItemSettings({ openAtLogin: true });
    expect(fs.readFileSync(desktop, "utf8")).toContain(
      "X-CursorAtelier-Build=2",
    );
    expect(fs.readFileSync(desktop, "utf8")).not.toContain("Hidden=true");
    updated.setLoginItemSettings({ openAtLogin: false });
    updated.syncCursorHook(false);
    expect(fs.existsSync(desktop)).toBe(false);
    expect(fs.existsSync(hook)).toBe(false);
  });

  it("never registers staging executables or overwrites another hook", () => {
    const { item, options, desktop, hook } = fixture();
    const staged = createLinuxLoginItem({
      ...options,
      executablePath: "/tmp/out.noindex/cursor-atelier",
    });
    staged.setLoginItemSettings({ openAtLogin: true });
    staged.syncCursorHook(true);
    expect(fs.existsSync(desktop)).toBe(false);
    expect(fs.existsSync(hook)).toBe(false);
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho user hook\n");
    expect(() => item.syncCursorHook(true)).toThrow("another script");
    expect(fs.readFileSync(hook, "utf8")).toContain("user hook");
  });

  // This starts only a temporary stand-in app, never the real cursor manager.
  // Exercise the actual shell and user manager: mocking spawn cannot detect a
  // cold launch retaining the theme command's lifetime, pipes, or environment.
  it.skipIf(!hasUserManager)(
    "migrates a blocking hook and detaches cold and repeated background launches",
    async () => {
      const { item, options, hook } = fixture();
      const statePath = path.join(options.homeDirectory, "state.json");
      const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
      fs.mkdirSync(path.dirname(options.executablePath), { recursive: true });
      fs.writeFileSync(
        options.executablePath,
        `#!${process.execPath}
const fs = require("node:fs");
const filename = ${JSON.stringify(statePath)};
if (fs.existsSync(filename)) {
  process.kill(JSON.parse(fs.readFileSync(filename, "utf8")).pid, "SIGUSR2");
  process.exit(0);
}
const fields = fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ");
const state = {
  pid: process.pid, group: Number(fields[2]), session: Number(fields[3]),
  arguments: process.argv.slice(2), repeated: 0,
  marker: process.env.CURSOR_ATELIER_THEME_HOOK_TEST ?? null,
  path: process.env.PATH,
};
process.on("SIGUSR2", () => {
  state.repeated += 1;
  fs.writeFileSync(filename, JSON.stringify(state));
});
fs.writeFileSync(filename, JSON.stringify(state));
process.stdout.write("app output must not retain the hook pipe\\n");
process.stderr.write("app errors belong in the user journal\\n");
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(
        hook,
        `#!/bin/sh\n# Cursor Atelier managed theme hook\nexec '${options.executablePath}' --background\n`,
        { mode: 0o700 },
      );
      item.syncCursorHook(true);

      const launch = () =>
        execFileAsync(hook, [], {
          timeout: 2000,
          detached: true,
          env: {
            ...process.env,
            CURSOR_ATELIER_THEME_HOOK_TEST: "temporary operation context",
            PATH: `/temporary-theme-bridge:${process.env.PATH}`,
          },
        });
      try {
        const cold = launch();
        expect(await cold).toMatchObject({ stdout: "", stderr: "" });
        await expect.poll(() => fs.existsSync(statePath)).toBe(true);
        const initial = readState();
        expect(initial.arguments).toEqual(["--background"]);
        expect(initial.group).not.toBe(cold.child.pid);
        expect(initial.session).not.toBe(cold.child.pid);
        expect(initial.marker).toBeNull();
        expect(initial.path).not.toContain("/temporary-theme-bridge");
        expect(() => process.kill(initial.pid, 0)).not.toThrow();

        expect(await launch()).toMatchObject({ stdout: "", stderr: "" });
        await expect.poll(() => readState().repeated).toBe(1);
        expect(readState().pid).toBe(initial.pid);
        expect(() => process.kill(initial.pid, 0)).not.toThrow();
      } finally {
        if (fs.existsSync(statePath)) {
          const { pid } = readState();
          try {
            process.kill(pid, "SIGTERM");
          } catch (error) {
            expect(error.code).toBe("ESRCH");
          }
          await expect.poll(() => fs.existsSync(`/proc/${pid}`)).toBe(false);
        }
      }
    },
  );
});
