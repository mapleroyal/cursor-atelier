const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "downloading",
  "converting",
  "installing",
]);

function stringSet(values) {
  const list = Array.isArray(values)
    ? values
    : values === null || values === undefined
      ? []
      : [values];
  return new Set(
    list
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function normalizedFamily(value) {
  return typeof value === "string"
    ? value.trim().normalize("NFC").toLocaleLowerCase("en-US")
    : "";
}

function themeIdentifiers(theme) {
  return stringSet([
    theme?.id,
    theme?.nativeThemeId,
    ...(Array.isArray(theme?.nativeThemeIds) ? theme.nativeThemeIds : []),
  ]);
}

function throwBusy(curatedFamilyId) {
  const error = new Error(
    "Wait for this curated family to finish before changing it.",
  );
  error.code = "CURATED_FAMILY_BUSY";
  error.curatedFamilyId = curatedFamilyId;
  throw error;
}

export function assertCuratedMutationAvailable({
  jobs = [],
  themes = [],
  identifiers = [],
  familyNames = [],
  curatedFamilies = [],
} = {}) {
  const activeFamilyIds = new Set(
    jobs
      .filter((job) => ACTIVE_JOB_STATUSES.has(job?.status))
      .map((job) => job?.familyId)
      .filter((familyId) => typeof familyId === "string" && familyId),
  );
  if (activeFamilyIds.size === 0) {
    return;
  }

  const targetIdentifiers = stringSet(identifiers);
  const targetFamilies = new Set(
    [...stringSet(familyNames)].map(normalizedFamily),
  );

  for (const theme of themes) {
    const curatedFamilyId = theme?.curatedFamilyId;
    if (!activeFamilyIds.has(curatedFamilyId)) {
      continue;
    }
    if (
      [...themeIdentifiers(theme)].some((identifier) =>
        targetIdentifiers.has(identifier),
      ) ||
      targetFamilies.has(normalizedFamily(theme?.family))
    ) {
      throwBusy(curatedFamilyId);
    }
  }

  for (const family of curatedFamilies) {
    if (
      activeFamilyIds.has(family?.id) &&
      targetFamilies.has(normalizedFamily(family?.name))
    ) {
      throwBusy(family.id);
    }
  }
}
