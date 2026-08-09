export function createRendererNavigation({
  canSend = () => true,
  onSendError = (error) =>
    console.error("Could not send renderer navigation.", error),
} = {}) {
  const pendingByWebContents = new Map();
  const readyWebContents = new Set();

  const deliver = (webContents) => {
    const identifier = webContents?.id;
    if (
      !readyWebContents.has(identifier) ||
      !pendingByWebContents.has(identifier) ||
      webContents.isDestroyed() ||
      !canSend(webContents)
    ) {
      return false;
    }

    const destination = pendingByWebContents.get(identifier);
    try {
      webContents.send("app:navigate", destination);
      pendingByWebContents.delete(identifier);
      return true;
    } catch (error) {
      readyWebContents.delete(identifier);
      try {
        onSendError(error, { webContents, destination });
      } catch (reportingError) {
        console.error(
          "Renderer navigation error reporter failed.",
          reportingError,
        );
      }
      return false;
    }
  };

  return {
    queue(webContents, destination) {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      pendingByWebContents.set(webContents.id, destination);
      return deliver(webContents);
    },
    markReady(webContents) {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      readyWebContents.add(webContents.id);
      return deliver(webContents);
    },
    markNotReady(webContents) {
      readyWebContents.delete(webContents?.id);
    },
    dispose(webContentsOrIdentifier) {
      const identifier =
        typeof webContentsOrIdentifier === "number"
          ? webContentsOrIdentifier
          : webContentsOrIdentifier?.id;
      readyWebContents.delete(identifier);
      pendingByWebContents.delete(identifier);
    },
  };
}
