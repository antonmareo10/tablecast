// The Otari gateway client (https://otari.ai, OpenAI-compatible, by Mozilla.ai).
//
// Every model call, web search, MCP call, code execution and guardrail check Tablecast makes goes through here, so
// one place adds what Otari needs to tell a run apart and bill it:
//   • Authorization: the app's Otari key (a service key, so it may name end users).
//   • Otari-Conversation-Id: one id per run, so the run is one session in Otari's agent traces.
//   • user: the restaurant as an Otari end user ("restaurant:<name>-<city>"), so each restaurant has its own spend
//     and its own weekly budget. Only sent when the key is a service key (checked once per process).
//   • metadata tags (app, role, run) on completions, so Usage can be grouped by role.
// and reads back what Otari says about how each request was served: the model and provider that answered, how many
// candidates were tried, whether a fallback served it, its cost (usage.cost_usd), guardrail verdicts and the
// end user's budget.

import { AsyncLocalStorage } from "node:async_hooks";
import { assertUnderLocalCap, recordLocalSpend } from "./otari-ledger";

// The account's region decides the host: EU accounts (keys "otk_v1_eu_…") use eu.api.otari.ai, US ones api.otari.ai.
// OTARI_BASE_URL may be given with or without the trailing /v1, as the dashboard shows it; paths below add /v1.
export const OTARI_API = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
const USER_AGENT = "tablecast/0.8 (+https://github.com/antonmareo10/tablecast)";

export function otariConfigured(): boolean {
  return !!process.env.OTARI_API_KEY;
}

// ---- The run a call belongs to ---------------------------------------------------------------

export interface RunTag {
  id: string; // "tablecast-<random>": the Otari-Conversation-Id of every request in the run
  endUser?: string; // "restaurant:gjelina-los-angeles", only when the key may name end users
}

const runStore = new AsyncLocalStorage<RunTag>();

/** Runs `fn` with every Otari request inside it tagged as part of `tag`'s run. */
export function withRun<T>(tag: RunTag, fn: () => Promise<T>): Promise<T> {
  return runStore.run(tag, fn);
}

export function currentRun(): RunTag | undefined {
  return runStore.getStore();
}

/** A stable Otari end-user id for a restaurant: one budget and one spend line per restaurant, whoever runs it. */
export function restaurantEndUser(restaurant: string, city: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 80);
  return `restaurant:${slug(restaurant) || "unnamed"}-${slug(city) || "somewhere"}`;
}

export function newRunId(): string {
  return `tablecast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- What Otari says about a request ----------------------------------------------------------

export type GuardrailVerdict = {
  profile: string;
  mode?: string;
  valid: boolean | null;
  score?: number | null;
  status?: string; // evaluated | inconclusive | unavailable
  reason?: string;
};

export interface Served {
  request_id?: string;
  provider?: string; // Otari-Provider: the provider instance that answered ("nebius", "fireworks")
  model?: string; // Otari-Model: the model that answered, as that provider names it
  attempts?: number; // Otari-Attempt-Count
  fallback?: boolean; // Otari-Fallback: a candidate other than the policy's first served it
  duration_ms?: number;
  cost_usd?: number; // usage.cost_usd, Otari's own figure
  pricing_source?: string;
  guardrails?: GuardrailVerdict[];
  end_user_budget?: string;
}

export function servedFrom(headers: Headers): Served {
  const s: Served = {};
  const get = (k: string) => headers.get(k) ?? undefined;
  s.request_id = get("otari-request-id");
  s.provider = get("otari-provider");
  s.model = get("otari-model");
  const attempts = Number(get("otari-attempt-count"));
  if (Number.isFinite(attempts) && attempts > 0) s.attempts = attempts;
  const fb = get("otari-fallback");
  if (fb) s.fallback = fb === "true";
  const dur = Number(get("otari-response-duration-ms"));
  if (Number.isFinite(dur) && dur > 0) s.duration_ms = dur;
  const g = get("otari-guardrails");
  if (g) {
    try {
      const parsed = JSON.parse(g) as GuardrailVerdict[];
      if (Array.isArray(parsed)) s.guardrails = parsed;
    } catch {
      /* not JSON: ignore */
    }
  }
  s.end_user_budget = get("otari-end-user-budget");
  for (const k of Object.keys(s) as (keyof Served)[]) if (s[k] === undefined) delete s[k];
  return s;
}

/** usage.cost_usd is a six-decimal USD string; absent when the request was not priced. */
export function costOf(usage: unknown): { cost?: number; source?: string } {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as { cost_usd?: unknown; pricing_source?: unknown };
  const cost = typeof u.cost_usd === "string" || typeof u.cost_usd === "number" ? Number(u.cost_usd) : NaN;
  return {
    ...(Number.isFinite(cost) ? { cost } : {}),
    ...(typeof u.pricing_source === "string" ? { source: u.pricing_source } : {}),
  };
}

// ---- Errors --------------------------------------------------------------------------------------

export class OtariError extends Error {
  readonly status: number; // 0 = the request never got an HTTP answer
  readonly code?: string; // Otari-Error-Code / body.code: budget_exceeded, guardrail_violation, insufficient_funds…
  readonly detail: string;
  readonly headers?: Headers;
  constructor(status: number, detail: string, code?: string, headers?: Headers) {
    super(`Otari ${status || "network"}${code ? ` ${code}` : ""}: ${detail}`);
    this.name = "OtariError";
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.headers = headers;
  }
  /** Which budget refused a budget_exceeded request: "user" (the restaurant), "api_token", "workspace"… */
  get budgetScope(): string | undefined {
    return this.headers?.get("otari-budget-scope") ?? undefined;
  }
  get retryAfterS(): number | undefined {
    const v = Number(this.headers?.get("retry-after"));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }
}

/** instanceof that survives a second copy of this module (test module resets, separate server bundles). */
export function isOtariError(err: unknown): err is OtariError {
  return err instanceof OtariError || (err instanceof Error && err.name === "OtariError" && "status" in err);
}

async function errorFrom(res: Response): Promise<OtariError> {
  let detail = res.statusText || "request failed";
  let code = res.headers.get("otari-error-code") ?? undefined;
  try {
    const body = (await res.json()) as { detail?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown } };
    const d = body?.detail ?? body?.error?.message;
    if (typeof d === "string") detail = d;
    else if (d != null) detail = JSON.stringify(d).slice(0, 300);
    const c = body?.code ?? body?.error?.code;
    if (!code && typeof c === "string") code = c;
  } catch {
    /* not JSON */
  }
  return new OtariError(res.status, detail.replace(/\s+/g, " ").slice(0, 300), code, res.headers);
}

// ---- Requests ---------------------------------------------------------------------------------------

export interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Spend this request may cause, for the local development cap, when Otari does not report it inline. */
  holdUsd?: number;
}

/** One HTTP request to the Otari API. Throws OtariError for any non-2xx answer or a request that never got one. */
export async function otariFetch(path: string, opts: RequestOpts = {}): Promise<Response> {
  const key = process.env.OTARI_API_KEY;
  if (!key) throw new OtariError(401, "OTARI_API_KEY is not set on this server", "not_configured");
  assertUnderLocalCap();
  const run = currentRun();
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "user-agent": USER_AGENT,
    accept: "application/json, text/event-stream",
    ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(run ? { "otari-conversation-id": run.id } : {}),
    ...opts.headers,
  };
  const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  let res: Response;
  try {
    res = await fetch(`${OTARI_API}${path.startsWith("/") ? path : `/${path}`}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // the caller's own abort propagates as it is
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new OtariError(0, timedOut ? "Otari did not answer in time" : `could not reach Otari (${err instanceof Error ? err.message : String(err)})`, timedOut ? "timeout" : "network");
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

/** Fields every completion carries: the restaurant as end user (service key only) and tags for Usage. */
export function completionExtras(role: string): Record<string, unknown> {
  const run = currentRun();
  return {
    ...(run?.endUser ? { user: run.endUser } : {}),
    metadata: { app: "tablecast", role, ...(run ? { run: run.id } : {}) },
  };
}

export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  cost_usd?: string;
  pricing_source?: string;
};

export type OtariToolCall = {
  id: string;
  type: "web_search" | "web_fetch" | "code_execution" | "mcp";
  status: "in_progress" | "completed" | "failed";
  query?: string;
  url?: string;
  sources?: { url: string; title?: string; published_date?: string | null }[];
  code?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  server?: string;
  name?: string;
  output?: string;
  truncated?: boolean;
  error?: { provider?: string | null; status?: number | null; tag?: string; retryable?: boolean };
};

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatResponse = {
  model?: string;
  choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }>;
  usage?: ChatUsage;
  otari_tool_calls?: OtariToolCall[];
};

/** A non-streamed chat completion. `role` names the step for Otari's usage tags and the local ledger. */
export async function chatCompletion(
  role: string,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ data: ChatResponse; served: Served }> {
  const res = await otariFetch("/v1/chat/completions", { body: { ...completionExtras(role), ...body }, ...opts });
  const data = (await res.json()) as ChatResponse;
  const served = servedFrom(res.headers);
  const { cost, source } = costOf(data.usage);
  if (cost != null) served.cost_usd = cost;
  if (source) served.pricing_source = source;
  recordLocalSpend({ path: "/v1/chat/completions", role, model: String(body.model), request_id: served.request_id, cost_usd: cost ?? null });
  return { data, served };
}

export type StreamChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatUsage | null;
  otari_tool_calls?: OtariToolCall[];
  error?: { message?: string; code?: string; provider_failure?: unknown };
};

/**
 * A streamed chat completion. Otari holds the response until the provider's first chunk, so a candidate that fails
 * before answering falls over to the policy's next one and the headers already name who serves the stream.
 * An error event in the stream (the provider failed after it started) is thrown as an OtariError.
 */
export async function chatStream(
  role: string,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<{ stream: AsyncIterable<StreamChunk>; served: Served }> {
  const res = await otariFetch("/v1/chat/completions", {
    body: { ...completionExtras(role), ...body, stream: true, stream_options: { include_usage: true } },
    ...opts,
  });
  const served = servedFrom(res.headers);
  if (!res.body) throw new OtariError(res.status, "Otari answered the stream with no body", "provider_error", res.headers);
  const model = String(body.model);
  const reader = res.body;
  async function* chunks(): AsyncGenerator<StreamChunk> {
    let billed = false;
    try {
      for await (const data of sseData(reader)) {
        if (data === "[DONE]") break;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new OtariError(200, chunk.error.message || "the stream failed", chunk.error.code || "provider_error", res.headers);
        if (chunk.usage) {
          const { cost, source } = costOf(chunk.usage);
          if (cost != null && !billed) {
            billed = true;
            served.cost_usd = cost;
            if (source) served.pricing_source = source;
            recordLocalSpend({ path: "/v1/chat/completions", role, model, request_id: served.request_id, cost_usd: cost });
          }
        }
        yield chunk;
      }
    } finally {
      // A stream cut before Otari reported its cost still costs something: the ledger keeps a mark of it.
      if (!billed) recordLocalSpend({ path: "/v1/chat/completions", role, model, request_id: served.request_id, cost_usd: null, note: "stream ended before usage" });
    }
  }
  return { stream: chunks(), served };
}

/** The `data:` payloads of a server-sent event stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = function* () {
    if (data.length) {
      const joined = data.join("\n");
      data = [];
      yield joined;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") yield* flush();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // event:, id:, retry: and comments are not needed here
      }
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

/** JSON GET/POST helper for Otari's non-completion endpoints (search, code execution, MCP, end users, models). */
export async function otariJSON<T>(path: string, opts: RequestOpts & { role?: string } = {}): Promise<{ data: T; served: Served; headers: Headers }> {
  const res = await otariFetch(path, opts);
  const data = (await res.json()) as T;
  const served = servedFrom(res.headers);
  const { cost } = costOf((data as { usage?: unknown })?.usage);
  if (cost != null) served.cost_usd = cost;
  if (opts.method !== "GET" && opts.body !== undefined)
    recordLocalSpend({
      path: path.split("?")[0],
      role: opts.role ?? path,
      request_id: served.request_id,
      cost_usd: cost ?? null,
      ...(cost == null && opts.holdUsd ? { estimate_usd: opts.holdUsd } : {}),
    });
  return { data, served, headers: res.headers };
}
