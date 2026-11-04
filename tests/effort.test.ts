import { describe, expect, it } from "vitest";
import { defaultRouting, economyRouting, effortFor } from "@/lib/model-runtime";

// Bedrock refuses reasoning_effort for non-Claude models (400), which made every Economy request fail over to its
// second candidate. The Economy writer's requests carry none; the Quick writer, its retry and the checker keep theirs.
describe("reasoning_effort per request", () => {
  it("Quick sends it to the writer", () => {
    const r = defaultRouting();
    expect(effortFor(r, r.reasoning, "medium")).toEqual({ reasoning_effort: "medium" });
  });

  it("Economy sends none to its writer, but keeps it for the Quick writer that takes over a retry, and for the checker", () => {
    const r = economyRouting();
    expect(effortFor(r, r.reasoning, "medium")).toEqual({});
    expect(effortFor(r, r.fallback as string, "low")).toEqual({ reasoning_effort: "low" });
    expect(effortFor(r, r.repair as string, "low")).toEqual({ reasoning_effort: "low" });
  });
});
