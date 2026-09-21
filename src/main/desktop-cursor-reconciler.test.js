import { afterEach, expect, it, vi } from "vitest";
import { createDesktopCursorReconciler } from "./desktop-cursor-reconciler.js";

const reconcilers = [];
afterEach(() => {
  for (const reconciler of reconcilers.splice(0)) {
    reconciler.stop();
  }
  vi.useRealTimers();
});

it("coalesces Windows desktop changes without changing direct-selection intent", async () => {
  vi.useFakeTimers();
  let finish;
  const status = { desiredEnabled: false, currentSentinelsMatchTheme: false };
  const reconcile = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(status);
  const onReconciled = vi.fn();
  const reconciler = createDesktopCursorReconciler({
    reconcile,
    onReconciled,
    settleDelayMs: 50,
  });
  reconcilers.push(reconciler);
  reconciler.request();
  reconciler.request();
  await vi.advanceTimersByTimeAsync(50);
  expect(reconcile).toHaveBeenCalledExactlyOnceWith({
    selectAppearance: false,
  });
  reconciler.request({ selectAppearance: true });
  reconciler.request();
  await vi.advanceTimersByTimeAsync(500);
  expect(reconcile).toHaveBeenCalledOnce();
  expect(onReconciled).not.toHaveBeenCalled();
  finish(status);
  await vi.advanceTimersByTimeAsync(50);
  expect(reconcile).toHaveBeenLastCalledWith({ selectAppearance: true });
  expect(onReconciled).toHaveBeenLastCalledWith(status);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
});

it("reports failed reconciliation without claiming a cursor is active and cancels retries on quit", async () => {
  vi.useFakeTimers();
  const error = new Error("Desktop unavailable");
  const reconcile = vi.fn().mockRejectedValue(error);
  const onError = vi.fn();
  const onReconciled = vi.fn();
  const reconciler = createDesktopCursorReconciler({
    reconcile,
    onError,
    onReconciled,
    settleDelayMs: 50,
    retryDelaysMs: [100],
  });
  reconcilers.push(reconciler);
  reconciler.request();
  await vi.advanceTimersByTimeAsync(150);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(onReconciled).not.toHaveBeenCalled();
  reconciler.request();
  reconciler.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
});
