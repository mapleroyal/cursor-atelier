import path from "node:path";
import { Worker } from "node:worker_threads";

const DEFAULT_WORKER_PATH = path.join(__dirname, "cursor-import-worker.js");
const CURSOR_IMPORT_WORKER_TIMEOUT_MS = 60 * 60 * 1000;

function workerError(payload) {
  const error = new Error(
    typeof payload?.message === "string"
      ? payload.message
      : "The cursor import worker failed.",
  );
  if (typeof payload?.name === "string") {
    error.name = payload.name;
  }
  if (typeof payload?.code === "string") {
    error.code = payload.code;
  }
  if (typeof payload?.stack === "string") {
    error.stack = payload.stack;
  }
  return error;
}

export function importCursorSourceInWorker(
  options,
  {
    WorkerConstructor = Worker,
    workerPath = DEFAULT_WORKER_PATH,
    timeoutMs = CURSOR_IMPORT_WORKER_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const { onProgress, ...workerOptions } = options ?? {};
    if (onProgress !== undefined && typeof onProgress !== "function") {
      const error = new TypeError("onProgress must be a function.");
      error.code = "INVALID_OPTIONS";
      reject(error);
      return;
    }
    let settled = false;
    let worker;
    let timeoutHandle;
    let timeoutScheduled = false;
    const finish = async (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutScheduled) {
        clearTimer(timeoutHandle);
        timeoutHandle = undefined;
        timeoutScheduled = false;
      }
      worker?.removeAllListeners();
      try {
        await worker?.terminate();
      } catch {
        // The original result is authoritative; termination errors must not
        // become unhandled rejections or hide the import failure.
      }
      callback(value);
    };

    try {
      worker = new WorkerConstructor(workerPath, {
        workerData: workerOptions,
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (error) {
      void finish(reject, error);
      return;
    }
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        try {
          onProgress?.(message.progress);
        } catch {
          // Progress observers cannot cancel or fail the conversion worker.
        }
        return;
      }
      if (message?.ok === true) {
        void finish(resolve, message.result);
      } else {
        void finish(reject, workerError(message?.error));
      }
    });
    worker.once("error", (error) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
        error = Object.assign(
          new Error(
            "The cursor import exceeded its memory limit and was stopped.",
          ),
          { code: "LIMIT_EXCEEDED" },
        );
      }
      void finish(reject, error);
    });
    worker.once("exit", (code) => {
      if (!settled) {
        void finish(
          reject,
          new Error(
            `The cursor import worker exited before replying (code ${code}).`,
          ),
        );
      }
    });
    timeoutScheduled = true;
    timeoutHandle = setTimer(() => {
      const error = new Error(
        "The cursor import took too long and was stopped.",
      );
      error.code = "CURSOR_IMPORT_TIMEOUT";
      void finish(reject, error);
    }, timeoutMs);
    timeoutHandle?.unref?.();
  });
}
