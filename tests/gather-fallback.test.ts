import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/types";

// A research turn that hangs must not cost the run its web research: the backup model takes over.
const { calls, behaviour } = vi.hoisted(() => {
  process.env.NEBIUS_GATHER_TURN_MS = "50";
  return { calls: [] as string[], behaviour: { lightning: "hang" as "hang" | "ok" } };
});

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: (body: { model: string }, opts: { signal: AbortSignal }) => {
          calls.push(body.model);
          if (/Lightning/.test(body.model) && behaviour.lightning === "hang") {
            return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("Request was aborted."))));
          }
          return Promise.resolve({ choices: [{ message: { content: "READY", tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
        },
      },
    };
  },
}));

import { gather, type Routing } from "@/lib/nebius-agent";

const routing: Routing = {
  fast: "nvidia/Nemotron-3_5-Lightning",
  repair: "nvidia/Nemotron-3-Ultra-550b-a55b",
  reasoning: "nvidia/Nemotron-3-Ultra-550b-a55b",
  vision: "nvidia/Nemotron-3.5-Super-VL",
  effort: "low",
};

async function run() {
  const events: AgentEvent[] = [];
  await gather({ routing, system: "s", user: "u", tools: [], maxTurns: 3, budgetMs: 10_000, emit: (e) => events.push(e) });
  return events;
}

describe("gather", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("hands the research to the backup model when the fast one hangs", async () => {
    behaviour.lightning = "hang";
    const events = await run();
    expect(calls).toEqual(["nvidia/Nemotron-3_5-Lightning", "nvidia/Nemotron-3-Ultra-550b-a55b"]);
    expect(events.some((e) => e.type === "note" && /takes over the research/.test(e.text))).toBe(true);
    const engine = events.find((e) => e.type === "engine");
    expect(engine?.type === "engine" && engine.call.model).toBe("nvidia/Nemotron-3-Ultra-550b-a55b");
  });

  it("uses only the fast model when it answers", async () => {
    behaviour.lightning = "ok";
    const events = await run();
    expect(calls).toEqual(["nvidia/Nemotron-3_5-Lightning"]);
    expect(events.some((e) => e.type === "note" && /takes over/.test(e.text))).toBe(false);
  });
});
