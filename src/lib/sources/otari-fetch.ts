// Otari's web fetch, used to read a page when Tablecast's own reader can't (a PDF menu, a page that refuses it).
//
// Otari has a direct search endpoint but no direct fetch endpoint, and on Chat Completions its fetch reports only the
// URL it read. On the Messages API, though, a gateway-run fetch comes back as a web_fetch_tool_result block holding the
// extracted text, so the app asks for one fetch in a one-turn Messages request (Otari-Web-Fetch: otari) and keeps the
// text of that block, exactly as Otari's fetcher extracted it. The model's own reply is ignored.

import { currentRun, otariFetch, costOf, servedFrom, type Served } from "../otari";
import { recordLocalSpend } from "../otari-ledger";
import { focusText } from "./reader";

export const FETCH_MODEL = process.env.OTARI_FETCH_MODEL || "tablecast-check";

type Block = {
  type: string;
  content?: { type?: string; url?: string; error_code?: string; content?: { source?: { data?: string; media_type?: string } }; retrieved_at?: string };
};

export type FetchedPage = { url: string; text: string; served: Served; ms: number };

/** Reads `url` with Otari's web fetch. Throws when Otari fetched nothing usable. */
export async function otariFetchPage(url: string, opts: { focus?: string; maxChars?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FetchedPage> {
  const t0 = Date.now();
  const run = currentRun();
  const res = await otariFetch("/v1/messages", {
    body: {
      model: FETCH_MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: `Fetch ${url} with the web_fetch tool, then reply with the single word OK.` }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }],
      tool_choice: { type: "tool", name: "web_fetch" },
      metadata: { ...(run?.endUser ? { user_id: run.endUser } : {}) },
    },
    headers: { "anthropic-version": "2023-06-01", "otari-web-fetch": "otari" },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 40_000,
  });
  const data = (await res.json()) as { content?: Block[]; usage?: unknown };
  const served = servedFrom(res.headers);
  const { cost } = costOf(data.usage);
  if (cost != null) served.cost_usd = cost;
  recordLocalSpend({ path: "/v1/messages", role: "fetch", model: FETCH_MODEL, request_id: served.request_id, cost_usd: cost ?? null, ...(cost == null ? { estimate_usd: 0.012 } : {}) });
  const block = (data.content ?? []).find((b) => b.type === "web_fetch_tool_result");
  const text = block?.content?.content?.source?.data?.trim() ?? "";
  if (!block || block.content?.type !== "web_fetch_result" || text.length < 40)
    throw new Error(block?.content?.error_code ? `Otari's fetch failed (${block.content.error_code})` : "Otari's fetch returned no text");
  return { url: block.content.url ?? url, text: focusText(text, opts.focus, opts.maxChars ?? 12_000), served, ms: Date.now() - t0 };
}
