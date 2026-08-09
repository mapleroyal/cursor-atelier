import { describe, expect, it } from "vitest";

import {
  getNextTime,
  getTimesValidationMessage,
} from "@/components/settings-screen";

describe("randomization schedule drafts", () => {
  it("keeps invalid and duplicate times distinguishable for inline feedback", () => {
    expect(getTimesValidationMessage(["09:00", ""])).toBe(
      "Enter a valid time.",
    );
    expect(getTimesValidationMessage(["09:00", "09:00"])).toBe(
      "Times must be unique.",
    );
    expect(getTimesValidationMessage(["09:00", "17:00"])).toBeNull();
  });

  it("adds the next editable slot after the final configured time", () => {
    expect(getNextTime(["09:00", "17:00"])).toBe("17:15");
    expect(getNextTime(["23:45", "00:00"])).toBe("00:15");
  });
});
