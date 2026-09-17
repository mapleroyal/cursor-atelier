import { createConnection } from "node:net";
import path from "node:path";

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
  let timer = null;
  let running = false;
  let pending = false;
  let selectAppearance = false;
  let retryIndex = 0;
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

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(perform, delay);
    timer.unref?.();
  }

  async function perform() {
    timer = null;
    if (stopped || running) {
      return;
    }
    running = true;
    pending = false;
    const appearance = selectAppearance;
    selectAppearance = false;
    let nextDelay = settleDelayMs;
    try {
      const status = await reconcile({ selectAppearance: appearance });
      if (!stopped) {
        onReconciled(status);
      }
      retryIndex = 0;
    } catch (error) {
      if (!stopped) {
        // A newer event already queued another attempt. Otherwise retry this
        // incident a bounded number of times while the desktop settles.
        selectAppearance ||= appearance;
        if (!pending && retryIndex < retryDelaysMs.length) {
          nextDelay = retryDelaysMs[retryIndex++];
          pending = true;
        } else if (!pending) {
          selectAppearance = false;
          onError(error);
        }
      }
    } finally {
      running = false;
      if (!stopped && pending) {
        schedule(nextDelay);
      }
    }
  }

  function request({ selectAppearance: appearance = false } = {}) {
    if (stopped) {
      return;
    }
    pending = true;
    selectAppearance ||= appearance;
    retryIndex = 0;
    if (!running) {
      schedule(settleDelayMs);
    }
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
      clearTimeout(timer);
      clearTimeout(reconnectTimer);
      socket?.destroy();
      socket = null;
    },
  };
}
