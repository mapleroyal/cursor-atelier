import { createConnection } from "node:net";
import path from "node:path";
import { createDesktopCursorReconciler } from "./desktop-cursor-reconciler.js";

const DESKTOP_EVENTS = new Set([
  "configreloaded",
  "monitoradded",
  "monitorremoved",
]);
const RETRY_DELAYS_MS = [500, 1_000, 3_000];

// Hyprland's config reload can reset cursor environment after an apply has
// started. Listen for completed reloads/display changes, then reconcile through
// the app's existing mutation queue. Only failed work is retried; no polling.
export function createLinuxCursorReconciler({
  reconcile,
  onReconciled = () => {},
  onError = () => {},
  env = process.env,
  connect = createConnection,
  settleDelayMs = 250,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  let stopped = false;
  const scheduler = createDesktopCursorReconciler({
    reconcile,
    onReconciled,
    onError,
    settleDelayMs,
    retryDelaysMs,
  });
  let socket = null;
  let reconnectTimer = null;
  let reconnectIndex = 0;
  const socketPath =
    env.HYPRLAND_INSTANCE_SIGNATURE && env.XDG_RUNTIME_DIR
      ? path.join(
          env.XDG_RUNTIME_DIR,
          "hypr",
          env.HYPRLAND_INSTANCE_SIGNATURE,
          ".socket2.sock",
        )
      : null;

  function request(options) {
    if (stopped) {
      return;
    }
    scheduler.request(options);
    if (!socket && !reconnectTimer) {
      reconnectIndex = 0;
      start();
    }
  }

  function start() {
    if (stopped || !socketPath || socket) {
      return;
    }
    const connection = connect(socketPath);
    socket = connection;
    let buffered = "";
    let connectionError = null;
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      reconnectIndex = 0;
      // Also repair any changes missed while the connection was unavailable.
      request();
    });
    connection.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (DESKTOP_EVENTS.has(line.split(">>", 1)[0])) {
          request();
        }
      }
      if (buffered.length > 64 * 1024) {
        buffered = "";
      }
    });
    connection.on("error", (error) => {
      connectionError = error;
    });
    connection.once("close", () => {
      if (socket === connection) {
        socket = null;
      }
      if (stopped) {
        return;
      }
      if (reconnectIndex < retryDelaysMs.length) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          start();
        }, retryDelaysMs[reconnectIndex++]);
        reconnectTimer.unref?.();
      } else {
        onError(
          connectionError ?? new Error("Hyprland's event connection closed."),
        );
      }
    });
  }

  return {
    start,
    request,
    stop() {
      stopped = true;
      scheduler.stop();
      clearTimeout(reconnectTimer);
      socket?.destroy();
      socket = null;
    },
  };
}
