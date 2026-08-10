import { describe, expect, it } from "vitest";

import {
  CURATED_FAMILY_CATALOG,
  CURATED_VARIANTS_BY_FAMILY,
  validateCuratedFamilyCatalog,
} from "./curated-family-catalog.js";

describe("curated family catalog", () => {
  it("locks all 240 source-derived variants to the 15 onboarding families", () => {
    expect(CURATED_FAMILY_CATALOG.families).toHaveLength(15);
    expect(CURATED_FAMILY_CATALOG.themeCount).toBe(240);
    expect(
      [...CURATED_VARIANTS_BY_FAMILY.values()].reduce(
        (total, identifiers) => total + identifiers.length,
        0,
      ),
    ).toBe(240);
  });

  it("rejects catalog metadata that no longer matches its digest", () => {
    const changed = structuredClone(CURATED_FAMILY_CATALOG);
    changed.families[0].variants[0].displayName = "Changed";
    expect(() => validateCuratedFamilyCatalog(changed)).toThrow(/integrity/);
  });
});
