import path from "node:path";

const DOCK_ICON_FILES = Object.freeze({
  light: "DockIconLight.png",
  dark: "DockIconDark.png",
});

export function getDockIconFilename(appearance) {
  return appearance === "dark" ? DOCK_ICON_FILES.dark : DOCK_ICON_FILES.light;
}

export function syncDockIcon({
  isMacOS = process.platform === "darwin",
  appearance,
  resourcesRoot,
  dock,
  nativeImage,
  onError = () => {},
} = {}) {
  if (!isMacOS || !dock || typeof dock.setIcon !== "function") {
    return false;
  }

  try {
    if (!resourcesRoot || typeof nativeImage?.createFromPath !== "function") {
      throw new TypeError("Dock icon resources are unavailable.");
    }
    const iconPath = path.join(resourcesRoot, getDockIconFilename(appearance));
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon || typeof icon.isEmpty !== "function" || icon.isEmpty()) {
      throw new Error(`The Dock icon is missing: ${iconPath}`);
    }
    dock.setIcon(icon);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
