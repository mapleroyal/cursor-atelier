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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      failure: null,
      installedVariantIds: ["Future", "FutureCyan"],
      currentVariant: null,
    });
  });

  it("acquires four families concurrently but converts only one at a time", async () => {
    const store = makeStore();
    const familyIds = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const acquisitions = new Map(
      familyIds.map((familyId) => [familyId, deferred()]),
    );
    const conversions = new Map(
      familyIds.map((familyId) => [familyId, deferred()]),
    );
    const acquisitionStarts = [];
    const conversionStarts = [];
    let activeAcquisitions = 0;
    let maximumAcquisitions = 0;
    let activeConversions = 0;
    let maximumConversions = 0;
    const service = createCuratedFamilyService({
      familyIds,
      variantsByFamily: Object.fromEntries(
        familyIds.map((familyId) => [familyId, [familyId.toUpperCase()]]),
      ),
      store,
      acquireFamilySources: async ({ familyId }) => {
        acquisitionStarts.push(familyId);
        activeAcquisitions += 1;
        maximumAcquisitions = Math.max(maximumAcquisitions, activeAcquisitions);
        await acquisitions.get(familyId).promise;
        activeAcquisitions -= 1;
        return { sourceRoot: `/sources/${familyId}` };
      },
      convertFamily: async ({ familyId, onEvent }) => {
        conversionStarts.push(familyId);
        activeConversions += 1;
        maximumConversions = Math.max(maximumConversions, activeConversions);
        await conversions.get(familyId).promise;
        await onEvent({
          type: "variant-complete",
          identifier: familyId.toUpperCase(),
          artifactDirectory: `/work/${familyId}`,
          progress: 1,
        });
        await onEvent({ type: "done" });
        activeConversions -= 1;
      },
      installVariants: async ({ variants }) => ({
        identifiers: variants.map((variant) => variant.expectedIdentifier),
      }),
    });

    service.start(familyIds);
    await vi.waitFor(() => expect(acquisitionStarts).toHaveLength(4));
    expect(acquisitionStarts).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(maximumAcquisitions).toBe(4);

    acquisitions.get("alpha").resolve();
    await vi.waitFor(() => expect(acquisitionStarts).toHaveLength(5));
    expect(acquisitionStarts[4]).toBe("epsilon");
    for (const familyId of familyIds.slice(1)) {
      acquisitions.get(familyId).resolve();
    }

    await vi.waitFor(() => expect(conversionStarts).toEqual(["alpha"]));
    for (let index = 0; index < familyIds.length; index += 1) {
      await vi.waitFor(() => expect(conversionStarts).toHaveLength(index + 1));
      conversions.get(conversionStarts[index]).resolve();
    }
    await service.whenIdle();

    expect(maximumConversions).toBe(1);
    expect(
      service.getState().jobs.every((job) => job.status === "completed"),
    ).toBe(true);
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
            progress: 0.5,
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
          progress: 1,
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
      failure: {
        code: "CONVERSION_FAILED",
        message: "renderer crashed",
      },
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

  it("lets unavailable source imports be dismissed without converting or removing installed themes", async () => {
    const store = makeStore();
    const acquisition = deferred();
    const convertFamily = vi.fn();
    const installVariants = vi.fn();
    const service = createCuratedFamilyService({
      familyIds: ["future"],
      variantsByFamily: { future: ["Future", "FutureCyan"] },
      store,
      getInstalledVariantIds: async () => ["Future"],
      acquireFamilySources: async ({ onProgress }) => {
        onProgress(null);
        expect(store.get().jobs[0].progress).toBeNull();
        onProgress(0.01);
        expect(store.get().jobs[0].progress).toBe(1);
        await acquisition.promise;
        throw Object.assign(new Error("The pinned source is gone."), {
          code: "SOURCE_UNAVAILABLE",
        });
      },
      convertFamily,
      installVariants,
      onError: () => {},
    });
    service.start(["future"]);
    expect(() => service.dismiss("future")).toThrow(/dismissal/);
    acquisition.resolve();
    await service.whenIdle();
    expect(service.getState().jobs[0]).toMatchObject({
      status: "failed",
      installedVariantIds: ["Future"],
      error:
        "This source has changed or is unavailable. Dismiss this import or import a local cursor pack.",
    });
    expect(() => service.retry("future")).toThrow(/retry/);
    expect(service.dismiss("future").jobs).toEqual([]);
    expect(service.getState().completed).toBe(true);
    expect(convertFamily).not.toHaveBeenCalled();
    expect(installVariants).not.toHaveBeenCalled();
    expect(() => service.dismiss("unknown")).toThrow(/selection/);
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
