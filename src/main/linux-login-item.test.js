import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxLoginItem } from "./linux-login-item.js";

const roots = [];
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
});
