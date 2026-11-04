import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// The supplier order is computed by a program the model writes and Otari's sandbox runs. The app reads the program and
// its stdout from otari_tool_calls (not the model's prose) and checks the sums against the plan's own lines.
const { calls, reply } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[], reply: { stdout: "", exit: 0 } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/v1/tools")) return otariJSONResponse({ object: "list", data: [{ id: "otari_web_fetch", object: "tool", available: false, reason: "workspace_disabled" }, { id: "otari_code_execution", object: "tool", available: true, reason: null }] });
    return otariJSONResponse(
      {
        choices: [{ message: { content: "DONE" } }],
        usage: { prompt_tokens: 900, completion_tokens: 700, cost_usd: "0.000152" },
        otari_tool_calls: [
          { id: "otari_ci_1", type: "code_execution", status: reply.exit === 0 ? "completed" : "failed", code: "import json, math\nprint(json.dumps(result))", stdout: reply.stdout, stderr: "", exit_code: reply.exit },
        ],
      },
      { headers: { "otari-provider": "deepinfra", "otari-model": "openai/gpt-oss-120b" } },
    );
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { checkResult, codeExecutionAvailable, lastJsonLine, resetCodeToolCache, runQuartermaster, type QuartermasterResult } from "@/lib/quartermaster";

const playbook = {
  currency: "USD",
  menu_moves: [
    { dish: "Squash soup", price: 14, when: "", why: "", description: "", evidence: [], ingredients: [{ item: "Butternut squash", qty: 6, unit: "kg", supplier_category: "produce" }] },
    { dish: "Burrata toast", price: 18, when: "", why: "", description: "", evidence: [], ingredients: [{ item: "Burrata", qty: 12, unit: "pieces", supplier_category: "dairy" }] },
  ],
  shopping_list: [
    { item: "Butternut squash", qty: 6, unit: "kg", supplier_category: "produce", est_cost: 21 },
    { item: "Burrata", qty: 12, unit: "pieces", supplier_category: "dairy", est_cost: 54 },
    { item: "Sourdough", qty: 2, unit: "loaves", supplier_category: "bakery", est_cost: 12.5 },
  ],
};

const good: QuartermasterResult = {
  order: [
    { category: "produce", lines: [{ item: "Butternut squash", qty: 6, unit: "kg", est_cost: 21 }], total: 21 },
    { category: "dairy", lines: [{ item: "Burrata", qty: 12, unit: "pieces", est_cost: 54 }], total: 54 },
    { category: "bakery", lines: [{ item: "Sourdough", qty: 2, unit: "loaves", est_cost: 12.5 }], total: 12.5 },
  ],
  grand_total: 87.5,
  dishes: [
    { dish: "Squash soup", price: 14, ingredient_cost: 21, break_even_portions: 2 },
    { dish: "Burrata toast", price: 18, ingredient_cost: 54, break_even_portions: 3 },
  ],
  unmatched: { not_used: ["Sourdough"], missing: [] },
};

beforeEach(() => {
  calls.length = 0;
  reply.stdout = `computing...\n${JSON.stringify(good)}\n`;
  reply.exit = 0;
  resetCodeToolCache();
});

describe("quartermaster", () => {
  it("asks the model to run code with Otari's otari_code_execution tool and reads the sandbox's stdout", async () => {
    const q = await runQuartermaster({ model: "tablecast-quartermaster", playbook: playbook as never });
    expect(calls[0].body).toMatchObject({ model: "tablecast-quartermaster", tools: [{ type: "otari_code_execution" }], max_tool_iterations: 3 });
    expect(q.report?.result).toEqual(good);
    expect(q.report?.code).toMatch(/import json/);
    expect(q.report?.checks).toEqual({ totals: true, break_even: true, notes: [] });
    expect(q.served).toMatchObject({ provider: "deepinfra", cost_usd: 0.000152 });
  });

  it("says why when the program failed or printed no JSON", async () => {
    reply.exit = 1;
    reply.stdout = "";
    expect((await runQuartermaster({ model: "m", playbook: playbook as never })).why).toBe("the program failed in the sandbox");
    reply.exit = 0;
    reply.stdout = "no json here";
    expect((await runQuartermaster({ model: "m", playbook: playbook as never })).why).toBe("the program's output was not the expected JSON");
  });

  it("catches a sum that does not match the plan's lines, and a break-even that is not ceil(cost / price)", () => {
    const bad = structuredClone(good);
    bad.grand_total = 90;
    bad.dishes[1].break_even_portions = 2;
    const c = checkResult(bad, playbook as never);
    expect(c.totals).toBe(false);
    expect(c.break_even).toBe(false);
    expect(c.notes.join(" ")).toMatch(/grand total 90 differs.*87\.50/);
    expect(c.notes.join(" ")).toMatch(/Burrata toast: break-even 2 is not ceil\(54 \/ 18\)/);
  });

  it("finds the last JSON line a program printed", () => {
    expect(lastJsonLine('{"a":1}\nlog\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJsonLine("nothing")).toBeNull();
    expect(lastJsonLine('log\n{\n  "a": 1,\n  "b": [2]\n}\n')).toEqual({ a: 1, b: [2] });
  });

  it("reads whether the workspace can run code", async () => {
    expect(await codeExecutionAvailable()).toMatchObject({ available: true });
    expect(calls[0].url).toBe("https://eu.api.otari.ai/api/v1/tools");
  });
});
