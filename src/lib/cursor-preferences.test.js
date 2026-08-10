import { describe, expect, it } from "vitest";

import {
  chooseRandomCursor,
  createCursorDeletionPreferencesPatch,
  createDefaultCursorPreferences,
  getCursorPreferenceId,
  getFavoriteCursorIds,
  getNextRandomizationDate,
  mergeCursorPreferences,
  normalizeCursorPreferences,
  resolveRandomCursorPool,
} from "./cursor-preferences";

function cursor({ id, nativeThemeId, family = "Oreo", canApply = true } = {}) {
  return { id, nativeThemeId, family, canApply };
}

describe("cursor preference normalization", () => {
  it("normalizes malformed values and preserves valid nested updates", () => {
    const current = createDefaultCursorPreferences();
    const merged = mergeCursorPreferences(current, {
      favorites: { cursorIds: ["  OreoBlue  ", "OreoBlue", 12] },
      appearance: {
        lightCursorId: " OreoWhite ",
      },
      randomization: {
        automaticEnabled: true,
        source: "family",
        family: " Oreo ",
        pools: {
          light: ["  OreoBlue  ", "OreoBlue", 12],
          dark: [" OreoWhite "],
        },
        schedule: {
          mode: "times",
          intervalHours: 1.26,
          times: ["17:00", "invalid", "09:00", "17:00"],
        },
        lastRunAt: "2026-08-06T14:30:00-05:00",
      },
      menuBar: { visible: false },
      startup: { runInBackground: true },
    });

    expect(merged).toMatchObject({
      favorites: { cursorIds: ["OreoBlue"], families: [] },
      appearance: {
        automaticSwitching: false,
        lightCursorId: "OreoWhite",
        darkCursorId: null,
      },
      randomization: {
        automaticEnabled: true,
        source: "family",
        family: "Oreo",
        pools: {
          light: ["OreoBlue"],
          dark: ["OreoWhite"],
        },
        schedule: {
          mode: "times",
          intervalHours: 1.25,
          dailyTime: "09:00",
          times: ["09:00", "17:00"],
        },
        lastRunAt: "2026-08-06T19:30:00.000Z",
      },
      menuBar: { visible: false },
      startup: { runInBackground: true },
    });
  });

  it("bounds stored identifiers, families, and per-appearance pools", () => {
    const cursorIds = Array.from(
      { length: 520 },
      (_, index) => `Cursor${index}`,
    );
    const families = Array.from(
      { length: 270 },
      (_, index) => `Family ${index}`,
    );
    const tooLong = "x".repeat(129);

    const normalized = normalizeCursorPreferences({
      favorites: {
        cursorIds: [tooLong, ...cursorIds],
        families: [tooLong, ...families],
      },
      appearance: {
        lightCursorId: tooLong,
        darkCursorId: "DarkCursor",
      },
      randomization: {
        family: tooLong,
        pools: {
          light: [tooLong, ...cursorIds],
          dark: [...cursorIds].reverse(),
        },
      },
    });

    expect(normalized.favorites.cursorIds).toHaveLength(512);
    expect(normalized.favorites.cursorIds.at(-1)).toBe("Cursor511");
    expect(normalized.favorites.families).toHaveLength(256);
    expect(normalized.favorites.families.at(-1)).toBe("Family 255");
    expect(normalized.appearance.lightCursorId).toBeNull();
    expect(normalized.appearance.darkCursorId).toBe("DarkCursor");
    expect(normalized.appearance.automaticSwitching).toBe(false);
    expect(normalized.randomization.family).toBeNull();
    expect(normalized.randomization.pools.light).toHaveLength(512);
    expect(normalized.randomization.pools.light.at(-1)).toBe("Cursor511");
    expect(normalized.randomization.pools.light).not.toContain(tooLong);
    expect(normalized.randomization.pools.dark).toHaveLength(512);
    expect(normalized.randomization.pools.dark.at(0)).toBe("Cursor519");
  });

  it("falls back to defaults for an invalid preference document", () => {
    expect(normalizeCursorPreferences(null)).toEqual(
      createDefaultCursorPreferences(),
    );
    expect(
      normalizeCursorPreferences({
        favorites: "invalid",
        appearance: [],
        randomization: { source: "unknown", schedule: { mode: "unknown" } },
        menuBar: { visible: "false" },
      }),
    ).toEqual(createDefaultCursorPreferences());
  });

  it("requires an explicit boolean to enable appearance switching", () => {
    expect(
      normalizeCursorPreferences({
        appearance: { automaticSwitching: true },
      }).appearance.automaticSwitching,
    ).toBe(true);
    expect(
      normalizeCursorPreferences({
        appearance: { automaticSwitching: "true" },
      }).appearance.automaticSwitching,
    ).toBe(false);
  });

  it("keeps background startup opt-in", () => {
    expect(createDefaultCursorPreferences().startup.runInBackground).toBe(
      false,
    );
    expect(
      normalizeCursorPreferences({
        startup: { runInBackground: true },
      }).startup.runInBackground,
    ).toBe(true);
    expect(
      normalizeCursorPreferences({
        startup: { runInBackground: "true" },
      }).startup.runInBackground,
    ).toBe(false);
  });

  it("keeps automatic randomization fail-closed and its schedule configurable", () => {
    expect(
      normalizeCursorPreferences({
        randomization: {
          automaticEnabled: true,
          schedule: { mode: "interval" },
        },
      }).randomization,
    ).toMatchObject({
      automaticEnabled: true,
      schedule: { mode: "interval" },
    });
    expect(
      normalizeCursorPreferences({
        randomization: {
          automaticEnabled: "true",
          schedule: { mode: "off" },
        },
      }).randomization,
    ).toMatchObject({
      automaticEnabled: false,
      schedule: { mode: "launch" },
    });
  });
});

describe("cursor deletion preference cleanup", () => {
  it("removes deleted cursor references and resets a vanished family source", () => {
    const patch = createCursorDeletionPreferencesPatch(
      {
        favorites: {
          cursorIds: ["ImportedBlue", "OreoWhite"],
          families: ["Imported", "Oreo"],
        },
        appearance: {
          lightCursorId: "ImportedBlue",
          darkCursorId: "OreoWhite",
        },
        randomization: {
          source: "family",
          family: "Imported",
          pools: {
            light: ["ImportedBlue", "OreoWhite"],
            dark: ["OreoWhite", "ImportedBlue"],
          },
        },
      },
      ["importedblue"],
      ["Oreo"],
    );

    expect(patch).toEqual({
      favorites: { cursorIds: ["OreoWhite"], families: ["Oreo"] },
      appearance: {
        lightCursorId: null,
        darkCursorId: "OreoWhite",
      },
      randomization: {
        source: "all",
        family: null,
        pools: {
          light: ["OreoWhite"],
          dark: ["OreoWhite"],
        },
      },
    });
  });
});

describe("cursor preference identity and favorites", () => {
  it("uses nativeThemeId as the canonical preference identity", () => {
    expect(
      getCursorPreferenceId(
        cursor({ id: "oreo-blue", nativeThemeId: "OreoBlue" }),
      ),
    ).toBe("OreoBlue");
    expect(getCursorPreferenceId(cursor({ id: "fallback-id" }))).toBe(
      "fallback-id",
    );
  });

  it("combines direct cursor and family favorites without duplicates", () => {
    const cursors = [
      cursor({ id: "oreo-blue", nativeThemeId: "OreoBlue" }),
      cursor({ id: "oreo-red", nativeThemeId: "OreoRed" }),
      cursor({
        id: "moga-candy",
        nativeThemeId: "MogaCandy",
        family: "Moga",
      }),
    ];
    const favoriteIds = getFavoriteCursorIds(cursors, {
      favorites: {
        cursorIds: ["OreoBlue", "MogaCandy"],
        families: ["Oreo"],
      },
    });

    expect(favoriteIds).toEqual(["OreoBlue", "MogaCandy", "OreoRed"]);
  });
});

describe("random cursor selection", () => {
  const cursors = [
    cursor({ id: "oreo-white", nativeThemeId: "OreoWhite" }),
    cursor({ id: "oreo-black", nativeThemeId: "OreoBlack" }),
    cursor({
      id: "moga-candy",
      nativeThemeId: "MogaCandy",
      family: "Moga",
    }),
    cursor({ id: "missing-capability", nativeThemeId: "MissingCapability" }),
    cursor({
      id: "unavailable",
      nativeThemeId: "Unavailable",
      canApply: false,
    }),
  ];
  delete cursors[3].canApply;

  it("requires explicit apply capability and resolves additive favorites", () => {
    const pool = resolveRandomCursorPool(cursors, {
      favorites: { cursorIds: ["MogaCandy"], families: ["Oreo"] },
      randomization: { source: "favorites" },
    });

    expect(pool.map(getCursorPreferenceId)).toEqual([
      "OreoWhite",
      "OreoBlack",
      "MogaCandy",
    ]);
  });

  it("keeps separate eligible pools for light and dark appearances", () => {
    const preferences = {
      randomization: {
        source: "all",
        pools: {
          light: ["OreoWhite", "MogaCandy"],
          dark: ["OreoBlack", "MogaCandy"],
        },
      },
    };

    expect(
      resolveRandomCursorPool(cursors, preferences, "light").map(
        getCursorPreferenceId,
      ),
    ).toEqual(["OreoWhite", "MogaCandy"]);
    expect(
      resolveRandomCursorPool(cursors, preferences, "dark").map(
        getCursorPreferenceId,
      ),
    ).toEqual(["OreoBlack", "MogaCandy"]);
  });

  it("excludes the current cursor when an alternative exists", () => {
    const white = cursors[0];
    const black = cursors[1];

    expect(chooseRandomCursor([white, black], "OreoWhite", () => 0)).toBe(
      black,
    );
    expect(chooseRandomCursor([white, black], "oreo-white", () => 0)).toBe(
      black,
    );
    expect(chooseRandomCursor([white], "OreoWhite", () => 0)).toBe(white);
    expect(chooseRandomCursor([], "OreoWhite", () => 0)).toBeNull();
  });
});

describe("randomization schedule math", () => {
  it("returns no timer date when automation is disabled or launch-only", () => {
    const now = new Date(2026, 7, 6, 8, 0);

    expect(
      getNextRandomizationDate(
        {
          randomization: {
            automaticEnabled: false,
            schedule: { mode: "interval" },
          },
        },
        now,
      ),
    ).toBeNull();
    expect(
      getNextRandomizationDate(
        {
          randomization: {
            automaticEnabled: true,
            schedule: { mode: "launch" },
          },
        },
        now,
      ),
    ).toBeNull();
  });

  it("calculates new, future, and overdue interval runs", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const interval = {
      randomization: {
        automaticEnabled: true,
        schedule: { mode: "interval", intervalHours: 1.5 },
      },
    };

    expect(getNextRandomizationDate(interval, now)).toEqual(
      new Date("2026-08-06T13:30:00.000Z"),
    );
    expect(
      getNextRandomizationDate(
        {
          randomization: {
            ...interval.randomization,
            lastRunAt: "2026-08-06T11:30:00.000Z",
          },
        },
        now,
      ),
    ).toEqual(new Date("2026-08-06T13:00:00.000Z"));
    expect(
      getNextRandomizationDate(
        {
          randomization: {
            ...interval.randomization,
            lastRunAt: "2026-08-06T09:00:00.000Z",
          },
        },
        now,
      ),
    ).toEqual(now);
  });

  it("rolls daily times forward and chooses the next configured time", () => {
    const morning = new Date(2026, 7, 6, 8, 30);
    const evening = new Date(2026, 7, 6, 19, 0);
    const daily = {
      randomization: {
        automaticEnabled: true,
        schedule: { mode: "daily", dailyTime: "09:00" },
      },
    };
    const times = {
      randomization: {
        automaticEnabled: true,
        schedule: { mode: "times", times: ["08:00", "12:00", "18:00"] },
      },
    };

    expect(getNextRandomizationDate(daily, morning)).toEqual(
      new Date(2026, 7, 6, 9, 0),
    );
    expect(getNextRandomizationDate(daily, new Date(2026, 7, 6, 9, 0))).toEqual(
      new Date(2026, 7, 7, 9, 0),
    );
    expect(getNextRandomizationDate(times, morning)).toEqual(
      new Date(2026, 7, 6, 12, 0),
    );
    expect(getNextRandomizationDate(times, evening)).toEqual(
      new Date(2026, 7, 7, 8, 0),
    );
  });
});
