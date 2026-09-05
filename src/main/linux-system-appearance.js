import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const destination = "org.freedesktop.portal.Desktop";
const objectPath = "/org/freedesktop/portal/desktop";
const appearanceNamespace = "org.freedesktop.appearance";
const portalArguments = [
  "--session",
  "--dest",
  destination,
  "--object-path",
  objectPath,
];

// Electron's themeSource also overrides shouldUseDarkColors on Linux. Read the
// desktop preference independently so a forced app theme never changes which
// cursor appearance automation selects. ReadAll and SettingChanged are the
// standard, read-only Settings portal API shared by GNOME, KDE and wlroots.
export function createLinuxSystemAppearance({
  nativeTheme,
  onChange = () => {},
  onError = () => {},
  execFileImpl = execFileAsync,
  spawnImpl = spawn,
} = {}) {
  let appearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  let portalAvailable = false;
  let stopped = true;
  let monitor = null;
  let retryTimer = null;
  let readPromise = null;

  function update(value) {
    if (stopped || value === appearance) {
      return;
    }
    appearance = value;
    onChange(appearance);
  }

  function acceptPortalValue(value) {
    portalAvailable = true;
    // The portal reserves 1 for dark; unknown values mean no preference.
    update(Number(value) === 1 ? "dark" : "light");
  }

  function nativeUpdated() {
    if (!portalAvailable && nativeTheme.themeSource === "system") {
      update(nativeTheme.shouldUseDarkColors ? "dark" : "light");
    }
  }

  function readPortal() {
    if (readPromise || stopped) {
      return readPromise;
    }
    readPromise = execFileImpl(
      "gdbus",
      [
        "call",
        ...portalArguments,
        "--method",
        "org.freedesktop.portal.Settings.ReadAll",
        `["${appearanceNamespace}"]`,
      ],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    )
      .then(({ stdout }) => {
        if (stopped) {
          return;
        }
        const value = stdout.match(/['"]color-scheme['"]:\s*<uint32\s+(\d+)>/);
        if (!value) {
          throw new Error(
            "The desktop Settings portal returned no color scheme.",
          );
        }
        acceptPortalValue(value[1]);
      })
      .catch((error) => {
        if (!stopped) {
          portalAvailable = false;
          nativeUpdated();
          onError(error);
        }
      })
      .finally(() => {
        readPromise = null;
      });
    return readPromise;
  }

  function startMonitor() {
    if (stopped) {
      return;
    }
    const child = spawnImpl("gdbus", ["monitor", ...portalArguments], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    monitor = child;
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > 64 * 1024) {
        buffered = "";
        void readPortal();
        return;
      }
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        const change = line.match(
          /org\.freedesktop\.portal\.Settings\.SettingChanged\s+\(['"]org\.freedesktop\.appearance['"],\s*['"]color-scheme['"],\s*<uint32\s+(\d+)>\)/,
        );
        if (change) {
          acceptPortalValue(change[1]);
        } else if (line.startsWith(`The name ${destination} is owned by `)) {
          void readPortal();
        } else if (
          line.startsWith(`The name ${destination} does not have an owner`)
        ) {
          portalAvailable = false;
        }
      }
    });
    // Drain diagnostics so the child's pipe cannot stall the monitor.
    child.stderr.resume();
    child.on("error", (error) => {
      if (!stopped) {
        onError(error);
      }
    });
    child.once("close", () => {
      if (monitor === child) {
        monitor = null;
      }
      if (!stopped) {
        portalAvailable = false;
        retryTimer = setTimeout(startMonitor, 30_000);
        retryTimer.unref?.();
      }
    });
    void readPortal();
  }

  return {
    get: () => appearance,
    async start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      nativeTheme.on("updated", nativeUpdated);
      startMonitor();
      await readPromise;
    },
    stop() {
      stopped = true;
      nativeTheme.off("updated", nativeUpdated);
      clearTimeout(retryTimer);
      retryTimer = null;
      monitor?.kill("SIGTERM");
      monitor = null;
    },
  };
}
