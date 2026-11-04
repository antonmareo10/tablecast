// The model runtime: every model call Tablecast makes, sent through the Otari gateway (src/lib/otari.ts).
//
// Roles, each an Otari routing policy (docs/OTARI_SETUP.md) whose candidates are open-weight models on otari.ai's
// hosted providers, with fallbacks to another provider and another model family:
//   • RESEARCH  (tablecast-research)  — drives the web-research tool loop: short "what to look up next" decisions.
//                                        Tools asked for in one turn run in parallel.
//   • VISION    (catalog id)           — reads the owner's menu photo into structured items.
//   • WRITE     (tablecast-write, or tablecast-economy) — writes the playbook through a forced function call, streamed
//                                        so the UI drafts it live. tablecast-write tiers down to Nemotron Super once the
//                                        restaurant has used most of its weekly Otari budget.
//   • CHECK     (tablecast-check)      — repairs what failed a code check (citations, prices, dates). Every fix is
//                                        re-checked by code; nothing is accepted on the model's word.
//
// The app asks Otari for a policy name; Otari says in its response headers which model and provider served the call,
// how many candidates it tried and whether a fallback answered, and puts the call's cost in usage.cost_usd. All of it
// is emitted as an `engine` event and shown in the app's engine room.

import { z } from "zod";
import type { SourceLedger } from "./evidence";
import { LoopGuard } from "./loop-guard";
import { isLocalCapError } from "./otari-ledger";
import {
  chatCompletion,
  chatStream,
  isOtariError,
  otariConfigured,
  otariJSON,
  type ChatResponse,
  type ChatUsage,
  type Served,
  type OtariToolCall,
  type StreamChunk,
  type ToolCall,
} from "./otari";
import type { AgentEvent, EngineCall, Evidence, MenuItem } from "./types";

export type Emit = (e: AgentEvent) => void;

const MAX_ARGS_CHARS = 70_000;
// A writer stream that sends nothing for this long is cut and the plan is written again. In my first Otari runs, two of
// three first attempts on Fireworks stopped sending after about 14,000 characters of the plan and stayed silent; the
// retry then wrote the whole plan in 36 s. Tokens normally arrive many times a second, so 30 s of silence is a stall.
const STALL_MS = Number(process.env.WRITER_STALL_MS || 30_000);
// A whole writing attempt may not take longer than this (a slow trickle never trips the stall watchdog).
// Read per call, so scripts can raise it; a run's deadline can only lower it.
const writerMaxMs = (routing: Routing, deadlineMs?: number) =>
  Math.min(Number(process.env.WRITER_MAX_MS) || routing.writerMaxMs || 150_000, deadlineMs ?? Infinity);

export interface Routing {
  fast: string; // research tool loop
  repair?: string; // the checker: citation, price and date repairs
  reasoning: string; // the playbook writer
  vision: string; // menu photos
  quartermaster?: string; // the supplier order, computed in Otari's code sandbox
  effort: "low" | "medium" | "high";
  writerMaxMs?: number; // how long one writing attempt may take
  fallback?: string; // model for the one retry, if not the writer itself
  // false: the writer's requests carry no reasoning_effort. Bedrock refuses the parameter for non-Claude models (400),
  // which made every Economy request fail over to its second candidate until I stopped sending it.
  writerEffort?: boolean;
}

/** The reasoning_effort field for a request to `model`, or nothing where the routing says the writer takes none. */
export function effortFor(routing: Routing, model: string, effort: string): { reasoning_effort?: string } {
  return model === routing.reasoning && routing.writerEffort === false ? {} : { reasoning_effort: effort };
}

// The policies the app asks Otari for, and the catalog id each falls back to when the workspace has no such policy.
// Catalog ids still route through Otari: it picks among the model's hosted offerings and fails over between them.
export const POLICIES = {
  research: { name: "tablecast-research", catalog: "alibaba/qwen3-235b-a22b-instruct-2507", label: "Qwen3 235B" },
  write: { name: "tablecast-write", catalog: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra" },
  economy: { name: "tablecast-economy", catalog: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super" },
  check: { name: "tablecast-check", catalog: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra" },
  quartermaster: { name: "tablecast-quartermaster", catalog: "openai/gpt-oss-120b", label: "gpt-oss-120b" },
  vision: { name: "alibaba/qwen3-vl-235b-a22b-instruct", catalog: "alibaba/qwen3-vl-235b-a22b-instruct", label: "Qwen3 VL 235B" },
} as const;

export function defaultRouting(): Routing {
  return {
    fast: process.env.OTARI_RESEARCH_MODEL || POLICIES.research.name,
    repair: process.env.OTARI_CHECK_MODEL || POLICIES.check.name,
    reasoning: process.env.OTARI_WRITE_MODEL || POLICIES.write.name,
    vision: process.env.OTARI_VISION_MODEL || POLICIES.vision.name,
    quartermaster: process.env.OTARI_QUARTERMASTER_MODEL || POLICIES.quartermaster.name,
    // Low, not the medium the Nebius eval chose: on Fireworks, Ultra at medium went silent for over a minute in my first
    // Otari run (the stall watchdog cut it) and the low-effort retry wrote the plan in 36 s. The Nebius eval had low and
    // medium within noise of each other (84% and 84% verified after repair in v6).
    effort: (process.env.WRITER_REASONING_EFFORT as Routing["effort"]) || "low",
  };
}

/** "Economy": Nemotron 3 Super writes; if it is cut short, the Quick writer takes over for the one retry. */
export function economyRouting(): Routing {
  const base = defaultRouting();
  return {
    ...base,
    reasoning: process.env.OTARI_ECONOMY_MODEL || POLICIES.economy.name,
    effort: "medium",
    writerEffort: false,
    writerMaxMs: 170_000,
    fallback: base.reasoning,
  };
}

/** A readable name for a policy, a catalog id or the model id a provider reported in Otari-Model. */
export function modelLabel(id: string | undefined): string {
  if (!id) return "model";
  const policy = Object.values(POLICIES).find((p) => p.name === id || p.catalog === id);
  if (policy) return policy.label;
  if (/qwen3-vl/i.test(id)) return "Qwen3 VL 235B";
  if (/nemotron/i.test(id) && /vl/i.test(id)) return "Nemotron Super VL";
  if (/ultra/i.test(id)) return "Nemotron 3 Ultra";
  if (/lightning/i.test(id)) return "Nemotron Lightning";
  if (/nemotron/i.test(id) && /super/i.test(id)) return "Nemotron 3 Super";
  if (/nano/i.test(id)) return "Nemotron Nano";
  if (/qwen3-235b/i.test(id)) return "Qwen3 235B";
  if (/gpt-oss-120b/i.test(id)) return "gpt-oss-120b";
  const glm = id.match(/glm-?(\d+(?:\.\d+)?)/i);
  if (glm) return `GLM ${glm[1]}`;
  if (/deepseek/i.test(id)) return (id.split("/").pop() ?? id).replace(/-/g, " ");
  if (/mistral-small/i.test(id)) return "Mistral Small 4";
  if (/mistral-large/i.test(id)) return "Mistral Large 3";
  return id.split(/[/:]/).pop() || id;
}

export function inferenceConfigured(): boolean {
  return otariConfigured();
}

// ---- Policy resolution ----------------------------------------------------------------------

let modelIds: { at: number; ids: Set<string> } | null = null;

/** The model names this key can call (catalog ids, aliases and the workspace's routing policies), cached 5 minutes. */
async function listModelIds(signal?: AbortSignal): Promise<Set<string>> {
  if (modelIds && Date.now() - modelIds.at < 300_000) return modelIds.ids;
  const { data } = await otariJSON<{ data?: { id: string }[] }>("/v1/models", { method: "GET", signal, timeoutMs: 15_000 });
  const ids = new Set((data.data ?? []).map((m) => m.id));
  modelIds = { at: Date.now(), ids };
  return ids;
}

/**
 * Before a live run: checks the key (GET /v1/models costs nothing) and swaps any routing policy the workspace does not
 * have for its catalog id, returning which were missing. Throws an OtariError when the key is refused.
 */
export async function resolveRouting(routing: Routing, signal?: AbortSignal): Promise<{ routing: Routing; missing: string[] }> {
  const ids = await listModelIds(signal);
  const missing: string[] = [];
  const pick = (name: string | undefined): string | undefined => {
    if (!name) return name;
    const p = Object.values(POLICIES).find((x) => x.name === name);
    if (!p || p.name === p.catalog || ids.has(name)) return name;
    missing.push(name);
    return p.catalog;
  };
  const out: Routing = {
    ...routing,
    fast: pick(routing.fast) as string,
    reasoning: pick(routing.reasoning) as string,
    vision: pick(routing.vision) as string,
    repair: pick(routing.repair),
    quartermaster: pick(routing.quartermaster),
    fallback: pick(routing.fallback),
  };
  return { routing: out, missing: [...new Set(missing)] };
}

/** For tests: forget the cached model list. */
export function resetModelCache(): void {
  modelIds = null;
}

// ---- low-level ------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Non-streamed calls (research turns, repairs, vision, baseline) never wait more than 90 s each.
function chat(role: string, body: Record<string, unknown>, signal?: AbortSignal, capMs = 90_000): Promise<{ data: ChatResponse; served: Served }> {
  return chatCompletion(role, body, { signal, timeoutMs: capMs });
}

/**
 * Errors that stop the whole run rather than one attempt: the key or the restaurant's budget is spent, the account
 * has no funds, the key was refused, or the local development cap is reached. Retrying any of them can't help.
 */
export function isStopError(err: unknown): boolean {
  if (isLocalCapError(err)) return true;
  if (!isOtariError(err)) return false;
  return (
    err.status === 401 ||
    err.status === 402 ||
    ["budget_exceeded", "insufficient_funds", "user_blocked", "end_user_limit_reached", "not_configured"].includes(err.code ?? "")
  );
}

// A research turn takes a second or two. If the research model hangs past this, the research moves to the checker's
// model. (Otari's own fallbacks handle a provider that fails; this handles one that is merely slow.)
const GATHER_TURN_MS = Number(process.env.GATHER_TURN_MS || 25_000);

/** A short, one-line description of a failed request, for the engine log. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 140);
}

export function measured(
  phase: EngineCall["phase"],
  model: string,
  ms: number,
  usage: ChatUsage | null | undefined,
  extra: Partial<EngineCall> & { served?: Served } = {},
): EngineCall {
  const { served, ...rest } = extra;
  // started_at lets the UI draw a real timeline of where the run's time went.
  const call: EngineCall = {
    phase,
    model,
    label: modelLabel(served?.model ?? model),
    ms: Math.round(ms),
    started_at: Date.now() - Math.round(ms),
    ...rest,
  };
  if (usage) {
    if (typeof usage.prompt_tokens === "number") call.prompt_tokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") call.completion_tokens = usage.completion_tokens;
    const r = usage.completion_tokens_details?.reasoning_tokens;
    if (typeof r === "number") call.reasoning_tokens = r;
  }
  if (served) {
    const s: NonNullable<EngineCall["served"]> = {};
    if (served.provider) s.provider = served.provider;
    if (served.model) s.model = served.model;
    if (served.attempts) s.attempts = served.attempts;
    if (served.fallback != null) s.fallback = served.fallback;
    if (served.request_id) s.request_id = served.request_id;
    if (Object.keys(s).length) call.served = s;
    if (served.cost_usd != null) call.cost_usd = (call.cost_usd ?? 0) + served.cost_usd;
    if (served.guardrails?.length) call.guardrails = served.guardrails;
  }
  return call;
}

/** Adds one more Otari answer to an engine entry that stands for several parallel calls. */
function addServed(total: { cost: number; served: Served[] }, served: Served) {
  if (served.cost_usd != null) total.cost += served.cost_usd;
  total.served.push(served);
}

function summarizeServed(list: Served[]): Partial<EngineCall> {
  if (!list.length) return {};
  const fallbacks = list.filter((s) => s.fallback).length;
  const models = [...new Set(list.map((s) => s.model).filter(Boolean))] as string[];
  const providers = [...new Set(list.map((s) => s.provider).filter(Boolean))] as string[];
  return {
    label: modelLabel(models[0]),
    served: {
      ...(models.length ? { model: models.join(", ") } : {}),
      ...(providers.length ? { provider: providers.join(", ") } : {}),
      fallback: fallbacks > 0,
      ...(fallbacks ? { fallbacks } : {}),
    },
  };
}

// Reasoning models may wrap chain-of-thought in <think>…</think> inside content; never show it as output.
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

// ---- RESEARCH: the research model drives the tools ---------------------------------------------

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
  /** More request fields for every research turn, e.g. `mcp_servers` so Otari runs MCP tools inside the turn. */
  extra?: Record<string, unknown>;
  /**
   * The calls Otari ran itself during a turn (MCP tools, web searches…), from `otari_tool_calls`. What it returns is
   * added to the conversation as a note, because those rounds happen inside Otari and are not in the message history.
   */
  onGatewayCalls?: (calls: OtariToolCall[]) => string | undefined | Promise<string | undefined>;
  /** How long one research turn may take (longer when Otari runs MCP calls inside it). */
  turnMs?: number;
  /** Gateway-run tools to declare on each turn, e.g. otari_web_search with what is left of the search budget. */
  extraTools?: () => Record<string, unknown>[];
}): Promise<void> {
  const { routing, tools, emit, signal } = opts;
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const started = Date.now();
  // If the research model doesn't answer a turn in time, the checker's model drives the rest of the research, so a
  // stuck model never costs the run its web research.
  let model = routing.fast;
  const backup = routing.repair ?? routing.reasoning;
  const turnCall = (m: string) =>
    chat(
      "research",
      {
        model: m,
        messages,
        tools: [...tools.map(toOpenAITool), ...(opts.extraTools?.() ?? [])],
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 2048,
        ...opts.extra,
        // The backup is a reasoning model; research turns are short decisions.
        ...(m === routing.fast ? {} : { reasoning_effort: "low" }),
      },
      signal,
      opts.turnMs ?? GATHER_TURN_MS,
    );
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (turn > 0 && Date.now() - started > opts.budgetMs) {
      emit({ type: "note", text: "Research time budget reached — writing the plan with what was found so far." });
      break;
    }
    let t0 = Date.now();
    let res: { data: ChatResponse; served: Served };
    try {
      res = await turnCall(model);
    } catch (err) {
      if (signal?.aborted || model === backup || isStopError(err)) throw err;
      emit({ type: "note", text: `${modelLabel(model)} didn't answer in time — ${modelLabel(backup)} takes over the research.` });
      model = backup;
      t0 = Date.now();
      res = await turnCall(model);
    }
    const callMs = Date.now() - t0;
    const msg = res.data.choices?.[0]?.message;
    if (!msg) break;
    const note = cleanText(msg.content);
    if (note && note.toUpperCase() !== "READY") emit({ type: "note", text: note.slice(0, 240) });
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls ?? [];
    const gateway = (res.data.otari_tool_calls ?? []).filter((c) => c.status !== "in_progress");
    const gatewayNote = gateway.length ? await opts.onGatewayCalls?.(gateway) : undefined;
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
        if (isStopError(err)) throw err;
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    calls.forEach((call, i) => messages.push({ role: "tool", tool_call_id: call.id, content: results[i] }));
    if (gatewayNote && calls.length) messages.push({ role: "user", content: gatewayNote });
    emit({
      type: "engine",
      call: measured("gather", model, callMs, res.data.usage, {
        started_at: t0,
        tool_calls: calls.length,
        ...(gateway.length ? { note: `${gateway.length} tool call${gateway.length > 1 ? "s" : ""} run inside Otari (${[...new Set(gateway.map((g) => (g.type === "mcp" ? `MCP ${g.name ?? ""}`.trim() : g.type)))].join(", ")})` } : {}),
        served: res.served,
        ...(calls.length ? { tools_ms: Date.now() - toolsStart } : {}),
      }),
    });
    if (!calls.length) break; // READY
    // Every tool refused for budget reasons: the research is over whatever the model thinks.
    if (results.every((r) => /budget used up/.test(r))) break;
  }
}

// ---- WRITE: the writer, forced tool, streamed --------------------------------

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
}): Promise<{ value: unknown | null; finish: string | null; served?: Served }> {
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
  let served: Served | undefined;
  try {
    ({ stream, served } = await chatStream(
      "write",
      {
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        tools: [toOpenAITool(opts.tool)],
        tool_choice: { type: "function", function: { name: opts.tool.name } },
        ...effortFor(routing, model, effort),
        temperature: 0.4,
        max_tokens: opts.maxTokens ?? 28000,
      },
      { signal: combined },
    ));
  } catch (err) {
    clearTimeout(stallTimer);
    clearTimeout(capTimer);
    // The connection never answered, or every candidate refused the request: let the caller retry once.
    if (signal?.aborted || isStopError(err)) throw err;
    if (finish !== "stall" && finish !== "slow") {
      finish = "error";
      emit({ type: "engine", call: measured("synthesize", model, Date.now() - started, undefined, { note: `reasoning_effort ${effort} · server error: ${errorText(err)}` }) });
    }
    return { value: null, finish };
  }
  let args = "";
  let ttft: number | null = null;
  let usage: ChatUsage | undefined;
  let lastDraft = 0;
  let lastThought = Date.now();
  let thinking = ""; // reasoning streamed since the last note
  let lastNote = "";
  const guard = new LoopGuard();
  let serverError = "";
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
    // The caller's abort propagates. Our own cuts (loop, stall, slow) and a server error mid-stream end this attempt,
    // and the caller retries once. (Held-out eval, 21 Oct: a provider failed a stream whose JSON held a 4,305-digit
    // number — "Exceeds the limit (4300 digits) for integer string conversion" — and the whole run was lost.)
    if (signal?.aborted || isStopError(err)) throw err;
    if (!((finish === "loop" || finish === "stall" || finish === "slow") && stopper.signal.aborted)) {
      finish = "error";
      serverError = errorText(err);
    }
  }
  clearTimeout(stallTimer);
  clearTimeout(capTimer);
  if (finish === "loop" || finish === "stall" || finish === "slow" || finish === "error") args = ""; // a cut-off or looping plan is not trusted
  // A stream cut by us never reports usage: estimate it (~4 characters per token) and say so.
  const estimated = !usage;
  if (estimated) usage = { prompt_tokens: Math.round((opts.system.length + opts.user.length) / 4), completion_tokens: Math.round(outChars / 4) };
  emit({
    type: "engine",
    call: measured("synthesize", model, Date.now() - started, usage, {
      ...(ttft != null ? { ttft_ms: ttft } : {}),
      ...(estimated ? { usage_estimated: true } : {}),
      served,
      note: `${effortFor(routing, model, effort).reasoning_effort ? `reasoning_effort ${effort}` : "model's default reasoning"}${finish === "loop" ? " · cut: reasoning loop detected" : finish === "error" ? ` · server error: ${serverError}` : finish && finish !== "stop" && finish !== "tool_calls" ? ` · stopped: ${finish}` : ""}`,
    }),
  });
  if (!args.trim()) return { value: null, finish, served };
  try {
    return { value: JSON.parse(args), finish, served };
  } catch {
    // A cut-off payload is not a plan: only accept a tolerant parse if the model finished on its own.
    return { value: finish === "length" ? null : tolerantParse(args), finish, served };
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
  const model = opts.routing.repair ?? opts.routing.fast;
  try {
    const res = await chat(
      "check",
      {
        model,
        reasoning_effort: "low",
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
      60_000,
    );
    const raw = res.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const second = raw ? opts.tool.schema.safeParse(tolerantParse(raw)) : null;
    opts.emit({
      type: "engine",
      call: measured("repair", model, Date.now() - t0, res.data.usage, { served: res.served, note: second?.success ? "schema repaired" : "schema repair failed" }),
    });
    if (second?.success) return { ok: true, value: second.data };
  } catch (err) {
    if (opts.signal?.aborted || isStopError(err)) throw err;
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
 * citation that doesn't talk about the claim) go back to the checker once — one small call per
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
  const repairEffort = process.env.REPAIR_EFFORT || "low";
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
  const total = { cost: 0, served: [] as Served[] };

  const decisions = await mapLimit(failing, 6, async ({ e, issue }) => {
    const cited = (e.cites ?? []).map((c) => c.span).filter((x): x is string => !!x);
    // Candidates: what it cited, where its unbacked numbers really appear, and the closest sentences by content.
    const candidates = [...new Set([...cited, ...ledger.spansWithNumbers(ledger.missingNumbers(ledger.resolve(e)), 4), ...ledger.relatedSpans(e.text, 6)])]
      .slice(0, 10)
      .map((id) => ({ id, text: ledger.span(id)?.text ?? "" }))
      .filter((c) => c.text);
    try {
      const res = await chat(
        "check",
        {
          model: repairModel,
          reasoning_effort: repairEffort,
          temperature: 0,
          max_tokens: 6000,
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
      usage.prompt_tokens += res.data.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += res.data.usage?.completion_tokens ?? 0;
      usage.completion_tokens_details.reasoning_tokens += res.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      addServed(total, res.served);
      const raw = res.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
      const parsed = FixSchema.safeParse(raw ? tolerantParse(raw) : null);
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (opts.signal?.aborted || isStopError(err)) throw err;
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
  emit({
    type: "engine",
    call: measured("verify", repairModel, Date.now() - t0, usage, {
      note,
      count: failing.length,
      ...(total.served.length ? { cost_usd: total.cost } : {}),
      ...summarizeServed(total.served),
    }),
  });
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
 * One small call: the checker rewrites only the money amounts of the listed fields so each equals an
 * allowed price for the same item, or drops it. Returns the proposed texts; the caller re-checks them in code.
 */
export async function repairAmounts(opts: {
  items: { where: string; text: string; amounts: string[]; notes?: string[] }[];
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
      "check",
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
For each text, change ONLY the listed amounts: use the allowed price of the same item if there is one, otherwise remove the amount and keep the sentence natural (e.g. "a half-portion of the lunch pasta" instead of "a $12 half-portion"). Where a text has notes, they say why an amount fails; follow them. Keep everything else exactly as written, in the same language. Never add new amounts.

${JSON.stringify({ allowed_prices: opts.allowed, texts: items })}`,
          },
        ],
      },
      signal,
    );
    const raw = res.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const parsed = AmountFixSchema.safeParse(raw ? tolerantParse(raw) : null);
    const out = new Map<string, string>();
    if (parsed.success) for (const f of parsed.data.fixes) if (items.some((i) => i.where === f.where) && f.text.trim()) out.set(f.where, f.text.trim());
    emit({
      type: "engine",
      call: measured("verify", model, Date.now() - t0, res.data.usage, { served: res.served, note: `prices in the plan text: ${out.size} of ${items.length} texts rewritten` }),
    });
    return out;
  } catch (err) {
    if (opts.signal?.aborted || isStopError(err)) throw err;
    return new Map(); // timed out or failed: the amounts stay listed as unbacked
  }
}

// ---- REPAIR: dates before today ---------------------------------------------------------------

/**
 * One small call: the checker re-dates the listed scheduling fields so nothing falls before today, using
 * the week's calendar. Returns the proposed texts; the caller re-checks them in code.
 */
export async function repairDates(opts: {
  items: { where: string; text: string }[];
  today: string; // "Wed 21 Oct 2026"
  calendar: string[]; // "Wed 21 Oct", "Thu 22 Oct"…
  language: string;
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
      "check",
      {
        model,
        reasoning_effort: "low",
        temperature: 0,
        max_tokens: 6000,
        tools: [toOpenAITool({ name: "fix_dates", description: "Return the corrected texts.", schema: AmountFixSchema })],
        tool_choice: { type: "function", function: { name: "fix_dates" } },
        messages: [
          {
            role: "user",
            content: `Today is ${opts.today}, the restaurant's local date. These texts from its plan for the coming week schedule something on a day before today, which can't happen.
Re-date each one to a day of this week's calendar, today or later, keeping its order relative to the rest of the plan (orders go out first; a new dish starts no earlier than the day after its order). Change only the days and dates, keep each weekday matching its date as in the calendar, and keep everything else exactly as written, in ${opts.language}.

${JSON.stringify({ calendar: opts.calendar, texts: items })}`,
          },
        ],
      },
      signal,
    );
    const raw = res.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const parsed = AmountFixSchema.safeParse(raw ? tolerantParse(raw) : null);
    const out = new Map<string, string>();
    if (parsed.success) for (const f of parsed.data.fixes) if (items.some((i) => i.where === f.where) && f.text.trim()) out.set(f.where, f.text.trim());
    emit({
      type: "engine",
      call: measured("verify", model, Date.now() - t0, res.data.usage, { served: res.served, note: `dates before today: ${out.size} of ${items.length} texts re-dated` }),
    });
    return out;
  } catch (err) {
    if (opts.signal?.aborted || isStopError(err)) throw err;
    return new Map(); // timed out or failed: code drops or lists what is still in the past
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
    "vision",
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
  const raw = res.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
  const parsed = MenuSchema.safeParse(raw ? tolerantParse(raw) : null);
  opts.emit({
    type: "engine",
    call: measured("vision", opts.routing.vision, Date.now() - t0, res.data.usage, {
      served: res.served,
      note: parsed.success ? `${parsed.data.items.length} menu items read` : "could not read the menu",
    }),
  });
  if (!parsed.success) return null;
  return {
    items: parsed.data.items.map((i) => ({ name: i.name, price: i.price ?? null, section: i.section ?? null })),
    currency: parsed.data.currency ?? null,
  };
}

// ---- BASELINE: the writer, no tools, no data -------------------------------------

/** The same model that writes the plan, asked without any data: the honest "without the week" comparison. */
export async function baseline(prompt: string, routing: Routing, emit: Emit, signal?: AbortSignal): Promise<string> {
  const t0 = Date.now();
  const res = await chat(
    "baseline",
    {
      model: routing.reasoning,
      ...effortFor(routing, routing.reasoning, "low"),
      max_tokens: 3000,
      temperature: 0.6,
      messages: [{ role: "user", content: prompt }],
    },
    signal,
  );
  emit({ type: "engine", call: measured("baseline", routing.reasoning, Date.now() - t0, res.data.usage, { served: res.served }) });
  return cleanText(res.data.choices?.[0]?.message?.content);
}
