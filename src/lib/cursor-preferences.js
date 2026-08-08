export const CURSOR_PREFERENCES_VERSION = 5;

export const RANDOM_SOURCES = Object.freeze(["all", "favorites", "family"]);
export const RANDOM_SCHEDULE_MODES = Object.freeze([
  "off",
  "launch",
  "interval",
  "daily",
  "times",
]);
export const CURSOR_APPEARANCES = Object.freeze(["light", "dark"]);

const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_INTERVAL_HOURS = 24 * 30;
const MIN_INTERVAL_HOURS = 0.25;
const MAX_CURSOR_IDS = 512;
const MAX_FAMILIES = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_FAMILY_LENGTH = 128;

export function createDefaultCursorPreferences() {
  return {
    version: CURSOR_PREFERENCES_VERSION,
    favorites: {
      cursorIds: [],
      families: [],
    },
    appearance: {
      automaticSwitching: false,
      lightCursorId: null,
      darkCursorId: null,
    },
    randomization: {
      source: "all",
      family: null,
      pools: {
        light: [],
        dark: [],
      },
      schedule: {
        mode: "off",
        intervalHours: 1,
        dailyTime: "09:00",
        times: ["09:00", "17:00"],
      },
      lastRunAt: null,
    },
    menuBar: {
      visible: true,
    },
  };
}

export const DEFAULT_CURSOR_PREFERENCES = Object.freeze(
  createDefaultCursorPreferences(),
);

function boundedString(value, maximumLength) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function uniqueStrings(
  values,
  { maximumEntries = Number.POSITIVE_INFINITY, maximumLength } = {},
) {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const entry = maximumLength
      ? boundedString(value, maximumLength)
      : typeof value === "string" && value.trim()
        ? value.trim()
        : null;
    if (!entry || seen.has(entry)) {
      continue;
    }
    normalized.push(entry);
    seen.add(entry);
    if (normalized.length >= maximumEntries) {
      break;
    }
  }
  return normalized;
}

function nullableIdentifier(value) {
  return boundedString(value, MAX_IDENTIFIER_LENGTH);
}

function nullableFamily(value) {
  return boundedString(value, MAX_FAMILY_LENGTH);
}

function normalizeClockTime(value, fallback) {
  return typeof value === "string" && CLOCK_TIME_PATTERN.test(value)
    ? value
    : fallback;
}

function normalizeIntervalHours(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) {
    return 1;
  }

  return Math.min(
    MAX_INTERVAL_HOURS,
    Math.max(MIN_INTERVAL_HOURS, Math.round(interval * 4) / 4),
  );
}

function normalizeLastRunAt(value) {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeCursorPreferences(value) {
  const defaults = createDefaultCursorPreferences();
  const candidate =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const favorites =
    candidate.favorites && typeof candidate.favorites === "object"
      ? candidate.favorites
      : {};
  const appearance =
    candidate.appearance && typeof candidate.appearance === "object"
      ? candidate.appearance
      : {};
  const randomization =
    candidate.randomization && typeof candidate.randomization === "object"
      ? candidate.randomization
      : {};
  const pools =
    randomization.pools &&
    typeof randomization.pools === "object" &&
    !Array.isArray(randomization.pools)
      ? randomization.pools
      : {};
  const schedule =
    randomization.schedule && typeof randomization.schedule === "object"
      ? randomization.schedule
      : {};
  const menuBar =
    candidate.menuBar && typeof candidate.menuBar === "object"
      ? candidate.menuBar
      : {};

  const source = RANDOM_SOURCES.includes(randomization.source)
    ? randomization.source
    : defaults.randomization.source;
  const mode = RANDOM_SCHEDULE_MODES.includes(schedule.mode)
    ? schedule.mode
    : defaults.randomization.schedule.mode;
  const times = uniqueStrings(schedule.times)
    .filter((time) => CLOCK_TIME_PATTERN.test(time))
    .sort();

  return {
    version: CURSOR_PREFERENCES_VERSION,
    favorites: {
      cursorIds: uniqueStrings(favorites.cursorIds, {
        maximumEntries: MAX_CURSOR_IDS,
        maximumLength: MAX_IDENTIFIER_LENGTH,
      }),
      families: uniqueStrings(favorites.families, {
        maximumEntries: MAX_FAMILIES,
        maximumLength: MAX_FAMILY_LENGTH,
      }),
    },
    appearance: {
      automaticSwitching: appearance.automaticSwitching === true,
      lightCursorId: nullableIdentifier(appearance.lightCursorId),
      darkCursorId: nullableIdentifier(appearance.darkCursorId),
    },
    randomization: {
      source,
      family: nullableFamily(randomization.family),
      pools: {
        light: uniqueStrings(pools.light, {
          maximumEntries: MAX_CURSOR_IDS,
          maximumLength: MAX_IDENTIFIER_LENGTH,
        }),
        dark: uniqueStrings(pools.dark, {
          maximumEntries: MAX_CURSOR_IDS,
          maximumLength: MAX_IDENTIFIER_LENGTH,
        }),
      },
      schedule: {
        mode,
        intervalHours: normalizeIntervalHours(schedule.intervalHours),
        dailyTime: normalizeClockTime(
          schedule.dailyTime,
          defaults.randomization.schedule.dailyTime,
        ),
        times: times.length ? times : defaults.randomization.schedule.times,
      },
      lastRunAt: normalizeLastRunAt(randomization.lastRunAt),
    },
    menuBar: {
      visible: menuBar.visible !== false,
    },
  };
}

export function mergeCursorPreferences(current, patch) {
  const base = normalizeCursorPreferences(current);
  const update =
    patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};

  return normalizeCursorPreferences({
    ...base,
    ...update,
    favorites: { ...base.favorites, ...(update.favorites ?? {}) },
    appearance: { ...base.appearance, ...(update.appearance ?? {}) },
    randomization: {
      ...base.randomization,
      ...(update.randomization ?? {}),
      pools: {
        ...base.randomization.pools,
        ...(update.randomization?.pools ?? {}),
      },
      schedule: {
        ...base.randomization.schedule,
        ...(update.randomization?.schedule ?? {}),
      },
    },
    menuBar: { ...base.menuBar, ...(update.menuBar ?? {}) },
  });
}

export function getCursorPreferenceId(cursor) {
  return (
    nullableIdentifier(cursor?.nativeThemeId) ?? nullableIdentifier(cursor?.id)
  );
}

export function createCursorDeletionPreferencesPatch(
  value,
  identifiers,
  remainingFamilies,
) {
  const preferences = normalizeCursorPreferences(value);
  const deleted = new Set(
    uniqueStrings(identifiers, {
      maximumEntries: MAX_CURSOR_IDS,
      maximumLength: MAX_IDENTIFIER_LENGTH,
    }).map((identifier) => identifier.toLowerCase()),
  );
  const families = new Set(
    uniqueStrings(remainingFamilies, {
      maximumEntries: MAX_FAMILIES,
      maximumLength: MAX_FAMILY_LENGTH,
    }),
  );
  const keepIdentifier = (identifier) =>
    !identifier || !deleted.has(identifier.toLowerCase());
  const randomFamily = families.has(preferences.randomization.family)
    ? preferences.randomization.family
    : null;

  return {
    favorites: {
      cursorIds: preferences.favorites.cursorIds.filter(keepIdentifier),
      families: preferences.favorites.families.filter((family) =>
        families.has(family),
      ),
    },
    appearance: {
      lightCursorId: keepIdentifier(preferences.appearance.lightCursorId)
        ? preferences.appearance.lightCursorId
        : null,
      darkCursorId: keepIdentifier(preferences.appearance.darkCursorId)
        ? preferences.appearance.darkCursorId
        : null,
    },
    randomization: {
      source:
        preferences.randomization.source === "family" && !randomFamily
          ? "all"
          : preferences.randomization.source,
      family: randomFamily,
      pools: {
        light: preferences.randomization.pools.light.filter(keepIdentifier),
        dark: preferences.randomization.pools.dark.filter(keepIdentifier),
      },
    },
  };
}

export function cursorMatchesIdentifier(cursor, identifier) {
  const value = nullableIdentifier(identifier);
  if (!cursor || !value) {
    return false;
  }
  return (
    getCursorPreferenceId(cursor) === value ||
    nullableIdentifier(cursor.id) === value ||
    (Array.isArray(cursor.nativeThemeIds) &&
      cursor.nativeThemeIds.some(
        (nativeThemeId) => nullableIdentifier(nativeThemeId) === value,
      ))
  );
}

export function getFavoriteCursorIds(cursors, preferences) {
  const normalized = normalizeCursorPreferences(preferences);
  const direct = new Set(normalized.favorites.cursorIds);
  const families = new Set(normalized.favorites.families);

  for (const cursor of Array.isArray(cursors) ? cursors : []) {
    const id = getCursorPreferenceId(cursor);
    if (id && families.has(cursor.family)) {
      direct.add(id);
    }
  }

  return [...direct];
}

export function resolveRandomCursorPool(
  cursors,
  preferences,
  systemAppearance,
) {
  const normalized = normalizeCursorPreferences(preferences);
  const available = (Array.isArray(cursors) ? cursors : []).filter(
    (cursor) => cursor?.canApply === true,
  );
  let pool = available;

  if (normalized.randomization.source === "favorites") {
    const favorites = new Set(getFavoriteCursorIds(available, normalized));
    pool = available.filter((cursor) =>
      favorites.has(getCursorPreferenceId(cursor)),
    );
  } else if (normalized.randomization.source === "family") {
    pool = available.filter(
      (cursor) => cursor.family === normalized.randomization.family,
    );
  }

  if (CURSOR_APPEARANCES.includes(systemAppearance)) {
    const appearancePool = new Set(
      normalized.randomization.pools[systemAppearance],
    );
    if (appearancePool.size) {
      pool = pool.filter((cursor) =>
        appearancePool.has(getCursorPreferenceId(cursor)),
      );
    }
  }

  return pool;
}

export function chooseRandomCursor(
  cursors,
  currentIdentifier,
  random = Math.random,
) {
  const pool = Array.isArray(cursors) ? cursors : [];
  if (!pool.length) {
    return null;
  }

  const alternatives = pool.filter(
    (cursor) => !cursorMatchesIdentifier(cursor, currentIdentifier),
  );
  const candidates = alternatives.length ? alternatives : pool;
  const sample = Number(random());
  const boundedSample = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 0.999999999999)
    : 0;
  return candidates[Math.floor(boundedSample * candidates.length)] ?? null;
}

function localDateAtTime(time, reference) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(reference);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

export function getNextRandomizationDate(preferences, now = new Date()) {
  const normalized = normalizeCursorPreferences(preferences);
  const { schedule, lastRunAt } = normalized.randomization;
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) {
    return null;
  }

  if (schedule.mode === "interval") {
    const lastRun = lastRunAt ? new Date(lastRunAt) : null;
    if (lastRun && Number.isFinite(lastRun.getTime())) {
      const next = new Date(
        lastRun.getTime() + schedule.intervalHours * 60 * 60 * 1000,
      );
      return next <= current ? current : next;
    }
    return new Date(
      current.getTime() + schedule.intervalHours * 60 * 60 * 1000,
    );
  }

  const clockTimes =
    schedule.mode === "daily"
      ? [schedule.dailyTime]
      : schedule.mode === "times"
        ? schedule.times
        : [];
  if (!clockTimes.length) {
    return null;
  }

  const candidates = clockTimes.map((time) => {
    const candidate = localDateAtTime(time, current);
    if (candidate <= current) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  });
  return candidates.reduce((earliest, candidate) =>
    candidate < earliest ? candidate : earliest,
  );
}
