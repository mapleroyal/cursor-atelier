import { describe, expect, it, vi } from "vitest";

import {
  createWindowLifecycle,
  shouldMainAppStayRunning,
  shouldRegisterMainAppLoginItem,
} from "./window-lifecycle.js";

function fixture({
  isMacOS = true,
  menuBarVisible = true,
  automaticSwitching = false,
  automaticRandomization = false,
  randomizationMode = "launch",
} = {}) {
  let menuBar = menuBarVisible;
  let switchAutomatically = automaticSwitching;
  const visibleWindows = new Set();
  const setActivationPolicy = vi.fn();
  const quit = vi.fn();
  const hideWindow = vi.fn((window) => visibleWindows.delete(window));
  const lifecycle = createWindowLifecycle({
    isMacOS,
    setActivationPolicy,
    quit,
    getMenuBarVisible: () => menuBar,
    getShouldStayRunning: () =>
      shouldMainAppStayRunning({
        appearance: { automaticSwitching: switchAutomatically },
        menuBar: { visible: menuBar },
        randomization: {
          automaticEnabled: automaticRandomization,
          schedule: { mode: randomizationMode },
        },
      }),
    hasVisibleWindows: (excludedWindow) =>
      [...visibleWindows].some((window) => window !== excludedWindow),
    hideWindow,
  });

  return {
    lifecycle,
    setActivationPolicy,
    quit,
    hideWindow,
    addVisibleWindow(window) {
      visibleWindows.add(window);
    },
    setMenuBarVisible(visible) {
      menuBar = visible;
    },
    setAutomaticSwitching(enabled) {
      switchAutomatically = enabled;
    },
  };
}

function closeEvent() {
  return { preventDefault: vi.fn() };
}

describe("window lifecycle", () => {
  it("registers the Electron login item for either resident feature", () => {
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: true },
        menuBar: { visible: true },
      }),
    ).toBe(true);
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: true },
        menuBar: { visible: false },
        appearance: { automaticSwitching: true },
      }),
    ).toBe(true);
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: true },
        menuBar: { visible: false },
        randomization: {
          automaticEnabled: true,
          schedule: { mode: "launch" },
        },
      }),
    ).toBe(true);
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: true },
        menuBar: { visible: false },
        appearance: {
          automaticSwitching: false,
          lightCursorId: "OreoWhite",
        },
        randomization: {
          automaticEnabled: true,
          schedule: { mode: "interval" },
        },
      }),
    ).toBe(true);
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: true },
        menuBar: { visible: false },
        appearance: {
          automaticSwitching: false,
          lightCursorId: "OreoWhite",
        },
        randomization: {
          automaticEnabled: false,
          schedule: { mode: "interval" },
        },
      }),
    ).toBe(false);
    expect(
      shouldRegisterMainAppLoginItem({
        startup: { runInBackground: false },
        menuBar: { visible: true },
        appearance: { automaticSwitching: true },
      }),
    ).toBe(false);
  });

  it("does not keep a launch-only schedule resident after launch work", () => {
    const preferences = {
      startup: { runInBackground: true },
      menuBar: { visible: false },
      appearance: { automaticSwitching: false },
      randomization: {
        automaticEnabled: true,
        schedule: { mode: "launch" },
      },
    };

    expect(shouldRegisterMainAppLoginItem(preferences)).toBe(true);
    expect(shouldMainAppStayRunning(preferences)).toBe(false);
  });

  it("moves between regular window presence and an accessory background app", () => {
    const { lifecycle, setActivationPolicy } = fixture();

    lifecycle.prepareToShowWindow();
    lifecycle.prepareToShowWindow();
    lifecycle.enterBackground();
    lifecycle.prepareToShowWindow();

    expect(setActivationPolicy.mock.calls).toEqual([
      ["regular"],
      ["accessory"],
      ["regular"],
    ]);
  });

  it("hides the last window and becomes an accessory app when the menu bar remains enabled", () => {
    const { lifecycle, setActivationPolicy, hideWindow, addVisibleWindow } =
      fixture();
    const window = {};
    const event = closeEvent();
    addVisibleWindow(window);
    lifecycle.prepareToShowWindow();

    expect(lifecycle.handleWindowClose(event, window)).toBe("hide");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(hideWindow).toHaveBeenCalledWith(window);
    expect(setActivationPolicy.mock.calls).toEqual([
      ["regular"],
      ["accessory"],
    ]);

    lifecycle.prepareToShowWindow();
    expect(setActivationPolicy).toHaveBeenLastCalledWith("regular");
  });

  it("allows one window to close while another visible window keeps the app regular", () => {
    const { lifecycle, setActivationPolicy, hideWindow, addVisibleWindow } =
      fixture();
    const firstWindow = {};
    const secondWindow = {};
    const event = closeEvent();
    addVisibleWindow(firstWindow);
    addVisibleWindow(secondWindow);
    lifecycle.prepareToShowWindow();

    expect(lifecycle.handleWindowClose(event, firstWindow)).toBe("close");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(hideWindow).not.toHaveBeenCalled();
    expect(setActivationPolicy).toHaveBeenCalledOnce();
  });

  it("waits for an open window to close after the menu bar is disabled", () => {
    const { lifecycle, quit, addVisibleWindow, setMenuBarVisible } = fixture();
    const window = {};
    const event = closeEvent();
    addVisibleWindow(window);
    lifecycle.prepareToShowWindow();
    setMenuBarVisible(false);

    expect(lifecycle.handleBackgroundPreferenceChanged(false)).toBe("stay");
    expect(quit).not.toHaveBeenCalled();
    expect(lifecycle.handleWindowClose(event, window)).toBe("close");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(lifecycle.handleAllWindowsClosed()).toBe("quit");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits when the menu bar is disabled without a visible window", () => {
    const { lifecycle, quit, setMenuBarVisible } = fixture();
    lifecycle.enterBackground();
    setMenuBarVisible(false);

    expect(lifecycle.handleBackgroundPreferenceChanged(false)).toBe("quit");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits a stale background login when the menu bar is disabled", () => {
    const { lifecycle, setActivationPolicy, quit } = fixture({
      menuBarVisible: false,
    });

    expect(lifecycle.enterBackground()).toBe(true);
    expect(setActivationPolicy).toHaveBeenCalledWith("accessory");
    expect(lifecycle.handleBackgroundPreferenceChanged(false)).toBe("quit");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("closes the last window but stays resident for automatic switching", () => {
    const { lifecycle, setActivationPolicy, quit, addVisibleWindow } = fixture({
      menuBarVisible: false,
      automaticSwitching: true,
    });
    const window = {};
    const event = closeEvent();
    addVisibleWindow(window);
    lifecycle.prepareToShowWindow();

    expect(lifecycle.handleWindowClose(event, window)).toBe("close-background");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(setActivationPolicy.mock.calls).toEqual([
      ["regular"],
      ["accessory"],
    ]);
    expect(lifecycle.handleAllWindowsClosed()).toBe("stay");
    expect(quit).not.toHaveBeenCalled();
  });

  it("does not quit when the menu bar is hidden but switching stays enabled", () => {
    const { lifecycle, quit, setMenuBarVisible, setAutomaticSwitching } =
      fixture();
    lifecycle.enterBackground();
    setAutomaticSwitching(true);
    setMenuBarVisible(false);

    expect(lifecycle.handleBackgroundPreferenceChanged(true)).toBe("stay");
    expect(quit).not.toHaveBeenCalled();
  });

  it("allows Cmd+Q to close windows without converting the app to an accessory", () => {
    const { lifecycle, setActivationPolicy, quit, addVisibleWindow } =
      fixture();
    const window = {};
    const event = closeEvent();
    addVisibleWindow(window);
    lifecycle.prepareToShowWindow();
    lifecycle.beginQuit();

    expect(lifecycle.handleWindowClose(event, window)).toBe("close");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(lifecycle.handleAllWindowsClosed()).toBe("stay");
    expect(setActivationPolicy).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("does not manipulate activation policy outside macOS", () => {
    const { lifecycle, setActivationPolicy } = fixture({ isMacOS: false });

    lifecycle.prepareToShowWindow();
    lifecycle.enterBackground();

    expect(setActivationPolicy).not.toHaveBeenCalled();
  });

  it("keeps Linux tray and scheduled features available after the last window closes", () => {
    const tray = fixture({ isMacOS: false });
    const window = {};
    tray.addVisibleWindow(window);
    expect(tray.lifecycle.handleWindowClose(closeEvent(), window)).toBe("hide");
    expect(tray.hideWindow).toHaveBeenCalledWith(window);
    expect(tray.lifecycle.handleAllWindowsClosed()).toBe("stay");
    expect(tray.setActivationPolicy).not.toHaveBeenCalled();

    const scheduled = fixture({
      isMacOS: false,
      menuBarVisible: false,
      automaticRandomization: true,
      randomizationMode: "interval",
    });
    expect(scheduled.lifecycle.handleAllWindowsClosed()).toBe("stay");
    expect(scheduled.quit).not.toHaveBeenCalled();
  });
});
