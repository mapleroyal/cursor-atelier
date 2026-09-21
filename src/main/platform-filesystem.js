import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function hasPrivateMode(stat) {
  // Windows stores inherit private DACLs; Unix permission bits are not implemented.
  return process.platform === "win32" || (stat.mode & 0o077) === 0;
}
export function isSafeWindowsPath(value) {
  return !value
    .split("/")
    .some(
      (part) =>
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
          part,
        ),
    );
}
const securedRoots = new Map();
export function securePrivateDirectory(directory) {
  if (process.platform !== "win32") {
    return;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The private store root is unsafe.");
  }
  const canonical = fs.realpathSync(directory);
  const identity = `${stat.dev}:${stat.ino}`;
  if (securedRoots.get(canonical) === identity) {
    return;
  }
  const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$directory=New-Object IO.DirectoryInfo($root)
$owner=$directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value -and $owner.Value -ne 'S-1-5-32-544') { throw 'The private store belongs to another user.' }
# Persist only the DACL. Set-Acl can request owner/SACL privileges that a
# normal desktop token does not hold, even when it owns this directory.
$security=$directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$security.SetAccessRuleProtection($true,$false)
foreach ($existing in @($security.Access)) { $security.RemoveAccessRuleSpecific($existing) }
foreach ($principal in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
 $rule=New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]$principal),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $security.AddAccessRule($rule)
}
$directory.SetAccessControl($security)
`;
  execFileSync(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify(canonical),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  securedRoots.set(canonical, identity);
}
export async function syncDirectory(directory) {
  // Node cannot open Win32 directory handles for FlushFileBuffers. Each
  // transaction file is flushed before its atomic rename on both platforms.
  if (process.platform === "win32") {
    return;
  }
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
