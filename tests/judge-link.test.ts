import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// The judges' link: live runs without the owner's token, every request billed to the judges' own Otari end user,
// refused before any paid call when the token is wrong or expired, when that end user isn't set up on its budget, is
// blocked or can't cover a plan; one judge run at a time and a few an hour.
const TOKEN = "judge-token-0123456789abcdefghij"; // 32 characters
const JUDGES = "judges:mozfest-wilding-2026";
const JUDGE_BUDGET = "budget-judges";

const { calls, behaviour } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return {
    calls: [] as Recorded[],
    behaviour: { judge: true as boolean, budget: "budget-judges", blocked: false, spend: 0.1, service: true },
  };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/v1/models")) return otariJSONResponse({ data: [{ id: "tablecast-research" }, { id: "tablecast-write" }] });
    if (call.url.endsWith("/v1/end-user-budgets")) {
      if (!behaviour.service) return otariJSONResponse({ detail: "Not a service key" }, { status: 403 });
      return otariJSONResponse([
        { budget_id: "budget-week", name: "tablecast-restaurant-week", max_budget: 1, reset_alignment: "calendar_week", is_default: true, end_user_count: 4 },
        { budget_id: JUDGE_BUDGET, name: "tablecast-judges", max_budget: 1, reset_alignment: null, is_default: false, end_user_count: 1 },
      ]);
    }
    if (call.url.includes("/v1/end-users?external_id=")) {
      const id = decodeURIComponent(call.url.split("external_id=")[1]);
      if (id === JUDGES && !behaviour.judge) return otariJSONResponse([]);
      return otariJSONResponse([
        { external_id: id, budget_id: id === JUDGES ? behaviour.budget : "budget-week", spend: behaviour.spend, reserved: 0, blocked: id === JUDGES && behaviour.blocked },
      ]);
    }
    if (call.url.endsWith("/v1/chat/completions")) {
      behaviour.spend += 0.05; // what Otari bills the end user, read back after the run
      return otariJSONResponse(
        { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost_usd: "0.000100" } },
        { headers: { "otari-provider": "deepinfra", "otari-model": "Qwen/Qwen3-235B-A22B-Instruct-2507" } },
      );
    }
    return otariJSONResponse({ detail: "unexpected call in this test" }, { status: 500 });
  }),
);
afterAll(() => vi.unstubAllGlobals());

// The run itself is replaced by one model call, to see whom Otari is asked to bill.
vi.mock("@/lib/agent", () => ({
  runTablecast: async (_req: unknown, emit: (e: unknown) => void) => {
    const { chatCompletion } = await import("@/lib/otari");
    await chatCompletion("research", { model: "tablecast-research", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    emit({ type: "note", text: "fake run" });
  },
}));

const ENV = ["JUDGE_LINK_TOKEN", "JUDGE_LINK_EXPIRES", "JUDGE_BUDGET_ID", "JUDGE_SPEND_CAP_USD", "JUDGE_RUNS_PER_HOUR", "LIVE_RUNS_TOKEN"];

beforeEach(() => {
  calls.length = 0;
  Object.assign(behaviour, { judge: true, budget: JUDGE_BUDGET, blocked: false, spend: 0.1, service: true });
  process.env.JUDGE_LINK_TOKEN = TOKEN;
  process.env.JUDGE_BUDGET_ID = JUDGE_BUDGET;
  process.env.LIVE_RUNS_TOKEN = "owner-token-0123456789"; // the public demo keeps ordinary live runs for its owner
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

const agentRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${Math.floor(Math.random() * 200)}`, ...headers },
    body: JSON.stringify({ restaurant: "Gjelina", city: "Los Angeles" }),
  });

async function freshRoute() {
  vi.resetModules();
  const { POST } = await import("@/app/api/agent/route");
  return POST;
}

const paid = () => calls.filter((c) => c.method !== "GET");
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("judge link: who gets in", () => {
  it("tells an ordinary request, a judge, a wrong token and an expired link apart", async () => {
    const { judgeAccess } = await import("@/lib/judge");
    expect(judgeAccess(agentRequest())).toEqual({ kind: "none" });
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": TOKEN }))).toEqual({ kind: "judge" });
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": `${TOKEN}x` }))).toMatchObject({ kind: "refused", status: 403 });
    process.env.JUDGE_LINK_EXPIRES = "2026-12-01T00:00:00Z";
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": TOKEN }), Date.parse("2026-11-30T23:00:00Z"))).toEqual({ kind: "judge" });
    const late = judgeAccess(agentRequest({ "x-tablecast-judge": TOKEN }), Date.parse("2026-12-01T00:00:01Z"));
    expect(late).toMatchObject({ kind: "refused", status: 403 });
    if (late.kind === "refused") expect(late.error).toMatch(/expired/);
  });

  it("treats a missing or short configured token as no judge link at all", async () => {
    const { judgeAccess } = await import("@/lib/judge");
    delete process.env.JUDGE_LINK_TOKEN;
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": "" }))).toEqual({ kind: "none" });
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": "anything" }))).toMatchObject({ kind: "refused" });
    process.env.JUDGE_LINK_TOKEN = "short-token";
    expect(judgeAccess(agentRequest({ "x-tablecast-judge": "short-token" }))).toMatchObject({ kind: "refused" });
  });

  it("refuses a wrong token before any Otari call", async () => {
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": "wrong-token-0123456789abcdefghij" }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatch(/isn't valid/);
    expect(calls).toHaveLength(0);
  });

  it("without the judges' token, the public demo still keeps live runs for its owner", async () => {
    const POST = await freshRoute();
    const res = await POST(agentRequest());
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatch(/kept for its owner/);
    expect(calls).toHaveLength(0);
  });
});

describe("judge link: the judges' own budget on Otari", () => {
  it("bills every request of a judge run to the judges' end user, not to the restaurant, and shows their budget", async () => {
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(200);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: "otari", end_user: JUDGES, judge: true });
    expect(events.find((e) => e.type === "budget" && e.stage === "start")).toMatchObject({ end_user: JUDGES, spend: 0.1, limit: 1, budget: "tablecast-judges" });
    expect(events.find((e) => e.type === "note" && String(e.text).startsWith("Judge link"))?.text).toMatch(/\$0\.90 left of \$1\.00/);
    const end = events.find((e) => e.type === "budget" && e.stage === "end");
    expect(end).toMatchObject({ end_user: JUDGES, before: 0.1 });
    expect(Number(end?.spend)).toBeCloseTo(0.15, 6);
    expect(paid()).toHaveLength(1);
    expect(paid()[0].body).toMatchObject({ user: JUDGES, model: "tablecast-research" });
    expect(calls.some((c) => c.url.includes("restaurant%3Agjelina"))).toBe(false);
  }, 15_000);

  it("refuses when the judges' end user doesn't exist yet, so it can't start on another budget", async () => {
    behaviour.judge = false;
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatch(/isn't set up on Otari/);
    expect(paid()).toHaveLength(0);
  });

  it("refuses when the judges' end user is on another budget than JUDGE_BUDGET_ID", async () => {
    behaviour.budget = "budget-week";
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(503);
    expect(paid()).toHaveLength(0);
  });

  it("refuses when the key can't name end users at all", async () => {
    behaviour.service = false;
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(503);
    expect(paid()).toHaveLength(0);
  });

  it("refuses once the judges' end user is blocked (the revoke switch)", async () => {
    behaviour.blocked = true;
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatch(/switched off/);
    expect(paid()).toHaveLength(0);
  });

  it("refuses a run the judges' budget can't cover, before anything is paid for", async () => {
    behaviour.spend = 0.9;
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatch(/judges' Otari budget is used up: \$0\.90 of \$1\.00/);
    expect(paid()).toHaveLength(0);
  });

  it("applies a lower app-side cap (JUDGE_SPEND_CAP_USD) on top of the Otari budget", async () => {
    process.env.JUDGE_SPEND_CAP_USD = "0.5";
    behaviour.spend = 0.35;
    const POST = await freshRoute();
    const res = await POST(agentRequest({ "x-tablecast-judge": TOKEN }));
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatch(/\$0\.35 of \$0\.50/);
    expect(paid()).toHaveLength(0);
  });
});

describe("judge link: rate limits", () => {
  it("allows one judge run at a time and a few an hour", async () => {
    vi.resetModules();
    process.env.JUDGE_RUNS_PER_HOUR = "2";
    const { acquireJudgeRun } = await import("@/lib/judge");
    const t0 = Date.parse("2026-11-12T10:00:00Z");
    const first = acquireJudgeRun("10.9.0.1", t0);
    expect(first.ok).toBe(true);
    const second = acquireJudgeRun("10.9.0.2", t0 + 1000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already in progress/);
    if (first.ok) first.release();
    const third = acquireJudgeRun("10.9.0.3", t0 + 2000);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    const fourth = acquireJudgeRun("10.9.0.4", t0 + 3000);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toMatch(/hourly limit/);
    expect(acquireJudgeRun("10.9.0.5", t0 + 3_601_000).ok).toBe(true);
  });
});

describe("judge link: the note the judges see", () => {
  it("answers only with the judges' token, from two free reads", async () => {
    vi.resetModules();
    const { GET } = await import("@/app/api/judge/route");
    const none = await GET(new Request("http://localhost/api/judge"));
    expect(none.status).toBe(404);
    expect(calls).toHaveLength(0);
    const res = await GET(new Request("http://localhost/api/judge", { headers: { "x-tablecast-judge": TOKEN } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number | string>;
    expect(body).toMatchObject({ end_user: JUDGES, limit: 1, budget: "tablecast-judges" });
    expect(Number(body.left)).toBeCloseTo(0.9, 6);
    expect(paid()).toHaveLength(0);
  });
});

describe("link tokens in the address bar", () => {
  it("takes the owner's and the judges' tokens out of the address, keeping the rest", async () => {
    const { splitLinkTokens } = await import("@/lib/link-tokens");
    expect(splitLinkTokens(`https://tablecast-otari.vercel.app/?judge=${TOKEN}`)).toEqual({ tokens: { judge: TOKEN }, clean: "/" });
    expect(splitLinkTokens("https://x.app/about?live=abc&lang=es#top")).toEqual({ tokens: { live: "abc" }, clean: "/about?lang=es#top" });
    expect(splitLinkTokens("https://x.app/?lang=es")).toEqual({ tokens: {}, clean: null });
  });
});
