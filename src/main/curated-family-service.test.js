import { describe, expect, it, vi } from "vitest";

import { createCuratedFamilyService } from "./curated-family-service.js";
import { createOnboardingStore } from "./onboarding-store.js";

class MemoryStore {
  static values = new Map();

  constructor({ name, defaults }) {
    this.name = name;
    MemoryStore.values.set(name, structuredClone(defaults));
  }

  get(key) {
    return structuredClone(MemoryStore.values.get(this.name)[key]);
  }

  set(key, value) {
    MemoryStore.values.get(this.name)[key] = structuredClone(value);
  }
}

function makeStore() {
  MemoryStore.values.clear();
  return createOnboardingStore({
    directory: "/state",
    Store: MemoryStore,
  });
}

describe("curated family service", () => {
  it("acquires once and installs every converted family variant incrementally", async () => {
    const store = makeStore();
    const changes = [];
    const releaseFamilySources = vi.fn();
    const installVariants = vi.fn(async ({ variants }) => ({
      identifiers: variants.map((variant) => variant.expectedIdentifier),
    }));
    const service = createCuratedFamilyService({
      familyIds: ["future"],
      variantsByFamily: new Map([["future", ["Future", "FutureCyan"]]]),
      store,
      acquireFamilySources: async ({ onProgress }) => {
        onProgress(0.5);
        return { sourceRoot: "/sources" };
      },
      releaseFamilySources,
      convertFamily: async ({ onEvent, skipIdentifiers }) => {
        expect(skipIdentifiers).toEqual([]);
        await onEvent({
          type: "variant-start",
          identifier: "Future",
          displayName: "Future",
          progress: 0.1,
        });
        await onEvent({
          type: "variant-complete",
          identifier: "Future",
          displayName: "Future",
          artifactDirectory: "/work/Future",
          progress: 0.5,
        });
        await onEvent({
          type: "variant-complete",
          identifier: "FutureCyan",
          displayName: "Future Cyan",
          artifactDirectory: "/work/FutureCyan",
          progress: 1,
        });
        await onEvent({ type: "family-complete", familyId: "future" });
      },
      installVariants,
      onLibraryChanged: (change) => changes.push(change),
    });

    service.start(["future"]);
    await service.whenIdle();

    expect(installVariants).toHaveBeenCalledTimes(1);
    expect(releaseFamilySources).toHaveBeenCalledWith({ familyId: "future" });
    expect(changes.map((change) => change.identifiers)).toEqual([
      ["Future", "FutureCyan"],
    ]);
    expect(service.getState().jobs[0]).toEqual({
      familyId: "future",
      status: "completed",
      progress: 100,
      error: null,
      installedVariantIds: ["Future", "FutureCyan"],
      currentVariant: null,
    });
  });

  it("keeps completed variants on failure and skips them on retry", async () => {
    const store = makeStore();
    let attempt = 0;
    const skips = [];
    const service = createCuratedFamilyService({
      familyIds: ["future"],
      variantsByFamily: { future: ["Future", "FutureCyan"] },
      store,
      getInstalledVariantIds: async () => (attempt === 0 ? [] : ["Future"]),
      acquireFamilySources: async () => ({ sourceRoot: "/sources" }),
      convertFamily: async ({ onEvent, skipIdentifiers }) => {
        attempt += 1;
        skips.push(skipIdentifiers);
        if (attempt === 1) {
          await onEvent({
            type: "variant-complete",
            identifier: "Future",
            artifactDirectory: "/work/Future",
            progress: 50,
          });
          await onEvent({ type: "failed", familyId: "future" });
          throw Object.assign(new Error("renderer crashed"), {
            code: "CONVERSION_FAILED",
          });
        }
        await onEvent({
          type: "variant-complete",
          identifier: "FutureCyan",
          artifactDirectory: "/work/FutureCyan",
          progress: 100,
        });
        await onEvent({ type: "done" });
      },
      installVariants: async ({ variants }) => ({
        identifiers: variants.map((variant) => variant.expectedIdentifier),
      }),
      onError: () => {},
    });

    service.start(["future"]);
    await service.whenIdle();
    expect(service.getState().jobs[0]).toMatchObject({
      status: "failed",
      installedVariantIds: ["Future"],
    });

    service.retry("future");
    await service.whenIdle();
    expect(skips).toEqual([[], ["Future"]]);
    expect(service.getState().jobs[0]).toMatchObject({
      status: "completed",
      installedVariantIds: ["Future", "FutureCyan"],
    });
  });

  it("rejects unknown and duplicate family selections", () => {
    const store = makeStore();
    const service = createCuratedFamilyService({
      familyIds: ["future"],
      variantsByFamily: { future: ["Future", "FutureCyan"] },
      store,
      acquireFamilySources: vi.fn(),
      convertFamily: vi.fn(),
      installVariants: vi.fn(),
    });

    expect(() => service.start(["unknown"])).toThrow(/selection/);
    expect(() => service.start(["future", "future"])).toThrow(/selection/);
  });

  it("does not reacquire a family whose exact variants are already installed", async () => {
    const store = makeStore();
    const acquireFamilySources = vi.fn();
    const releaseFamilySources = vi.fn();
    const service = createCuratedFamilyService({
      familyIds: ["future"],
      variantsByFamily: { future: ["Future", "FutureCyan"] },
      store,
      getInstalledVariantIds: async () => ["Future", "FutureCyan"],
      acquireFamilySources,
      releaseFamilySources,
      convertFamily: vi.fn(),
      installVariants: vi.fn(),
    });

    service.start(["future"]);
    await service.whenIdle();

    expect(acquireFamilySources).not.toHaveBeenCalled();
    expect(releaseFamilySources).toHaveBeenCalledWith({ familyId: "future" });
    expect(service.getState().jobs[0]).toMatchObject({
      status: "completed",
      installedVariantIds: ["Future", "FutureCyan"],
    });
  });
});
