export function broadcastToRendererWindows({
  windows,
  channel,
  payload,
  canSend,
  onSendError = (error) =>
    console.error("Could not notify a renderer window.", error),
} = {}) {
  for (const window of windows) {
    try {
      if (window.isDestroyed()) {
        continue;
      }
      const webContents = window.webContents;
      if (canSend(webContents)) {
        webContents.send(channel, payload);
      }
    } catch (error) {
      try {
        onSendError(error, { channel, window });
      } catch (reportingError) {
        console.error(
          "Renderer notification error reporter failed.",
          reportingError,
        );
      }
    }
  }
}
