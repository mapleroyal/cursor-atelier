import { describe, expect, it } from "vitest";

import { assertCuratedMutationAvailable } from "./curated-mutation-guard.js";

const qogirTheme = {
  id: "qogir-blue",
  nativeThemeId: "QogirBlue",
  nativeThemeIds: ["QogirBlueAlias"],
  family: "Qogir Installed",
  curatedFamilyId: "qogir",
};

const catalogFamilies = [
  { id: "qogir", name: "Qogir" },
  { id: "future", name: "Future" },
];

function guard(overrides = {}) {
  return () =>
    assertCuratedMutationAvailable({
      jobs: [{ familyId: "qogir", status: "downloading" }],
      themes: [qogirTheme],
      curatedFamilies: catalogFamilies,
      ...overrides,
    });
}

describe("curated mutation guard", () => {
  it.each(["queued", "downloading", "converting", "installing"])(
    "rejects a selected theme while its curated family is %s",
    (status) => {
      expect(
        guard({
          jobs: [{ familyId: "qogir", status }],
          identifiers: ["QogirBlueAlias"],
        }),
      ).toThrow(
        expect.objectContaining({
          code: "CURATED_FAMILY_BUSY",
          curatedFamilyId: "qogir",
        }),
      );
    },
  );

  it("recognizes family targets from both catalog and installed display names", () => {
    expect(guard({ familyNames: [" qOGIR "] })).toThrow(
      expect.objectContaining({ code: "CURATED_FAMILY_BUSY" }),
    );
    expect(guard({ familyNames: ["qogir installed"] })).toThrow(
      expect.objectContaining({ code: "CURATED_FAMILY_BUSY" }),
    );
  });

  it("allows unrelated themes and families while another curated family runs", () => {
    expect(
      guard({
        identifiers: ["FutureCyan"],
        familyNames: ["Future"],
        themes: [
          qogirTheme,
          {
            nativeThemeId: "FutureCyan",
            family: "Future",
            curatedFamilyId: "future",
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each(["failed", "completed"])(
    "allows mutations after the matching curated family has %s",
    (status) => {
      expect(
        guard({
          jobs: [{ familyId: "qogir", status }],
          identifiers: ["QogirBlue"],
          familyNames: ["Qogir"],
        }),
      ).not.toThrow();
    },
  );

  it("does not infer curated ownership from an identifier alone", () => {
    expect(
      guard({
        identifiers: ["QogirBlue"],
        themes: [{ nativeThemeId: "QogirBlue", family: "Unrelated" }],
      }),
    ).not.toThrow();
  });
});
