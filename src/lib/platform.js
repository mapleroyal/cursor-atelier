export const platform = globalThis.window?.electronAPI?.platform;
export const isLinux = platform === "linux";
export const isWindows = platform === "win32";
export const isMacOS = platform === "darwin" || !platform;
