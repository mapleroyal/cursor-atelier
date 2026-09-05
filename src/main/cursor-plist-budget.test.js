import fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as plist from "plist";
import { assertBinaryCursorPlistBudget } from "./cursor-plist-budget.js";

describe("cursor plist structure budget", () => {
  it("accepts ordinary dictionary metadata and image representations", () => {
    const buffer = Buffer.from(
      plist.buildBinary({
        ThemeName: "Example",
        Cursors: {
          Arrow: {
            FrameCount: 2,
            FrameDuration: 0.1,
            HotSpotX: 4,
            HotSpotY: 5,
            Representations: [new Uint8Array([1, 2, 3])],
          },
        },
      }),
    );
    expect(() => assertBinaryCursorPlistBudget(buffer)).not.toThrow();
    expect(plist.parseBinary(buffer)).toMatchObject({ ThemeName: "Example" });
  });

  it("accepts the real Oreo theme before normal plist decoding", () => {
    const buffer = fs.readFileSync(
      new URL(
        "../../native/oreo/Resources/Themes/OreoWhite.cursor",
        import.meta.url,
      ),
    );
    expect(() => assertBinaryCursorPlistBudget(buffer)).not.toThrow();
    expect(plist.parseBinary(buffer).Cursors).toBeDefined();
  });
});
