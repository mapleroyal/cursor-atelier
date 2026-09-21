import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateWindowsUpdate,
  runningIdentityMatches,
} from "../../scripts/windows-install-support.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "cursor-windows-update-test-"),
  );
  temporary.push(root);
  const installed = path.join(root, "Cursor Atelier");
  const staged = path.join(root, "out.noindex", "staged");
  function write(directory, buildVersion) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "identity.json"),
      JSON.stringify({ buildVersion, version: "0.1.0" }),
    );
    fs.writeFileSync(path.join(directory, "app.exe"), `build ${buildVersion}`);
  }
  write(installed, "1");
  write(staged, "2");
  const data = path.join(root, "user-data.json");
  fs.writeFileSync(data, '{"selectedTheme":"user-created"}');
  const read = (directory) =>
    JSON.parse(fs.readFileSync(path.join(directory, "identity.json"), "utf8"));
  const events = [];
  const options = {
    staged,
    installed,
    verifyPackage: (directory) => {
      const info = read(directory);
      if (
        fs.readFileSync(path.join(directory, "app.exe"), "utf8") !==
        `build ${info.buildVersion}`
      ) {
        throw new Error("Package integrity failed");
      }
      return info;
    },
    stopInstalled: vi.fn(async () =>
      events.push(`stop:${read(installed).buildVersion}`),
    ),
    activateInstalled: vi.fn(async (build) => {
      expect(read(installed)).toEqual(build);
      events.push(`activate:${build.buildVersion}`);
    }),
    restoreRegistrations: vi.fn(async () => events.push("restore")),
    relaunchPrevious: vi.fn(async (build) => {
      expect(read(installed)).toEqual(build);
      events.push(`launch:${build.buildVersion}`);
    }),
    wasRunning: true,
  };
  return { root, installed, staged, data, read, events, options };
}

describe("Windows installed application update", () => {
  it("replaces a running build while preserving its recovery copy and user data", async () => {
    const f = fixture();
    const result = await activateWindowsUpdate(f.options);
    expect(f.events).toEqual(["stop:1", "activate:2"]);
    expect(f.read(f.installed).buildVersion).toBe("2");
    expect(f.read(result.recovery).buildVersion).toBe("1");
    expect(fs.readFileSync(f.data, "utf8")).toBe(
      '{"selectedTheme":"user-created"}',
    );
    expect(
      fs.readdirSync(f.root).some((name) => name.includes(".incoming-")),
    ).toBe(false);
  });
  it("restores registrations and relaunches the previous build after activation fails", async () => {
    const f = fixture();
    f.options.activateInstalled = async () => {
      f.events.push("activate:2");
      throw new Error("Renderer unavailable");
    };
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "Renderer unavailable",
    );
    expect(f.events).toEqual([
      "stop:1",
      "activate:2",
      "stop:2",
      "restore",
      "launch:1",
    ]);
    expect(f.read(f.installed).buildVersion).toBe("1");
    const failed = fs
      .readdirSync(f.root)
      .find((name) => name.startsWith("Cursor Atelier.failed-2-"));
    expect(f.read(path.join(f.root, failed)).buildVersion).toBe("2");
    expect(fs.readFileSync(f.data, "utf8")).toBe(
      '{"selectedTheme":"user-created"}',
    );
  });
  it("does not stop the installed app when staged files are corrupt", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.staged, "app.exe"), "altered");
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "Package integrity failed",
    );
    expect(f.options.stopInstalled).not.toHaveBeenCalled();
    expect(f.read(f.installed).buildVersion).toBe("1");
  });
  it("verifies the copied files before stopping the installed app", async () => {
    const f = fixture();
    const verify = f.options.verifyPackage;
    f.options.verifyPackage = (directory) => {
      if (directory.includes(".incoming-")) {
        throw new Error("Copied package failed verification");
      }
      return verify(directory);
    };
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "Copied package failed verification",
    );
    expect(f.options.stopInstalled).not.toHaveBeenCalled();
    expect(f.read(f.installed).buildVersion).toBe("1");
  });
  it("leaves the current directory untouched when a resident process will not stop", async () => {
    const f = fixture();
    f.options.stopInstalled = vi.fn(async () => {
      throw new Error("Still running");
    });
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "Still running",
    );
    expect(f.options.activateInstalled).not.toHaveBeenCalled();
    expect(f.read(f.installed).buildVersion).toBe("1");
    expect(
      fs.readdirSync(f.root).some((name) => name.includes(".previous-")),
    ).toBe(false);
  });
  it("keeps the recoverable prior directory when the failed build cannot be stopped", async () => {
    const f = fixture();
    f.options.activateInstalled = async () => {
      throw new Error("Bad launch");
    };
    f.options.stopInstalled = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Locked executable"));
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "rollback needs attention",
    );
    expect(f.read(f.installed).buildVersion).toBe("2");
    const previous = fs
      .readdirSync(f.root)
      .find((name) => name.startsWith("Cursor Atelier.previous-1-"));
    expect(f.read(path.join(f.root, previous)).buildVersion).toBe("1");
    expect(f.options.restoreRegistrations).not.toHaveBeenCalled();
  });
  it("refuses a downgrade before stopping the running build", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.staged, "identity.json"),
      JSON.stringify({ buildVersion: "0", version: "0.1.0" }),
    );
    fs.writeFileSync(path.join(f.staged, "app.exe"), "build 0");
    await expect(activateWindowsUpdate(f.options)).rejects.toThrow(
      "older build",
    );
    expect(f.options.stopInstalled).not.toHaveBeenCalled();
  });
});

describe("Windows installed runtime identity", () => {
  const executable =
    "C:\\Users\\agent\\AppData\\Local\\Programs\\Cursor Atelier\\cursor-atelier.exe";
  const runtime = {
    executablePath: executable,
    buildVersion: "123",
    pid: 400,
    rendererReady: true,
  };
  const process = { executable, pid: 400, main: true, sessionId: 1 };
  it("requires one exact installed main process in the user's desktop session", () => {
    expect(
      runningIdentityMatches(runtime, "123", executable, [process], [1]),
    ).toBe(true);
    for (const changes of [
      { pid: 401 },
      { executable: "C:\\staging\\cursor-atelier.exe" },
      { sessionId: 0 },
      { sessionId: 2 },
    ]) {
      expect(
        runningIdentityMatches(
          runtime,
          "123",
          executable,
          [{ ...process, ...changes }],
          [1],
        ),
      ).toBe(false);
    }
    expect(
      runningIdentityMatches(
        runtime,
        "123",
        executable,
        [process, { ...process, pid: 401 }],
        [1],
      ),
    ).toBe(false);
    expect(
      runningIdentityMatches(
        { ...runtime, buildVersion: "122" },
        "123",
        executable,
        [process],
        [1],
      ),
    ).toBe(false);
    expect(
      runningIdentityMatches(
        { ...runtime, rendererReady: false },
        "123",
        executable,
        [process],
        [1],
      ),
    ).toBe(false);
  });
});
