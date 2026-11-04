import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/types";
import { hang, otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// A research turn that hangs must not cost the run its web research: the checker's model takes over.
// (Otari's routing policy fails over when a provider fails; a provider that is merely slow is the app's to handle.)
const { calls, behaviour } = vi.hoisted(() => {
  process.env.GATHER_TURN_MS = "50";
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[], behaviour: { research: "hang" as "hang" | "ok" } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.body?.model === "tablecast-research" && behaviour.research === "hang") return hang(init);
    return otariJSONResponse(
      { choices: [{ message: { content: "READY", tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost_usd: "0.000012", pricing_source: "deployment" } },
      { headers: { "otari-provider": "fireworks", "otari-model": "accounts/fireworks/models/nemotron-3-ultra-nvfp4", "otari-attempt-count": "2", "otari-fallback": "true" } },
    );
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { gather, type Routing } from "@/lib/model-runtime";
import { withRun } from "@/lib/otari";

const routing: Routing = {
  fast: "tablecast-research",
  repair: "tablecast-check",
  reasoning: "tablecast-write",
  vision: "alibaba/qwen3-vl-235b-a22b-instruct",
  effort: "low",
};

async function run() {
  const events: AgentEvent[] = [];
  await withRun({ id: "tablecast-test", endUser: "restaurant:gjelina-los-angeles" }, () =>
    gather({ routing, system: "s", user: "u", tools: [], maxTurns: 3, budgetMs: 10_000, emit: (e: AgentEvent) => events.push(e) }),
  );
  return events;
}

describe("gather", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("hands the research to the checker's model when the research model hangs", async () => {
    behaviour.research = "hang";
    const events = await run();
    expect(calls.map((c) => c.body?.model)).toEqual(["tablecast-research", "tablecast-check"]);
    expect(events.some((e) => e.type === "note" && /takes over the research/.test(e.text))).toBe(true);
    const engine = events.find((e) => e.type === "engine");
    expect(engine?.type === "engine" && engine.call.model).toBe("tablecast-check");
  });

  it("uses only the research policy when it answers, and records how Otari served it", async () => {
    behaviour.research = "ok";
    const events = await run();
    expect(calls.map((c) => c.body?.model)).toEqual(["tablecast-research"]);
    const engine = events.find((e) => e.type === "engine");
    if (engine?.type !== "engine") throw new Error("no engine event");
    expect(engine.call.served).toMatchObject({ provider: "fireworks", attempts: 2, fallback: true, request_id: "req-test" });
    expect(engine.call.label).toBe("Nemotron 3 Ultra"); // the model that answered, not the policy name
    expect(engine.call.cost_usd).toBeCloseTo(0.000012, 9);
  });

  it("tags every request with the run's session id, the restaurant as end user and the step's role", async () => {
    behaviour.research = "ok";
    await run();
    const [c] = calls;
    expect(c.url).toBe("https://eu.api.otari.ai/api/v1/chat/completions");
    expect(c.headers["authorization"]).toBe("Bearer otk_test");
    expect(c.headers["otari-conversation-id"]).toBe("tablecast-test");
    expect(c.body?.user).toBe("restaurant:gjelina-los-angeles");
    expect(c.body?.metadata).toEqual({ app: "tablecast", role: "research", run: "tablecast-test" });
  });
});
