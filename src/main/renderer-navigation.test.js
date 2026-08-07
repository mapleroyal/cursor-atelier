import { describe, expect, it, vi } from "vitest";

import { createRendererNavigation } from "./renderer-navigation.js";

function webContents(id = 1) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
}

describe("renderer navigation", () => {
  it("retains navigation until the renderer listener is ready", () => {
    const target = webContents();
    const navigation = createRendererNavigation();

    expect(navigation.queue(target, "settings")).toBe(false);
    expect(target.send).not.toHaveBeenCalled();

    expect(navigation.markReady(target)).toBe(true);
    expect(target.send).toHaveBeenCalledOnce();
    expect(target.send).toHaveBeenCalledWith("app:navigate", "settings");
    expect(navigation.markReady(target)).toBe(false);
    expect(target.send).toHaveBeenCalledOnce();
  });

  it("delivers immediately only while the renderer remains ready", () => {
    const target = webContents();
    const navigation = createRendererNavigation();

    navigation.markReady(target);
    expect(navigation.queue(target, "settings")).toBe(true);

    navigation.markNotReady(target);
    expect(navigation.queue(target, "catalog")).toBe(false);
    expect(target.send).toHaveBeenCalledOnce();

    navigation.markReady(target);
    expect(target.send).toHaveBeenLastCalledWith("app:navigate", "catalog");
  });

  it("disposes pending state by identifier after a window is destroyed", () => {
    const target = webContents();
    const navigation = createRendererNavigation();

    navigation.queue(target, "settings");
    navigation.dispose(target.id);
    expect(navigation.markReady(target)).toBe(false);
    expect(target.send).not.toHaveBeenCalled();
  });
});
