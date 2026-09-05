import { describe, expect, it } from "vitest";

import {
  createOptimisticOnboardingState,
  failOnboardingJobs,
  getOnboardingFailureDetail,
  getOnboardingJobLabel,
  canRetryOnboardingJob,
  groupCursorFamilies,
  isOnboardingJobVisible,
  normalizeOnboardingState,
  queueOnboardingJob,
} from "./onboarding.js";

describe("onboarding state", () => {
  it("normalizes backend aliases and percentage progress", () => {
    expect(
      normalizeOnboardingState({
        version: 2,
        completed: true,
        imports: [
          {
            familyId: "oreo",
            phase: "fetching",
            progress: 42,
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
          failure: null,
          currentVariant: "White",
          installedVariantIds: ["OreoBlack"],
        },
        {
          familyId: "bibata",
          status: "completed",
          progress: null,
          error: null,
          failure: null,
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
    expect(failed.jobs[0].failure).toEqual({
      code: "ONBOARDING_REQUEST_FAILED",
      message: "Network unavailable",
    });

    const retrying = queueOnboardingJob(failed, "future");
    expect(getOnboardingJobLabel(retrying.jobs[0])).toBe("Preparing…");
    expect(retrying.jobs[0].error).toBeNull();
    expect(retrying.jobs[0].failure).toBeNull();
  });

  it("normalizes structured failure details for copyable diagnostics", () => {
    const [job] = normalizeOnboardingState({
      jobs: [
        {
          familyId: "simp1e",
          status: "failed",
          error: "Download failed. Try again.",
          failure: {
            code: "DOWNLOAD_FAILED",
            message: "GitLab returned HTTP 406.",
          },
        },
      ],
    }).jobs;

    expect(job.failure).toEqual({
      code: "DOWNLOAD_FAILED",
      message: "GitLab returned HTTP 406.",
    });
    expect(getOnboardingFailureDetail(job)).toBe(
      "DOWNLOAD_FAILED: GitLab returned HTTP 406.",
    );
    expect(
      getOnboardingFailureDetail({ error: "Conversion failed. Try again." }),
    ).toBe("Conversion failed. Try again.");
  });

  it("does not keep completed jobs in the temporary rail", () => {
    expect(isOnboardingJobVisible({ status: "completed" })).toBe(false);
    expect(getOnboardingJobLabel({ status: "converting", progress: 63 })).toBe(
      "Converting 63%",
    );
  });

  it("preserves one percent and indeterminate progress from the service", () => {
    expect(getOnboardingJobLabel({ status: "downloading", progress: 1 })).toBe(
      "Downloading 1%",
    );
    expect(
      getOnboardingJobLabel({ status: "downloading", progress: null }),
    ).toBe("Downloading…");
  });

  it("offers retries for transient failures but not unavailable pinned sources", () => {
    expect(
      canRetryOnboardingJob({
        status: "failed",
        failure: { code: "DOWNLOAD_FAILED" },
      }),
    ).toBe(true);
    expect(
      canRetryOnboardingJob({
        status: "failed",
        failure: { code: "SOURCE_CHANGED" },
      }),
    ).toBe(false);
    expect(
      canRetryOnboardingJob({
        status: "failed",
        failure: { code: "SOURCE_UNAVAILABLE" },
      }),
    ).toBe(false);
    expect(canRetryOnboardingJob({ status: "downloading" })).toBe(false);
  });

  it("keeps installed families above families that are still being added", () => {
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
      { id: "oreo-white", family: "Oreo", variant: "White" },
    ];

    const groups = groupCursorFamilies(packs, jobs);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      family: "Oreo",
      familyPacks: [packs[2]],
      job: null,
    });
    expect(groups[1]).toMatchObject({
      family: "Nordzy",
      familyPacks: packs.slice(0, 2),
      job: jobs[0],
    });
    expect(groups[2]).toMatchObject({
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
