const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const {
  AutoUnpackNativesPlugin,
} = require("@electron-forge/plugin-auto-unpack-natives");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const productVersion = require("./package.json").version;

const rootDirectory = __dirname;
const outerAppName = "Cursor Atelier.app";
const outerBundleId = "com.cursoratelier.CursorAtelier";
const nativeAppName = "Oreo Cursor.app";
const nativeBundleId = "com.cursoratelier.CursorAtelier.NativeCursor";
const helperAppName = "Oreo Cursor Login Helper.app";
const helperBundleId =
  "com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper";
const nativeAppPath = path.join(
  rootDirectory,
  "native",
  "oreo",
  "build",
  "Release",
  nativeAppName,
);
const electronEntitlementsPath = path.join(
  rootDirectory,
  "assets",
  "entitlements.mac.plist",
);
const electronPluginEntitlementsPath = path.join(
  rootDirectory,
  "assets",
  "entitlements.mac.plugin.plist",
);
const unusedPrivacyKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];
const forbiddenMetadataKeys = [...unusedPrivacyKeys, "NSAppTransportSecurity"];
const packagedRuntimeAncestors = new Set([
  "/node_modules",
  "/node_modules/@napi-rs",
]);
const packagedRuntimeRoots = Object.freeze([
  "/.vite",
  "/node_modules/@img",
  "/node_modules/@napi-rs/lzma",
  "/node_modules/detect-libc",
  "/node_modules/semver",
  "/node_modules/sharp",
]);
const packagedRuntimePrefixes = Object.freeze(["/node_modules/@napi-rs/lzma-"]);

function ignorePackagedFile(filePath) {
  if (!filePath) {
    return false;
  }
  return !(
    packagedRuntimeAncestors.has(filePath) ||
    packagedRuntimeRoots.some(
      (root) => filePath === root || filePath.startsWith(`${root}/`),
    ) ||
    packagedRuntimePrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

function visitInfoPlists(directory, callback) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visitInfoPlists(entryPath, callback);
    } else if (entry.isFile() && entry.name === "Info.plist") {
      callback(entryPath);
    }
  }
}

function hasMatchingFile(directory, predicate) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return false;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (hasMatchingFile(entryPath, predicate)) {
        return true;
      }
    } else if (entry.isFile() && predicate(entryPath)) {
      return true;
    }
  }
  return false;
}

function removeUnusedElectronMetadata(
  stagingDirectory,
  _electronVersion,
  _platform,
  _arch,
  callback,
) {
  try {
    const contentsDirectory = path.join(
      stagingDirectory,
      outerAppName,
      "Contents",
    );
    if (!fs.statSync(contentsDirectory).isDirectory()) {
      throw new Error("The Electron bundle metadata could not be located.");
    }
    visitInfoPlists(contentsDirectory, (plistPath) => {
      for (const key of unusedPrivacyKeys) {
        spawnSync("/usr/libexec/PlistBuddy", [
          "-c",
          `Delete :${key}`,
          plistPath,
        ]);
      }
      spawnSync("/usr/libexec/PlistBuddy", [
        "-c",
        "Delete :NSAppTransportSecurity",
        plistPath,
      ]);
    });
    callback();
  } catch (error) {
    callback(error);
  }
}

function plistValue(plistPath, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plistPath],
    { encoding: "utf8" },
  ).trim();
}

function codesignDetails(appPath) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=2", appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not inspect the signature for ${appPath}.`);
  }
  return result.stderr;
}

let resolvedOuterSigningIdentity;

function codesignAuthority(details) {
  return details.match(/^Authority=(.+)$/m)?.[1] ?? null;
}

function outerSigningIdentity() {
  if (resolvedOuterSigningIdentity) {
    return resolvedOuterSigningIdentity;
  }
  const identity = codesignAuthority(codesignDetails(nativeAppPath));
  if (!identity?.startsWith("Apple Development: ")) {
    throw new Error(
      "The native app must use an Apple Development signing identity.",
    );
  }
  resolvedOuterSigningIdentity = identity;
  return resolvedOuterSigningIdentity;
}

function codesignTeamIdentifier(details) {
  return details.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1] ?? null;
}

function codesignEntitlements(appPath) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--xml", "--entitlements", "-", appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not inspect the entitlements for ${appPath}.`);
  }
  const conversion = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { encoding: "utf8", input: result.stdout },
  );
  if (conversion.status !== 0) {
    throw new Error(`Could not parse the entitlements for ${appPath}.`);
  }
  return JSON.parse(conversion.stdout);
}

function electronSignOptions(filePath) {
  return {
    entitlements: filePath.includes("(Plugin).app")
      ? electronPluginEntitlementsPath
      : electronEntitlementsPath,
    timestamp: "none",
  };
}

function verifyPackagedApp(_forgeConfig, { arch, platform, outputPaths }) {
  if (platform !== "darwin") {
    return;
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`The macOS package architecture is unsupported: ${arch}.`);
  }
  for (const outputPath of outputPaths) {
    const appPath = path.join(outputPath, outerAppName);
    if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
      throw new Error(`Forge did not produce the expected ${outerAppName}.`);
    }
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    const unpackedModules = path.join(
      appPath,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
    );
    const hasSharpAddon = hasMatchingFile(
      path.join(unpackedModules, "@img"),
      (filePath) =>
        path.extname(filePath) === ".node" &&
        filePath.includes(`${path.sep}sharp-darwin-${arch}${path.sep}`),
    );
    const hasSharpLibvips = hasMatchingFile(
      path.join(unpackedModules, "@img"),
      (filePath) =>
        path.extname(filePath) === ".dylib" &&
        filePath.includes(`${path.sep}sharp-libvips-darwin-${arch}${path.sep}`),
    );
    const hasLzmaAddon = hasMatchingFile(
      path.join(unpackedModules, "@napi-rs"),
      (filePath) =>
        path.extname(filePath) === ".node" &&
        filePath.includes(`${path.sep}lzma-darwin-${arch}${path.sep}`),
    );
    if (!hasSharpAddon || !hasSharpLibvips || !hasLzmaAddon) {
      throw new Error(
        "The packaged cursor importer is missing a required unpacked native dependency.",
      );
    }
    const packagedNativeApp = path.join(
      appPath,
      "Contents",
      "Resources",
      nativeAppName,
    );
    if (fs.existsSync(packagedNativeApp)) {
      throw new Error(
        "The native application was unexpectedly staged before signing.",
      );
    }
    fs.cpSync(nativeAppPath, packagedNativeApp, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    // Electron Packager signs the Electron code graph before this large native
    // resource is staged. Re-sealing only the outer bundle preserves the
    // native app/helper's stable ServiceManagement signature and avoids asking
    // osx-sign to inspect thousands of non-code preview PNGs.
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        outerSigningIdentity(),
        "--timestamp=none",
        "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
        appPath,
      ],
      { stdio: "inherit" },
    );
    const nativeInfo = path.join(packagedNativeApp, "Contents", "Info.plist");
    const packagedHelperApp = path.join(
      packagedNativeApp,
      "Contents",
      "Library",
      "LoginItems",
      helperAppName,
    );
    const helperInfo = path.join(packagedHelperApp, "Contents", "Info.plist");
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", appPath],
      { stdio: "inherit" },
    );
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", packagedNativeApp],
      { stdio: "inherit" },
    );
    const minimumSystem = plistValue(plistPath, "LSMinimumSystemVersion");
    if (minimumSystem !== "13.0") {
      throw new Error("The packaged minimum macOS version is inconsistent.");
    }
    const outerIdentifier = plistValue(plistPath, "CFBundleIdentifier");
    const nativeIdentifier = plistValue(nativeInfo, "CFBundleIdentifier");
    const helperIdentifier = plistValue(helperInfo, "CFBundleIdentifier");
    const outerBuildVersion = plistValue(plistPath, "CFBundleVersion");
    const nativeBuildVersion = plistValue(nativeInfo, "CFBundleVersion");
    const helperBuildVersion = plistValue(helperInfo, "CFBundleVersion");
    if (
      outerIdentifier !== outerBundleId ||
      nativeIdentifier !== nativeBundleId ||
      helperIdentifier !== helperBundleId ||
      new Set([outerIdentifier, nativeIdentifier, helperIdentifier]).size !== 3
    ) {
      throw new Error(
        "The packaged application bundle identifiers are inconsistent.",
      );
    }
    if (
      !/^\d+(?:\.\d+){0,2}$/.test(nativeBuildVersion) ||
      nativeBuildVersion === productVersion ||
      outerBuildVersion !== nativeBuildVersion ||
      helperBuildVersion !== nativeBuildVersion
    ) {
      throw new Error(
        "The packaged application and resident helper build identities are inconsistent.",
      );
    }
    const iconName = plistValue(plistPath, "CFBundleIconFile");
    const iconFile = iconName.endsWith(".icns") ? iconName : `${iconName}.icns`;
    if (
      !iconName ||
      !fs.existsSync(path.join(appPath, "Contents", "Resources", iconFile))
    ) {
      throw new Error("The packaged application icon is missing.");
    }
    const packagedResources = path.join(appPath, "Contents", "Resources");
    for (const templateName of [
      "MenuBarIconTemplate.png",
      "MenuBarIconTemplate@2x.png",
    ]) {
      if (!fs.existsSync(path.join(packagedResources, templateName))) {
        throw new Error(
          `The packaged menu-bar icon is missing: ${templateName}.`,
        );
      }
    }
    const outerSignature = codesignDetails(appPath);
    const nativeSignature = codesignDetails(packagedNativeApp);
    const helperSignature = codesignDetails(packagedHelperApp);
    const outerAuthority = codesignAuthority(outerSignature);
    const nativeAuthority = codesignAuthority(nativeSignature);
    const helperAuthority = codesignAuthority(helperSignature);
    const outerTeamIdentifier = codesignTeamIdentifier(outerSignature);
    const nativeTeamIdentifier = codesignTeamIdentifier(nativeSignature);
    const helperTeamIdentifier = codesignTeamIdentifier(helperSignature);
    if (
      !outerSignature.includes(`Identifier=${outerBundleId}`) ||
      !outerTeamIdentifier ||
      outerTeamIdentifier !== nativeTeamIdentifier ||
      !outerAuthority ||
      outerAuthority !== nativeAuthority
    ) {
      throw new Error(
        "The outer application does not have the stable native-app signing identity.",
      );
    }
    if (
      !nativeSignature.includes(`Identifier=${nativeBundleId}`) ||
      !helperSignature.includes(`Identifier=${helperBundleId}`) ||
      !nativeTeamIdentifier ||
      nativeTeamIdentifier !== helperTeamIdentifier ||
      !nativeAuthority ||
      nativeAuthority !== helperAuthority
    ) {
      throw new Error(
        "The packaged native signing identities are inconsistent.",
      );
    }
    const electronApps = [
      appPath,
      path.join(appPath, "Contents", "Frameworks", "Cursor Atelier Helper.app"),
      path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Cursor Atelier Helper (GPU).app",
      ),
      path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Cursor Atelier Helper (Plugin).app",
      ),
      path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Cursor Atelier Helper (Renderer).app",
      ),
    ];
    for (const electronApp of electronApps) {
      if (codesignAuthority(codesignDetails(electronApp)) !== nativeAuthority) {
        throw new Error(
          `The Electron runtime has an inconsistent signing identity: ${electronApp}.`,
        );
      }
      const entitlements = codesignEntitlements(electronApp);
      if (
        entitlements["com.apple.security.cs.disable-library-validation"] !==
        true
      ) {
        throw new Error(
          `The Electron runtime cannot load its framework: ${electronApp}.`,
        );
      }
      const unexpectedPrivacyEntitlement = Object.keys(entitlements).find(
        (key) =>
          key.startsWith("com.apple.security.device.") ||
          key.startsWith("com.apple.security.personal-information."),
      );
      if (unexpectedPrivacyEntitlement) {
        throw new Error(
          `The packaged app contains unused entitlement ${unexpectedPrivacyEntitlement}.`,
        );
      }
    }
    for (const key of forbiddenMetadataKeys) {
      const result = spawnSync("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        plistPath,
      ]);
      if (result.status === 0) {
        throw new Error(`The packaged app contains unused privacy key ${key}.`);
      }
    }
  }
}

function runNativePreflight() {
  execFileSync(
    process.execPath,
    [path.join(rootDirectory, "scripts", "native-preflight.mjs")],
    { cwd: rootDirectory, stdio: "inherit" },
  );
}

module.exports = {
  packagerConfig: {
    name: "Cursor Atelier",
    // Keep the outer bundle on the same exact-build identity as the signed
    // native app and login helper. CFBundleShortVersionString remains the
    // human-facing package version.
    buildVersion: plistValue(
      path.join(nativeAppPath, "Contents", "Info.plist"),
      "CFBundleVersion",
    ),
    // Sharp's native addon links a sibling libvips dylib. The generic native
    // unpack plugin below covers .node files; this rule keeps that dylib and
    // the rest of its @img runtime package beside the extracted addon.
    asar: {
      unpack: "**/node_modules/@img/**/*",
    },
    // Forge's Vite plugin otherwise ignores node_modules after Vite leaves a
    // package external. Keep only the two importer runtimes and Sharp's small
    // JavaScript dependency closure; Electron Packager still prunes modules
    // that are not installed for the target architecture.
    ignore: ignorePackagedFile,
    appBundleId: outerBundleId,
    appCategoryType: "public.app-category.utilities",
    appCopyright: "Cursor Atelier contributors",
    darwinDarkModeSupport: true,
    icon: path.join(rootDirectory, "assets", "AppIcon.icns"),
    extendInfo: {
      LSMinimumSystemVersion: "13.0",
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
      },
      NSHighResolutionCapable: true,
    },
    // The outer app and its background service registration need the same
    // stable Apple-issued identity used by the signed native cursor helper.
    // The native app is staged by postPackage and the outer resource seal is
    // then refreshed without altering the nested signature.
    osxSign: {
      identity: outerSigningIdentity(),
      continueOnError: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: electronSignOptions,
    },
    // Keep the menu-bar template at the Resources root so Electron can load
    // the correct raster density without unpacking the application archive.
    extraResource: [
      path.join(rootDirectory, "assets", "MenuBarIconTemplate.png"),
      path.join(rootDirectory, "assets", "MenuBarIconTemplate@2x.png"),
    ],
    afterCopyExtraResources: [removeUnusedElectronMetadata],
  },
  rebuildConfig: {},
  hooks: {
    prePackage: runNativePreflight,
    postPackage: verifyPackagedApp,
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          {
            entry: "src/main.js",
            config: "vite.main.config.mjs",
            target: "main",
          },
          {
            entry: "src/preload.js",
            config: "vite.preload.config.mjs",
            target: "preload",
          },
        ],
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.mjs",
          },
        ],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
