// Source ledger: every piece of outside data the agent saw during a run (web pages and search
// results from Tavily, the forecast from Open-Meteo, venues from OpenStreetMap, events from
// Ticketmaster, holidays from Nager.Date, the owner's menu photo as read by Nemotron VL).
//
// The model may only support a claim by citing a source id plus a verbatim quote from it. The
// server then checks, deterministically, that (1) the source exists in this run, (2) the quote
// appears word for word in that source's text, and (3) every number in the claim's sentence
// appears in the text of a source it cites. A claim is "verified" only if all three hold.
// No model is asked whether a claim is true — code decides.

import type { Cite, Evidence, Source, SourceKind } from "./types";

/** Word-level normal form used for quote matching: accents folded, case and punctuation ignored. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, "$1d$2") // keep 6.2 / 6,2 as one token ("6d2") so it can't match "6 2"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Numbers written with digits in a sentence, normalised the same way as the quote matcher. */
export function numbersIn(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(/[.,]/, "d"));
  return [...out];
}

const MIN_QUOTE_TOKENS = 2;
const MIN_QUOTE_CHARS = 6;

export type CiteCheck = { ok: true } | { ok: false; reason: string };

export class SourceLedger {
  private sources: Source[] = [];
  private byKey = new Map<string, Source>();
  private norm = new Map<string, string>();

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
   * keeps one id and accumulates text, so a quote from the search snippet or from the full page
   * both verify against it.
   */
  add(src: Omit<Source, "id">): Source {
    const key = `${src.kind}|${src.url ?? src.title}`;
    const existing = this.byKey.get(key) ?? (src.url ? this.byKey.get(`url|${src.url}`) : undefined);
    if (existing) {
      if (src.text && !existing.text.includes(src.text)) {
        existing.text = `${existing.text}\n${src.text}`;
        this.norm.set(existing.id, normalizeText(existing.text));
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
    return this.sources.find((s) => s.id === id.trim().toUpperCase());
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

  checkCite(c: Cite): CiteCheck {
    const src = this.get(c.source ?? "");
    if (!src) return { ok: false, reason: `unknown source ${c.source}` };
    const q = normalizeText(c.quote ?? "");
    if (q.split(" ").filter(Boolean).length < MIN_QUOTE_TOKENS || q.length < MIN_QUOTE_CHARS) {
      return { ok: false, reason: "quote too short to check" };
    }
    const hay = ` ${this.norm.get(src.id) ?? ""} `;
    if (!hay.includes(` ${q} `)) return { ok: false, reason: `quote not found in ${src.id}` };
    return { ok: true };
  }

  /** Verify one claim: every cite checks out, and every number in the sentence is in a cited source. */
  verifyEvidence(e: Evidence): Evidence {
    const checks = (e.cites ?? []).map((c) => ({ c, r: this.checkCite(c) }));
    const cites = checks.map(({ c, r }) => ({ ...c, ok: r.ok }));
    let issue: string | undefined;
    if (cites.length === 0) issue = "no source cited";
    else {
      const bad = checks.find(({ r }) => !r.ok)?.r;
      if (bad && !bad.ok) issue = bad.reason;
    }
    if (!issue) {
      const cited = cites.map((c) => this.norm.get(this.get(c.source)?.id ?? "") ?? "").join(" ");
      const tokens = new Set(cited.split(" "));
      const missing = numbersIn(e.text).filter((n) => !tokens.has(n));
      if (missing.length) issue = `number${missing.length > 1 ? "s" : ""} ${missing.join(", ").replace(/d/g, ".")} not in the cited sources`;
    }
    return { ...e, cites, verified: !issue, ...(issue ? { issue } : {}) };
  }

  verifyAll(list: Evidence[]): { items: Evidence[]; checked: number; verified: number } {
    const items = list.map((e) => this.verifyEvidence(e));
    return { items, checked: items.length, verified: items.filter((e) => e.verified).length };
  }

  /**
   * The part of a source most likely meant by a failed quote (best word overlap), so a repair
   * step can copy the exact wording. Returns the original text, not the normalised one.
   */
  excerpt(id: string, quote: string, width = 360): string {
    const src = this.get(id);
    if (!src) return "";
    const text = src.text;
    if (text.length <= width) return text;
    const words = new Set(normalizeText(quote).split(" ").filter((w) => w.length > 2 || /\d/.test(w)));
    let best = 0;
    let bestAt = 0;
    const step = Math.max(40, Math.floor(width / 3));
    for (let at = 0; at < text.length; at += step) {
      const win = normalizeText(text.slice(at, at + width)).split(" ");
      let score = 0;
      for (const w of win) if (words.has(w)) score += 1;
      if (score > best) {
        best = score;
        bestAt = at;
      }
    }
    return text.slice(bestAt, bestAt + width);
  }

  /** The first source whose text contains `quote` word for word (null if none, or if the quote is too short). */
  findQuote(quote: string): string | null {
    const q = normalizeText(quote);
    if (q.split(" ").filter(Boolean).length < MIN_QUOTE_TOKENS || q.length < MIN_QUOTE_CHARS) return null;
    for (const s of this.sources) if (` ${this.norm.get(s.id) ?? ""} `.includes(` ${q} `)) return s.id;
    return null;
  }

  /**
   * A cite whose quote is not in the source it names, but IS word for word in another source fetched in
   * this run, is pointed at that source (the model copied the right words and mislabelled the id).
   * Returns how many cites were re-attributed. The claim still has to pass verifyEvidence afterwards.
   */
  reattribute(list: Evidence[]): number {
    let moved = 0;
    for (const e of list) {
      for (const c of e.cites ?? []) {
        if (this.checkCite(c).ok) continue;
        const found = this.findQuote(c.quote ?? "");
        if (found && found !== c.source) {
          c.source = found;
          moved += 1;
        }
      }
    }
    return moved;
  }

  /** Numbers in the claim's sentence that none of its cited sources contains. */
  missingNumbers(e: Evidence): string[] {
    const cited = (e.cites ?? []).map((c) => this.norm.get(this.get(c.source ?? "")?.id ?? "") ?? "").join(" ");
    const tokens = new Set(cited.split(" "));
    return numbersIn(e.text).filter((n) => !tokens.has(n));
  }

  /** Sources that contain the given numbers (normalised form), most matches first. */
  withNumbers(nums: string[], k = 3, exclude: string[] = []): string[] {
    if (!nums.length) return [];
    return this.sources
      .filter((s) => !exclude.includes(s.id))
      .map((s) => {
        const toks = new Set((this.norm.get(s.id) ?? "").split(" "));
        return { id: s.id, hits: nums.filter((n) => toks.has(n)).length };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, k)
      .map((x) => x.id);
  }

  /** Sources whose text shares the most words with `text` (for repair prompts), best first. */
  related(text: string, k = 2, exclude: string[] = []): string[] {
    const words = new Set(normalizeText(text).split(" ").filter((w) => w.length > 3 || /\d/.test(w)));
    if (!words.size) return [];
    return this.sources
      .filter((s) => !exclude.includes(s.id))
      .map((s) => {
        const toks = new Set((this.norm.get(s.id) ?? "").split(" "));
        let score = 0;
        for (const w of words) if (toks.has(w)) score += /\d/.test(w) ? 3 : 1;
        return { id: s.id, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.id);
  }

  /** Compact "id — provider · title · url" lines plus text, for prompts. */
  forPrompt(maxCharsPerSource = 900): string {
    return this.sources
      .map((s) => `[${s.id}] ${s.provider} · ${s.kind} · ${s.title}${s.url ? ` · ${s.url}` : ""}${s.published ? ` · ${s.published}` : ""}\n${s.text.slice(0, maxCharsPerSource)}`)
      .join("\n\n");
  }
}
