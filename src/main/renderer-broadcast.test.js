import { describe, expect, it, vi } from "vitest";

import { broadcastToRendererWindows } from "./renderer-broadcast.js";

function rendererWindow(send) {
  return {
    isDestroyed: () => false,
    webContents: { send },
  };
}

describe("renderer broadcasts", () => {
  it("continues broadcasting after one renderer send fails", () => {
    const first = rendererWindow(
      vi.fn(() => {
        throw new Error("renderer disappeared");
      }),
    );
    const laterSend = vi.fn();
    const later = rendererWindow(laterSend);
    const errors = vi.fn();
    const payload = { visible: false };

    broadcastToRendererWindows({
      windows: [first, later],
      channel: "preferences:changed",
      payload,
      canSend: () => true,
      onSendError: errors,
    });

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "renderer disappeared" }),
      { channel: "preferences:changed", window: first },
    );
    expect(laterSend).toHaveBeenCalledWith("preferences:changed", payload);
  });
});
