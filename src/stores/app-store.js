import { create } from "zustand";
import themeSeedColors from "@/lib/theme-seed-colors";
import {
  ONBOARDING_VERSION,
  canRetryOnboardingJob,
  createOptimisticOnboardingState,
  failOnboardingJobs,
  normalizeOnboardingState,
  queueOnboardingJob,
} from "@/lib/onboarding";

const DARK_MODE_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value) {
  return value === "light" || value === "dark";
}

function isThemeMode(value) {
  return value === "system" || isTheme(value);
}

function resolveElectronAPI(electronAPI) {
  return electronAPI ?? globalThis?.window?.electronAPI;
}

function resolveMatchMedia(matchMedia) {
  return matchMedia ?? globalThis?.window?.matchMedia;
}

export function getAppAppearanceMode(electronAPI) {
  try {
    const value = resolveElectronAPI(electronAPI)?.getAppAppearanceMode?.();
    return isThemeMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function getDesktopAppearance(electronAPI) {
  const value = resolveElectronAPI(electronAPI)?.getSystemAppearance?.();
  return isTheme(value) ? value : null;
}

export function getSystemTheme({ matchMedia } = {}) {
  const resolvedMatchMedia = resolveMatchMedia(matchMedia);

  if (typeof resolvedMatchMedia !== "function") {
    return "light";
  }

  return resolvedMatchMedia(DARK_MODE_MEDIA_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(themeMode, options = {}) {
  if (!isThemeMode(themeMode)) {
    return "light";
  }

  return themeMode === "system" ? getSystemTheme(options) : themeMode;
}

export function getInitialThemeMode({ electronAPI } = {}) {
  return getAppAppearanceMode(electronAPI) ?? "system";
}

export function getInitialTheme(options = {}) {
  return resolveTheme(getInitialThemeMode(options), options);
}

export function subscribeToSystemTheme(callback, matchMedia) {
  const resolvedMatchMedia = resolveMatchMedia(matchMedia);

  if (typeof resolvedMatchMedia !== "function") {
    return () => {};
  }

  const mediaQueryList = resolvedMatchMedia(DARK_MODE_MEDIA_QUERY);

  if (!mediaQueryList) {
    return () => {};
  }

  const handleChange = (event) => {
    callback(event.matches ? "dark" : "light");
  };

  if (typeof mediaQueryList.addEventListener === "function") {
    mediaQueryList.addEventListener("change", handleChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }

  if (typeof mediaQueryList.addListener === "function") {
    mediaQueryList.addListener(handleChange);

    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }

  return () => {};
}

export function applyThemeToDocument(
  theme,
  element = globalThis?.document?.documentElement,
) {
  if (!element?.classList || !isTheme(theme)) {
    return;
  }

  element.classList.toggle("dark", theme === "dark");

  if (element.style) {
    element.style.colorScheme = theme;
    element.style.backgroundColor =
      theme === "dark"
        ? themeSeedColors.dark.documentBackground
        : themeSeedColors.light.documentBackground;
  }
}

export function createAppStore({ electronAPI, matchMedia } = {}) {
  const initialThemeMode = getInitialThemeMode({ electronAPI });
  let confirmedThemeMode = initialThemeMode;
  let appearanceRequest = 0;
  let appearanceRevision = 0;
  let persistenceQueue = Promise.resolve();
  let onboardingRequest = 0;
  let onboardingHydration = null;
  const onboardingRetryRequests = new Map();

  const initialOnboardingState = {
    version: ONBOARDING_VERSION,
    completed: null,
    jobs: [],
    error: null,
  };

  return create((set, get) => ({
    themeMode: initialThemeMode,
    theme: resolveTheme(initialThemeMode, { matchMedia }),
    systemAppearance: getDesktopAppearance(electronAPI),
    themeError: null,
    onboarding: initialOnboardingState,
    onboardingLoading: true,
    setThemeMode: (themeMode) => {
      if (!isThemeMode(themeMode)) {
        return Promise.resolve(false);
      }

      const theme = resolveTheme(themeMode, { matchMedia });
      const request = ++appearanceRequest;
      const revision = appearanceRevision;

      set({ themeMode, theme, themeError: null });
      const setter = resolveElectronAPI(electronAPI)?.setAppAppearanceMode;
      if (typeof setter !== "function") {
        confirmedThemeMode = themeMode;
        return Promise.resolve(true);
      }

      // An imported or recovered preference supersedes older queued choices.
      const persist = () =>
        appearanceRevision === revision
          ? setter(themeMode)
          : confirmedThemeMode;
      const result = persistenceQueue.then(persist, persist);
      persistenceQueue = result.then(
        () => undefined,
        () => undefined,
      );

      return Promise.resolve(result).then(
        (persistedMode) => {
          const canonicalMode = isThemeMode(persistedMode)
            ? persistedMode
            : themeMode;
          if (appearanceRevision === revision) {
            confirmedThemeMode = canonicalMode;
          }
          if (
            appearanceRevision === revision &&
            appearanceRequest === request &&
            get().themeMode === themeMode
          ) {
            set({
              themeMode: canonicalMode,
              theme: resolveTheme(canonicalMode, {
                matchMedia,
              }),
              themeError: null,
            });
          }
          return true;
        },
        (error) => {
          if (
            appearanceRevision === revision &&
            appearanceRequest === request &&
            get().themeMode === themeMode
          ) {
            set({
              themeMode: confirmedThemeMode,
              theme: resolveTheme(confirmedThemeMode, {
                matchMedia,
              }),
              themeError: "Couldn’t save the appearance preference.",
            });
          }
          console.error("Couldn’t save the appearance preference.", error);
          return false;
        },
      );
    },
    setTheme: (theme) => {
      if (!isTheme(theme)) {
        return Promise.resolve(false);
      }
      return get().setThemeMode(theme);
    },
    followSystemTheme: () => get().setThemeMode("system"),
    syncAppAppearanceMode: (mode) => {
      if (!isThemeMode(mode)) {
        return;
      }
      confirmedThemeMode = mode;
      appearanceRevision += 1;
      set({
        themeMode: mode,
        theme: resolveTheme(mode, { matchMedia }),
        themeError: null,
      });
    },
    syncDesktopAppearance: (appearance) => {
      if (isTheme(appearance)) {
        set({ systemAppearance: appearance });
      }
    },
    syncSystemTheme: (systemTheme) =>
      set((state) => {
        if (state.themeMode !== "system" || !isTheme(systemTheme)) {
          return state;
        }

        if (state.theme === systemTheme) {
          return state;
        }

        return { ...state, theme: systemTheme };
      }),
    toggleTheme: () =>
      get().setThemeMode(get().theme === "dark" ? "light" : "dark"),
    hydrateOnboarding: () => {
      if (onboardingHydration) {
        return onboardingHydration;
      }
      const request = ++onboardingRequest;
      const getter = resolveElectronAPI(electronAPI)?.getOnboardingState;
      if (typeof getter !== "function") {
        const state = { ...initialOnboardingState, completed: true };
        set({ onboarding: state, onboardingLoading: false });
        onboardingHydration = Promise.resolve(state);
        return onboardingHydration;
      }

      onboardingHydration = Promise.resolve()
        .then(() => getter())
        .then(
          (value) => {
            const state = normalizeOnboardingState(value);
            if (request === onboardingRequest) {
              set({ onboarding: state, onboardingLoading: false });
            }
            return state;
          },
          (error) => {
            const state = normalizeOnboardingState({
              completed: false,
              error,
            });
            if (request === onboardingRequest) {
              set({ onboarding: state, onboardingLoading: false });
            }
            return state;
          },
        );
      return onboardingHydration;
    },
    completeOnboarding: (familyIds) => {
      onboardingRetryRequests.clear();
      const optimistic = createOptimisticOnboardingState(familyIds);
      const request = ++onboardingRequest;
      set({ onboarding: optimistic, onboardingLoading: false });
      const starter = resolveElectronAPI(electronAPI)?.startOnboarding;
      if (typeof starter !== "function") {
        const failed = optimistic.jobs.length
          ? failOnboardingJobs(
              optimistic,
              "Starter pack imports are unavailable in this build.",
            )
          : optimistic;
        set({ onboarding: failed });
        return Promise.resolve(failed);
      }

      return Promise.resolve()
        .then(() => starter(optimistic.jobs.map((job) => job.familyId)))
        .then(
          (value) => {
            const state = normalizeOnboardingState(value, optimistic);
            if (request === onboardingRequest) {
              set({ onboarding: state });
            }
            return state;
          },
          (error) => {
            const failed = failOnboardingJobs(optimistic, error);
            if (request === onboardingRequest) {
              set({ onboarding: failed });
            }
            return failed;
          },
        );
    },
    retryOnboardingImport: (familyId) => {
      const id = String(familyId ?? "").trim();
      if (
        !canRetryOnboardingJob(
          get().onboarding.jobs.find((job) => job.familyId === id),
        )
      ) {
        return Promise.resolve(get().onboarding);
      }
      const optimistic = queueOnboardingJob(get().onboarding, id);
      const request = ++onboardingRequest;
      onboardingRetryRequests.set(id, request);
      set({ onboarding: optimistic });
      const failRetry = (error) => {
        const current = get().onboarding;
        if (
          onboardingRetryRequests.get(id) !== request ||
          !current.jobs.some(
            (job) => job.familyId === id && job.status === "queued",
          )
        ) {
          return current;
        }
        onboardingRetryRequests.delete(id);
        const message = String(error?.message ?? error ?? "Retry failed.");
        const failed = {
          ...current,
          jobs: current.jobs.map((job) =>
            job.familyId === id
              ? { ...job, status: "failed", error: message }
              : job,
          ),
        };
        set({ onboarding: failed });
        return failed;
      };
      const retry = resolveElectronAPI(electronAPI)?.retryOnboardingImport;
      if (typeof retry !== "function") {
        return Promise.resolve(
          failRetry("Retry is unavailable in this build."),
        );
      }

      return Promise.resolve()
        .then(() => retry(id))
        .then((value) => {
          const state = normalizeOnboardingState(value, optimistic);
          if (request === onboardingRequest) {
            set({ onboarding: state });
          }
          return state;
        }, failRetry)
        .finally(() => {
          if (onboardingRetryRequests.get(id) === request) {
            onboardingRetryRequests.delete(id);
          }
        });
    },
    dismissOnboardingImport: async (familyId) => {
      const id = String(familyId ?? "").trim();
      const job = get().onboarding.jobs.find(
        (candidate) => candidate.familyId === id,
      );
      if (job?.status !== "failed") {
        return get().onboarding;
      }
      const dismiss = resolveElectronAPI(electronAPI)?.dismissOnboardingImport;
      if (typeof dismiss !== "function") {
        throw new Error("Dismissing imports is unavailable in this build.");
      }
      const request = ++onboardingRequest;
      const value = await dismiss(id);
      const state = normalizeOnboardingState(value);
      if (request === onboardingRequest) {
        set({ onboarding: state });
      }
      return state;
    },
    syncOnboarding: (value) => {
      onboardingRequest += 1;
      // Every job in this snapshot is authoritative, including queued jobs.
      onboardingRetryRequests.clear();
      const onboarding = normalizeOnboardingState(value, get().onboarding);
      set({ onboarding, onboardingLoading: false });
      return onboarding;
    },
  }));
}

export const useAppStore = createAppStore();
