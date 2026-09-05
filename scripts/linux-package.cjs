const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const applicationId = "com.cursoratelier.CursorAtelier";
const executableName = "cursor-atelier";

function sha256(filename) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function verifyElf(filename, arch) {
  const descriptor = fs.openSync(filename, "r");
  const header = Buffer.alloc(20);
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (
    header.subarray(0, 4).toString("hex") !== "7f454c46" ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== { x64: 62, arm64: 183 }[arch]
  ) {
    throw new Error(`Expected a Linux ${arch} executable: ${filename}`);
  }
  fs.accessSync(filename, fs.constants.X_OK);
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
    info.platform !== "linux" ||
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
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(directory, filename);
      if (relative === "resources/install-manifest.json") {
        continue;
      }
      if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(filename);
        const resolved = path.resolve(path.dirname(filename), target);
        if (
          path.isAbsolute(target) ||
          !resolved.startsWith(`${directory}${path.sep}`)
        ) {
          throw new Error(
            `Package symlink escapes its installation: ${relative}`,
          );
        }
        files[relative] = { link: target };
      } else if (entry.isFile()) {
        files[relative] = {
          sha256: sha256(filename),
          mode: fs.statSync(filename).mode & 0o777,
        };
      } else {
        throw new Error(`Unexpected package file type: ${relative}`);
      }
    }
  }
  visit(directory);
  return files;
}

function verifyLinuxPackage(
  directory,
  { checkManifest = true, selfTest = true } = {},
) {
  directory = path.resolve(directory);
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing a symlink installation: ${directory}`);
  }
  const info = readBuildInfo(directory);
  verifyElf(path.join(directory, executableName), info.arch);
  const resources = path.join(directory, "resources");
  const converter = path.join(
    resources,
    "curated-cursor-converter",
    "curated-cursor-converter",
  );
  verifyElf(converter, info.arch);
  for (const filename of [
    "app.asar",
    "AppIcon.png",
    "MenuBarIconTemplate.png",
    "MenuBarIconTemplate@2x.png",
  ]) {
    if (!fs.statSync(path.join(resources, filename)).isFile()) {
      throw new Error(`Missing packaged resource: ${filename}`);
    }
  }
  const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
  const dependencies = [
    [`@img/sharp-linux-${info.arch}/lib`, /^sharp-linux-.*\.node$/],
    [`@img/sharp-libvips-linux-${info.arch}/lib`, /^libvips-cpp\.so\./],
    [`@napi-rs/lzma-linux-${info.arch}-gnu`, /^lzma\.linux-.*-gnu\.node$/],
  ];
  for (const [directory, pattern] of dependencies) {
    const location = path.join(unpacked, directory);
    if (
      !fs.existsSync(location) ||
      !fs.readdirSync(location).some((name) => pattern.test(name))
    ) {
      throw new Error(`Missing unpacked importer dependency: ${directory}`);
    }
  }
  if (selfTest) {
    const result = JSON.parse(
      execFileSync(converter, ["self-test"], {
        encoding: "utf8",
        timeout: 60000,
      }),
    );
    const catalog = require("../native/cursor-packs/curated-family-catalog.json");
    if (
      result.ok !== true ||
      result.type !== "self-test" ||
      result.themeCount !== 240 ||
      result.roleCount !== 47 ||
      result.catalogSha256 !== catalog.sha256
    ) {
      throw new Error("The packaged curated converter failed its self-test.");
    }
  }
  if (checkManifest) {
    const expected = JSON.parse(
      fs.readFileSync(path.join(resources, "install-manifest.json"), "utf8"),
    );
    const actual = packageInventory(directory);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`Package verification failed: ${directory}`);
    }
  }
  return info;
}

function runningPackageProcesses(directory) {
  const resolved = fs.existsSync(directory)
    ? fs.realpathSync(directory)
    : path.resolve(directory);
  const processes = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const proc = path.join("/proc", entry);
      if (fs.statSync(proc).uid !== process.getuid()) {
        continue;
      }
      const executable = fs
        .readlinkSync(path.join(proc, "exe"))
        .replace(/ \(deleted\)$/, "");
      if (!executable.startsWith(`${resolved}${path.sep}`)) {
        continue;
      }
      // Chromium rewrites argv[0] to include its process type on Linux.
      const args = fs
        .readFileSync(path.join(proc, "cmdline"), "utf8")
        .split("\0");
      processes.push({
        pid: Number(entry),
        executable,
        main:
          executable === path.join(resolved, executableName) &&
          !args.some((arg) => /(?:^|\s)--type=/.test(arg)),
      });
    } catch {
      // Processes may exit between listing /proc and reading their identity.
    }
  }
  return processes;
}

module.exports = {
  applicationId,
  executableName,
  readBuildInfo,
  packageInventory,
  verifyElf,
  verifyLinuxPackage,
  runningPackageProcesses,
};
