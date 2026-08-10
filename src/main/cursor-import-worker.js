import { parentPort, workerData } from "node:worker_threads";

import { importCursorSource } from "./cursor-importer.js";

function serializedError(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    message:
      typeof error?.message === "string"
        ? error.message
        : "The cursor import worker failed.",
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
  };
}

void importCursorSource({
  ...workerData,
  onProgress(progress) {
    parentPort?.postMessage({ type: "progress", progress });
  },
}).then(
  (result) => parentPort?.postMessage({ type: "result", ok: true, result }),
  (error) =>
    parentPort?.postMessage({
      type: "result",
      ok: false,
      error: serializedError(error),
    }),
);
