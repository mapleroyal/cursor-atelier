import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("router scaffold", () => {
  it("boots with a memory-backed root route at /", async () => {
    await router.navigate("/");
    expect(router.state.location.pathname).toBe("/");
  });
});
