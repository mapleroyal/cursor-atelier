import { describe, expect, it, vi } from "vitest";
import { reconcileCursorAtLogin } from "./cursor-login-reconciler.js";

function fixture({
  appearance = "dark",
  assignment = "Dark",
  enabled = true,
  themes = ["Light", "Dark", "Manual"],
} = {}) {
  const preferences = {
    appearance: {
      automaticSwitching: false,
      lightCursorId: "Light",
      darkCursorId: assignment,
    },
  };
  const bridge = {
    status: vi.fn(async () => ({
      desiredEnabled: enabled,
      selectedNativeThemeId: "Manual",
    })),
    listThemes: vi.fn(async () =>
      themes.map((id) => ({ id, nativeThemeId: id, canApply: true })),
    ),
    applyTheme: vi.fn(async (id, { shouldApply }) =>
      shouldApply() ? { selectedNativeThemeId: id } : { applySkipped: true },
    ),
    reconcileLoginItems: vi.fn(async () => ({
      selectedNativeThemeId: "Manual",
    })),
  };
  return {
    bridge,
    preferencesStore: { get: () => preferences },
    getSystemAppearance: () => appearance,
  };
}

describe("cursor selection at login", () => {
  it.each(["light", "dark"])(
    "uses the current %s assignment before the directly selected cursor",
    async (appearance) => {
      const context = fixture({ appearance });
      const result = await reconcileCursorAtLogin(context);
      expect(result.selectedNativeThemeId).toBe(
        appearance === "dark" ? "Dark" : "Light",
      );
      expect(context.bridge.reconcileLoginItems).not.toHaveBeenCalled();
    },
  );

  it.each([null, "Missing"])(
    "falls back to the selected cursor when assignment is %s",
    async (assignment) => {
      const context = fixture({ assignment });
      expect(await reconcileCursorAtLogin(context)).toEqual({
        selectedNativeThemeId: "Manual",
      });
      expect(context.bridge.applyTheme).not.toHaveBeenCalled();
    },
  );

  it("preserves Restore's disabled persistence state", async () => {
    const context = fixture({ enabled: false });
    await reconcileCursorAtLogin(context);
    expect(context.bridge.applyTheme).not.toHaveBeenCalled();
    expect(context.bridge.reconcileLoginItems).toHaveBeenCalledOnce();
  });

  it("reconciles a desktop change that occurs during cursor application", async () => {
    const context = fixture();
    let appearance = "dark";
    context.getSystemAppearance = () => appearance;
    context.bridge.applyTheme.mockImplementationOnce(async (id) => {
      appearance = "light";
      return { selectedNativeThemeId: id };
    });
    expect(await reconcileCursorAtLogin(context)).toEqual({
      selectedNativeThemeId: "Light",
    });
    expect(context.bridge.applyTheme.mock.calls.map(([id]) => id)).toEqual([
      "Dark",
      "Light",
    ]);
  });

  it("uses a new appearance assignment after restoring the selected fallback", async () => {
    const context = fixture({ assignment: null });
    let appearance = "dark";
    context.getSystemAppearance = () => appearance;
    context.bridge.reconcileLoginItems.mockImplementationOnce(async () => {
      appearance = "light";
      return { selectedNativeThemeId: "Manual" };
    });
    expect(await reconcileCursorAtLogin(context)).toEqual({
      selectedNativeThemeId: "Light",
    });
    expect(context.bridge.applyTheme).toHaveBeenCalledExactlyOnceWith(
      "Light",
      expect.objectContaining({ shouldApply: expect.any(Function) }),
    );
  });
});
