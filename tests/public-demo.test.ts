import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// What keeps a public deployment from spending its Otari credit: live runs only with the owner's token, and the two
// small live demos (guardrail check, failover drill) capped per visitor.
const { calls } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[] };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push(recordCall(input, init));
    return otariJSONResponse(
      { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 20, completion_tokens: 2, cost_usd: "0.000052" } },
      { headers: { "otari-provider": "fireworks", "otari-model": "accounts/fireworks/models/nemotron-3-ultra-nvfp4", "otari-attempt-count": "2", "otari-fallback": "true" } },
    );
  }),
);
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  delete process.env.LIVE_RUNS_TOKEN;
  calls.length = 0;
});

import { liveTokenRefusal } from "@/lib/limits";
import { POST as agent } from "@/app/api/agent/route";
import { POST as drill } from "@/app/api/failover-drill/route";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/agent", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ restaurant: "Gjelina", city: "Los Angeles" }) });

describe("public demo safety", () => {
  it("with LIVE_RUNS_TOKEN set, a live run without the owner's token is refused before any Otari call", async () => {
    process.env.LIVE_RUNS_TOKEN = "owner-token-0123456789";
    expect(liveTokenRefusal(req())).toMatch(/kept for its owner/);
    expect(liveTokenRefusal(req({ "x-tablecast-live": "owner-token-0123456789" }))).toBeNull();
    const res = await agent(req({ "x-tablecast-live": "nope" }));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("without LIVE_RUNS_TOKEN, live runs are open (within the other caps)", () => {
    expect(liveTokenRefusal(req())).toBeNull();
  });

  it("the failover drill reports who served it from Otari's headers, and is capped per visitor", async () => {
    const res = await drill(new Request("http://localhost/api/failover-drill", { method: "POST", headers: { "x-forwarded-for": "10.7.7.7" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ asked: "tablecast-drill", provider: "fireworks", label: "Nemotron 3 Ultra", attempts: 2, fallback: true });
    expect(calls[0].body).toMatchObject({ model: "tablecast-drill", reasoning_effort: "low" });
    let last = 200;
    for (let i = 0; i < 6; i++) last = (await drill(new Request("http://localhost/api/failover-drill", { method: "POST", headers: { "x-forwarded-for": "10.7.7.7" } }))).status;
    expect(last).toBe(429);
  });
});
