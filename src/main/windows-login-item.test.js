import { describe, expect, it, vi } from "vitest";
import {
  createWindowsLoginItem,
  getWindowsCursorLoginStatus,
} from "./windows-login-item.js";
import { createCursorBridge } from "./cursor-bridge.js";
import { isVerifiedRestoredStatus } from "./cursor-state-service.js";

describe("Windows startup registration", () => {
  it("uses the exact executable and background arguments for writes and reads", () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [
          {
            name: "com.cursoratelier.CursorAtelier",
            scope: "user",
            enabled: true,
          },
        ],
      })),
      setLoginItemSettings: vi.fn(),
    };
    const executablePath =
      "C:\\Users\\Agent\\AppData\\Local\\Programs\\Cursor Atelier\\cursor-atelier.exe";
    const item = createWindowsLoginItem({ app, executablePath });
    item.setLoginItemSettings({ openAtLogin: true });
    const settings = app.setLoginItemSettings.mock.calls[0][0];
    expect(settings).toMatchObject({
      path: executablePath,
      args: ["--background"],
      name: "com.cursoratelier.CursorAtelier",
      openAtLogin: true,
    });
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: `"${executablePath}"`,
      args: settings.args,
    });
    expect(item.getLoginItemSettings().status).toBe("enabled");
  });
  it("does not mistake another enabled startup entry for the disabled app entry", () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [
          { name: "another-entry", scope: "user", enabled: true },
          {
            name: "com.cursoratelier.CursorAtelier",
            scope: "machine",
            enabled: true,
          },
          {
            name: "com.cursoratelier.CursorAtelier",
            scope: "user",
            enabled: false,
          },
        ],
      })),
      setLoginItemSettings: vi.fn(),
    };
    const item = createWindowsLoginItem({ app });
    expect(item.getLoginItemSettings().status).toBe("requires-approval");
    item.setLoginItemSettings({ openAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("preserves a Startup Apps disable until the user explicitly toggles startup", () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({
        openAtLogin: true,
        executableWillLaunchAtLogin: false,
        launchItems: [
          {
            name: "com.cursoratelier.CursorAtelier",
            scope: "user",
            enabled: false,
          },
        ],
      })),
      setLoginItemSettings: vi.fn(),
    };
    const executablePath =
      "C:\\Users\\Agent\\AppData\\Local\\Programs\\Cursor Atelier\\cursor-atelier.exe";
    const item = createWindowsLoginItem({ app, executablePath });
    item.setLoginItemSettings({ openAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(item.getLoginItemSettings().status).toBe("requires-approval");
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: `"${executablePath}"`,
      args: ["--background"],
    });
    item.setLoginItemSettings({ openAtLogin: false });
    item.setLoginItemSettings({ openAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe("Windows cursor startup status", () => {
  it.each(["enabled", "requires-approval", "not-registered"])(
    "verifies cursor restore when independent app startup is %s",
    async (loginStatus) => {
      const app = {
        getLoginItemSettings: vi.fn(() => ({
          openAtLogin: loginStatus !== "not-registered",
          executableWillLaunchAtLogin: loginStatus === "enabled",
          launchItems:
            loginStatus === "not-registered"
              ? []
              : [
                  {
                    name: "com.cursoratelier.CursorAtelier",
                    scope: "user",
                    enabled: loginStatus === "enabled",
                  },
                ],
        })),
        setLoginItemSettings: vi.fn(),
      };
      const item = createWindowsLoginItem({ app });
      const bridge = createCursorBridge({
        discover: false,
        manifestData: { schemaVersion: 2, themes: [] },
        commandRunner: async ({ command }) => {
          expect(command).toBe("--teardown");
          return {
            supported: true,
            themeValid: false,
            selectedThemeIdentifier: "",
            desiredEnabled: false,
            effectiveApplied: false,
            currentSentinelsMatchTheme: false,
            launchAtLoginDesired: false,
            loginApprovalRequired: false,
            loginItemRegistrationCurrent: false,
            transactionPending: false,
          };
        },
        onStatus: (status) =>
          Object.assign(
            status,
            getWindowsCursorLoginStatus(status, item.getLoginItemSettings()),
          ),
      });

      const restored = await bridge.restore();
      expect(isVerifiedRestoredStatus(restored)).toBe(true);
      expect(restored.loginApprovalRequired).toBe(false);
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(item.getLoginItemSettings().status).toBe(loginStatus);
    },
  );

  it.each([
    ["enabled", true, false],
    ["requires-approval", false, true],
    ["not-registered", false, false],
  ])(
    "reports applied cursor startup when the app is %s",
    (status, registered, approvalRequired) => {
      expect(
        getWindowsCursorLoginStatus({ desiredEnabled: true }, { status }),
      ).toEqual({
        loginItemRegistrationCurrent: registered,
        loginApprovalRequired: approvalRequired,
      });
    },
  );
});
