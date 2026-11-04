import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// Before a live run, one free Otari call (GET /v1/models) checks the key and which routing policies exist. A rejected
// key stops the run at once with a plain "paused" message, and nothing else is called.
const { calls, behaviour } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  process.env.TAVILY_API_KEY = "test-key";
  return { calls: [] as Recorded[], behaviour: { models: "ok" as "ok" | "401" } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (behaviour.models === "401") return otariJSONResponse({ detail: "Invalid API key" }, { status: 401 });
    return otariJSONResponse({ data: [{ id: "tablecast-research" }, { id: "tablecast-write" }, { id: "nvidia/nemotron-3-ultra-550b-a55b" }] });
  }),
);
afterAll(() => vi.unstubAllGlobals());

const post = async () => {
  vi.resetModules();
  const { POST } = await import("@/app/api/agent/route");
  const limits = await import("@/lib/limits");
  const res = await POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify({ restaurant: "Gjelina", city: "Los Angeles" }),
    }),
  );
  return { res, limits };
};

beforeEach(() => {
  calls.length = 0;
  behaviour.models = "ok";
});

describe("live-run preflight", () => {
  it("stops before any research when Otari rejects the key, and pauses live runs", async () => {
    behaviour.models = "401";
    const { res, limits } = await post();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Live runs are paused: Otari rejected this demo's API key/);
    expect(calls).toHaveLength(1); // only the free model listing
    expect(calls[0].url).toBe("https://eu.api.otari.ai/api/v1/models");
    expect(limits.liveRunsDisabled()).toMatch(/paused/);
  });

  it("keeps the workspace's routing policies and swaps a missing one for its catalog id", async () => {
    vi.resetModules();
    const { resolveRouting, defaultRouting, resetModelCache } = await import("@/lib/model-runtime");
    resetModelCache();
    const { routing, missing } = await resolveRouting(defaultRouting());
    expect(routing.fast).toBe("tablecast-research");
    expect(routing.reasoning).toBe("tablecast-write");
    expect(routing.repair).toBe("nvidia/nemotron-3-ultra-550b-a55b"); // tablecast-check is not in the listing
    expect(routing.quartermaster).toBe("openai/gpt-oss-120b");
    expect(missing).toEqual(["tablecast-check", "tablecast-quartermaster"]);
  });
});
