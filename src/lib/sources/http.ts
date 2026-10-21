// Shared HTTP helper for the open-data source clients: polite User-Agent, a hard timeout on every call,
// at most one retry (5xx, 429, network) with a short backoff, and a typed error the clients can map.
//
// Policy used by every client in this folder: config problems (missing / rejected key) throw SourceError
// "CONFIG"; upstream trouble (5xx, timeouts, rate limits, bad payloads) is logged with console.warn and the
// client returns empty / null, so one flaky source never sinks a whole playbook run.

export const USER_AGENT = "Tablecast/1.0 (hackathon demo; contact antonmareo@gmail.com)";
export const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_BACKOFF_MS = 600;
/** A Retry-After longer than this is not worth waiting for inside a request: fail fast instead. */
const MAX_RETRY_AFTER_MS = 5_000;

export type SourceErrorCode = "CONFIG" | "UPSTREAM" | "TIMEOUT" | "RATE_LIMIT";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  /** HTTP status when the upstream answered. */
  readonly status?: number;
  readonly url?: string;

  constructor(code: SourceErrorCode, message: string, opts: { status?: number; url?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "SourceError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.url !== undefined) this.url = opts.url;
  }
}

export type FetchJsonOptions = {
  /** Per-attempt timeout. Default 12 s. */
  timeoutMs?: number;
  /** Extra attempts after the first (5xx / 429 / network only). Default 1, capped at 1. */
  retries?: number;
  /** Delay before the retry when the server gives no Retry-After. Default 600 ms. */
  backoffMs?: number;
  /** Awaited before every attempt (e.g. a per-host throttle). */
  beforeAttempt?: () => Promise<void>;
  /** Caller cancellation, combined with the timeout. */
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Strips query strings so API keys never end up in logs or error messages. */
export function redactUrl(url: string | URL): string {
  const s = String(url);
  const q = s.indexOf("?");
  return q === -1 ? s : `${s.slice(0, q)}?…`;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * GET/POST a JSON endpoint. Resolves the parsed body (null for an empty body, e.g. 204).
 * Throws SourceError: RATE_LIMIT (429), UPSTREAM (other non-2xx, network, unparseable JSON), TIMEOUT.
 * Timeouts are not retried, so a dead host costs at most one timeout.
 */
export async function fetchJson<T>(url: string | URL, init: RequestInit = {}, opts: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.min(1, opts.retries ?? 1));
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const safeUrl = redactUrl(url);
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let lastError: SourceError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.beforeAttempt) await opts.beforeAttempt();
    if (opts.signal?.aborted) throw new SourceError("UPSTREAM", `Request to ${safeUrl} was cancelled`, { url: safeUrl });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal });
    } catch (err) {
      if (timeout.aborted) throw new SourceError("TIMEOUT", `No response from ${safeUrl} within ${timeoutMs} ms`, { url: safeUrl, cause: err });
      if (opts.signal?.aborted) throw new SourceError("UPSTREAM", `Request to ${safeUrl} was cancelled`, { url: safeUrl, cause: err });
      lastError = new SourceError("UPSTREAM", `Network error calling ${safeUrl}: ${(err as Error)?.message ?? String(err)}`, { url: safeUrl, cause: err });
      if (attempt < retries) await sleep(backoffMs);
      continue;
    }

    if (res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        const code = timeout.aborted ? "TIMEOUT" : "UPSTREAM";
        throw new SourceError(code, `Failed reading the body from ${safeUrl}`, { url: safeUrl, status: res.status, cause: err });
      }
      if (!text.trim()) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new SourceError("UPSTREAM", `Invalid JSON from ${safeUrl}: ${text.slice(0, 120)}`, { url: safeUrl, status: res.status, cause: err });
      }
    }

    const body = await res.text().catch(() => "");
    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
    if (res.status === 429) {
      lastError = new SourceError("RATE_LIMIT", `Rate limited by ${safeUrl} (429)${snippet ? `: ${snippet}` : ""}`, { url: safeUrl, status: 429 });
      const wait = retryAfterMs(res);
      if (attempt >= retries || (wait !== null && wait > MAX_RETRY_AFTER_MS)) throw lastError;
      await sleep(wait ?? backoffMs);
      continue;
    }
    lastError = new SourceError("UPSTREAM", `${safeUrl} answered ${res.status}${snippet ? `: ${snippet}` : ""}`, { url: safeUrl, status: res.status });
    if (res.status < 500) throw lastError;
    if (attempt < retries) await sleep(backoffMs);
  }
  throw lastError ?? new SourceError("UPSTREAM", `Request to ${safeUrl} failed`, { url: safeUrl });
}

/** Logs a soft (non-config) failure in one consistent format before a client returns empty / null. */
export function warnSource(source: string, err: unknown): void {
  const msg = err instanceof SourceError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? String(err);
  console.warn(`[sources/${source}] ${msg}`);
}
