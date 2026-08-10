export const ONBOARDING_VERSION = 2;

const RUNNING_STATUSES = new Set([
  "queued",
  "downloading",
  "converting",
  "installing",
]);

function normalizeStatus(value) {
  const status = String(value ?? "queued")
    .trim()
    .toLocaleLowerCase();
  if (["pending", "preparing", "waiting"].includes(status)) {
    return "queued";
  }
  if (["download", "fetching"].includes(status)) {
    return "downloading";
  }
  if (["convert", "upscaling", "processing"].includes(status)) {
    return "converting";
  }
  if (["install", "committing"].includes(status)) {
    return "installing";
  }
  if (["complete", "ready", "succeeded", "success"].includes(status)) {
    return "completed";
  }
  if (["error", "cancelled", "canceled"].includes(status)) {
    return "failed";
  }
  return [
    "queued",
    "downloading",
    "converting",
    "installing",
    "failed",
    "completed",
  ].includes(status)
    ? status
    : "queued";
}

function normalizeProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) {
    return null;
  }
  const percentage = progress > 0 && progress <= 1 ? progress * 100 : progress;
  return Math.round(Math.min(100, Math.max(0, percentage)));
}

function errorMessage(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value.message ?? value.reason ?? "Import failed.");
}

function failureDetail(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const code = String(value.code ?? "").trim();
  const message = errorMessage(value)?.replace(/\s+/g, " ").trim();
  return code && message ? { code, message } : null;
}

export function normalizeOnboardingJob(job) {
  if (!job || typeof job !== "object") {
    return null;
  }
  const familyId = String(job.familyId ?? "").trim();
  if (!familyId) {
    return null;
  }
  return {
    familyId,
    status: normalizeStatus(job.status ?? job.state ?? job.phase),
    progress: normalizeProgress(job.progress ?? job.percentage),
    error: errorMessage(job.error ?? job.lastError ?? job.reason),
    failure: failureDetail(job.failure ?? job.errorDetail),
    currentVariant:
      typeof job.currentVariant === "string" && job.currentVariant.trim()
        ? job.currentVariant.trim()
        : null,
    installedVariantIds: Array.isArray(job.installedVariantIds)
      ? [
          ...new Set(
            job.installedVariantIds
              .map((identifier) => String(identifier ?? "").trim())
              .filter(Boolean),
          ),
        ]
      : [],
  };
}

export function normalizeOnboardingState(value, fallback = {}) {
  const jobsSource = Array.isArray(value?.jobs)
    ? value.jobs
    : Array.isArray(value?.imports)
      ? value.imports
      : (fallback.jobs ?? []);
  const jobs = jobsSource.map(normalizeOnboardingJob).filter(Boolean);

  return {
    version: Number.isInteger(Number(value?.version))
      ? Number(value.version)
      : ONBOARDING_VERSION,
    completed:
      typeof value?.completed === "boolean"
        ? value.completed
        : Boolean(fallback.completed),
    jobs,
    error: errorMessage(value?.error ?? fallback.error),
  };
}

export function createOptimisticOnboardingState(familyIds) {
  const ids = [
    ...new Set(
      (Array.isArray(familyIds) ? familyIds : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  return {
    version: ONBOARDING_VERSION,
    completed: true,
    jobs: ids.map((familyId) => ({
      familyId,
      status: "queued",
      progress: null,
      error: null,
      failure: null,
      currentVariant: null,
      installedVariantIds: [],
    })),
    error: null,
  };
}

export function failOnboardingJobs(state, error) {
  const message = errorMessage(error) ?? "Import failed.";
  const failure = {
    code: String(error?.code ?? "ONBOARDING_REQUEST_FAILED"),
    message,
  };
  return {
    ...normalizeOnboardingState(state),
    jobs: (state?.jobs ?? []).map((job) => ({
      ...normalizeOnboardingJob(job),
      status: "failed",
      error: message,
      failure,
    })),
    error: message,
  };
}

export function queueOnboardingJob(state, familyId) {
  const normalized = normalizeOnboardingState(state);
  return {
    ...normalized,
    jobs: normalized.jobs.map((job) =>
      job.familyId === familyId
        ? {
            ...job,
            status: "queued",
            progress: null,
            error: null,
            failure: null,
            currentVariant: null,
          }
        : job,
    ),
    error: null,
  };
}

export function isOnboardingJobVisible(job) {
  const status = normalizeStatus(job?.status);
  return RUNNING_STATUSES.has(status) || status === "failed";
}

export function getOnboardingJobLabel(job) {
  const status = normalizeStatus(job?.status);
  const progress = normalizeProgress(job?.progress);
  if (status === "failed") {
    return "Failed";
  }
  if (status === "queued") {
    return "Preparing…";
  }
  const phase = {
    downloading: "Downloading",
    converting: "Converting",
    installing: "Installing",
  }[status];
  return progress === null ? `${phase}…` : `${phase} ${progress}%`;
}

export function getOnboardingFailureDetail(job) {
  const failure = failureDetail(job?.failure ?? job?.errorDetail);
  if (failure) {
    return `${failure.code}: ${failure.message}`;
  }
  return (
    errorMessage(job?.error ?? job?.lastError ?? job?.reason) ??
    "Import failed."
  );
}

export function groupCursorFamilies(packs, jobs, search = "") {
  const query = String(search ?? "")
    .trim()
    .toLocaleLowerCase();
  const groups = new Map();

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isOnboardingJobVisible(job)) {
      continue;
    }
    const family = String(job.family ?? "").trim();
    if (!family || (query && !family.toLocaleLowerCase().includes(query))) {
      continue;
    }
    const key = family.toLocaleLowerCase();
    groups.set(key, { family, familyPacks: [], job });
  }

  for (const pack of Array.isArray(packs) ? packs : []) {
    const family = String(pack?.family ?? "").trim();
    if (!family) {
      continue;
    }
    const key = family.toLocaleLowerCase();
    const group = groups.get(key) ?? {
      family,
      familyPacks: [],
      job: null,
    };
    group.family = family;
    group.familyPacks.push(pack);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      const rank = ({ job }) => {
        if (!job) {
          return 0;
        }
        return normalizeStatus(job.status) === "failed" ? 1 : 2;
      };
      return rank(left.group) - rank(right.group) || left.index - right.index;
    })
    .map(({ group }) => group);
}
