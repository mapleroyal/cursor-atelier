import fs from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

function loadPreload({ appearanceMode = "dark" } = {}) {
  let exposedApi;
  const ipcRenderer = {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(() => appearanceMode),
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: vi.fn((_name, api) => {
        exposedApi = api;
      }),
    },
    ipcRenderer,
  };
  const source = fs.readFileSync(
    new URL("./preload.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    require(identifier) {
      if (identifier === "electron") {
        return electron;
      }
      throw new Error(`Unexpected preload dependency: ${identifier}`);
    },
  });
  return { api: exposedApi, ipcRenderer };
}

describe("sandbox preload", () => {
  it("hydrates app appearance synchronously through main-process IPC", () => {
    const { api, ipcRenderer } = loadPreload({ appearanceMode: "dark" });

    expect(api.getAppAppearanceMode()).toBe("dark");
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(
      "app:get-appearance-mode",
    );
  });

  it("keeps appearance writes on the asynchronous IPC path", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.setAppAppearanceMode("light");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "app:set-appearance-mode",
      "light",
    );
  });

  it("falls back safely if main returns an invalid mode", () => {
    const { api } = loadPreload({ appearanceMode: "sepia" });

    expect(api.getAppAppearanceMode()).toBe("system");
  });
});
