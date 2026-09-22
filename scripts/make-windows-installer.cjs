const path = require("node:path");
const { verifyWindowsPackage } = require("./windows-package.cjs");

// Forge owns compilation, native resources, signing, and package verification.
// electron-builder consumes that exact package only to produce its NSIS wizard.
module.exports = async function makeWindowsInstaller(forgeConfig, results) {
  const root = path.resolve(__dirname, "..");
  for (const result of results) {
    if (result.platform !== "win32") {
      continue;
    }
    const directory = path.join(
      root,
      forgeConfig.outDir,
      "Cursor Atelier-win32-" + result.arch,
    );
    const identity = verifyWindowsPackage(directory, { selfTest: false });
    const { build, Platform, Arch } = require("electron-builder");
    const artifacts = await build({
      projectDir: root,
      prepackaged: directory,
      targets: Platform.WINDOWS.createTarget("nsis", Arch[result.arch]),
      publish: "never",
      config: {
        appId: identity.applicationId,
        productName: "Cursor Atelier",
        executableName: "cursor-atelier",
        electronVersion: require("electron/package.json").version,
        directories: {
          output: path.join(
            root,
            forgeConfig.outDir,
            "make",
            "nsis",
            result.arch,
          ),
          buildResources: path.join(root, "assets"),
        },
        win: {
          icon: path.join(directory, "resources", "AppIcon.ico"),
          signAndEditExecutable: false,
        },
        nsis: {
          oneClick: false,
          perMachine: false,
          allowElevation: false,
          packElevateHelper: false,
          include: path.join(root, "assets", "windows-installer.nsh"),
          installerIcon: path.join(directory, "resources", "AppIcon.ico"),
          uninstallerIcon: path.join(directory, "resources", "AppIcon.ico"),
          createDesktopShortcut: false,
          createStartMenuShortcut: true,
          shortcutName: "Cursor Atelier",
          runAfterFinish: true,
          deleteAppDataOnUninstall: false,
          differentialPackage: false,
          artifactName:
            "Cursor-Atelier-" +
            identity.version +
            "-" +
            identity.buildVersion +
            "-" +
            result.arch +
            "-Setup.exe",
        },
      },
    });
    // Reject any packaging tool that unexpectedly changes the verified payload.
    verifyWindowsPackage(directory, { selfTest: false });
    result.artifacts.push(...artifacts);
  }
  return results;
};
