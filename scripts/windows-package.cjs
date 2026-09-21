const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const applicationId = "com.cursoratelier.CursorAtelier";
const executableName = "cursor-atelier.exe";

function runPowerShell(script, data = {}, options = {}) {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const command = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\n$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\ntry {\n${script}\n} catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`;
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-delivery-"),
  );
  const filename = path.join(temporary, "command.ps1");
  let output;
  try {
    fs.writeFileSync(filename, `\uFEFF${command}`, { flag: "wx", mode: 0o600 });
    output = execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        filename,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        ...options,
      },
    )
      .replace(/^\uFEFF/, "")
      .trim();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return output ? JSON.parse(output) : null;
}
function verifyPe(filename, arch) {
  const fd = fs.openSync(filename, "r");
  try {
    const dos = Buffer.alloc(64);
    if (
      fs.readSync(fd, dos, 0, 64, 0) !== 64 ||
      dos.toString("ascii", 0, 2) !== "MZ"
    ) {
      throw new Error(`Expected a Windows executable: ${filename}`);
    }
    const offset = dos.readUInt32LE(60),
      header = Buffer.alloc(6);
    if (
      offset < 64 ||
      fs.readSync(fd, header, 0, 6, offset) !== 6 ||
      header.toString("hex", 0, 4) !== "50450000" ||
      header.readUInt16LE(4) !== { x64: 0x8664, arm64: 0xaa64 }[arch]
    ) {
      throw new Error(`Expected a Windows ${arch} executable: ${filename}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
function readBuildInfo(directory) {
  const info = JSON.parse(
    fs.readFileSync(
      path.join(directory, "resources", "build-info.json"),
      "utf8",
    ),
  );
  if (
    info.applicationId !== applicationId ||
    info.platform !== "win32" ||
    !["x64", "arm64"].includes(info.arch) ||
    !/^\d+$/.test(info.buildVersion) ||
    typeof info.version !== "string"
  ) {
    throw new Error(`Invalid Cursor Atelier build identity: ${directory}`);
  }
  return info;
}
function packageInventory(directory) {
  const files = {};
  function visit(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const filename = path.join(current, entry.name),
        relative = path.relative(directory, filename).split(path.sep).join("/");
      if (relative === "resources/install-manifest.json") {
        continue;
      }
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) {
        throw new Error(`Package contains a link: ${relative}`);
      }
      if (stat.isDirectory()) {
        visit(filename);
      } else if (stat.isFile()) {
        files[relative] = {
          sha256: crypto
            .createHash("sha256")
            .update(fs.readFileSync(filename))
            .digest("hex"),
        };
      } else {
        throw new Error(`Unexpected package file type: ${relative}`);
      }
    }
  }
  visit(directory);
  return files;
}
function verifyWindowsConverter(executable, arch = process.arch) {
  verifyPe(executable, arch);
  const result = JSON.parse(
    execFileSync(executable, ["self-test"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    }),
  );
  const catalog = require("../native/cursor-packs/curated-family-catalog.json");
  if (
    result.ok !== true ||
    result.type !== "self-test" ||
    result.themeCount !== 240 ||
    result.roleCount !== 47 ||
    result.xcursorEncoderVersion !== "2.2.5" ||
    result.windowsEncoder !== "cur-ani" ||
    result.catalogSha256 !== catalog.sha256
  ) {
    throw new Error("The Windows curated converter failed its self-test.");
  }
  return result;
}
function verifyWindowsPackage(
  directory,
  { checkManifest = true, selfTest = true } = {},
) {
  directory = path.resolve(directory);
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing a linked installation: ${directory}`);
  }
  const info = readBuildInfo(directory),
    resources = path.join(directory, "resources");
  verifyPe(path.join(directory, executableName), info.arch);
  const converter = path.join(
    resources,
    "curated-cursor-converter",
    "curated-cursor-converter.exe",
  );
  verifyPe(converter, info.arch);
  for (const filename of [
    "app.asar",
    "AppIcon.png",
    "AppIcon.ico",
    "MenuBarIconTemplate.png",
    "MenuBarIconTemplate@2x.png",
  ]) {
    if (!fs.statSync(path.join(resources, filename)).isFile()) {
      throw new Error(`Missing packaged resource: ${filename}`);
    }
  }
  const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
  for (const [directory, pattern] of [
    [`@img/sharp-win32-${info.arch}/lib`, /^sharp-win32-.*\.node$/],
    [`@img/sharp-win32-${info.arch}/lib`, /^libvips.*\.dll$/i],
    [`@napi-rs/lzma-win32-${info.arch}-msvc`, /^lzma\.win32-.*-msvc\.node$/],
  ]) {
    const location = path.join(unpacked, directory),
      matching = fs.existsSync(location)
        ? fs.readdirSync(location).filter((name) => pattern.test(name))
        : [];
    if (!matching.length) {
      throw new Error(
        `Missing unpacked importer dependency: ${directory} (${pattern})`,
      );
    }
    for (const filename of matching) {
      verifyPe(path.join(location, filename), info.arch);
    }
  }
  if (selfTest) {
    verifyWindowsConverter(converter, info.arch);
  }
  if (checkManifest) {
    const expected = JSON.parse(
      fs.readFileSync(path.join(resources, "install-manifest.json"), "utf8"),
    );
    if (
      JSON.stringify(expected) !== JSON.stringify(packageInventory(directory))
    ) {
      throw new Error(`Package verification failed: ${directory}`);
    }
  }
  return info;
}
function runningPackageProcesses(directory) {
  return (
    runPowerShell(
      `
$root=[IO.Path]::GetFullPath($data.directory).TrimEnd('\\')+'\\'
$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
  $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
  if($owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    [pscustomobject]@{pid=[int]$_.ProcessId;executable=$_.ExecutablePath;sessionId=[int]$_.SessionId;main=($_.ExecutablePath.Equals([IO.Path]::Combine($data.directory,$data.executableName),[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '(?:^|\\s)--type=')}
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
`,
      { directory: path.resolve(directory), executableName },
    ) || []
  );
}
module.exports = {
  applicationId,
  executableName,
  runPowerShell,
  verifyPe,
  readBuildInfo,
  packageInventory,
  verifyWindowsPackage,
  verifyWindowsConverter,
  runningPackageProcesses,
};
