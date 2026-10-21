// Tavily web search + page extraction (https://docs.tavily.com, API reference checked 20-Oct-2026).
// Key from TAVILY_API_KEY, Bearer auth. Every call asks for `include_usage` so runs can report credits:
// search basic = 1 credit, advanced = 2; extract basic = 1 credit per 5 successful URLs, advanced = 2 per 5;
// map = 1 credit per 10 pages returned (2 with instructions).
// Missing / rejected key and exhausted plan (401, 403, 432, 433) throw SourceError CONFIG; any other
// failure returns an empty result (logged).

import { fetchJson, SourceError, warnSource } from "./http";
import { cleanText } from "./format";

const TAVILY_API = "https://api.tavily.com";
const MAX_SEARCH_CONTENT = 2_000;
const MAX_EXTRACT_CONTENT = 6_000;
const EXTRACT_BATCH = 20; // API limit: 1–20 URLs per request

export type TavilySearchOptions = {
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month";
  /** ISO 3166-1 alpha-2 ("ES") or Tavily's lowercase English name ("spain"). Only used with topic "general". */
  country?: string;
  /** 0–20, default 5. */
  maxResults?: number;
  depth?: "basic" | "advanced";
  includeDomains?: string[];
  includeAnswer?: boolean;
};

export type TavilySearchResult = { title: string; url: string; content: string; score?: number; published_date?: string };
export type TavilySearchResponse = { answer: string | null; results: TavilySearchResult[]; credits: number | null };

export type TavilyExtractOptions = {
  /** Reranks extracted chunks by relevance to this intent. */
  query?: string;
  /** 1–5 chunks per page; only applies with `query`. */
  chunksPerSource?: number;
  depth?: "basic" | "advanced";
};
export type TavilyExtractResponse = { results: { url: string; content: string }[]; failed: string[]; credits: number | null };

function apiKey(): string {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) throw new SourceError("CONFIG", "TAVILY_API_KEY is not configured");
  return key;
}

const ACCOUNT_ERRORS: Record<number, string> = {
  401: "TAVILY_API_KEY was rejected (401)",
  403: "TAVILY_API_KEY is not allowed to call this endpoint (403)",
  432: "Tavily plan credit limit reached (432)",
  433: "Tavily pay-as-you-go limit reached (433)",
};

async function post<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  try {
    return await fetchJson<T>(
      `${TAVILY_API}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
      },
      { timeoutMs },
    );
  } catch (err) {
    if (err instanceof SourceError && err.status != null && ACCOUNT_ERRORS[err.status]) {
      throw new SourceError("CONFIG", ACCOUNT_ERRORS[err.status], { status: err.status, cause: err });
    }
    throw err;
  }
}

/** Tavily wants a lowercase English country name; accept ISO codes too. */
export function tavilyCountry(country: string | undefined): string | undefined {
  const c = cleanText(country).toLowerCase();
  if (!c) return undefined;
  if (!/^[a-z]{2}$/.test(c)) return c;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(c.toUpperCase());
    return name && name.toLowerCase() !== c ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts long text at a word boundary near `max` (never splitting a surrogate pair). */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const ws = cut.search(/\s\S*$/);
  if (ws > max - 200) cut = cut.slice(0, ws);
  return cut.trimEnd();
}

const credits = (usage: unknown): number | null => {
  const c = (usage as { credits?: unknown } | undefined)?.credits;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
};

type RawSearch = {
  answer?: string | null;
  results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string | null }>;
  usage?: { credits?: number };
};

export async function search(query: string, opts: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
  apiKey(); // config errors surface even for empty queries
  const q = cleanText(query);
  const empty: TavilySearchResponse = { answer: null, results: [], credits: null };
  if (!q) return empty;
  const topic = opts.topic ?? "general";
  const maxResults = Math.max(0, Math.min(20, Math.round(opts.maxResults ?? 5)));
  const body: Record<string, unknown> = {
    query: q,
    topic,
    search_depth: opts.depth ?? "basic",
    max_results: maxResults,
    include_answer: opts.includeAnswer ? "basic" : false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  };
  if (opts.timeRange) body.time_range = opts.timeRange;
  const country = topic === "general" ? tavilyCountry(opts.country) : undefined;
  if (country) body.country = country;
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  const timeoutMs = opts.depth === "advanced" ? 25_000 : 15_000;

  let data: RawSearch | null;
  try {
    data = await post<RawSearch>("/search", body, timeoutMs);
  } catch (err) {
    if (err instanceof SourceError && err.code === "CONFIG") throw err;
    // Tavily's country enum does not cover every ISO name (e.g. "czechia"): retry once without it.
    if (err instanceof SourceError && err.status === 400 && body.country) {
      delete body.country;
      try {
        data = await post<RawSearch>("/search", body, timeoutMs);
      } catch (err2) {
        if (err2 instanceof SourceError && err2.code === "CONFIG") throw err2;
        warnSource("tavily/search", err2);
        return empty;
      }
    } else {
      warnSource("tavily/search", err);
      return empty;
    }
  }

  const results: TavilySearchResult[] = [];
  for (const r of data?.results ?? []) {
    if (!r.url) continue;
    results.push({
      title: cleanText(r.title) || r.url,
      url: r.url,
      content: truncateText(cleanText(r.content), MAX_SEARCH_CONTENT),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      ...(r.published_date ? { published_date: r.published_date } : {}),
    });
  }
  return {
    answer: typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : null,
    results: results.slice(0, maxResults),
    credits: credits(data?.usage),
  };
}

type RawExtract = {
  results?: Array<{ url?: string; raw_content?: string | null }>;
  failed_results?: Array<{ url?: string; error?: string }>;
  usage?: { credits?: number };
};

/** Clean text of up to 20 pages per request (larger lists are batched), each cut to ~6,000 chars. */
export async function extract(urls: string[], opts: TavilyExtractOptions = {}): Promise<TavilyExtractResponse> {
  apiKey();
  const failed: string[] = [];
  const valid: string[] = [];
  for (const u of urls) {
    const s = cleanText(u);
    if (!s) continue;
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(s).protocol);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(s);
    else if (!valid.includes(s)) valid.push(s);
  }

  const results: { url: string; content: string }[] = [];
  let total: number | null = null;
  const query = cleanText(opts.query);
  for (let i = 0; i < valid.length; i += EXTRACT_BATCH) {
    const batch = valid.slice(i, i + EXTRACT_BATCH);
    const body: Record<string, unknown> = {
      urls: batch,
      extract_depth: opts.depth ?? "basic",
      format: "text",
      include_images: false,
      include_usage: true,
    };
    if (query) {
      body.query = query;
      if (opts.chunksPerSource != null) body.chunks_per_source = Math.max(1, Math.min(5, Math.round(opts.chunksPerSource)));
    }
    let data: RawExtract | null;
    try {
      data = await post<RawExtract>("/extract", body, opts.depth === "advanced" ? 40_000 : 20_000);
    } catch (err) {
      if (err instanceof SourceError && err.code === "CONFIG") throw err;
      warnSource("tavily/extract", err);
      failed.push(...batch);
      continue;
    }
    const got = new Set<string>();
    for (const r of data?.results ?? []) {
      const content = truncateText((r.raw_content ?? "").trim(), MAX_EXTRACT_CONTENT);
      if (!r.url || !content) continue;
      got.add(r.url);
      results.push({ url: r.url, content });
    }
    for (const f of data?.failed_results ?? []) if (f.url && !got.has(f.url)) failed.push(f.url);
    const c = credits(data?.usage);
    if (c != null) total = (total ?? 0) + c;
  }
  return { results, failed: [...new Set(failed)], credits: total };
}

export type TavilyMapOptions = {
  /** Natural-language guidance for which pages matter, e.g. "menu, carta, food and drink pages". Doubles the credit rate. */
  instructions?: string;
  maxDepth?: number; // 1-5, default 1
  /** Links followed per page, 1-500. Tavily's default is 20: a home page's first 20 links, often nav and shop. */
  maxBreadth?: number;
  limit?: number; // links processed in total before the crawl stops, default 30
  /** Regexes on the URL path: only matching pages are returned — and billed (1 credit per 10 pages returned). */
  selectPaths?: string[];
  timeoutMs?: number;
};
/** `error` says why the map came back empty when it failed (upstream, timeout…); config errors throw instead. */
export type TavilyMapResponse = { urls: string[]; credits: number | null; error?: string };

type RawMap = { base_url?: string; results?: unknown[]; usage?: { credits?: number } };

/** The page URLs of a Map response: plain strings (the documented shape) or `{ url }` objects. */
export function mapUrls(data: RawMap | null | undefined): string[] {
  const urls: string[] = [];
  for (const r of data?.results ?? []) {
    const u = typeof r === "string" ? r : typeof (r as { url?: unknown } | null)?.url === "string" ? (r as { url: string }).url : null;
    if (u && /^https?:\/\//i.test(u.trim())) urls.push(u.trim());
  }
  return [...new Set(urls)];
}

/**
 * Tavily Map: the URLs of a site, so the agent can find the menu page instead of guessing it.
 * Same-domain only (no external links). Empty list, with the reason in `error`, on any non-config failure.
 */
export async function map(url: string, opts: TavilyMapOptions = {}): Promise<TavilyMapResponse> {
  apiKey();
  let root: URL;
  try {
    root = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return { urls: [], credits: null, error: `not a URL: ${url.slice(0, 80)}` };
  }
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const body: Record<string, unknown> = {
    url: root.toString(),
    max_depth: Math.max(1, Math.min(5, Math.round(opts.maxDepth ?? 1))),
    limit: Math.max(1, Math.min(500, Math.round(opts.limit ?? 30))),
    allow_external: false,
    include_usage: true,
    // Tavily's own time limit (10-150 s), a little under ours so it answers before we give up.
    timeout: Math.max(10, Math.min(150, Math.round(timeoutMs / 1000) - 3)),
  };
  if (opts.maxBreadth != null) body.max_breadth = Math.max(1, Math.min(500, Math.round(opts.maxBreadth)));
  if (opts.selectPaths?.length) body.select_paths = opts.selectPaths;
  const instructions = cleanText(opts.instructions);
  if (instructions) body.instructions = instructions;
  try {
    const data = await post<RawMap>("/map", body, timeoutMs);
    return { urls: mapUrls(data), credits: credits(data?.usage) };
  } catch (err) {
    if (err instanceof SourceError && err.code === "CONFIG") throw err;
    warnSource("tavily/map", err);
    const msg = err instanceof SourceError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? String(err);
    return { urls: [], credits: null, error: msg.slice(0, 200) };
  }
}
