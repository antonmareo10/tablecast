// Source ledger: every piece of outside data the agent saw during a run (web pages and search
// results from Tavily, the forecast from Open-Meteo, venues from OpenStreetMap, events from
// Ticketmaster, holidays from Nager.Date, the owner's menu photo as read by Nemotron VL).
//
// Each source is cut into numbered sentences ("spans": S9.1, S9.2…). The writer supports a claim by
// citing span ids — it never types a quote — and the server fills in the exact text of each cited span.
// A claim is "verified" only if, deterministically:
//   1. every cited span exists in this run's sources;
//   2. every number in the claim's sentence appears in a cited span (or the lines right next to it: menus
//      put a dish, its price and its description on separate lines, so for menu and site pages the window is
//      the line before and the two after);
//   3. the cited spans say what the claim says: every content word of the claim (dish names, ingredients,
//      places, days…) appears in them, except at most one word in five (one, for claims of 4–9 words; none
//      for shorter ones). Connective words ("brings", "costs"), the restaurant's own name and street don't
//      count; "Wednesday" matches "Wed", "highs" matches "max", plurals match singulars.
// When a number or word is found only on a neighbouring line, that line is attached to the cite so the owner
// sees it. No model is asked whether a claim is true — code decides. (Older quote-style cites are still
// checked: the quote must appear word for word in the cited source.)

import type { Cite, Evidence, Source, SourceKind } from "./types";

/** Word-level normal form used for matching: accents folded, case and punctuation ignored. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2") // "Malai15.50" → "malai 15.50": a price glued to a name is still a number
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/(\d+)[.,](\d+)/g, (_m, a: string, b: string) => canonNumber(a, b)) // 6.2 / 6,2 → "6d2"; 142,00 → "142"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Numbers written with digits in a sentence, normalised the same way as the matcher. */
export function numbersIn(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/(\d+)(?:[.,](\d+))?/g)) out.add(m[2] ? canonNumber(m[1], m[2]) : m[1]);
  return [...out];
}

/** One token per decimal number, so "6.2" can't match "6 2"; trailing zeros dropped so "142,00" equals "142" and "37,50" equals "37.5". */
function canonNumber(int: string, frac: string): string {
  const f = frac.replace(/0+$/, "");
  return f ? `${int}d${f}` : int;
}

const STOP = new Set(
  "this that with from have will your their there they them what when which while where into over under about after before more most very also than then just only each such week weeks day days near nearby around guests guest restaurant restaurants menu menus dish dishes plan para pero como este esta estos estas desde hasta sobre entre cada todo toda todos todas muy mas menos porque cuando donde".split(
    " ",
  ),
);

/** Content words (4+ letters, not stopwords) and numbers of a text, for ranking related sentences. */
function contentTokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((w) => (/\d/.test(w) && w.length > 0) || (w.length >= 4 && !STOP.has(w))),
  );
}

// ---- coverage ------------------------------------------------------------------------------------

/** How many of a claim's content words may be missing from its cited sentences (see the header). */
export function allowedMissing(words: number, share = 0.2): number {
  return words >= 4 ? Math.max(1, Math.floor(words * share)) : 0;
}

// Words that connect facts rather than state them: a claim may use them without its source saying them.
const GENERIC = new Set(
  "brings bring expected expect shows show stays stay include includes including offers offer serves serve serving runs run opens open available current currently listed lists features featuring located starts start starting within away between through every other some both still today tonight morning afternoon evening night weekend weather forecast forecasts temperature temperatures chance likely roughly approximately sell sells sold cost costs priced price prices item items there here tiene tienen ofrece ofrecen sirve sirven abre abren precio precios cuesta cuestan prevision tiempo temperatura temperaturas probabilidad".split(
    " ",
  ),
);

// One form for words that sources and claims write differently.
const CANON: Record<string, string> = {
  monday: "mon", tuesday: "tue", tues: "tue", wednesday: "wed", thursday: "thu", thur: "thu", thurs: "thu", friday: "fri", saturday: "sat", sunday: "sun",
  lunes: "mon", martes: "tue", miercoles: "wed", jueves: "thu", viernes: "fri", sabado: "sat", domingo: "sun",
  january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul", august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec",
  enero: "jan", febrero: "feb", marzo: "mar", abril: "apr", mayo: "may", junio: "jun", julio: "jul", agosto: "aug", septiembre: "sep", setiembre: "sep", octubre: "oct", noviembre: "nov", diciembre: "dec",
  high: "max", highs: "max", maximum: "max", maxima: "max", low: "min", lows: "min", minimum: "min", minima: "min",
  rainfall: "rain", precipitation: "rain", showers: "rain", shower: "rain", lluvia: "rain", lluvias: "rain",
};
const SHORT_KEEP = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "max", "min", "rain"]);

/** Plural-insensitive form: "tomatoes" ~ "tomato", "croquetas" ~ "croqueta", "sauces" ~ "sauce". */
function stem(w: string): string {
  return w.replace(/ies$/, "y").replace(/s$/, "").replace(/e$/, "");
}

/** The words of a text that a citation has to back up, in comparable form, mapped back to how they were written. */
function coverageWords(s: string, ignore: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of normalizeText(s).split(" ")) {
    if (!raw || /\d/.test(raw)) continue;
    const w = CANON[raw] ?? raw;
    if (!SHORT_KEEP.has(w) && (w.length < 4 || STOP.has(w) || GENERIC.has(w))) continue;
    const key = stem(w);
    if (ignore.has(key)) continue;
    if (!out.has(key)) out.set(key, raw);
  }
  return out;
}

const MAX_SPAN = 240;

/**
 * Cuts a source's text into short, citable spans: one per line, long lines split into sentences, and
 * anything still too long split at a clause boundary or a word boundary. Deterministic, so span ids are stable.
 */
export function segment(text: string, max = MAX_SPAN): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑÜ0-9"“(¡¿])/)) {
      let rest = sentence.trim();
      while (rest.length > max) {
        const window = rest.slice(0, max);
        const cut = Math.max(window.lastIndexOf("; "), window.lastIndexOf(" · "), window.lastIndexOf(" | "), window.lastIndexOf(" — "), window.lastIndexOf(", "));
        const at = cut > max * 0.4 ? cut + 1 : window.lastIndexOf(" ") > max * 0.4 ? window.lastIndexOf(" ") : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) out.push(rest);
    }
  }
  return out;
}

const MIN_QUOTE_TOKENS = 2;
const MIN_QUOTE_CHARS = 6;

export type CiteCheck = { ok: true } | { ok: false; reason: string };

export class SourceLedger {
  private sources: Source[] = [];
  private byKey = new Map<string, Source>();
  private norm = new Map<string, string>();
  private spanCache = new Map<string, string[]>();
  private ignored = new Set<string>();
  /** Share of a claim's content words that may be missing from its cited sentences (calibrated in the eval). */
  missingShare = 0.2;

  /** Words a claim may use without its sources saying them: the restaurant's own name, its street and city. */
  ignoreWords(...texts: (string | null | undefined)[]): void {
    for (const t of texts) if (t) for (const key of coverageWords(t, new Set()).keys()) this.ignored.add(key);
  }

  /** Rebuild a ledger from a saved source list, keeping every id as it was. */
  static from(list: Source[]): SourceLedger {
    const l = new SourceLedger();
    for (const s of list) {
      const copy = { ...s };
      l.sources.push(copy);
      l.byKey.set(`${copy.kind}|${copy.url ?? copy.title}`, copy);
      if (copy.url) l.byKey.set(`url|${copy.url}`, copy);
      l.norm.set(copy.id, normalizeText(copy.text));
    }
    return l;
  }

  /**
   * Register a source and get its id. The same URL (or the same structured item) registered twice
   * keeps one id and accumulates text (search snippet first, then the full page).
   */
  add(src: Omit<Source, "id">): Source {
    const key = `${src.kind}|${src.url ?? src.title}`;
    const existing = this.byKey.get(key) ?? (src.url ? this.byKey.get(`url|${src.url}`) : undefined);
    if (existing) {
      if (src.text && !existing.text.includes(src.text)) {
        existing.text = `${existing.text}\n${src.text}`;
        this.norm.set(existing.id, normalizeText(existing.text));
        this.spanCache.delete(existing.id);
      }
      if (!existing.published && src.published) existing.published = src.published;
      return existing;
    }
    const source: Source = { ...src, id: `S${this.sources.length + 1}` };
    this.sources.push(source);
    this.byKey.set(key, source);
    if (src.url) this.byKey.set(`url|${src.url}`, source);
    this.norm.set(source.id, normalizeText(source.text));
    return source;
  }

  get(id: string): Source | undefined {
    const sid = id.trim().toUpperCase().split(".")[0];
    return this.sources.find((s) => s.id === sid);
  }

  list(): Source[] {
    return [...this.sources];
  }

  get size(): number {
    return this.sources.length;
  }

  countBy(kind: SourceKind): number {
    return this.sources.filter((s) => s.kind === kind).length;
  }

  // ---- spans --------------------------------------------------------------------------------

  spansOf(id: string): string[] {
    const src = this.get(id);
    if (!src) return [];
    let spans = this.spanCache.get(src.id);
    if (!spans) {
      spans = segment(src.text);
      this.spanCache.set(src.id, spans);
    }
    return spans;
  }

  /** "S9.4" → the 4th span of S9 (1-based), or null. */
  span(spanId: string): { source: Source; index: number; text: string } | null {
    const m = spanId.trim().toUpperCase().match(/^(S\d+)\.(\d+)$/);
    if (!m) return null;
    const source = this.get(m[1]);
    if (!source) return null;
    const index = Number(m[2]) - 1;
    const text = this.spansOf(source.id)[index];
    return text == null ? null : { source, index, text };
  }

  /**
   * The lines around a span that a claim may also draw on: the one before and the one after; for menu and
   * site pages, the one before and the two after (a dish, its price and its description often sit on
   * separate lines).
   */
  private window(spanId: string): { before: string[]; text: string; after: string[] } | null {
    const s = this.span(spanId);
    if (!s) return null;
    const all = this.spansOf(s.source.id);
    const n = s.source.kind === "menu" || s.source.kind === "site" ? 2 : 1;
    return { before: all.slice(Math.max(0, s.index - 1), s.index), text: s.text, after: all.slice(s.index + 1, s.index + 1 + n) };
  }

  /** A span plus its neighbours, as one text. */
  private spanWithNeighbours(spanId: string): string {
    const w = this.window(spanId);
    return w ? [...w.before, w.text, ...w.after].join(" ") : "";
  }

  /** Turn writer cites ({ span }) into display cites ({ source, span, quote = the span's exact text }). */
  resolve(e: Evidence): Evidence {
    return {
      ...e,
      cites: (e.cites ?? []).map((c) => {
        if (!c.span) return c;
        const s = this.span(c.span);
        return s ? { source: s.source.id, span: c.span.toUpperCase(), quote: s.text } : { source: c.span.split(".")[0].toUpperCase(), span: c.span, quote: "" };
      }),
    };
  }

  // ---- verification -------------------------------------------------------------------------

  checkCite(c: Cite): CiteCheck {
    if (c.span) return this.span(c.span) ? { ok: true } : { ok: false, reason: `unknown sentence ${c.span}` };
    const src = this.get(c.source ?? "");
    if (!src) return { ok: false, reason: `unknown source ${c.source}` };
    const q = normalizeText(c.quote ?? "");
    if (q.split(" ").filter(Boolean).length < MIN_QUOTE_TOKENS || q.length < MIN_QUOTE_CHARS) {
      return { ok: false, reason: "quote too short to check" };
    }
    if (!this.contains(src.id, c.quote ?? "")) return { ok: false, reason: `quote not found in ${src.id}` };
    return { ok: true };
  }

  /**
   * True if `quote` appears word for word in the source, either whole or as a run of verbatim fragments
   * (split at sentence punctuation or dashes) that each appear in that same source.
   */
  private contains(id: string, quote: string): boolean {
    const hay = ` ${this.norm.get(id) ?? ""} `;
    const q = normalizeText(quote);
    if (!q) return false;
    if (hay.includes(` ${q} `)) return true;
    const parts = quote
      .split(/[.;!?…]+(?=\s|$)|\s[–—-]\s|\.{3}/)
      .map((p) => normalizeText(p))
      .filter(Boolean);
    return parts.length > 1 && parts.every((p) => hay.includes(` ${p} `));
  }

  /** The text each cite stands on: its span (+ neighbours) for span cites, the whole source for quote cites. */
  private citedText(c: Cite): string {
    if (c.span) return this.spanWithNeighbours(c.span);
    return this.get(c.source ?? "")?.text ?? "";
  }

  /** Numbers in the claim's sentence that none of its cites contains. */
  missingNumbers(e: Evidence): string[] {
    const tokens = new Set(normalizeText((e.cites ?? []).map((c) => this.citedText(c)).join(" ")).split(" "));
    return numbersIn(e.text).filter((n) => !tokens.has(n));
  }

  /** The claim's content words (as written) that its cited sentences don't contain, and how many it has. */
  uncovered(e: Evidence): { missing: string[]; words: number } {
    const words = coverageWords(e.text, this.ignored);
    const cited = coverageWords((e.cites ?? []).map((c) => this.citedText(c)).join(" "), new Set());
    const missing = [...words].filter(([key]) => !cited.has(key)).map(([, raw]) => raw);
    return { missing, words: words.size };
  }

  /**
   * The neighbouring lines a span cite needed: those holding a number or word of the claim that the cited
   * span itself doesn't have. Shown to the owner next to the quote.
   */
  private neighboursUsed(c: Cite, claim: string, citedSpans: string): string[] {
    const w = c.span ? this.window(c.span) : null;
    if (!w) return [];
    // What every cited sentence already says (a claim citing Saturday and Sunday needs no neighbour for either).
    const own = normalizeText(citedSpans).split(" ");
    const ownWords = coverageWords(citedSpans, new Set());
    const nums = numbersIn(claim).filter((n) => !own.includes(n));
    const words = [...coverageWords(claim, this.ignored).keys()].filter((k) => !ownWords.has(k));
    if (!nums.length && !words.length) return [];
    return [...w.before, ...w.after].filter((line) => {
      const toks = normalizeText(line).split(" ");
      const lw = coverageWords(line, new Set());
      return nums.some((n) => toks.includes(n)) || words.some((k) => lw.has(k));
    });
  }

  /** Verify one claim (see the header of this file). */
  verifyEvidence(e: Evidence): Evidence {
    const resolved = this.resolve(e);
    const checks = resolved.cites.map((c) => ({ c, r: this.checkCite(c) }));
    const citedSpans = resolved.cites.map((c) => (c.span ? (this.span(c.span)?.text ?? "") : "")).join(" ");
    const cites: Cite[] = checks.map(({ c, r }) => {
      const context = r.ok ? this.neighboursUsed(c, e.text, citedSpans) : [];
      return { ...c, ok: r.ok, ...(context.length ? { context } : {}) };
    });
    let issue: string | undefined;
    if (cites.length === 0) issue = "no source cited";
    else {
      const bad = checks.find(({ r }) => !r.ok)?.r;
      if (bad && !bad.ok) issue = bad.reason;
    }
    if (!issue) {
      const missing = this.missingNumbers(resolved);
      if (missing.length) issue = `number${missing.length > 1 ? "s" : ""} ${missing.join(", ").replace(/d/g, ".")} not in the cited sentences`;
    }
    if (!issue && cites.some((c) => c.span)) {
      const { missing, words } = this.uncovered(resolved);
      if (missing.length > allowedMissing(words, this.missingShare))
        issue = `the cited sentences don't mention ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}`;
    }
    return { ...resolved, cites, verified: !issue, ...(issue ? { issue } : {}) };
  }

  verifyAll(list: Evidence[]): { items: Evidence[]; checked: number; verified: number } {
    const items = list.map((e) => this.verifyEvidence(e));
    return { items, checked: items.length, verified: items.filter((e) => e.verified).length };
  }

  /** True if a menu or site source has `name` on a line with `price` on it or on a neighbouring line. */
  hasPriceFor(name: string, price: number): boolean {
    const n = normalizeText(name);
    const p = numbersIn(String(price));
    if (!n || !p.length) return false;
    for (const s of this.sources) {
      if (s.kind !== "menu" && s.kind !== "site") continue;
      const spans = this.spansOf(s.id);
      for (let i = 0; i < spans.length; i++) {
        if (!` ${normalizeText(spans[i])} `.includes(` ${n} `)) continue;
        const near = normalizeText([spans[i - 1], spans[i], spans[i + 1]].filter(Boolean).join(" ")).split(" ");
        if (p.every((x) => near.includes(x))) return true;
      }
    }
    return false;
  }

  // ---- helpers for the repair pass ------------------------------------------------------------

  /** Span ids whose text best matches `text` (shared content words; numbers weigh more), best first. */
  relatedSpans(text: string, k = 5, exclude: string[] = []): string[] {
    const want = contentTokens(text);
    if (!want.size) return [];
    const scored: { id: string; score: number }[] = [];
    for (const s of this.sources) {
      this.spansOf(s.id).forEach((t, i) => {
        const id = `${s.id}.${i + 1}`;
        if (exclude.includes(id)) return;
        let score = 0;
        for (const w of contentTokens(t)) if (want.has(w)) score += /\d/.test(w) ? 3 : 1;
        if (score > 0) scored.push({ id, score });
      });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.id);
  }

  /** Span ids that contain any of the given numbers (normalised form), most matches first. */
  spansWithNumbers(nums: string[], k = 4, exclude: string[] = []): string[] {
    if (!nums.length) return [];
    const scored: { id: string; hits: number }[] = [];
    for (const s of this.sources) {
      this.spansOf(s.id).forEach((t, i) => {
        const id = `${s.id}.${i + 1}`;
        if (exclude.includes(id)) return;
        const toks = new Set(normalizeText(t).split(" "));
        const hits = nums.filter((n) => toks.has(n)).length;
        if (hits) scored.push({ id, hits });
      });
    }
    return scored
      .sort((a, b) => b.hits - a.hits)
      .slice(0, k)
      .map((x) => x.id);
  }

  /**
   * Legacy quote mode: a cite whose quote is word for word in a different source than the one it names
   * is pointed at that source. Returns how many cites moved. (Span cites never need this.)
   */
  reattribute(list: Evidence[]): number {
    let moved = 0;
    for (const e of list) {
      for (const c of e.cites ?? []) {
        if (c.span || this.checkCite(c).ok) continue;
        const q = c.quote ?? "";
        if (normalizeText(q).split(" ").filter(Boolean).length < MIN_QUOTE_TOKENS) continue;
        const found = this.sources.find((s) => this.contains(s.id, q))?.id;
        if (found && found !== c.source) {
          c.source = found;
          moved += 1;
        }
      }
    }
    return moved;
  }

  /** Sources rendered for a prompt: a header, then numbered spans up to `maxChars` of text. */
  forPrompt(maxCharsFor: (s: Source) => number): string {
    return this.sources
      .map((s) => {
        const lines: string[] = [];
        let used = 0;
        for (const [i, t] of this.spansOf(s.id).entries()) {
          if (used > maxCharsFor(s)) break;
          lines.push(`${s.id}.${i + 1} ${t}`);
          used += t.length;
        }
        return `[${s.id}] ${s.provider} · ${s.kind} · ${s.title}${s.url ? ` · ${s.url}` : ""}${s.published ? ` · published ${s.published}` : ""}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }
}
