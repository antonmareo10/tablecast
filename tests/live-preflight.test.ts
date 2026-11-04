import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// Before a live run, free Otari calls check the key (GET /v1/models), which routing policies exist, whether the key is
// a service key (GET /v1/end-user-budgets) and where the restaurant stands on its own budget (GET /v1/end-users).
// A rejected key, or a restaurant that cannot cover a plan, stops the run before anything is paid for.
const { calls, behaviour } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[], behaviour: { models: "ok" as "ok" | "401", service: true, spend: 0.1 } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/v1/models")) {
      if (behaviour.models === "401") return otariJSONResponse({ detail: "Invalid API key" }, { status: 401 });
      return otariJSONResponse({ data: [{ id: "tablecast-research" }, { id: "tablecast-write" }, { id: "nvidia/nemotron-3-ultra-550b-a55b" }] });
    }
    if (call.url.endsWith("/v1/end-user-budgets")) {
      if (!behaviour.service) return otariJSONResponse({ detail: "Not a service key" }, { status: 403 });
      return otariJSONResponse([{ id: "tablecast-restaurant-week", name: "tablecast-restaurant-week", max_budget: 1, reset_alignment: "calendar_week", end_user_count: 3 }]);
    }
    if (call.url.includes("/v1/end-users?external_id="))
      return otariJSONResponse([{ external_id: "restaurant:gjelina-los-angeles", budget_id: "tablecast-restaurant-week", spend: behaviour.spend, max_budget: 1, blocked: false }]);
    return otariJSONResponse({ detail: "unexpected call in this test" }, { status: 500 });
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

const paid = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  calls.length = 0;
  behaviour.models = "ok";
  behaviour.service = true;
  behaviour.spend = 0.1;
});

describe("live-run preflight", () => {
  it("stops before any research when Otari rejects the key, and pauses live runs", async () => {
    behaviour.models = "401";
    const { res, limits } = await post();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Live runs are paused: Otari rejected this demo's API key/);
    expect(paid()).toHaveLength(0);
    expect(calls.map((c) => c.url)).toContain("https://eu.api.otari.ai/api/v1/models");
    expect(limits.liveRunsDisabled()).toMatch(/paused/);
  });

  it("stops a restaurant whose weekly Otari budget can't cover a plan, before anything is paid for, without pausing others", async () => {
    behaviour.spend = 0.95;
    const { res, limits } = await post();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/This restaurant has \$0\.05 left of its \$1\.00 AI budget on Otari/);
    expect(calls.find((c) => c.url.includes("/v1/end-users?"))?.url).toBe("https://eu.api.otari.ai/api/v1/end-users?external_id=restaurant%3Agjelina-los-angeles");
    expect(paid()).toHaveLength(0);
    expect(limits.liveRunsDisabled()).toBeNull();
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

  it("reads a restaurant's budget line from Otari's end-user record", async () => {
    vi.resetModules();
    const b = await import("@/lib/otari-budget");
    b.resetEndUserCache();
    const svc = await b.endUsersEnabled();
    expect(svc.enabled).toBe(true);
    const status = await b.endUserStatus("restaurant:gjelina-los-angeles");
    expect(b.budgetLine(status, svc.budgets)).toEqual({ spend: 0.1, limit: 1, budget: "tablecast-restaurant-week", period: "calendar_week" });
    behaviour.service = false;
    b.resetEndUserCache();
    expect((await b.endUsersEnabled()).enabled).toBe(false);
  });
});
