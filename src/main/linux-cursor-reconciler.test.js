import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinuxCursorReconciler } from "./linux-cursor-reconciler.js";

const reconcilers = [];
afterEach(() => {
  for (const reconciler of reconcilers.splice(0)) {
    reconciler.stop();
  }
  vi.useRealTimers();
});

function fixture(reconcile = vi.fn(async () => ({ desiredEnabled: false }))) {
  vi.useFakeTimers();
  const sockets = [];
  const connect = vi.fn(() => {
    const socket = new EventEmitter();
    socket.setEncoding = vi.fn();
    socket.destroy = vi.fn(() => socket.emit("close"));
    sockets.push(socket);
    return socket;
  });
  const onError = vi.fn();
  const onReconciled = vi.fn();
  const reconciler = createLinuxCursorReconciler({
    reconcile,
    onError,
    onReconciled,
    connect,
    env: { XDG_RUNTIME_DIR: "/private", HYPRLAND_INSTANCE_SIGNATURE: "test" },
    settleDelayMs: 50,
    retryDelaysMs: [100, 200],
  });
  reconcilers.push(reconciler);
  reconciler.start();
  return { reconciler, reconcile, onReconciled, onError, connect, sockets };
}

describe("event-driven Linux cursor persistence", () => {
  it("coalesces fragmented reload/display events and ignores ordinary window events", async () => {
    const { sockets, reconcile } = fixture();
    sockets[0].emit("data", "configreloa");
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).not.toHaveBeenCalled();
    sockets[0].emit(
      "data",
      "ded>>\nmonitoradded>>DP-1\nactivewindow>>app,title\n",
    );
    await vi.advanceTimersByTimeAsync(25);
    sockets[0].emit("data", "monitorremoved>>DP-2\n");
    await vi.advanceTimersByTimeAsync(49);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith({
      selectAppearance: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("serializes a reload arriving during an apply and retains pending appearance selection", async () => {
    let finish;
    const reconcile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        desiredEnabled: true,
        currentSentinelsMatchTheme: true,
      });
    const context = fixture(reconcile);
    context.reconciler.request();
    await vi.advanceTimersByTimeAsync(50);
    context.reconciler.request({ selectAppearance: true });
    context.sockets[0].emit("data", "configreloaded>>\n");
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).toHaveBeenCalledOnce();
    finish({ desiredEnabled: true, currentSentinelsMatchTheme: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(reconcile.mock.calls).toEqual([
      [{ selectAppearance: false }],
      [{ selectAppearance: true }],
    ]);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("bounds retries, rearms on a later event, and cancels work on shutdown", async () => {
    const error = new Error("Compositor still reloading");
    const context = fixture(vi.fn().mockRejectedValue(error));
    context.reconciler.request({ selectAppearance: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.reconcile).toHaveBeenCalledTimes(3);
    expect(
      context.reconcile.mock.calls.every(
        ([options]) => options.selectAppearance,
      ),
    ).toBe(true);
    expect(context.onError).toHaveBeenCalledExactlyOnceWith(error);
    context.sockets[0].emit("data", "configreloaded>>\n");
    await vi.advanceTimersByTimeAsync(50);
    expect(context.reconcile).toHaveBeenCalledTimes(4);
    context.reconciler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.reconcile).toHaveBeenCalledTimes(4);
    expect(context.sockets[0].destroy).toHaveBeenCalled();
  });

  it("reconnects a lost event socket and repairs changes missed while disconnected", async () => {
    const context = fixture();
    context.sockets[0].emit("error", new Error("Socket lost"));
    context.sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(100);
    expect(context.connect).toHaveBeenCalledTimes(2);
    context.sockets[1].emit("connect");
    await vi.advanceTimersByTimeAsync(50);
    expect(context.reconcile).toHaveBeenCalledOnce();
    expect(context.onError).not.toHaveBeenCalled();
  });
});
