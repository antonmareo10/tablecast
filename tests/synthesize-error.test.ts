import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "@/lib/types";

// A server error in the middle of the writer's stream must end that attempt (so the run retries once), not the run.
// Real case, held-out eval 21 Oct: Token Factory failed a stream whose JSON held a 4,305-digit number.
const { mode } = vi.hoisted(() => ({ mode: { value: "midstream" as "midstream" | "refused" } }));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => {
          if (mode.value === "refused") throw new Error("500 Internal Server Error");
          return (async function* () {
            yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "publish", arguments: '{"qty": 1' } }] } }] };
            throw new Error("Exceeds the limit (4300 digits) for integer string conversion: value has 4305 digits");
          })();
        },
      },
    };
  },
}));

import { synthesize, type Routing } from "@/lib/nebius-agent";

const routing: Routing = {
  fast: "nvidia/Nemotron-3_5-Lightning",
  reasoning: "nvidia/Nemotron-3-Ultra-550b-a55b",
  vision: "nvidia/Nemotron-3.5-Super-VL",
  effort: "medium",
};
const tool = { name: "publish", description: "Publish.", schema: z.object({ qty: z.number() }) };

async function attempt() {
  const events: AgentEvent[] = [];
  const out = await synthesize({ routing, system: "s", user: "u", tool, emit: (e) => events.push(e) });
  return { out, events };
}

describe("writer: a server error ends the attempt, not the run", () => {
  it("mid-stream: no plan, finish 'error', and the engine log says why", async () => {
    mode.value = "midstream";
    const { out, events } = await attempt();
    expect(out).toEqual({ value: null, finish: "error" });
    const call = events.find((e) => e.type === "engine");
    expect(call?.type === "engine" && call.call.note).toMatch(/server error: Exceeds the limit \(4300 digits\)/);
  });

  it("refused at the start: the same", async () => {
    mode.value = "refused";
    const { out, events } = await attempt();
    expect(out).toEqual({ value: null, finish: "error" });
    expect(events.some((e) => e.type === "engine" && /server error: 500/.test(e.call.note ?? ""))).toBe(true);
  });
});
