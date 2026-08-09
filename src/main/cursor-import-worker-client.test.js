import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { importCursorSourceInWorker } from "./cursor-import-worker-client.js";

class FakeWorker extends EventEmitter {
  constructor(workerPath, options) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    this.terminate = vi.fn();
    FakeWorker.instance = this;
  }
}

describe("cursor import worker client", () => {
  it("runs an import in the configured worker and returns its result", async () => {
    const options = {
      sourcePath: "/source",
      stagingDirectory: "/staging",
    };
    const importing = importCursorSourceInWorker(options, {
      WorkerConstructor: FakeWorker,
      workerPath: "/build/cursor-import-worker.js",
    });

    expect(FakeWorker.instance.workerPath).toBe(
      "/build/cursor-import-worker.js",
    );
    expect(FakeWorker.instance.options).toEqual({ workerData: options });
    FakeWorker.instance.emit("message", {
      ok: true,
      result: { artifactCount: 2 },
    });

    await expect(importing).resolves.toEqual({ artifactCount: 2 });
    expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
  });

  it("preserves a typed importer failure across the worker boundary", async () => {
    const importing = importCursorSourceInWorker(
      {},
      {
        WorkerConstructor: FakeWorker,
        workerPath: "/build/cursor-import-worker.js",
      },
    );
    FakeWorker.instance.emit("message", {
      ok: false,
      error: {
        name: "CursorImportError",
        code: "LIMIT_EXCEEDED",
        message: "The source is too large.",
      },
    });

    await expect(importing).rejects.toMatchObject({
      name: "CursorImportError",
      code: "LIMIT_EXCEEDED",
      message: "The source is too large.",
    });
  });

  it("terminates and rejects a worker that never replies", async () => {
    let timeoutCallback;
    const timeoutHandle = { unref: vi.fn() };
    const setTimer = vi.fn((callback) => {
      timeoutCallback = callback;
      return timeoutHandle;
    });
    const clearTimer = vi.fn();
    const importing = importCursorSourceInWorker(
      {},
      {
        WorkerConstructor: FakeWorker,
        workerPath: "/build/cursor-import-worker.js",
        timeoutMs: 123,
        setTimer,
        clearTimer,
      },
    );

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 123);
    expect(timeoutHandle.unref).toHaveBeenCalledOnce();
    timeoutCallback();

    await expect(importing).rejects.toMatchObject({
      code: "CURSOR_IMPORT_TIMEOUT",
      message: "The cursor import took too long and was stopped.",
    });
    expect(clearTimer).toHaveBeenCalledWith(timeoutHandle);
    expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
  });
});
