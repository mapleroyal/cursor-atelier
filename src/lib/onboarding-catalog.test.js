import { describe, expect, it } from "vitest";

import { ONBOARDING_FAMILIES } from "./onboarding-catalog.js";

describe("onboarding catalogue", () => {
  it("contains one representative and three previews for every UI family", () => {
    expect(ONBOARDING_FAMILIES).toHaveLength(15);
    expect(new Set(ONBOARDING_FAMILIES.map((item) => item.family)).size).toBe(
      15,
    );
    expect(
      ONBOARDING_FAMILIES.every((item) => item.previews.length === 3),
    ).toBe(true);
    expect(
      ONBOARDING_FAMILIES.flatMap((item) => item.previews).every(Boolean),
    ).toBe(true);
  });

  it("uses stable family-level identifiers rather than representative variants", () => {
    expect(ONBOARDING_FAMILIES.map(({ id }) => id)).toEqual([
      "oreo",
      "remus",
      "drop",
      "moga",
      "volantes",
      "vimix",
      "qogir",
      "bibata-extra",
      "google",
      "simp1e",
      "capitaine",
      "future",
      "nordzy",
      "colloid",
      "bibata",
    ]);
  });
});
