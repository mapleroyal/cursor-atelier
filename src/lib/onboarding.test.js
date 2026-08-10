import { describe, expect, it } from "vitest";

import {
  createOptimisticOnboardingState,
  failOnboardingJobs,
  getOnboardingJobLabel,
  groupCursorFamilies,
  isOnboardingJobVisible,
  normalizeOnboardingState,
  queueOnboardingJob,
} from "./onboarding.js";

describe("onboarding state", () => {
  it("normalizes backend aliases and fractional progress", () => {
    expect(
      normalizeOnboardingState({
        version: 2,
        completed: true,
        imports: [
          {
            familyId: "oreo",
            phase: "fetching",
            progress: 0.42,
            currentVariant: "White",
            installedVariantIds: ["OreoBlack", "OreoBlack"],
          },
          { familyId: "bibata", state: "success" },
        ],
      }),
    ).toEqual({
      version: 2,
      completed: true,
      jobs: [
        {
          familyId: "oreo",
          status: "downloading",
          progress: 42,
          error: null,
          currentVariant: "White",
          installedVariantIds: ["OreoBlack"],
        },
        {
          familyId: "bibata",
          status: "completed",
          progress: null,
          error: null,
          currentVariant: null,
          installedVariantIds: [],
        },
      ],
      error: null,
    });
  });

  it("creates one deduplicated optimistic rail job per selection", () => {
    const state = createOptimisticOnboardingState([
      "oreo",
      "bibata",
      "oreo",
      "",
    ]);

    expect(state.completed).toBe(true);
    expect(state.jobs.map((job) => job.familyId)).toEqual(["oreo", "bibata"]);
    expect(state.jobs.every(isOnboardingJobVisible)).toBe(true);
  });

  it("moves failed jobs back to a quiet queued state for retry", () => {
    const failed = failOnboardingJobs(
      createOptimisticOnboardingState(["future"]),
      new Error("Network unavailable"),
    );
    expect(getOnboardingJobLabel(failed.jobs[0])).toBe("Failed");
    expect(failed.jobs[0].error).toBe("Network unavailable");

    const retrying = queueOnboardingJob(failed, "future");
    expect(getOnboardingJobLabel(retrying.jobs[0])).toBe("Preparing…");
    expect(retrying.jobs[0].error).toBeNull();
  });

  it("does not keep completed jobs in the temporary rail", () => {
    expect(isOnboardingJobVisible({ status: "completed" })).toBe(false);
    expect(getOnboardingJobLabel({ status: "converting", progress: 63 })).toBe(
      "Converting 63%",
    );
  });

  it("merges family jobs and progressively installed variants into one rail group", () => {
    const jobs = [
      {
        familyId: "nordzy",
        family: "Nordzy",
        status: "converting",
        progress: 24,
      },
      {
        familyId: "bibata",
        family: "Bibata",
        status: "queued",
      },
    ];
    const packs = [
      { id: "nordzy-white", family: "Nordzy", variant: "White" },
      { id: "nordzy-black", family: "Nordzy", variant: "Black" },
    ];

    const groups = groupCursorFamilies(packs, jobs);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      family: "Nordzy",
      familyPacks: packs,
      job: jobs[0],
    });
    expect(groups[1]).toMatchObject({
      family: "Bibata",
      familyPacks: [],
      job: jobs[1],
    });
  });

  it("filters an empty in-flight family alongside ordinary pack results", () => {
    const jobs = [
      { familyId: "future", family: "Future", status: "downloading" },
      { familyId: "bibata", family: "Bibata", status: "converting" },
    ];

    expect(
      groupCursorFamilies([], jobs, "fut").map(({ family }) => family),
    ).toEqual(["Future"]);
  });
});
