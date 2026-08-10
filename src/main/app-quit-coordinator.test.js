import { describe, expect, it, vi } from "vitest";

import { createAppQuitCoordinator } from "./app-quit-coordinator.js";

describe("app quit coordinator", () => {
  it("cleans up once and exits without waiting for background work", () => {
    const cleanup = vi.fn();
    const exit = vi.fn();
    const queued = [];
    const coordinator = createAppQuitCoordinator({
      cleanup,
      exit,
      queueExit: (callback) => queued.push(callback),
    });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(first);
    coordinator.handleBeforeQuit(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);

    queued[0]();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits when cleanup reports a failure", () => {
    const error = new Error("cleanup failed");
    const onError = vi.fn();
    const exit = vi.fn();
    const coordinator = createAppQuitCoordinator({
      cleanup: () => {
        throw error;
      },
      exit,
      queueExit: (callback) => callback(),
      onError,
    });

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    expect(onError).toHaveBeenCalledWith(error);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
