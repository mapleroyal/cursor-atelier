import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import packageTools from "./windows-package.cjs";
import {
  activateWindowsUpdate,
  desktopContext,
  launchInDesktop,
  ordinaryDirectory,
  runningIdentityMatches,
  sameWindowsPath,
  windowsInstallPaths,
} from "./windows-install-support.mjs";

const {
  applicationId,
  executableName,
  verifyWindowsPackage,
  runningPackageProcesses,
  runPowerShell,
} = packageTools;
if (process.platform !== "win32") {
  throw new Error("This installer requires Windows.");
}
if (process.argv.length !== 2) {
  throw new Error("app:install does not accept arguments.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { installed, shortcut, runtimeFile } = windowsInstallPaths();
const executable = path.join(installed, executableName);
const staged = path.join(
  root,
  "out.noindex",
  `Cursor Atelier-win32-${process.arch}`,
);
const context = desktopContext();
const launchEnvironment = process.env.CURSOR_ATELIER_USER_DATA
  ? { CURSOR_ATELIER_USER_DATA: process.env.CURSOR_ATELIER_USER_DATA }
  : {};
const runKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const approvalKey =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const expectedRun = `"${executable}" --background`;
ordinaryDirectory(path.dirname(installed));
ordinaryDirectory(path.dirname(shortcut));

function readRegistrations() {
  const state = runPowerShell(
    `
$records = @(foreach ($keyPath in $data.keys) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
  try {
    $exists = $key -and ($key.GetValueNames() -contains $data.name)
    $kind = $null; $value = $null
    if ($exists) {
      $kind = $key.GetValueKind($data.name).ToString()
      $value = $key.GetValue($data.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($kind -eq 'Binary') { $value = [Convert]::ToBase64String($value) }
    }
    @{ path = $keyPath; exists = [bool]$exists; kind = $kind; value = $value }
  } finally { if ($key) { $key.Close() } }
})
$link = $null
if (Test-Path -LiteralPath $data.shortcut) {
  $shell = New-Object -ComObject WScript.Shell
  $item = $shell.CreateShortcut($data.shortcut)
  $link = @{ target = $item.TargetPath; arguments = $item.Arguments }
}
@{ records = $records; shortcut = $link } | ConvertTo-Json -Depth 5 -Compress
`,
    { keys: [runKey, approvalKey], name: applicationId, shortcut },
  );
  const run = state.records.find((record) => record.path === runKey);
  if (
    run.exists &&
    (run.kind !== "String" ||
      run.value.toLowerCase() !== expectedRun.toLowerCase())
  ) {
    throw new Error(
      "Refusing an unrecognized Cursor Atelier startup registration.",
    );
  }
  if (
    state.shortcut &&
    (!sameWindowsPath(state.shortcut.target, executable) ||
      state.shortcut.arguments)
  ) {
    throw new Error(`Refusing an unrecognized shortcut: ${shortcut}`);
  }
  return state;
}
const shortcutStat = fs.lstatSync(shortcut, { throwIfNoEntry: false });
if (shortcutStat && (!shortcutStat.isFile() || shortcutStat.isSymbolicLink())) {
  throw new Error(`Refusing an unexpected shortcut: ${shortcut}`);
}
const savedShortcut = shortcutStat ? fs.readFileSync(shortcut) : null;
const savedRegistrations = readRegistrations();
function restoreRegistrations() {
  runPowerShell(
    `
foreach ($record in $data.records) {
  if ($record.exists) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($record.path)
    try {
      $value = $record.value
      if ($record.kind -eq 'Binary') { $value = [Convert]::FromBase64String($value) }
      $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $record.kind)
      $key.SetValue($data.name, $value, $kind)
    } finally { $key.Close() }
  } else {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($record.path, $true)
    if ($key) { try { $key.DeleteValue($data.name, $false) } finally { $key.Close() } }
  }
}
`,
    { records: savedRegistrations.records, name: applicationId },
  );
  if (savedShortcut) {
    fs.writeFileSync(shortcut, savedShortcut);
  } else {
    fs.rmSync(shortcut, { force: true });
  }
}
function writeShortcut() {
  const temporary = `${shortcut}.incoming-${process.pid}.lnk`;
  try {
    runPowerShell(
      `
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($data.shortcut)
$link.TargetPath = $data.executable
$link.WorkingDirectory = $data.directory
$link.IconLocation = $data.executable + ',0'
$link.Description = 'Cursor Atelier'
$link.Save()
`,
      { shortcut: temporary, executable, directory: installed },
    );
    fs.renameSync(temporary, shortcut);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
async function waitForExit(timeout = 30000) {
  const deadline = Date.now() + timeout;
  let remaining;
  do {
    remaining = runningPackageProcesses(installed);
    if (!remaining.length) {
      return;
    }
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error(
    `Cursor Atelier still has processes in ${installed}: ${remaining.map((entry) => entry.pid).join(", ")}. Its installation was retained.`,
  );
}
async function stopInstalled(env = launchEnvironment) {
  if (!runningPackageProcesses(installed).length) {
    return;
  }
  const removeTask = launchInDesktop({
    executable,
    args: ["--quit-for-update"],
    env,
    context,
  });
  try {
    await waitForExit();
  } finally {
    removeTask();
  }
}
async function inspectInstalled(build) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-install-check-"),
  );
  const resultFile = path.join(temporary, "result.json");
  const env = {
    CURSOR_ATELIER_USER_DATA: path.join(temporary, "data"),
    CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION: "1",
  };
  const removeTask = launchInDesktop({
    executable,
    args: [`--installation-check=${resultFile}`],
    context,
    env,
  });
  try {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) {
      const status = removeTask.diagnostics();
      if (["exited", "failed"].includes(status.phase)) {
        throw new Error(
          `Installed app inspection failed: ${JSON.stringify(status)}`,
        );
      }
      await delay(300);
    }
    if (!fs.existsSync(resultFile)) {
      throw new Error(
        `The installed app's isolated renderer inspection timed out: ${JSON.stringify(removeTask.diagnostics())}`,
      );
    }
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (
      !sameWindowsPath(result.executablePath, executable) ||
      result.buildVersion !== build.buildVersion ||
      result.rendererReady !== true
    ) {
      throw new Error(
        "The installed app did not confirm the expected build and renderer.",
      );
    }
    await waitForExit();
  } catch (error) {
    // This instance only owns temporary inspection state. Cancel pending task
    // startup as well as the isolated process before rolling files back.
    removeTask.cancel();
    await waitForExit();
    throw error;
  } finally {
    removeTask();
    // A failing inspection may still own files; preserve its state for diagnosis.
    if (!runningPackageProcesses(installed).length) {
      fs.rmSync(temporary, { recursive: true });
    } else {
      process.stderr.write(`Retained inspection state: ${temporary}\n`);
    }
  }
}
async function launchInstalled(build) {
  const removeTask = launchInDesktop({
    executable,
    env: launchEnvironment,
    context,
  });
  try {
    const deadline = Date.now() + 60000;
    let observation;
    while (Date.now() < deadline) {
      const status = removeTask.diagnostics();
      if (["exited", "failed"].includes(status.phase)) {
        throw new Error(
          `Installed app launch failed: ${JSON.stringify(status)}`,
        );
      }
      try {
        const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
        const processes = runningPackageProcesses(installed);
        if (
          runningIdentityMatches(
            runtime,
            build.buildVersion,
            executable,
            processes,
            context.sessions,
          )
        ) {
          readRegistrations();
          return runtime;
        }
        const next = JSON.stringify({ runtime, processes });
        if (next !== observation) {
          process.stdout.write(`Waiting for installed identity: ${next}\n`);
          observation = next;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.message !== observation) {
          process.stderr.write(
            `Waiting for installed identity: ${error.message}\n`,
          );
          observation = error.message;
        }
      }
      await delay(300);
    }
    throw new Error(
      "The installed app did not confirm its desktop process and build identity.",
    );
  } catch (error) {
    await stopInstalled();
    // Prevent a delayed task from launching against files being rolled back.
    removeTask.cancel();
    throw error;
  } finally {
    removeTask();
  }
}

const stagedRunning = runningPackageProcesses(staged);
if (stagedRunning.length) {
  throw new Error("Close the staged package before installing it.");
}
const runningBefore = runningPackageProcesses(installed);
process.stdout.write(
  `${JSON.stringify({ installed, runningBefore, savedRegistrations, staged, runtimeFile }, null, 2)}\n`,
);
let runtime;
const result = await activateWindowsUpdate({
  staged,
  installed,
  verifyPackage: verifyWindowsPackage,
  stopInstalled,
  wasRunning: runningBefore.length > 0,
  activateInstalled: async (build) => {
    await inspectInstalled(build);
    writeShortcut();
    runtime = await launchInstalled(build);
    verifyWindowsPackage(installed, { selfTest: false });
  },
  restoreRegistrations,
  relaunchPrevious: launchInstalled,
  log: (message) => process.stderr.write(`${message}\n`),
});
process.stdout.write(
  `Installed and running Cursor Atelier ${result.build.version} (${result.build.buildVersion}), desktop PID ${runtime.pid}: ${executable}\n`,
);
if (result.recovery) {
  process.stdout.write(
    `Recoverable previous installation: ${result.recovery}\n`,
  );
}
process.stdout.write(
  "After verification, run npm run package:clean -- --dry-run, then npm run package:clean.\n",
);
