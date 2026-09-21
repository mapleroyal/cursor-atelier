import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import packageTools from "./windows-package.cjs";
const { runPowerShell } = packageTools;

export function sameWindowsPath(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    path.win32.resolve(left).toLowerCase() ===
      path.win32.resolve(right).toLowerCase()
  );
}
export function runningIdentityMatches(
  runtime,
  buildVersion,
  executable,
  processes,
  sessions,
) {
  const mains = processes.filter((entry) => entry.main);
  return (
    runtime?.rendererReady === true &&
    runtime.buildVersion === buildVersion &&
    sameWindowsPath(runtime.executablePath, executable) &&
    mains.length === 1 &&
    mains[0].pid === runtime.pid &&
    sameWindowsPath(mains[0].executable, executable) &&
    mains[0].sessionId > 0 &&
    sessions.includes(mains[0].sessionId)
  );
}
export function windowsInstallPaths(env = process.env) {
  for (const name of ["LOCALAPPDATA", "APPDATA"]) {
    if (!env[name] || !path.isAbsolute(env[name])) {
      throw new Error(`A Windows user profile with ${name} is required.`);
    }
  }
  if (
    env.CURSOR_ATELIER_USER_DATA &&
    !path.isAbsolute(env.CURSOR_ATELIER_USER_DATA)
  ) {
    throw new Error("CURSOR_ATELIER_USER_DATA must be absolute.");
  }
  return {
    installed: path.join(env.LOCALAPPDATA, "Programs", "Cursor Atelier"),
    shortcut: path.join(
      env.APPDATA,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Cursor Atelier.lnk",
    ),
    runtimeFile: path.join(
      env.CURSOR_ATELIER_USER_DATA || path.join(env.APPDATA, "Cursor Atelier"),
      "runtime.json",
    ),
  };
}
export function ordinaryDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) {
    ordinaryDirectory(parent);
  }
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory);
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Refusing an unexpected installation directory: ${directory}`,
    );
  }
}
export function desktopContext() {
  const context = runPowerShell(`
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessions = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'" | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
  if ($owner.Sid -eq $sid -and $_.SessionId -gt 0) { [int]$_.SessionId }
} | Sort-Object -Unique)
@{ sid = $sid; sessions = $sessions } | ConvertTo-Json -Compress
`);
  if (!context?.sessions?.length) {
    throw new Error(
      "Sign in to the Windows desktop before installing Cursor Atelier.",
    );
  }
  return context;
}
function quoteWindowsArgument(argument) {
  if (/[\0\r\n]/.test(argument)) {
    throw new Error("Invalid Windows launch argument.");
  }
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
// Interactive-token tasks put SSH launches in the user's desktop session.
// No password is stored, and no trigger remains after the launch is verified.
export function launchInDesktop({ executable, args = [], env = {}, context }) {
  const taskName = `CursorAtelier-Install-${randomUUID()}`;
  const diagnosticDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-launch-"),
  );
  const statusFile = path.join(diagnosticDirectory, "status.json");
  const stderrFile = path.join(diagnosticDirectory, "stderr.txt");
  const payload = Buffer.from(
    JSON.stringify({
      executable,
      commandLine: args.map(quoteWindowsArgument).join(" "),
      env,
      statusFile,
      stderrFile,
      stdoutFile: path.join(diagnosticDirectory, "stdout.txt"),
    }),
    "utf8",
  ).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
function Write-Status($value) { [IO.File]::WriteAllText($data.statusFile, ($value | ConvertTo-Json -Compress)) }
try {
  foreach ($entry in $data.env.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
  }
  Write-Status @{ phase = 'starting'; executable = $data.executable }
  $parameters = @{
    FilePath = $data.executable; WorkingDirectory = [IO.Path]::GetDirectoryName($data.executable)
    PassThru = $true; RedirectStandardOutput = $data.stdoutFile; RedirectStandardError = $data.stderrFile
  }
  if ($data.commandLine) { $parameters.ArgumentList = $data.commandLine }
  $child = Start-Process @parameters
  Write-Status @{ phase = 'running'; pid = $child.Id }
  $child.WaitForExit()
  Write-Status @{ phase = 'exited'; pid = $child.Id; exitCode = $child.ExitCode }
} catch { Write-Status @{ phase = 'failed'; error = $_.Exception.Message } }
`;
  const diagnostics = () => {
    let status = {};
    try {
      status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    } catch {
      /* A status write may still be in progress. */
    }
    return {
      ...status,
      diagnosticDirectory,
      stderr: fs.existsSync(stderrFile)
        ? fs.readFileSync(stderrFile, "utf8").slice(-8000)
        : "",
    };
  };
  const remove = () => {
    runPowerShell(
      `Unregister-ScheduledTask -TaskName $data.taskName -Confirm:$false -ErrorAction SilentlyContinue`,
      { taskName },
    );
    const status = diagnostics();
    if (status.phase === "exited" && status.exitCode === 0) {
      fs.rmSync(diagnosticDirectory, { recursive: true, force: true });
    }
  };
  remove.diagnostics = diagnostics;
  remove.cancel = () =>
    runPowerShell(
      `
Stop-ScheduledTask -TaskName $data.taskName -ErrorAction SilentlyContinue
`,
      { taskName },
    );
  try {
    runPowerShell(
      `
$principal = New-ScheduledTaskPrincipal -UserId $data.sid -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute $data.shell -Argument $data.arguments -WorkingDirectory $data.directory
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $data.taskName -Action $action -Principal $principal -Settings $settings -Description 'Temporary Cursor Atelier installation launch' | Out-Null
Start-ScheduledTask -TaskName $data.taskName
`,
      {
        taskName,
        sid: context.sid,
        shell: path.join(
          process.env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`,
        // The launcher must not keep a current-directory handle on the install.
        directory: os.tmpdir(),
      },
    );
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}
export async function recycleDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing an unexpected recycle path: ${directory}`);
  }
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-recycle-"),
  );
  const resultFile = path.join(temporary, "result.json");
  const payload = Buffer.from(
    JSON.stringify({ directory, resultFile }),
    "utf8",
  ).toString("base64");
  // FileSystem's recycle option is ignored in service/session-0 processes.
  // Run in the desktop and verify the new shell Recycle Bin item itself.
  const script = `
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
try {
  if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'Recycling requires the interactive Windows desktop.'
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  $shell = New-Object -ComObject Shell.Application
  $bin = $shell.NameSpace(10)
  $before = @($bin.Items() | ForEach-Object { $_.Path })
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $data.directory,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
    [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
  $parent = [IO.Path]::GetDirectoryName($data.directory)
  $name = [IO.Path]::GetFileName($data.directory)
  $recycled = @($bin.Items() | Where-Object {
    $_.Path -notin $before -and $_.Name -eq $name -and
    $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $parent
  })
  if ($recycled.Count -ne 1 -or [IO.Directory]::Exists($data.directory)) {
    throw 'The shell did not confirm a recoverable Recycle Bin item.'
  }
  $result = @{ ok = $true; recycledPath = $recycled[0].Path }
} catch { $result = @{ ok = $false; error = $_.Exception.Message } }
[IO.File]::WriteAllText($data.resultFile, ($result | ConvertTo-Json -Compress))
`;
  const removeTask = launchInDesktop({
    executable: path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    context: desktopContext(),
  });
  try {
    const deadline = Date.now() + 120000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) {
      await delay(300);
    }
    if (!fs.existsSync(resultFile)) {
      throw new Error(
        `Recycling did not finish. Inspect the Windows desktop; diagnostic directory: ${temporary}`,
      );
    }
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (!result.ok || !fs.statSync(result.recycledPath).isDirectory()) {
      throw new Error(
        result.error || "The recycled directory could not be verified.",
      );
    }
    return result.recycledPath;
  } finally {
    removeTask();
    if (fs.existsSync(resultFile)) {
      fs.rmSync(temporary, { recursive: true });
    }
  }
}
// Callbacks own platform process and registration APIs. User data is never moved.
export async function activateWindowsUpdate({
  staged,
  installed,
  verifyPackage,
  stopInstalled,
  activateInstalled,
  restoreRegistrations,
  relaunchPrevious,
  wasRunning = false,
  log = () => {},
}) {
  const build = verifyPackage(staged);
  const previous = fs.existsSync(installed)
    ? verifyPackage(installed, { selfTest: false })
    : null;
  if (previous && BigInt(build.buildVersion) < BigInt(previous.buildVersion)) {
    throw new Error(
      "Refusing to install an older build over the current installation.",
    );
  }
  ordinaryDirectory(path.dirname(installed));
  const incoming = fs.mkdtempSync(`${installed}.incoming-`);
  const recovery = `${installed}.previous-${previous?.buildVersion || "none"}-${randomUUID()}`;
  let previousMoved = false,
    activated = false,
    stopped = false;
  try {
    fs.cpSync(staged, incoming, { recursive: true, dereference: false });
    const copied = verifyPackage(incoming);
    if (copied.buildVersion !== build.buildVersion) {
      throw new Error("The staged build changed while it was being copied.");
    }
    await stopInstalled();
    stopped = true;
    if (previous) {
      fs.renameSync(installed, recovery);
      previousMoved = true;
    }
    fs.renameSync(incoming, installed);
    activated = true;
    await activateInstalled(build);
    return { build, previous, recovery: previousMoved ? recovery : null };
  } catch (error) {
    try {
      if (activated) {
        // Never rename an installation while any of its code is still running.
        await stopInstalled();
        const failed = `${installed}.failed-${build.buildVersion}-${randomUUID()}`;
        fs.renameSync(installed, failed);
        log(`Retained failed installation for diagnosis: ${failed}`);
      }
      if (previousMoved) {
        fs.renameSync(recovery, installed);
        previousMoved = false;
      }
      if (activated) {
        await restoreRegistrations();
      }
      if (stopped && wasRunning && previous) {
        await relaunchPrevious(previous);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Installation failed and rollback needs attention. Prior installation retained at ${previousMoved ? recovery : installed}.`,
        { cause: rollbackError },
      );
    }
    throw error;
  } finally {
    if (fs.existsSync(incoming)) {
      fs.rmSync(incoming, { recursive: true });
    }
  }
}
