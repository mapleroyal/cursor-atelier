import ElectronStore from "electron-store";

export const ONBOARDING_STATE_VERSION = 2;

const STORE_NAME = "onboarding";
const STORE_KEY = "state";
const FAMILY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RUNNING_STATUSES = new Set([
  "queued",
  "downloading",
  "converting",
  "installing",
]);
const STATUSES = new Set([...RUNNING_STATUSES, "failed", "completed"]);
const MAX_JOBS = 15;
const MAX_VARIANTS_PER_FAMILY = 192;
const MAX_ERROR_LENGTH = 300;
const MAX_FAILURE_DETAIL_LENGTH = 1_200;

function clone(value) {
  return structuredClone(value);
}

function normalizeError(value) {
  if (typeof value !== "string") {
    return null;
  }
  const message = value.trim();
  return message ? message.slice(0, MAX_ERROR_LENGTH) : null;
}

function normalizeFailure(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const code = String(value.code ?? "").trim();
  const message = String(value.message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_DETAIL_LENGTH);
  if (!FAILURE_CODE.test(code) || !message) {
    return null;
  }
  return { code, message };
}

function normalizeProgress(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const progress = Number(value);
  return Number.isFinite(progress)
    ? Math.round(Math.min(100, Math.max(0, progress)))
    : null;
}

function normalizeJob(value) {
  const familyId = String(value?.familyId ?? "").trim();
  if (!FAMILY_ID.test(familyId)) {
    return null;
  }
  const status = STATUSES.has(value?.status) ? value.status : "failed";
  const installedVariantIds = [];
  const seenVariants = new Set();
  for (const candidate of Array.isArray(value?.installedVariantIds)
    ? value.installedVariantIds
    : []) {
    const identifier = String(candidate ?? "").trim();
    if (!THEME_ID.test(identifier) || seenVariants.has(identifier)) {
      continue;
    }
    seenVariants.add(identifier);
    installedVariantIds.push(identifier);
    if (installedVariantIds.length === MAX_VARIANTS_PER_FAMILY) {
      break;
    }
  }
  const currentVariant =
    typeof value?.currentVariant === "string" && value.currentVariant.trim()
      ? value.currentVariant.trim().slice(0, 160)
      : null;
  return {
    familyId,
    status,
    progress: normalizeProgress(value?.progress),
    error: status === "failed" ? normalizeError(value?.error) : null,
    failure: status === "failed" ? normalizeFailure(value?.failure) : null,
    installedVariantIds,
    currentVariant: RUNNING_STATUSES.has(status) ? currentVariant : null,
  };
}

export function normalizeOnboardingStoreState(value) {
  if (value?.version !== ONBOARDING_STATE_VERSION) {
    return {
      version: ONBOARDING_STATE_VERSION,
      completed: false,
      jobs: [],
      error: null,
    };
  }
  const seen = new Set();
  const jobs = [];
  for (const candidate of Array.isArray(value?.jobs) ? value.jobs : []) {
    const job = normalizeJob(candidate);
    if (!job || seen.has(job.familyId)) {
      continue;
    }
    seen.add(job.familyId);
    jobs.push(job);
    if (jobs.length === MAX_JOBS) {
      break;
    }
  }
  return {
    version: ONBOARDING_STATE_VERSION,
    completed: value?.completed === true,
    jobs,
    error: normalizeError(value?.error),
  };
}

function assertFamilyIds(familyIds) {
  if (!Array.isArray(familyIds) || familyIds.length > MAX_JOBS) {
    throw new TypeError("Starter family identifiers are invalid.");
  }
  const unique = [...new Set(familyIds)];
  if (
    unique.length !== familyIds.length ||
    unique.some((familyId) => !FAMILY_ID.test(familyId))
  ) {
    throw new TypeError("Starter family identifiers are invalid.");
  }
  return unique;
}

export function createOnboardingStore({
  directory,
  Store = ElectronStore,
  onListenerError = (error) =>
    console.error("Onboarding state listener failed.", error),
} = {}) {
  if (typeof directory !== "string" || !directory) {
    throw new TypeError("An onboarding state directory is required.");
  }

  const backingStore = new Store({
    cwd: directory,
    name: STORE_NAME,
    defaults: {
      [STORE_KEY]: normalizeOnboardingStoreState(null),
    },
  });
  const stored = backingStore.get(STORE_KEY);
  let state = normalizeOnboardingStoreState(stored);
  const listeners = new Set();

  if (JSON.stringify(stored) !== JSON.stringify(state)) {
    backingStore.set(STORE_KEY, state);
  }

  const emit = () => {
    const snapshot = clone(state);
    for (const listener of listeners) {
      try {
        listener(clone(snapshot));
      } catch (error) {
        try {
          onListenerError(error);
        } catch (reportingError) {
          console.error(
            "Onboarding listener error reporter failed.",
            reportingError,
          );
        }
      }
    }
  };

  const replace = (next) => {
    const normalized = normalizeOnboardingStoreState(next);
    if (JSON.stringify(normalized) === JSON.stringify(state)) {
      return clone(state);
    }
    backingStore.set(STORE_KEY, normalized);
    state = normalized;
    emit();
    return clone(state);
  };

  const updateJob = (familyId, patch) => {
    if (!FAMILY_ID.test(familyId) || !patch || typeof patch !== "object") {
      throw new TypeError("The onboarding job update is invalid.");
    }
    const index = state.jobs.findIndex((job) => job.familyId === familyId);
    if (index === -1) {
      throw new Error(`Unknown onboarding job: ${familyId}`);
    }
    const job = normalizeJob({ ...state.jobs[index], ...patch, familyId });
    if (!job) {
      throw new TypeError("The onboarding job update is invalid.");
    }
    const jobs = [...state.jobs];
    jobs[index] = job;
    return replace({ ...state, jobs, error: null });
  };

  return {
    get() {
      return clone(state);
    },
    start(familyIds) {
      const identifiers = assertFamilyIds(familyIds);
      if (state.completed) {
        return clone(state);
      }
      return replace({
        version: ONBOARDING_STATE_VERSION,
        completed: true,
        jobs: identifiers.map((familyId) => ({
          familyId,
          status: "queued",
          progress: null,
          error: null,
          failure: null,
          installedVariantIds: [],
          currentVariant: null,
        })),
        error: null,
      });
    },
    updateJob(familyId, patch) {
      return updateJob(familyId, patch);
    },
    retry(familyId) {
      const job = state.jobs.find(
        (candidate) => candidate.familyId === familyId,
      );
      if (!job || job.status !== "failed") {
        throw new Error("Only failed starter family imports can be retried.");
      }
      return updateJob(familyId, {
        status: "queued",
        progress: null,
        error: null,
        failure: null,
        currentVariant: null,
      });
    },
    dismiss(familyId) {
      const job = state.jobs.find(
        (candidate) => candidate.familyId === familyId,
      );
      if (!job || job.status !== "failed") {
        throw new Error("Only failed starter family imports can be dismissed.");
      }
      return replace({
        ...state,
        jobs: state.jobs.filter((candidate) => candidate.familyId !== familyId),
        error: null,
      });
    },
    interruptRunning() {
      const jobs = state.jobs.map((job) =>
        RUNNING_STATUSES.has(job.status)
          ? {
              ...job,
              status: "failed",
              progress: null,
              error: "Interrupted. Try again.",
              failure: {
                code: "INTERRUPTED",
                message: "Curated family import was interrupted.",
              },
            }
          : job,
      );
      return replace({ ...state, jobs });
    },
    replaceDataSnapshot(value) {
      return replace(value);
    },
    resetData() {
      return replace(normalizeOnboardingStoreState(null));
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("An onboarding state listener is required.");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
