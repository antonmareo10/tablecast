// Web search through Otari's direct search API (POST /v1/search), which runs the search tool the workspace is
// configured with and bills the call to the restaurant (the `user` field on a service key).
//
// The app calls it itself, rather than letting the model use Otari's in-loop otari_web_search, because every result
// becomes a numbered source whose exact text the verifier checks claims against, and only the direct API returns
// that text (`snippet` is the page text when the provider gives it, else its excerpt).

import { currentRun, otariJSON, type Served } from "../otari";

export type SearchHit = { title: string; url: string; content: string; published_date?: string };
export type SearchOutcome = { results: SearchHit[]; tool?: string; served: Served; ms: number };

type OtariSearchResponse = {
  object?: string;
  search_tool?: string;
  results?: { title?: string; url?: string; snippet?: string; date?: string | null }[];
};

export async function otariSearch(
  query: string,
  opts: { maxResults?: number; country?: string; domains?: string[]; maxTokensPerPage?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SearchOutcome> {
  const t0 = Date.now();
  const run = currentRun();
  const { data, served } = await otariJSON<OtariSearchResponse>("/v1/search", {
    role: "search",
    body: {
      query: query.slice(0, 400),
      max_results: opts.maxResults ?? 5,
      ...(opts.country && /^[a-z]{2}$/i.test(opts.country) ? { country: opts.country.toUpperCase() } : {}),
      ...(opts.domains?.length ? { search_domain_filter: opts.domains.slice(0, 20) } : {}),
      max_tokens_per_page: opts.maxTokensPerPage ?? 600,
      ...(run?.endUser ? { user: run.endUser } : {}),
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 20_000,
    holdUsd: 0.01,
  });
  const results: SearchHit[] = [];
  for (const r of data.results ?? []) {
    if (!r.url || !/^https?:\/\//i.test(r.url)) continue;
    const content = (r.snippet ?? "").trim();
    if (!content) continue;
    results.push({ title: (r.title ?? "").trim() || r.url, url: r.url, content, ...(r.date ? { published_date: r.date } : {}) });
  }
  return { results, tool: data.search_tool, served, ms: Date.now() - t0 };
}

/** News results dated more than `days` before `today` (YYYY-MM-DD) are not "this week". Undated results stay. */
export function recentEnough(hit: SearchHit, today: string, days = 14): boolean {
  if (!hit.published_date) return true;
  const t = Date.parse(hit.published_date);
  if (!Number.isFinite(t)) return true;
  return Date.parse(`${today}T00:00:00Z`) - t <= days * 86_400_000;
}
