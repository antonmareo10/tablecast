import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "@/lib/types";
import { otariJSONResponse, otariSSEResponse } from "./helpers/otari-mock";

// A server error in the middle of the writer's stream must end that attempt (so the run retries once), not the run.
// Real case, held-out eval 21 Oct: a provider failed a stream whose JSON held a 4,305-digit number.
const { mode } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { mode: { value: "midstream" as "midstream" | "refused" | "event" | "budget" | "ok" } };
});

const draft = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "publish", arguments: '{"qty": 1' } }] } }] };

vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    switch (mode.value) {
      case "refused":
        return otariJSONResponse({ detail: "The provider failed the request with HTTP 500" }, { status: 502 });
      case "budget":
        return otariJSONResponse(
          { detail: "User 'restaurant:x' has exceeded budget limit", code: "budget_exceeded" },
          { status: 403, headers: { "otari-error-code": "budget_exceeded", "otari-budget-scope": "user" } },
        );
      case "event":
        return otariSSEResponse([draft, { error: { message: "An error occurred during streaming", code: "provider_error" } }]);
      case "ok":
        return otariSSEResponse(
          [
            draft,
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost_usd: "0.000108", pricing_source: "deployment" } },
            "[DONE]",
          ],
          { headers: { "otari-provider": "deepinfra", "otari-model": "zai-org/GLM-5.2", "otari-attempt-count": "2", "otari-fallback": "true" } },
        );
      default:
        return otariSSEResponse([draft], { failWith: new Error("Exceeds the limit (4300 digits) for integer string conversion: value has 4305 digits") });
    }
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { synthesize, type Routing } from "@/lib/model-runtime";
import { OtariError } from "@/lib/otari";

const routing: Routing = {
  fast: "tablecast-research",
  reasoning: "tablecast-write",
  vision: "alibaba/qwen3-vl-235b-a22b-instruct",
  effort: "medium",
};
const tool = { name: "publish", description: "Publish.", schema: z.object({ qty: z.number() }) };

async function attempt() {
  const events: AgentEvent[] = [];
  const out = await synthesize({ routing, system: "s", user: "u", tool, emit: (e: AgentEvent) => events.push(e) });
  return { out, events };
}

describe("writer: a server error ends the attempt, not the run", () => {
  it("mid-stream: no plan, finish 'error', and the engine log says why", async () => {
    mode.value = "midstream";
    const { out, events } = await attempt();
    expect(out).toMatchObject({ value: null, finish: "error" });
    const call = events.find((e) => e.type === "engine");
    expect(call?.type === "engine" && call.call.note).toMatch(/server error: Exceeds the limit \(4300 digits\)/);
  });

  it("refused before the stream opens (every candidate failed): the same", async () => {
    mode.value = "refused";
    const { out, events } = await attempt();
    expect(out).toMatchObject({ value: null, finish: "error" });
    expect(events.some((e) => e.type === "engine" && /server error: Otari 502/.test(e.call.note ?? ""))).toBe(true);
  });

  it("an error event inside the stream: the same", async () => {
    mode.value = "event";
    const { out } = await attempt();
    expect(out).toMatchObject({ value: null, finish: "error" });
  });

  it("a spent restaurant budget stops the run instead of being retried", async () => {
    mode.value = "budget";
    const err = await attempt().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OtariError);
    expect((err as OtariError).code).toBe("budget_exceeded");
    expect((err as OtariError).budgetScope).toBe("user");
  });

  it("a finished stream: the plan, and who served it (a fallback here) with Otari's cost", async () => {
    mode.value = "ok";
    const { out, events } = await attempt();
    expect(out.value).toEqual({ qty: 1 });
    expect(out.served).toMatchObject({ provider: "deepinfra", fallback: true, attempts: 2, cost_usd: 0.000108 });
    const call = events.find((e) => e.type === "engine");
    if (call?.type !== "engine") throw new Error("no engine event");
    expect(call.call.label).toBe("GLM 5.2");
    expect(call.call.cost_usd).toBeCloseTo(0.000108, 9);
    expect(call.call.prompt_tokens).toBe(100);
  });
});
