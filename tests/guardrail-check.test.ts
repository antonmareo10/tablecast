import { afterAll, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// The live guardrail check sends two fixed texts through the run's own screening: the clean one passes, the poisoned
// one is blocked by Otari before any model is called.
const { calls } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[] };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/guardrails/profiles")) return otariJSONResponse({ available: true, profiles: [{ profile: "prompt-injection" }] });
    const text = (call.body?.messages as { content: string }[])[0].content;
    if (/ignore all previous instructions/i.test(text))
      return otariJSONResponse({ detail: "Blocked by guardrail", code: "guardrail_violation" }, { status: 403, headers: { "otari-error-code": "guardrail_violation" } });
    return otariJSONResponse(
      { choices: [{ message: { content: "W" } }], usage: { prompt_tokens: 40, completion_tokens: 1, cost_usd: "0.000004" } },
      { headers: { "otari-guardrails": JSON.stringify([{ profile: "prompt-injection", mode: "block", valid: true, score: 0.01, status: "evaluated" }]) } },
    );
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { POST } from "@/app/api/guardrail-check/route";

describe("live guardrail check", () => {
  it("passes the clean review and reports the poisoned one as blocked by Otari", async () => {
    const res = await POST(new Request("http://localhost/api/guardrail-check", { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; samples: { id: string; verdict: string }[] };
    expect(body.available).toBe(true);
    expect(Object.fromEntries(body.samples.map((s) => [s.id, s.verdict]))).toEqual({ clean: "passed", poisoned: "flagged" });
    const completions = calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(completions).toHaveLength(2);
    for (const c of completions) expect(c.headers["otari-conversation-id"]).toMatch(/^tablecast-/);
  });

  it("limits how often one visitor can run it", async () => {
    let last = 200;
    for (let i = 0; i < 7; i++) last = (await POST(new Request("http://localhost/api/guardrail-check", { method: "POST", headers: { "x-forwarded-for": "10.8.8.8" } }))).status;
    expect(last).toBe(429);
  });
});
