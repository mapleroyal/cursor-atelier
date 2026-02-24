import { describe, expect, it } from "vitest";
import { queryClient } from "./query-client";

describe("query client defaults", () => {
  it("uses conservative, offline-friendly defaults for scaffolded apps", () => {
    const options = queryClient.getDefaultOptions().queries;

    expect(options.staleTime).toBe(5 * 60 * 1000);
    expect(options.gcTime).toBe(30 * 60 * 1000);
    expect(options.retry).toBe(1);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.networkMode).toBe("offlineFirst");
  });
});
