// The quartermaster: the plan's supplier order and each new dish's break-even, computed in Otari's code sandbox.
//
// A model (tablecast-quartermaster, gpt-oss-120b) gets the plan's three dishes and its shopping list, and must write and
// run one Python program with Otari's otari_code_execution tool: group the order by supplier, total it, match each
// dish's ingredients to the order lines (names never line up exactly, which is why a model writes the matching), and
// compute how many portions of each dish pay for its ingredients. The app reads the program and its stdout from
// `otari_tool_calls`, never the model's own account of them, and then checks in code what can be checked exactly:
// every total is the sum of the plan's own lines, and every break-even is ceil(ingredient cost / price).

import { z } from "zod";
import { chatCompletion, otariJSON, type OtariToolCall, type Served } from "./otari";
import type { Playbook } from "./types";

export type QuartermasterResult = {
  order: { category: string; lines: { item: string; qty: number; unit: string; est_cost: number }[]; total: number }[];
  grand_total: number;
  dishes: { dish: string; price: number; ingredient_cost: number; break_even_portions: number }[];
  unmatched?: { not_used?: string[]; missing?: string[] };
};

export type QuartermasterReport = {
  result: QuartermasterResult;
  code: string;
  exit_code?: number;
  checks: { totals: boolean; break_even: boolean; notes: string[] };
  currency: string;
};

// The programs list unmatched items as names or as {dish, ingredient} records; both become one readable line.
const Unmatched = z.union([
  z.string(),
  z
    .record(z.string(), z.unknown())
    .transform((o) => {
      const name = String(o.ingredient ?? o.item ?? o.name ?? Object.values(o).find((v) => typeof v === "string") ?? "");
      return o.dish ? `${name} (${String(o.dish)})` : name;
    }),
]);

const ResultSchema = z.object({
  order: z
    .array(
      z.object({
        category: z.string(),
        lines: z.array(z.object({ item: z.string(), qty: z.number(), unit: z.string(), est_cost: z.number() })),
        total: z.number(),
      }),
    )
    .max(30),
  grand_total: z.number(),
  dishes: z.array(z.object({ dish: z.string(), price: z.number(), ingredient_cost: z.number(), break_even_portions: z.number() })).max(10),
  unmatched: z.object({ not_used: z.array(Unmatched).optional(), missing: z.array(Unmatched).optional() }).optional(),
});

let codeTool: { at: number; available: boolean; reason?: string } | null = null;

/** Whether this key's workspace can run otari_code_execution (GET /v1/tools), cached 10 minutes. */
export async function codeExecutionAvailable(signal?: AbortSignal): Promise<{ available: boolean; reason?: string }> {
  if (process.env.OTARI_CODE_EXECUTION === "off") return { available: false, reason: "switched off" };
  if (codeTool && Date.now() - codeTool.at < 600_000) return codeTool;
  try {
    const { data } = await otariJSON<unknown>("/v1/tools", { method: "GET", signal, timeoutMs: 10_000 });
    const list = (Array.isArray(data) ? data : ((data as { data?: unknown[]; tools?: unknown[] }).data ?? (data as { tools?: unknown[] }).tools ?? [])) as {
      id?: string;
      name?: string;
      available?: boolean;
      reason?: string | null;
    }[];
    const t = list.find((x) => x.id === "otari_code_execution" || x.name === "otari_code_execution");
    codeTool = { at: Date.now(), available: t ? t.available !== false : false, ...(t?.reason ? { reason: t.reason } : t ? {} : { reason: "not listed" }) };
  } catch {
    codeTool = { at: Date.now(), available: true }; // the listing failed: let the request say for itself
  }
  return codeTool;
}

export function resetCodeToolCache(): void {
  codeTool = null;
}

const SYSTEM = `You are the quartermaster of a small restaurant kitchen. You never do arithmetic in your head: you write one Python program and run it with the code execution tool, then reply with the single word DONE.`;

function task(pb: Pick<Playbook, "menu_moves" | "shopping_list" | "currency">): string {
  const data = {
    currency: pb.currency,
    dishes: pb.menu_moves.map((m) => ({ dish: m.dish, price: m.price, ingredients: m.ingredients.map((i) => ({ item: i.item, qty: i.qty, unit: i.unit })) })),
    shopping_list: pb.shopping_list.map((s) => ({ item: s.item, qty: s.qty, unit: s.unit, supplier_category: s.supplier_category, est_cost: s.est_cost })),
  };
  return `Here is this week's plan: three new dishes and the shopping list to test them. Write and run ONE Python program that:
1. Builds the supplier order: the shopping_list lines grouped by supplier_category, each group's total est_cost, and the grand total.
2. For each dish, matches its ingredients to shopping_list lines by item name (case-insensitive; a line counts for a dish when either name contains the other or they share their main noun), sums the est_cost of the matched lines as ingredient_cost (a line used by several dishes is split evenly between them), and computes break_even_portions = ceil(ingredient_cost / price).
3. Lists shopping_list items no dish uses (not_used) and dish ingredients with no shopping_list line (missing).
Copy the data below into the program exactly, as a Python literal. Round money to 2 decimals. The LAST line the program prints must be one JSON object, printed with json.dumps(result) on a single line, with the keys order (a list of {category, lines: [{item, qty, unit, est_cost}], total}), grand_total, dishes (a list of {dish, price, ingredient_cost, break_even_portions}) and unmatched ({not_used: a list of item names, missing: a list of ingredient names}).

${JSON.stringify(data)}`;
}

/** The last JSON object a program printed, on one line or pretty-printed over several. */
export function lastJsonLine(stdout: string | undefined): unknown {
  const lines = (stdout ?? "").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    for (const candidate of [lines[i].trim(), lines.slice(i).join("\n").trim()]) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.011 + Math.abs(b) * 0.001;

/** What code can check exactly about the sandbox's answer, against the plan's own numbers. */
export function checkResult(r: QuartermasterResult, pb: Pick<Playbook, "menu_moves" | "shopping_list">): QuartermasterReport["checks"] {
  const notes: string[] = [];
  const planTotal = pb.shopping_list.reduce((n, s) => n + s.est_cost, 0);
  let totals = near(r.grand_total, planTotal);
  if (!totals) notes.push(`grand total ${r.grand_total} differs from the plan's lines, which add up to ${planTotal.toFixed(2)}`);
  const byCat = new Map<string, number>();
  for (const s of pb.shopping_list) byCat.set(s.supplier_category.toLowerCase(), (byCat.get(s.supplier_category.toLowerCase()) ?? 0) + s.est_cost);
  for (const g of r.order) {
    const want = byCat.get(g.category.toLowerCase());
    const lineSum = g.lines.reduce((n, l) => n + l.est_cost, 0);
    if (want == null || !near(g.total, want) || !near(lineSum, g.total)) {
      totals = false;
      notes.push(`${g.category}: ${g.total} does not match the plan's ${want?.toFixed(2) ?? "missing"} category total`);
    }
  }
  if (r.order.length !== byCat.size) {
    totals = false;
    notes.push(`${r.order.length} supplier groups for ${byCat.size} categories in the plan`);
  }
  let breakEven = r.dishes.length === pb.menu_moves.length;
  if (!breakEven) notes.push(`${r.dishes.length} dishes computed for ${pb.menu_moves.length} in the plan`);
  for (const d of r.dishes) {
    const plan = pb.menu_moves.find((m) => m.dish.toLowerCase() === d.dish.toLowerCase());
    const want = d.price > 0 ? Math.ceil(d.ingredient_cost / d.price - 1e-9) : NaN;
    if (!plan || !near(plan.price, d.price) || d.break_even_portions !== want) {
      breakEven = false;
      notes.push(`${d.dish}: break-even ${d.break_even_portions} is not ceil(${d.ingredient_cost} / ${d.price})${plan ? "" : ", and the dish is not in the plan"}`);
    }
  }
  return { totals, break_even: breakEven, notes };
}

/** Runs the quartermaster. Returns null (and says why in `onNote`) when the sandbox is unavailable or its output unusable. */
export async function runQuartermaster(opts: {
  model: string;
  playbook: Pick<Playbook, "menu_moves" | "shopping_list" | "currency">;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ report: QuartermasterReport | null; served: Served; calls: OtariToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; ms: number; why?: string }> {
  const t0 = Date.now();
  const { data, served } = await chatCompletion(
    "quartermaster",
    {
      model: opts.model,
      reasoning_effort: "low",
      temperature: 0,
      max_tokens: 6000,
      max_tool_iterations: 3,
      tools: [{ type: "otari_code_execution" }],
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: task(opts.playbook) },
      ],
    },
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  const ms = Date.now() - t0;
  const calls = (data.otari_tool_calls ?? []).filter((c) => c.type === "code_execution");
  const ran = calls.filter((c) => c.status === "completed" || c.exit_code === 0);
  const last = [...ran].reverse().find((c) => lastJsonLine(c.stdout) != null) ?? ran.at(-1);
  if (!last) return { report: null, served, calls, usage: data.usage, ms, why: calls.length ? "the program failed in the sandbox" : "the model did not run any code" };
  const parsed = ResultSchema.safeParse(lastJsonLine(last.stdout));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { report: null, served, calls, usage: data.usage, ms, why: `the program's output was not the expected JSON (${issue ? `${issue.path.join(".")}: ${issue.message}` : "unreadable"})` };
  }
  const result = parsed.data as QuartermasterResult;
  return {
    report: { result, code: last.code ?? "", ...(last.exit_code != null ? { exit_code: last.exit_code } : {}), checks: checkResult(result, opts.playbook), currency: opts.playbook.currency },
    served,
    calls,
    usage: data.usage,
    ms,
  };
}
