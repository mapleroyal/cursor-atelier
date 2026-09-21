const installers = {
  linux: "./install-linux.mjs",
  win32: "./install-windows.mjs",
};
const installer = installers[process.platform];
if (!installer) {
  throw new Error(
    "On macOS install the signed app at /Applications/Cursor Atelier.app as described in README.md.",
  );
}
await import(installer);
