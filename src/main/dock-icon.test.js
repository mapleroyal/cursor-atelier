import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getDockIconFilename, syncDockIcon } from "./dock-icon.js";

describe("Dock appearance icon", () => {
  it("maps only the dark system appearance to dark artwork", () => {
    expect(getDockIconFilename("dark")).toBe("DockIconDark.png");
    expect(getDockIconFilename("light")).toBe("DockIconLight.png");
    expect(getDockIconFilename("unknown")).toBe("DockIconLight.png");
  });

  it("loads and installs the matching high-density image family", () => {
    const image = { isEmpty: () => false };
    const nativeImage = { createFromPath: vi.fn(() => image) };
    const dock = { setIcon: vi.fn() };

    expect(
      syncDockIcon({
        isMacOS: true,
        appearance: "dark",
        resourcesRoot: "/app/resources",
        dock,
        nativeImage,
      }),
    ).toBe(true);
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(
      path.join("/app/resources", "DockIconDark.png"),
    );
    expect(dock.setIcon).toHaveBeenCalledWith(image);
  });

  it("stays inert off macOS and reports missing artwork", () => {
    const onError = vi.fn();
    const dock = { setIcon: vi.fn() };
    expect(syncDockIcon({ isMacOS: false, dock })).toBe(false);
    expect(dock.setIcon).not.toHaveBeenCalled();

    expect(
      syncDockIcon({
        isMacOS: true,
        appearance: "light",
        resourcesRoot: "/app/resources",
        dock,
        nativeImage: {
          createFromPath: () => ({ isEmpty: () => true }),
        },
        onError,
      }),
    ).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });
});
