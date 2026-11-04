// Tablecast's own page reader: fetches one public web page and keeps its readable text, exactly as the page has it.
//
// Every claim in a plan is checked against the exact text of the sources it cites, so the app needs that text itself.
// Otari's in-loop web fetch gives the page to the model but reports back only its URL, which is why this reader exists:
// it is what the Tablecast MCP server (src/lib/mcp-server.ts) serves to the research model through Otari, and what the
// app calls in-process when no MCP server is configured. It also lists a site's links for the menu-page finder.
//
// Safety: http(s) only, public hosts only (every redirect hop is resolved and checked, at most 5), a 10 s deadline,
// at most 3 MB read, HTML and text only. Page text is data: nothing here follows instructions in it.

import { lookup } from "node:dns/promises";
import net from "node:net";

const UA = "Mozilla/5.0 (compatible; Tablecast/0.8; +https://github.com/antonmareo10/tablecast)";
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ReaderError extends Error {
  readonly kind: "blocked" | "http" | "type" | "network" | "empty";
  readonly status?: number;
  constructor(kind: ReaderError["kind"], message: string, status?: number) {
    super(message);
    this.name = "ReaderError";
    this.kind = kind;
    this.status = status;
  }
}

// ---- Address safety ------------------------------------------------------------------------------

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses, in v4 or v6 form. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Throws unless `url` is http(s) on a host that resolves only to public addresses. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ReaderError("blocked", `only http(s) pages can be read (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new ReaderError("blocked", "private host");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new ReaderError("blocked", "private address");
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new ReaderError("network", `could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ReaderError("blocked", "host resolves to a private address");
}

// ---- Fetch ---------------------------------------------------------------------------------------

export type Fetched = { url: string; contentType: string; body: string };

/** GET a public page, following redirects by hand so each hop is checked. */
export async function safeFetch(rawUrl: string, opts: { timeoutMs?: number; signal?: AbortSignal; accept?: string } = {}): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ReaderError("blocked", "not a valid URL");
  }
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": UA,
          accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "en,es;q=0.8,*;q=0.5",
        },
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new ReaderError("network", deadline.aborted ? "the page did not answer in time" : "could not reach the page");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ReaderError("http", `redirect without a location (${res.status})`, res.status);
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) throw new ReaderError("http", `the page answered ${res.status}`, res.status);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (/pdf/.test(contentType)) throw new ReaderError("type", "the page is a PDF, which this reader does not open");
    if (contentType && !/html|text|xml|json/.test(contentType)) throw new ReaderError("type", `not a text page (${contentType.split(";")[0]})`);
    const body = await readCapped(res, MAX_BYTES);
    return { url: url.toString(), contentType, body };
  }
  throw new ReaderError("http", "too many redirects");
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - off));
    all.set(part, off);
    off += part.length;
    if (off >= all.length) break;
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8").decode(all);
  } catch {
    return new TextDecoder("utf-8").decode(all);
  }
}

// ---- HTML to text --------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  trade: "™",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  times: "×",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  iacute: "í",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  uacute: "ú",
  ugrave: "ù",
  ntilde: "ñ",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  iexcl: "¡",
  iquest: "¿",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const DROP_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer", "aside", "form", "button", "select", "dialog"];
const BLOCK = /<\/?(p|div|li|ul|ol|dl|dd|dt|h[1-6]|tr|table|thead|tbody|section|article|header|main|blockquote|pre|figure|figcaption|address|hr)\b[^>]*>/gi;

function stripBlocks(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_BLOCKS) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "\n");
  return s;
}

function tagsToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(BLOCK, "\n")
      .replace(/<\/(td|th)\s*>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  );
}

function tidyLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/[  -​\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s|]+|[\s|]+$/g, "")
      .trim();
    if (!line || /^[|·•\-–—_*]+$/.test(line)) continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

/** The page's title and readable text, preferring its <main> or <article> when that holds the content. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = tidyLines(decodeEntities((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " "))).join(" ").slice(0, 200);
  const stripped = stripBlocks(html);
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(stripped)?.[1] ?? stripped;
  const whole = tidyLines(tagsToText(body)).join("\n");
  for (const tag of ["main", "article"]) {
    const parts = [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))].map((m) => tidyLines(tagsToText(m[1])).join("\n"));
    const joined = parts.join("\n").trim();
    if (joined.length >= 400 && joined.length >= whole.length * 0.3) return { title, text: joined };
  }
  return { title, text: whole };
}

// ---- Focus: keep the relevant part of a long page ---------------------------------------------------

const MONEY = /(?:[$€£¥]\s?\d|\d(?:[.,]\d{1,2})?\s?(?:€|eur|usd|gbp|\$|£)|\b\d{1,3}[.,]\d{2}\b)/i;

/**
 * A long page is cut to the windows of lines that best match `focus` (and, for menus, lines with prices), kept in the
 * page's order, up to `maxChars`. Short pages come back whole.
 */
export function focusText(text: string, focus: string | undefined, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const words = (focus ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  const menuish = /menu|dish|price|carta|plato|precio/i.test(focus ?? "");
  const WINDOW = 12;
  const windows: { start: number; score: number; len: number }[] = [];
  for (let start = 0; start < lines.length; start += WINDOW) {
    const chunk = lines.slice(start, start + WINDOW);
    const lower = chunk.join(" ").toLowerCase();
    let score = words.reduce((n, w) => n + (lower.split(w).length - 1), 0);
    if (menuish) score += chunk.filter((l) => MONEY.test(l)).length * 2;
    windows.push({ start, score, len: chunk.join("\n").length + 1 });
  }
  const picked = new Set<number>();
  let used = 0;
  for (const w of [...windows].sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (used + w.len > maxChars) continue;
    picked.add(w.start);
    used += w.len;
  }
  return windows
    .filter((w) => picked.has(w.start))
    .map((w) => lines.slice(w.start, w.start + WINDOW).join("\n"))
    .join("\n[...]\n");
}

// ---- The two things the reader does --------------------------------------------------------------------

export type ReadPage = { url: string; title: string; text: string; chars: number; truncated: boolean };

/** Reads one public page and returns its text (focused on `focus` when it is long). */
export async function readPage(url: string, opts: { focus?: string; maxChars?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReadPage> {
  const f = await safeFetch(url, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  const isHtml = /html|xml/.test(f.contentType) || /^\s*</.test(f.body);
  const { title, text } = isHtml ? htmlToText(f.body) : { title: "", text: tidyLines(f.body).join("\n") };
  if (text.length < 40) throw new ReaderError("empty", "the page has almost no readable text (it may be built by scripts or an image)");
  const max = opts.maxChars ?? 12_000;
  const out = focusText(text, opts.focus, max);
  return { url: f.url, title: title || new URL(f.url).hostname, text: out, chars: text.length, truncated: out.length < text.length };
}

/** The same-site links of a home page, plus the URLs in its sitemap.xml, for the menu-page finder. */
export async function siteLinks(website: string, opts: { signal?: AbortSignal; max?: number } = {}): Promise<string[]> {
  const base = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  const sameSite = (u: URL) => u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
  const out = new Set<string>();
  const add = (href: string, from: URL) => {
    try {
      const u = new URL(decodeEntities(href.trim()), from);
      if ((u.protocol === "https:" || u.protocol === "http:") && sameSite(u)) {
        u.hash = "";
        out.add(u.toString());
      }
    } catch {
      /* not a URL */
    }
  };
  const [home, sitemap] = await Promise.allSettled([
    safeFetch(base.toString(), { signal: opts.signal }),
    safeFetch(new URL("/sitemap.xml", base).toString(), { signal: opts.signal, timeoutMs: 6_000, accept: "application/xml,text/xml,*/*;q=0.5" }),
  ]);
  if (home.status === "fulfilled") {
    const from = new URL(home.value.url);
    for (const m of home.value.body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) add(m[1], from);
  }
  if (sitemap.status === "fulfilled" && /<urlset|<sitemapindex/i.test(sitemap.value.body)) {
    for (const m of sitemap.value.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) add(m[1], base);
  }
  if (home.status === "rejected" && !out.size) throw home.reason instanceof Error ? home.reason : new ReaderError("network", "could not read the site");
  return [...out].slice(0, opts.max ?? 400);
}
