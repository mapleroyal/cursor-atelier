import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createLinuxSystemAppearance } from "./linux-system-appearance.js";

function fixture({
  stdout = "({'org.freedesktop.appearance': {'color-scheme': <uint32 2>}},)",
  error,
  pendingRead,
} = {}) {
  const nativeTheme = Object.assign(new EventEmitter(), {
    shouldUseDarkColors: false,
    themeSource: "system",
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const changed = vi.fn();
  const onError = vi.fn();
  const execFileImpl = pendingRead
    ? vi.fn(() => pendingRead)
    : error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue({ stdout });
  const monitor = createLinuxSystemAppearance({
    nativeTheme,
    onChange: changed,
    onError,
    execFileImpl,
    spawnImpl: () => child,
  });
  return { monitor, nativeTheme, child, changed, onError };
}

describe("Linux system appearance", () => {
  test.each(["resolved", "rejected"])(
    "keeps a newer appearance signal when the initial read is %s late",
    async (result) => {
      let resolveRead;
      let rejectRead;
      const pendingRead = new Promise((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      const { monitor, child, changed, onError } = fixture({ pendingRead });
      const started = monitor.start();
      child.stdout.write(
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)\n",
      );
      if (result === "resolved") {
        resolveRead({
          stdout:
            "({'org.freedesktop.appearance': {'color-scheme': <uint32 2>}},)",
        });
      } else {
        rejectRead(new Error("Old portal read disconnected"));
      }
      await started;
      expect(monitor.get()).toBe("dark");
      expect(changed).toHaveBeenCalledExactlyOnceWith("dark");
      expect(onError).not.toHaveBeenCalled();
      monitor.stop();
    },
  );

  test("keeps the portal preference independent from a forced app theme", async () => {
    const { monitor, nativeTheme, changed } = fixture();
    await monitor.start();
    nativeTheme.themeSource = "dark";
    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");
    expect(monitor.get()).toBe("light");
    expect(changed).not.toHaveBeenCalled();
    monitor.stop();
  });

  test("handles split Settings signals and emits only actual appearance changes", async () => {
    const { monitor, child, changed } = fixture();
    await monitor.start();
    const signal =
      "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)\n";
    child.stdout.write(signal.slice(0, 60));
    expect(monitor.get()).toBe("light");
    child.stdout.write(signal.slice(60));
    child.stdout.write(signal);
    expect(monitor.get()).toBe("dark");
    expect(changed).toHaveBeenCalledExactlyOnceWith("dark");
    monitor.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("uses native updates only in system mode when the portal is unavailable", async () => {
    const { monitor, nativeTheme, onError } = fixture({
      error: new Error("No portal"),
    });
    await monitor.start();
    expect(onError).toHaveBeenCalledOnce();
    nativeTheme.themeSource = "dark";
    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");
    expect(monitor.get()).toBe("light");
    nativeTheme.themeSource = "system";
    nativeTheme.emit("updated");
    expect(monitor.get()).toBe("dark");
    monitor.stop();
    expect(nativeTheme.listenerCount("updated")).toBe(0);
  });
});
