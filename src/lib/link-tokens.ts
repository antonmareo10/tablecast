// The two links that open live runs on a public deployment: the owner's (?live=<LIVE_RUNS_TOKEN>) and the judges'
// (?judge=<JUDGE_LINK_TOKEN>). The page keeps the token for the tab (sessionStorage) and takes it out of the address
// bar at once, so it doesn't show in a screen recording, a screenshot or the browser's history of the page.

export const LINK_TOKENS = [
  { param: "live", storage: "tablecast-live", header: "x-tablecast-live" },
  { param: "judge", storage: "tablecast-judge", header: "x-tablecast-judge" },
] as const;

/** The tokens an address carries, and the same address without them (null when it carries none). */
export function splitLinkTokens(href: string): { tokens: Partial<Record<"live" | "judge", string>>; clean: string | null } {
  const url = new URL(href);
  const tokens: Partial<Record<"live" | "judge", string>> = {};
  for (const t of LINK_TOKENS) {
    const v = url.searchParams.get(t.param);
    if (v) tokens[t.param] = v;
    url.searchParams.delete(t.param);
  }
  const changed = Object.keys(tokens).length > 0 || new URL(href).search !== url.search;
  return { tokens, clean: changed ? `${url.pathname}${url.search}${url.hash}` : null };
}

/** Keeps the tokens of the page's address for this tab and takes them out of the address bar. Browser only. */
export function captureLinkTokens(): void {
  try {
    const { tokens, clean } = splitLinkTokens(window.location.href);
    for (const t of LINK_TOKENS) if (tokens[t.param]) sessionStorage.setItem(t.storage, tokens[t.param]!);
    if (clean != null) window.history.replaceState(window.history.state, "", clean);
  } catch {
    /* storage blocked: the token then only lives in the address bar, as before */
  }
}

/** The headers a live run sends: whichever link tokens this tab has. */
export function linkTokenHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const { tokens } = splitLinkTokens(window.location.href);
    for (const t of LINK_TOKENS) {
      const v = tokens[t.param] ?? sessionStorage.getItem(t.storage);
      if (v) headers[t.header] = v;
    }
  } catch {
    /* no storage: nothing to send */
  }
  return headers;
}
