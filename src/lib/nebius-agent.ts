// The Nemotron runtime on Nebius Token Factory (OpenAI-compatible API).
//
// Model routing, each step on the Nemotron that suits it:
//   • GATHER     — a FAST Nemotron (reasoning_effort "none") drives the web-research tool loop:
//                  cheap, low-latency "what to look up next" decisions. Tools asked for in one
//                  turn run in parallel.
//   • VISION     — Nemotron Super VL reads the owner's menu photo into structured items.
//   • SYNTHESIZE — a REASONING Nemotron writes the playbook through a forced function call,
//                  streamed so the UI drafts it live.
//   • REPAIR     — if the output breaks its schema, the FAST Nemotron fixes it; if a cited quote is
//                  not in its source, the reasoning Nemotron (low effort) gets one chance to fix or
//                  drop the claim. Every fix is re-checked by code; nothing is accepted on the model's word.
//
// Every call is measured (Token Factory `usage` + wall clock) and emitted as an `engine` event.

import OpenAI from "openai";
import { z } from "zod";
import type { SourceLedger } from "./evidence";
import { LoopGuard } from "./loop-guard";
import { estimateCostUsd } from "./nebius-pricing";
import type { AgentEvent, EngineCall, Evidence, MenuItem } from "./types";

export type Emit = (e: AgentEvent) => void;

const MAX_ARGS_CHARS = 70_000;
const STALL_MS = Number(process.env.NEBIUS_STALL_MS || 60_000);
// A whole writing attempt may not take longer than this (a slow trickle never trips the stall watchdog).
// Read per call, so scripts can raise it; a run's deadline can only lower it.
const writerMaxMs = (routing: Routing, deadlineMs?: number) =>
  Math.min(Number(process.env.NEBIUS_WRITER_MAX_MS) || routing.writerMaxMs || 150_000, deadlineMs ?? Infinity);

const BASE_URL = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1/";

export interface Routing {
  fast: string; // tool loop, baseline
  repair?: string; // citation repair (defaults to the reasoning model at low effort)
  reasoning: string; // the playbook
  vision: string; // menu photos
  effort: "low" | "medium" | "high";
  writerMaxMs?: number; // how long one writing attempt may take
  fallback?: string; // model for the one retry, if not the writer itself
}

export function defaultRouting(): Routing {
  return {
    fast: process.env.NEBIUS_FAST_MODEL || "nvidia/Nemotron-3_5-Lightning",
    // Measured: Ultra at low effort fixes far more failed citations than Lightning (see eval/SUMMARY.md).
    repair: process.env.NEBIUS_REPAIR_MODEL || process.env.NEBIUS_MODEL || "nvidia/Nemotron-3-Ultra-550b-a55b",
    reasoning: process.env.NEBIUS_MODEL || "nvidia/Nemotron-3-Ultra-550b-a55b",
    vision: process.env.NEBIUS_VISION_MODEL || "nvidia/Nemotron-3.5-Super-VL",
    // Measured with the strict verifier (eval/SUMMARY.md, v5 and v6): medium effort has the best average (89% and 84%
    // verified after repair, vs 81% and 84% at low) and writes about as fast (median 27–31 s).
    effort: (process.env.NEBIUS_REASONING_EFFORT as Routing["effort"]) || "medium",
  };
}

/** "Economy": Nemotron Super writes. Measured (v5, v6): as faithful as Ultra (82%, 88%) at a third to half its cost per plan, but ~2 min to write. */
export function economyRouting(): Routing {
  const base = defaultRouting();
  return {
    ...base,
    reasoning: process.env.NEBIUS_ECONOMY_MODEL || process.env.NEBIUS_THOROUGH_MODEL || "nvidia/nemotron-3-super-120b-a12b",
    effort: "medium",
    writerMaxMs: 170_000,
    fallback: base.reasoning, // if Super is cut short, Ultra (fast) takes over
  };
}

export function modelLabel(id: string): string {
  if (/vl/i.test(id) && /super/i.test(id)) return "Nemotron Super VL";
  if (/ultra/i.test(id)) return "Nemotron Ultra";
  if (/lightning/i.test(id)) return "Nemotron Lightning";
  if (/super/i.test(id)) return "Nemotron Super";
  if (/nano/i.test(id)) return "Nemotron Nano";
  return id.split("/").pop() || id;
}

export function nebiusConfigured(): boolean {
  return !!process.env.NEBIUS_API_KEY;
}

// ---- low-level ------------------------------------------------------------------------

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
};

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

type ChatResponse = {
  choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
  usage?: Usage;
};

type StreamChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: Usage | null;
};

let sharedClient: OpenAI | null = null;
function client(): OpenAI {
  sharedClient ??= new OpenAI({ baseURL: BASE_URL, apiKey: process.env.NEBIUS_API_KEY, maxRetries: 2, timeout: 240_000 }); // no request may hang a run;
  return sharedClient;
}

// The SDK's types don't know Nemotron's extra params (reasoning_effort), so we call it loosely.
// Non-streamed calls (research turns, repairs, vision, baseline) never wait more than 90 s each.
function chat(body: Record<string, unknown>, signal?: AbortSignal, capMs = 90_000): Promise<ChatResponse> {
  const capped = signal ? AbortSignal.any([signal, AbortSignal.timeout(capMs)]) : AbortSignal.timeout(capMs);
  return (client().chat.completions.create as unknown as (a: unknown, o?: unknown) => Promise<ChatResponse>)(body, { signal: capped, maxRetries: 1 });
}

// A research turn takes ~0.6 s (median) and at most ~10 s in our recorded runs and evals. If the fast
// model hangs past this (it happens on Token Factory now and then), the research moves to the backup.
const GATHER_TURN_MS = Number(process.env.NEBIUS_GATHER_TURN_MS || 20_000);
function chatStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>> {
  return (client().chat.completions.create as unknown as (a: unknown, o?: unknown) => Promise<AsyncIterable<StreamChunk>>)(
    { ...body, stream: true, stream_options: { include_usage: true } },
    { signal },
  );
}

export function measured(phase: EngineCall["phase"], model: string, ms: number, usage: Usage | null | undefined, extra: Partial<EngineCall> = {}): EngineCall {
  // started_at lets the UI draw a real timeline of where the run's time went.
  const call: EngineCall = { phase, model, label: modelLabel(model), ms: Math.round(ms), started_at: Date.now() - Math.round(ms), ...extra };
  if (usage) {
    if (typeof usage.prompt_tokens === "number") call.prompt_tokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") call.completion_tokens = usage.completion_tokens;
    const r = usage.completion_tokens_details?.reasoning_tokens;
    if (typeof r === "number") call.reasoning_tokens = r;
  }
  const cost = estimateCostUsd(model, call.prompt_tokens, call.completion_tokens);
  if (cost != null) call.est_cost_usd = cost;
  return call;
}

// Nemotron may wrap chain-of-thought in <think>…</think> inside content; never show it as output.
export const cleanText = (t: string | null | undefined): string =>
  (t ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();

/** The latest whole, readable sentence of a reasoning stream (no JSON, source ids or half-sentences), for the agent log. */
export function readableThought(thinking: string): string | undefined {
  // A sentence starts with a capital and ends at . ! or ? followed by a space (so "0.5" is not an end).
  const sentences = cleanText(thinking).match(/[A-Z][^\n]*?[.!?](?=\s|$)/g) ?? [];
  const ok = (x: string) => {
    const words = x.split(/\s+/);
    const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
    return (
      x.length >= 30 &&
      x.length <= 180 &&
      words.length >= 5 &&
      capitalised / words.length <= 0.5 && // a list of names or ingredients, not a thought
      !/[{}[\]"=<>|?]|\(S\d|\bS\d+\.\d| - /.test(x)
    );
  };
  return sentences
    .map((x) => x.trim().replace(/\*+|`/g, "").replace(/_/g, " "))
    .filter(ok)
    .at(-1);
}

export function toOpenAITool(spec: { name: string; description: string; schema: z.ZodType }) {
  return {
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>,
    },
  };
}

// Best-effort parse of a possibly-incomplete JSON string, for the live playbook draft.
export function tolerantParse(s: string): unknown | null {
  if (!s || !s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to repair */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let fixed = s;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/\\$/, "").replace(/,\s*$/, "").replace(/:\s*$/, ": null");
  for (let i = stack.length - 1; i >= 0; i--) fixed += stack[i];
  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

// Runs `fn` over `items` with at most `limit` in flight, keeping the input order in the output.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- tool specs ----------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (input: unknown, ctx: { id: string }) => Promise<string>;
}

// ---- GATHER: fast model drives the tools ---------------------------------------------

export async function gather(opts: {
  routing: Routing;
  system: string;
  user: string;
  tools: ToolSpec[];
  maxTurns: number;
  budgetMs: number;
  emit: Emit;
  signal?: AbortSignal;
  concurrency?: number;
}): Promise<void> {
  const { routing, tools, emit, signal } = opts;
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const started = Date.now();
  // If the fast model doesn't answer a turn in time, the backup (the repair model, Ultra by default)
  // drives the rest of the research, so a stuck model never costs the run its web research.
  let model = routing.fast;
  const backup = routing.repair ?? routing.reasoning;
  const turnCall = (m: string) =>
    chat(
      {
        model: m,
        messages,
        tools: tools.map(toOpenAITool),
        tool_choice: "auto",
        reasoning_effort: "none",
        temperature: 0.3,
        max_tokens: 2048,
      },
      signal,
      GATHER_TURN_MS,
    );
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (turn > 0 && Date.now() - started > opts.budgetMs) {
      emit({ type: "note", text: "Research time budget reached — writing the plan with what was found so far." });
      break;
    }
    let t0 = Date.now();
    let res: ChatResponse;
    try {
      res = await turnCall(model);
    } catch (err) {
      if (signal?.aborted || model === backup) throw err;
      emit({ type: "note", text: `${modelLabel(model)} didn't answer in time — ${modelLabel(backup)} takes over the research.` });
      model = backup;
      t0 = Date.now();
      res = await turnCall(model);
    }
    const callMs = Date.now() - t0;
    const msg = res.choices[0]?.message;
    if (!msg) break;
    const note = cleanText(msg.content);
    if (note && note.toUpperCase() !== "READY") emit({ type: "note", text: note.slice(0, 240) });
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls ?? [];
    const toolsStart = Date.now();
    const results = await mapLimit(calls, opts.concurrency ?? 4, async (call) => {
      const spec = byName.get(call.function.name);
      if (!spec) return `Error: unknown tool ${call.function.name}.`;
      let args: unknown;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        return "Error: arguments were not valid JSON. Retry with valid JSON.";
      }
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) return `Error: invalid arguments — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      try {
        return await spec.run(parsed.data, { id: call.id });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    calls.forEach((call, i) => messages.push({ role: "tool", tool_call_id: call.id, content: results[i] }));
    emit({
      type: "engine",
      call: measured("gather", model, callMs, res.usage, {
        started_at: t0,
        tool_calls: calls.length,
        ...(calls.length ? { tools_ms: Date.now() - toolsStart } : {}),
      }),
    });
    if (!calls.length) break; // READY
    // Every tool refused for budget reasons: the research is over whatever the model thinks.
    if (results.every((r) => /budget used up/.test(r))) break;
  }
}

// ---- SYNTHESIZE: reasoning model, forced tool, streamed --------------------------------

export async function synthesize(opts: {
  routing: Routing;
  system: string;
  user: string;
  tool: { name: string; description: string; schema: z.ZodType };
  emit: Emit;
  signal?: AbortSignal;
  onDraft?: (draft: Record<string, unknown>) => void;
  effort?: Routing["effort"];
  model?: string; // overrides routing.reasoning (the retry fallback)
  maxMs?: number; // what is left of the run's time budget for this attempt
  maxTokens?: number;
}): Promise<{ value: unknown | null; finish: string | null }> {
  const { routing, emit, signal } = opts;
  const effort = opts.effort ?? routing.effort;
  const model = opts.model ?? routing.reasoning;
  const started = Date.now();
  // Our own abort, so a reasoning loop can be cut without cancelling the whole run.
  const stopper = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
  let finish: string | null = null;
  // Stall watchdog: a stream that sends nothing for a minute is cut (and the caller retries once).
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      finish = "stall";
      stopper.abort();
    }, STALL_MS);
  };
  kick();
  const capTimer = setTimeout(
    () => {
      finish = "slow";
      stopper.abort();
    },
    writerMaxMs(routing, opts.maxMs),
  );
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await chatStream(
      {
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        tools: [toOpenAITool(opts.tool)],
        tool_choice: { type: "function", function: { name: opts.tool.name } },
        reasoning_effort: effort,
        temperature: 0.4,
        max_tokens: opts.maxTokens ?? 28000,
      },
      combined,
    );
  } catch (err) {
    clearTimeout(stallTimer);
    // The connection never answered: let the caller retry once.
    clearTimeout(capTimer);
    if ((finish === "stall" || finish === "slow") && !signal?.aborted) return { value: null, finish };
    throw err;
  }
  let args = "";
  let ttft: number | null = null;
  let usage: Usage | undefined;
  let lastDraft = 0;
  let lastThought = Date.now();
  let thinking = ""; // reasoning streamed since the last note
  let lastNote = "";
  const guard = new LoopGuard();
  let outChars = 0; // streamed characters, to estimate tokens if a cut stream never reports usage
  try {
    for await (const chunk of stream) {
      kick();
      if (chunk.usage) usage = chunk.usage;
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (ttft == null && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)) {
        ttft = Date.now() - started;
      }
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (thought) {
        thinking += thought;
        outChars += thought.length;
        // Loop guard: sustained repetition in the reasoning means the model is stuck.
        if (guard.push(thought)) {
          finish = "loop";
          stopper.abort();
          break;
        }
        // Every few seconds, show the latest complete sentence of the model's reasoning.
        if (Date.now() - lastThought > 3500) {
          const last = readableThought(thinking);
          if (last && last !== lastNote) {
            emit({ type: "note", text: `🧠 ${last.slice(0, 200)}` });
            lastNote = last;
            lastThought = Date.now();
            thinking = "";
          }
        }
      }
      if (delta.content) outChars += delta.content.length;
      for (const tc of delta.tool_calls ?? []) {
        if (tc.function?.arguments) {
          args += tc.function.arguments;
          outChars += tc.function.arguments.length;
          // A whole plan is ~15-30k characters of JSON; far beyond that the output has run away.
          if (args.length > MAX_ARGS_CHARS) {
            finish = "loop";
            stopper.abort();
            break;
          }
          if (opts.onDraft && Date.now() - lastDraft > 700) {
            lastDraft = Date.now();
            const partial = tolerantParse(args);
            if (partial && typeof partial === "object") opts.onDraft(partial as Record<string, unknown>);
          }
        }
      }
    }
  } catch (err) {
    // Only our loop guard may end the stream early; anything else (incl. the caller's abort) propagates.
    if (!((finish === "loop" || finish === "stall" || finish === "slow") && stopper.signal.aborted && !signal?.aborted)) throw err;
  }
  clearTimeout(stallTimer);
  clearTimeout(capTimer);
  if (finish === "loop" || finish === "stall" || finish === "slow") args = ""; // a cut-off or looping plan is not trusted
  // A stream cut by us never reports usage: estimate it (~4 characters per token) and say so.
  const estimated = !usage;
  if (estimated) usage = { prompt_tokens: Math.round((opts.system.length + opts.user.length) / 4), completion_tokens: Math.round(outChars / 4) };
  emit({
    type: "engine",
    call: measured("synthesize", model, Date.now() - started, usage, {
      ...(ttft != null ? { ttft_ms: ttft } : {}),
      ...(estimated ? { usage_estimated: true } : {}),
      note: `reasoning_effort ${effort}${finish === "loop" ? " · cut: reasoning loop detected" : finish && finish !== "stop" && finish !== "tool_calls" ? ` · stopped: ${finish}` : ""}`,
    }),
  });
  if (!args.trim()) return { value: null, finish };
  try {
    return { value: JSON.parse(args), finish };
  } catch {
    // A cut-off payload is not a plan: only accept a tolerant parse if the model finished on its own.
    return { value: finish === "length" ? null : tolerantParse(args), finish };
  }
}

// ---- REPAIR: schema --------------------------------------------------------------------

export async function ensureSchema<T>(opts: {
  value: unknown;
  tool: { name: string; description: string; schema: z.ZodType<T> };
  routing: Routing;
  emit: Emit;
  signal?: AbortSignal;
}): Promise<{ ok: true; value: T } | { ok: false; issues: string[] }> {
  const first = opts.tool.schema.safeParse(opts.value);
  if (first.success) return { ok: true, value: first.data };
  const issues = first.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const t0 = Date.now();
  try {
    const res = await chat(
      {
        model: opts.routing.fast,
        reasoning_effort: "none",
        temperature: 0,
        max_tokens: 16000,
        tools: [toOpenAITool(opts.tool)],
        tool_choice: { type: "function", function: { name: opts.tool.name } },
        messages: [
          {
            role: "user",
            content: `This ${opts.tool.name} payload fails its schema:\n${issues.join("\n")}\n\nCall ${opts.tool.name} with the same content, fixing ONLY those problems (fill a missing field from content already present, fix types, trim over-long lists). Do not add new facts or sources.\n\n${JSON.stringify(opts.value)}`,
          },
        ],
      },
      opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    );
    const raw = res.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const second = raw ? opts.tool.schema.safeParse(tolerantParse(raw)) : null;
    opts.emit({
      type: "engine",
      call: measured("repair", opts.routing.fast, Date.now() - t0, res.usage, { note: second?.success ? "schema repaired" : "schema repair failed" }),
    });
    if (second?.success) return { ok: true, value: second.data };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
  }
  return { ok: false, issues };
}

// ---- REPAIR: citations -----------------------------------------------------------------

export type EvidenceGroup = { label: string; list: Evidence[]; minKeep: number };

const FixSchema = z.object({
  action: z.enum(["fix", "drop"]),
  text: z.string().optional().describe("The rewritten claim (for fix)"),
  cites: z
    .array(z.object({ span: z.string() }))
    .optional()
    .describe("1-3 candidate sentence ids that state the fact (for fix)"),
});

/**
 * Claims that fail the code check (unknown sentence id, a number no cited sentence contains, or a
 * citation that doesn't talk about the claim) go back to the repair model once — one small call per
 * claim, all in parallel — with candidate sentences, to be corrected or dropped. A correction is kept
 * only if it passes the same check.
 */
export async function repairCitations(opts: {
  groups: EvidenceGroup[];
  ledger: SourceLedger;
  routing: Routing;
  emit: Emit;
  signal?: AbortSignal;
  maxMs?: number; // what is left of the run's time budget
}): Promise<{ failing: number; fixed: number; dropped: number }> {
  const { groups, ledger, routing, emit } = opts;
  const repairModel = routing.repair || routing.fast;
  const repairEffort = process.env.NEBIUS_REPAIR_EFFORT || (repairModel === routing.fast ? "none" : "low");
  const failing: { g: EvidenceGroup; e: Evidence; issue: string }[] = [];
  for (const g of groups)
    for (const e of g.list) {
      const v = ledger.verifyEvidence(e, g.label);
      if (!v.verified) failing.push({ g, e, issue: v.issue ?? "unverified" });
    }
  if (!failing.length) return { failing: 0, fixed: 0, dropped: 0 };

  emit({
    type: "note",
    text: `🔎 Verifier: ${failing.length} claim${failing.length > 1 ? "s" : ""} failed the check against ${failing.length > 1 ? "their" : "its"} cited sentences — sending ${failing.length > 1 ? "them" : "it"} to ${modelLabel(repairModel)} to correct or drop, in parallel.`,
  });

  // A slow repair never holds the plan back: after 45 s the claims simply stay marked unverified.
  const capMs = Math.max(5_000, Math.min(45_000, opts.maxMs ?? 45_000));
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(capMs)]) : AbortSignal.timeout(capMs);
  const t0 = Date.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } };

  const decisions = await mapLimit(failing, 6, async ({ e, issue }) => {
    const cited = (e.cites ?? []).map((c) => c.span).filter((x): x is string => !!x);
    // Candidates: what it cited, where its unbacked numbers really appear, and the closest sentences by content.
    const candidates = [...new Set([...cited, ...ledger.spansWithNumbers(ledger.missingNumbers(ledger.resolve(e)), 4), ...ledger.relatedSpans(e.text, 6)])]
      .slice(0, 10)
      .map((id) => ({ id, text: ledger.span(id)?.text ?? "" }))
      .filter((c) => c.text);
    try {
      const res = await chat(
        {
          model: repairModel,
          reasoning_effort: repairEffort,
          temperature: 0,
          max_tokens: repairEffort === "none" ? 2000 : 6000,
          tools: [toOpenAITool({ name: "fix_claim", description: "Fix or drop this claim.", schema: FixSchema })],
          tool_choice: { type: "function", function: { name: "fix_claim" } },
          messages: [
            {
              role: "user",
              content: `This claim failed the check (${issue}).
- "fix": cite 1-3 ids from candidate_sentences that really state the fact, and rewrite the claim so every number and every specific detail in it (names, ingredients, days, places) appears in those sentences — drop what you cannot back, keep it a plain statement of fact, and never add computed totals or ranges.
- "drop": if no candidate sentence supports the claim.
Never cite an id that is not listed.

${JSON.stringify({ claim: e.text, cited, candidate_sentences: candidates })}`,
            },
          ],
        },
        signal,
      );
      usage.prompt_tokens += res.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += res.usage?.completion_tokens ?? 0;
      usage.completion_tokens_details.reasoning_tokens += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const raw = res.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
      const parsed = FixSchema.safeParse(raw ? tolerantParse(raw) : null);
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return null; // timed out or failed: the claim stays marked unverified
    }
  });

  let fixed = 0;
  let dropped = 0;
  const toDrop: { g: EvidenceGroup; e: Evidence }[] = [];
  failing.forEach((f, i) => {
    const it = decisions[i];
    if (!it) return;
    if (it.action === "fix" && it.text && it.cites?.length) {
      const fixedCites = it.cites.map((c) => ({ source: c.span.split(".")[0].toUpperCase(), quote: "", span: c.span }));
      if (ledger.verifyEvidence({ text: it.text, cites: fixedCites }, f.g.label).verified) {
        const idx = f.g.list.indexOf(f.e);
        if (idx >= 0) f.g.list[idx] = { text: it.text, cites: fixedCites };
        fixed += 1;
        return;
      }
    }
    if (it.action === "drop") toDrop.push({ g: f.g, e: f.e });
  });
  for (const { g, e } of toDrop) {
    const idx = g.list.indexOf(e);
    if (idx >= 0 && g.list.length > g.minKeep) {
      g.list.splice(idx, 1);
      dropped += 1;
    }
  }
  const note = `fixed ${fixed}, dropped ${dropped}, of ${failing.length} unverified (${failing.length} parallel calls)`;
  emit({ type: "engine", call: measured("verify", repairModel, Date.now() - t0, usage, { note, count: failing.length }) });
  emit({ type: "note", text: `🔎 Verifier: fixed ${fixed}, dropped ${dropped}, of ${failing.length} unverified.` });
  return { failing: failing.length, fixed, dropped };
}

// ---- REPAIR: money amounts in the plan's free text ----------------------------------------------

const AmountFixSchema = z.object({
  fixes: z
    .array(z.object({ where: z.string().describe("The field id, exactly as given"), text: z.string().describe("The corrected text") }))
    .max(20),
});

/**
 * One small call: the writer's model rewrites only the money amounts of the listed fields so each equals an
 * allowed price for the same item, or drops it. Returns the proposed texts; the caller re-checks them in code.
 */
export async function repairAmounts(opts: {
  items: { where: string; text: string; amounts: string[] }[];
  allowed: string[];
  currency: string;
  routing: Routing;
  emit: Emit;
  signal?: AbortSignal;
  maxMs?: number;
}): Promise<Map<string, string>> {
  const { items, routing, emit } = opts;
  const model = routing.repair || routing.reasoning;
  const capMs = Math.max(5_000, Math.min(30_000, opts.maxMs ?? 30_000));
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(capMs)]) : AbortSignal.timeout(capMs);
  const t0 = Date.now();
  try {
    const res = await chat(
      {
        model,
        reasoning_effort: "low",
        temperature: 0,
        max_tokens: 6000,
        tools: [toOpenAITool({ name: "fix_amounts", description: "Return the corrected texts.", schema: AmountFixSchema })],
        tool_choice: { type: "function", function: { name: "fix_amounts" } },
        messages: [
          {
            role: "user",
            content: `These texts from a restaurant's weekly plan contain money amounts that match no price the plan can back (currency ${opts.currency}).
For each text, change ONLY the listed amounts: use the allowed price of the same item if there is one, otherwise remove the amount and keep the sentence natural (e.g. "a half-portion of the lunch pasta" instead of "a $12 half-portion"). Keep everything else exactly as written, in the same language. Never add new amounts.

${JSON.stringify({ allowed_prices: opts.allowed, texts: items })}`,
          },
        ],
      },
      signal,
    );
    const raw = res.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const parsed = AmountFixSchema.safeParse(raw ? tolerantParse(raw) : null);
    const out = new Map<string, string>();
    if (parsed.success) for (const f of parsed.data.fixes) if (items.some((i) => i.where === f.where) && f.text.trim()) out.set(f.where, f.text.trim());
    emit({ type: "engine", call: measured("verify", model, Date.now() - t0, res.usage, { note: `prices in the plan text: ${out.size} of ${items.length} texts rewritten` }) });
    return out;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return new Map(); // timed out or failed: the amounts stay listed as unbacked
  }
}

// ---- VISION: menu photo -------------------------------------------------------------------

const MenuSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string(),
        price: z.number().nullable().optional(),
        section: z.string().nullable().optional(),
      }),
    )
    .max(80),
  currency: z.string().nullable().optional(),
});

export async function readMenuPhoto(opts: {
  dataUrl: string;
  routing: Routing;
  emit: Emit;
  signal?: AbortSignal;
}): Promise<{ items: MenuItem[]; currency: string | null } | null> {
  const t0 = Date.now();
  const res = await chat(
    {
      model: opts.routing.vision,
      temperature: 0,
      max_tokens: 4000,
      tools: [toOpenAITool({ name: "menu", description: "The dishes and prices printed on this menu.", schema: MenuSchema })],
      tool_choice: { type: "function", function: { name: "menu" } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this restaurant menu: every dish or drink name exactly as printed, its price as a number (null if none), and its section heading. Do not translate or invent items.",
            },
            { type: "image_url", image_url: { url: opts.dataUrl } },
          ],
        },
      ],
    },
    opts.signal,
  );
  const raw = res.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
  const parsed = MenuSchema.safeParse(raw ? tolerantParse(raw) : null);
  opts.emit({
    type: "engine",
    call: measured("vision", opts.routing.vision, Date.now() - t0, res.usage, {
      note: parsed.success ? `${parsed.data.items.length} menu items read` : "could not read the menu",
    }),
  });
  if (!parsed.success) return null;
  return {
    items: parsed.data.items.map((i) => ({ name: i.name, price: i.price ?? null, section: i.section ?? null })),
    currency: parsed.data.currency ?? null,
  };
}

// ---- BASELINE: the same fast Nemotron, no tools, no data -------------------------------------

/** The same model that writes the plan, asked without any data: the honest "without the week" comparison. */
export async function baseline(prompt: string, routing: Routing, emit: Emit, signal?: AbortSignal): Promise<string> {
  const t0 = Date.now();
  const res = await chat(
    {
      model: routing.reasoning,
      reasoning_effort: "low",
      max_tokens: 3000,
      temperature: 0.6,
      messages: [{ role: "user", content: prompt }],
    },
    signal,
  );
  emit({ type: "engine", call: measured("baseline", routing.reasoning, Date.now() - t0, res.usage) });
  return cleanText(res.choices?.[0]?.message?.content);
}
