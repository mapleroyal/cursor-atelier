import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOnboardingStore,
  normalizeOnboardingStoreState,
} from "./onboarding-store.js";

class MemoryStore {
  static values = new Map();

  constructor({ name, defaults }) {
    this.name = name;
    if (!MemoryStore.values.has(name)) {
      MemoryStore.values.set(name, structuredClone(defaults));
    }
  }

  get(key) {
    return structuredClone(MemoryStore.values.get(this.name)[key]);
  }

  set(key, value) {
    MemoryStore.values.get(this.name)[key] = structuredClone(value);
  }
}

describe("onboarding store", () => {
  beforeEach(() => {
    MemoryStore.values.clear();
  });

  it("normalizes malformed persisted state", () => {
    expect(
      normalizeOnboardingStoreState({
        version: 2,
        completed: "yes",
        jobs: [
          {
            familyId: "oreo",
            status: "downloading",
            progress: 130,
            installedVariantIds: ["OreoWhite", "OreoWhite", "../escape"],
            currentVariant: "  Spark Dark  ",
          },
          { familyId: "oreo", status: "completed" },
          { familyId: "../escape", status: "queued" },
        ],
        error: "  problem  ",
      }),
    ).toEqual({
      version: 2,
      completed: false,
      jobs: [
        {
          familyId: "oreo",
          status: "downloading",
          progress: 100,
          error: null,
          failure: null,
          installedVariantIds: ["OreoWhite"],
          currentVariant: "Spark Dark",
        },
      ],
      error: "problem",
    });
  });

  it("starts once, persists progress, and retries only failures", () => {
    const store = createOnboardingStore({
      directory: "/state",
      Store: MemoryStore,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.start(["oreo", "future"]);
    store.updateJob("oreo", {
      status: "failed",
      error: "Download failed.",
    });
    store.retry("oreo");

    expect(store.get()).toMatchObject({
      completed: true,
      jobs: [
        { familyId: "oreo", status: "queued", error: null },
        { familyId: "future", status: "queued", error: null },
      ],
    });
    expect(store.start([]).jobs).toHaveLength(2);
    expect(() => store.retry("future")).toThrow(/Only failed/);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("turns interrupted work into explicit retryable failures", () => {
    const first = createOnboardingStore({
      directory: "/state",
      Store: MemoryStore,
    });
    first.start(["colloid"]);
    first.updateJob("colloid", { status: "installing", progress: 90 });

    const relaunched = createOnboardingStore({
      directory: "/state",
      Store: MemoryStore,
    });
    relaunched.interruptRunning();

    expect(relaunched.get().jobs[0]).toEqual({
      familyId: "colloid",
      status: "failed",
      progress: null,
      error: "Interrupted. Try again.",
      failure: {
        code: "INTERRUPTED",
        message: "Curated family import was interrupted.",
      },
      installedVariantIds: [],
      currentVariant: null,
    });
  });

  it("keeps concise structured failure details only on failed jobs", () => {
    expect(
      normalizeOnboardingStoreState({
        version: 2,
        completed: true,
        jobs: [
          {
            familyId: "qogir",
            status: "failed",
            error: "Conversion failed. Try again.",
            failure: {
              code: "CURATED_CONVERSION_FAILED",
              message: "  required wait cursor is not animated\ntry again  ",
            },
          },
          {
            familyId: "colloid",
            status: "completed",
            failure: { code: "STALE", message: "not retained" },
          },
        ],
      }).jobs,
    ).toMatchObject([
      {
        familyId: "qogir",
        failure: {
          code: "CURATED_CONVERSION_FAILED",
          message: "required wait cursor is not animated try again",
        },
      },
      { familyId: "colloid", failure: null },
    ]);
  });

  it("resets incompatible pre-release state instead of carrying it forward", () => {
    expect(
      normalizeOnboardingStoreState({
        version: 1,
        completed: true,
        jobs: [{ catalogId: "oreo-white", status: "completed" }],
      }),
    ).toEqual({ version: 2, completed: false, jobs: [], error: null });
  });

  it("replaces and resets data for portable archive transactions", () => {
    const store = createOnboardingStore({
      directory: "/state",
      Store: MemoryStore,
    });
    store.replaceDataSnapshot({
      version: 2,
      completed: true,
      jobs: [
        {
          familyId: "oreo",
          status: "completed",
          installedVariantIds: ["OreoWhite"],
        },
      ],
    });
    expect(store.get()).toMatchObject({
      completed: true,
      jobs: [{ familyId: "oreo", status: "completed" }],
    });

    expect(store.resetData()).toEqual({
      version: 2,
      completed: false,
      jobs: [],
      error: null,
    });
  });
});
