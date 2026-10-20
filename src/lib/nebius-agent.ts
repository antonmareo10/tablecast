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

const BASE_URL = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1/";

export interface Routing {
  fast: string; // tool loop, baseline
  repair?: string; // citation repair (defaults to the reasoning model at low effort)
  reasoning: string; // the playbook
  vision: string; // menu photos
  effort: "low" | "medium" | "high";
}

export function defaultRouting(): Routing {
  return {
    fast: process.env.NEBIUS_FAST_MODEL || "nvidia/Nemotron-3_5-Lightning",
    // Measured: Ultra at low effort fixes far more failed citations than Lightning (see eval/SUMMARY.md).
    repair: process.env.NEBIUS_REPAIR_MODEL || process.env.NEBIUS_MODEL || "nvidia/Nemotron-3-Ultra-550b-a55b",
    reasoning: process.env.NEBIUS_MODEL || "nvidia/Nemotron-3-Ultra-550b-a55b",
    vision: process.env.NEBIUS_VISION_MODEL || "nvidia/Nemotron-3.5-Super-VL",
    effort: (process.env.NEBIUS_REASONING_EFFORT as Routing["effort"]) || "medium",
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
  sharedClient ??= new OpenAI({ baseURL: BASE_URL, apiKey: process.env.NEBIUS_API_KEY, maxRetries: 2 });
  return sharedClient;
}

// The SDK's types don't know Nemotron's extra params (reasoning_effort), so we call it loosely.
function chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResponse> {
  return (client().chat.completions.create as unknown as (a: unknown, o?: unknown) => Promise<ChatResponse>)(body, { signal });
}
function chatStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>> {
  return (client().chat.completions.create as unknown as (a: unknown, o?: unknown) => Promise<AsyncIterable<StreamChunk>>)(
    { ...body, stream: true, stream_options: { include_usage: true } },
    { signal },
  );
}

export function measured(phase: EngineCall["phase"], model: string, ms: number, usage: Usage | null | undefined, extra: Partial<EngineCall> = {}): EngineCall {
  const call: EngineCall = { phase, model, label: modelLabel(model), ms: Math.round(ms), ...extra };
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

export function toOpenAITool(spec: { name: string; description: string; schema: z.ZodType }) {
  return {
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.schema, { target: "draft-7" }) as Record<string, unknown>,
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
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (turn > 0 && Date.now() - started > opts.budgetMs) {
      emit({ type: "note", text: "Research time budget reached — writing the plan with what was found so far." });
      break;
    }
    const t0 = Date.now();
    const res = await chat(
      {
        model: routing.fast,
        messages,
        tools: tools.map(toOpenAITool),
        tool_choice: "auto",
        reasoning_effort: "none",
        temperature: 0.3,
        max_tokens: 2048,
      },
      signal,
    );
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
      call: measured("gather", routing.fast, callMs, res.usage, {
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
  maxTokens?: number;
}): Promise<{ value: unknown | null; finish: string | null }> {
  const { routing, emit, signal } = opts;
  const effort = opts.effort ?? routing.effort;
  const started = Date.now();
  // Our own abort, so a reasoning loop can be cut without cancelling the whole run.
  const stopper = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
  const stream = await chatStream(
    {
      model: routing.reasoning,
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
  let args = "";
  let finish: string | null = null;
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
          const sentences = cleanText(thinking).match(/[^.!?\n]{25,}[.!?]/g);
          const last = sentences?.at(-1)?.trim();
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
    if (!(finish === "loop" && stopper.signal.aborted && !signal?.aborted)) throw err;
  }
  if (finish === "loop") args = ""; // a plan written by a looping model is not trusted
  // A stream cut by us never reports usage: estimate it (~4 characters per token) and say so.
  const estimated = !usage;
  if (estimated) usage = { prompt_tokens: Math.round((opts.system.length + opts.user.length) / 4), completion_tokens: Math.round(outChars / 4) };
  emit({
    type: "engine",
    call: measured("synthesize", routing.reasoning, Date.now() - started, usage, {
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
      opts.signal,
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
  items: z.array(
    z.object({
      ref: z.string(),
      action: z.enum(["fix", "drop"]),
      text: z.string().optional(),
      cites: z.array(z.object({ source: z.string(), quote: z.string() })).optional(),
    }),
  ),
});

/**
 * Claims whose quotes are not in their sources (or whose numbers no cited source contains) go
 * back to the fast model once, with the closest passage of each cited source, to be corrected
 * or dropped. A correction is kept only if it passes the same deterministic check.
 */
export async function repairCitations(opts: {
  groups: EvidenceGroup[];
  ledger: SourceLedger;
  routing: Routing;
  emit: Emit;
  signal?: AbortSignal;
}): Promise<{ failing: number; fixed: number; dropped: number }> {
  const { groups, ledger, routing, emit } = opts;
  const repairModel = routing.repair || routing.fast;
  const repairEffort = repairModel === routing.fast ? "none" : "low";
  const failing: { ref: string; g: EvidenceGroup; e: Evidence; issue: string }[] = [];
  groups.forEach((g, gi) =>
    g.list.forEach((e, i) => {
      const v = ledger.verifyEvidence(e);
      if (!v.verified) failing.push({ ref: `g${gi}i${i}`, g, e, issue: v.issue ?? "unverified" });
    }),
  );
  if (!failing.length) return { failing: 0, fixed: 0, dropped: 0 };

  emit({
    type: "note",
    text: `🔎 Verifier: ${failing.length} claim${failing.length > 1 ? "s" : ""} did not match ${failing.length > 1 ? "their" : "its"} sources word for word — sending ${failing.length > 1 ? "them" : "it"} back to ${modelLabel(repairModel)} to correct or drop.`,
  });

  const payload = failing.map(({ ref, e, issue }) => {
    const cited = [...new Set((e.cites ?? []).map((c) => c.source))];
    const missing = ledger.missingNumbers(e);
    const withNums = ledger.withNumbers(missing, 3, cited);
    const others = ledger.related(`${e.text} ${(e.cites ?? []).map((c) => c.quote).join(" ")}`, 2, [...cited, ...withNums]);
    const hint = `${e.text} ${(e.cites ?? []).map((c) => c.quote).join(" ")}`;
    return {
      ref,
      text: e.text,
      cites: e.cites,
      problem: issue,
      source_passages: [
        ...cited.map((id) => ({ source: id, passage: ledger.excerpt(id, hint) })),
        // Where the sentence's unbacked numbers actually appear, centred on them.
        ...withNums.map((id) => ({ source: id, passage: ledger.excerpt(id, missing.map((n) => n.replace("d", ".")).join(" ")) })),
        ...others.map((id) => ({ source: id, passage: ledger.excerpt(id, hint) })),
      ],
    };
  });

  const t0 = Date.now();
  const res = await chat(
    {
      model: repairModel,
      reasoning_effort: repairEffort,
      temperature: 0,
      max_tokens: repairEffort === "none" ? 4000 : 12000,
      tools: [toOpenAITool({ name: "fix_claims", description: "A fix or drop decision for every claim.", schema: FixSchema })],
      tool_choice: { type: "function", function: { name: "fix_claims" } },
      messages: [
        {
          role: "user",
          content: `Each claim below cites a source, but its quote is not found word for word in that source, or the sentence has a number that the cited source does not contain. For each claim:
- "fix": cite any of the given passages (use its source id) with a quote of 3-20 words copied EXACTLY as written there (same words, same order), up to 3 cites, and rewrite the sentence so every number in it appears in a passage you cite. Drop numbers you cannot back.
- "drop": if the passage does not support the claim.
Never invent wording that is not in the passage.

${JSON.stringify(payload)}`,
        },
      ],
    },
    opts.signal,
  );
  const raw = res.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
  const parsed = FixSchema.safeParse(raw ? tolerantParse(raw) : null);
  let fixed = 0;
  let dropped = 0;
  if (parsed.success) {
    const byRef = new Map(parsed.data.items.map((it) => [it.ref, it] as const));
    const toDrop: { g: EvidenceGroup; e: Evidence }[] = [];
    for (const f of failing) {
      const it = byRef.get(f.ref);
      if (!it) continue;
      if (it.action === "fix" && it.text && it.cites?.length) {
        const candidate = ledger.verifyEvidence({ text: it.text, cites: it.cites });
        if (candidate.verified) {
          const idx = f.g.list.indexOf(f.e);
          if (idx >= 0) f.g.list[idx] = { text: it.text, cites: it.cites };
          fixed += 1;
          continue;
        }
      }
      if (it.action === "drop") toDrop.push({ g: f.g, e: f.e });
    }
    for (const { g, e } of toDrop) {
      const idx = g.list.indexOf(e);
      if (idx >= 0 && g.list.length > g.minKeep) {
        g.list.splice(idx, 1);
        dropped += 1;
      }
    }
  }
  const note = `fixed ${fixed}, dropped ${dropped}, of ${failing.length} unverified`;
  emit({ type: "engine", call: measured("verify", repairModel, Date.now() - t0, res.usage, { note }) });
  emit({ type: "note", text: `🔎 Verifier: ${note}.` });
  return { failing: failing.length, fixed, dropped };
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

export async function baseline(prompt: string, routing: Routing, emit: Emit, signal?: AbortSignal): Promise<string> {
  const t0 = Date.now();
  const res = await chat(
    {
      model: routing.fast,
      reasoning_effort: "none",
      max_tokens: 800,
      temperature: 0.6,
      messages: [{ role: "user", content: prompt }],
    },
    signal,
  );
  emit({ type: "engine", call: measured("baseline", routing.fast, Date.now() - t0, res.usage) });
  return cleanText(res.choices?.[0]?.message?.content);
}
