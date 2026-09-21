import { describe, it, expect, vi } from "vitest";
import { WINDOWS_CURSOR_ROLES } from "./windows-cursor-theme.js";
import { createWindowsCursorDesktop } from "./windows-cursor-desktop.js";

describe("Windows native desktop read", () => {
  it.skipIf(process.platform !== "win32")(
    "reports real Windows desktop capability without changing settings",
    async () => {
      const result = await createWindowsCursorDesktop().read();
      expect(result.kind).toBe("windows");
      expect(result.supported).toBe(
        typeof result.session === "number" && result.session !== 0,
      );
      expect(result.values).toHaveLength(16);
      expect(result.cursorSize).toBeGreaterThan(0);
    },
    30_000,
  );
});

it("rejects a damaged late snapshot entry before invoking any registry mutation", async () => {
  const slots = Object.keys(WINDOWS_CURSOR_ROLES);
  const snapshot = {
    kind: "windows",
    session: 1,
    cursorSize: 32,
    values: [...slots, "", "Scheme Source"].map((name) => ({
      name,
      exists: false,
      kind: null,
      value: null,
    })),
    sizes: Object.fromEntries(slots.map((name) => [name, 32])),
    fingerprints: Object.fromEntries(
      ["Arrow", "IBeam", "Hand"].map((name) => [
        name,
        `32:32:0:0:${Buffer.alloc(32).toString("base64")}`,
      ]),
    ),
  };
  const runCommand = vi.fn(async () => '{"restored":true}');
  const desktop = createWindowsCursorDesktop({ runCommand });
  for (const invalid of [
    {
      ...snapshot,
      values: [...snapshot.values.slice(0, -1), snapshot.values[0]],
    },
    {
      ...snapshot,
      values: [
        ...snapshot.values.slice(0, -1),
        {
          name: "Scheme Source",
          exists: true,
          kind: "DWord",
          value: "not a number",
        },
      ],
    },
    { ...snapshot, fingerprints: {} },
    { ...snapshot, sizes: {} },
  ]) {
    await expect(desktop.restore(invalid)).rejects.toThrow(
      "desktop was not changed",
    );
  }
  expect(runCommand).not.toHaveBeenCalled();
  await expect(desktop.restore(snapshot)).resolves.toEqual({ restored: true });
  expect(runCommand).toHaveBeenCalledOnce();
});
