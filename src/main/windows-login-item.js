export function createWindowsLoginItem({
  app,
  executablePath = process.execPath,
}) {
  const options = { path: executablePath, args: ["--background"] };
  // Electron parses the lookup path as a command line when listing startup
  // entries. Quote it so installation paths with spaces remain one executable.
  const queryOptions = { ...options, path: `"${executablePath}"` };
  const ownedItem = (current) =>
    current.launchItems?.find(
      (entry) =>
        entry.name === "com.cursoratelier.CursorAtelier" &&
        entry.scope === "user",
    );
  let lastDesired = null;
  return {
    setLoginItemSettings({ openAtLogin }) {
      const current = app.getLoginItemSettings(queryOptions);
      const item = ownedItem(current);
      // Keep the user's Startup Apps choice when reconciling an existing entry.
      const enabled =
        openAtLogin && (lastDesired === false || item?.enabled !== false);
      app.setLoginItemSettings({
        ...options,
        name: "com.cursoratelier.CursorAtelier",
        openAtLogin,
        enabled,
      });
      lastDesired = openAtLogin;
    },
    getLoginItemSettings() {
      const current = app.getLoginItemSettings(queryOptions);
      return {
        ...current,
        status: current.openAtLogin
          ? ownedItem(current)?.enabled === true
            ? "enabled"
            : "requires-approval"
          : "not-registered",
      };
    },
  };
}

export function getWindowsCursorLoginStatus(cursorStatus, loginSettings) {
  const cursorDesiredEnabled = cursorStatus.desiredEnabled === true;
  return {
    loginApprovalRequired:
      cursorDesiredEnabled && loginSettings.status === "requires-approval",
    // The app may still start for independent preferences after cursor restore.
    loginItemRegistrationCurrent:
      cursorDesiredEnabled && loginSettings.status === "enabled",
  };
}
