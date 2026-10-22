// Money amounts in a plan's free text (headline, plays, the event, the post, the reasoning) are not
// evidence claims, but an owner reads them as facts. Each one must equal a price the plan can back:
// one of its proposed dishes, a dish on the restaurant's current menu, or a number inside a checked claim.
// An amount written next to a competitor's name must also come from that competitor (v7.1, below).
// Anything else is repaired once by the model and re-checked here; what still fails is listed to the owner.

import { normalizeText, numbersIn } from "./evidence";
import type { Evidence } from "./types";

// "$24", "€ 18", "12,50 €", "28 EUR", "30 dollars". Percentages, °C, mm and times are not money.
const MONEY = /[$€£]\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?(?:€|£|\$|(?:EUR|USD|GBP|euros?|dollars?)(?![a-z]))/gi;

export function moneyIn(text: string): string[] {
  return [...(text ?? "").matchAll(MONEY)].map((m) => m[0].trim());
}

export type ProseField = { where: string; get: () => string; set: (text: string) => void };

/** The plan fields an owner reads as plain text, each addressable for repair. */
export function proseFields(pb: PlanText): ProseField[] {
  const f = (where: string, obj: Record<string, unknown>, key: string): ProseField => ({
    where,
    get: () => String(obj[key] ?? ""),
    set: (text) => {
      obj[key] = text;
    },
  });
  return [
    f("headline", pb as unknown as Record<string, unknown>, "headline"),
    f("snapshot.summary", pb.snapshot, "summary"),
    ...pb.moments.flatMap((m, i) => [f(`moments.${i}.title`, m, "title"), f(`moments.${i}.play`, m, "play")]),
    ...pb.menu_moves.flatMap((m, i) => [f(`menu_moves.${i}.description`, m, "description"), f(`menu_moves.${i}.why`, m, "why")]),
    f("rivals.summary", pb.rivals, "summary"),
    f("experience.event_idea", pb.experience, "event_idea"),
    f("experience.event_why", pb.experience, "event_why"),
    f("marketing.instagram_post", pb.marketing, "instagram_post"),
    ...pb.week_plan.map((w, i) => f(`week_plan.${i}.action`, w, "action")),
  ];
}

/** The minimal shape of a plan this module reads and edits. */
export type PlanText = {
  headline: string;
  snapshot: { summary: string };
  moments: { title: string; play: string }[];
  menu_moves: { dish: string; description: string; why: string; price: number; evidence: Evidence[] }[];
  menu_seen?: { name: string; price: number | null }[];
  rivals: { summary: string };
  experience: { event_idea: string; event_why: string };
  marketing: { instagram_post: string };
  week_plan: { action: string }[];
};

/** Prices the plan can back, with what each one is, for the checker and the repair prompt. */
export function allowedAmounts(pb: PlanText, verified: Evidence[]): { numbers: Set<string>; labels: string[] } {
  const numbers = new Set<string>();
  const labels: string[] = [];
  const add = (n: number | string | null | undefined, label: string) => {
    if (n == null || n === "") return;
    const found = numbersIn(String(n));
    if (!found.length) return;
    found.forEach((x) => numbers.add(x));
    labels.push(`${n} (${label})`);
  };
  for (const m of pb.menu_moves) add(m.price, `proposed dish: ${m.dish}`);
  for (const m of pb.menu_seen ?? []) add(m.price, `current menu: ${m.name}`);
  for (const e of verified) if (e.verified) for (const n of numbersIn(e.text)) numbers.add(n);
  for (const e of verified) if (e.verified && moneyIn(e.text).length) labels.push(`from a checked claim: "${e.text}"`);
  return { numbers, labels };
}

/** `venue` is set when the number is a price the plan can back, but it sits next to a competitor no source prices. */
export type Unbacked = { where: string; amount: string; venue?: string };

/**
 * Money amounts in the free text that are none of the allowed prices. With an attribution context (v7.1), an
 * allowed amount still fails when its clause names a competitor and nothing prices that competitor at that amount.
 */
export function unbackedAmounts(
  fields: ProseField[],
  allowed: Set<string>,
  attribution?: AttributionContext,
): { checked: number; unbacked: Unbacked[] } {
  let checked = 0;
  const unbacked: Unbacked[] = [];
  for (const f of fields) {
    const text = f.get();
    for (const m of text.matchAll(MONEY)) {
      checked += 1;
      const amount = m[0].trim();
      if (!numbersIn(amount).every((n) => allowed.has(n))) {
        unbacked.push({ where: f.where, amount });
        continue;
      }
      const venue = attribution ? misattributed(clauseAt(text, m.index ?? 0), amount, attribution) : null;
      if (venue) unbacked.push({ where: f.where, amount, venue });
    }
  }
  return { checked, unbacked };
}

// ---- v7.1: a price next to a competitor's name ---------------------------------------------------
// The number check only asks whether an amount is a price the plan can back. In the Gjelina replay, "the nearest
// pizza is $22 at Abbot's" passed because Gjelina's own Pomodoro is $22, and no source prices Abbot's. So when an
// amount's clause names a venue from the block, the amount has to come from that venue: a checked claim that puts
// the venue's name and the amount in one clause. A dish or menu item of the restaurant's own, named in the same
// clause at that price, also backs it ("our $22 Pomodoro against Abbot's slices").

export type AttributionContext = {
  rivals: { name: string; aliases: string[] }[];
  own: { aliases: string[]; numbers: string[] }[];
  claims: string[];
};

// Clause boundaries: sentence ends and semicolons, commas, spaced dashes, "+", and the conjunctions that join two
// priced things ("$24 and $28", "while Gjelina's Pomodoro is also $22"). Not colons or brackets: "Orecchiette ($32)"
// and "Rivals: Abbot's $18" keep the amount with its name. Decimal points and thousands commas never break.
const CLAUSE_BREAK =
  /[.!?;](?=\s|$)|,(?=\s)|\s[—–-]\s|\s\+\s|\s(?:and|or|but|while|whereas|vs\.?|versus|than|y|o|pero|mientras|frente a)\s/gi;

/** The clauses of a text with their offsets. */
export function clauses(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    const at = m.index ?? 0;
    out.push({ start: last, end: at, text: text.slice(last, at) });
    last = at + m[0].length;
  }
  out.push({ start: last, end: text.length, text: text.slice(last) });
  return out.filter((c) => c.text.trim());
}

function clauseAt(text: string, index: number): string {
  return clauses(text).find((c) => index >= c.start && index < c.end)?.text ?? text;
}

// Names too generic to stand for one venue ("TBD" is a real restaurant on Abbot Kinney).
const GENERIC = new Set("bar cafe pub grill kitchen pizza pizzeria restaurant bistro deli bakery market diner coffee tbd".split(" "));

/** Ways a plan may write a venue's name: full, without the bracket or "The", the first two words, "Abbot's". */
export function venueAliases(name: string): string[] {
  const clean = name.replace(/[’‘]/g, "'").trim();
  const base = clean.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const words = base.split(" ");
  const raw = [clean, base, ...[...clean.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])];
  if (/^the$/i.test(words[0] ?? "") && words.length > 1) raw.push(words.slice(1).join(" "));
  if (words.length >= 3) raw.push(words.slice(0, 2).join(" "));
  if (/'s$/i.test(words[0] ?? "") && words[0].length >= 5) raw.push(words[0]);
  const out = new Set<string>();
  for (const r of raw) {
    const n = normalizeText(r);
    if (n.replace(/ /g, "").length >= 4 && !GENERIC.has(n)) out.add(n);
  }
  return [...out];
}

/** Ways a plan may write one of the restaurant's own dishes: full, or the part before a dash, comma or bracket. */
function itemAliases(name: string): string[] {
  const out = new Set<string>();
  for (const r of [name, name.split(/\s[—–-]\s|,|\(|:/)[0]]) {
    const n = normalizeText(r);
    if (n.replace(/ /g, "").length >= 4 && !GENERIC.has(n)) out.add(n);
  }
  return [...out];
}

/** The venues on the block (OpenStreetMap lines "Name — kind, …, 73 m away"), without the restaurant and its own outlets. */
export function blockVenueNames(sources: { kind: string; text: string }[], restaurant: string): string[] {
  const venues: { name: string; distance_m: number }[] = [];
  for (const s of sources) {
    if (s.kind !== "block") continue;
    for (const line of s.text.split("\n").slice(1)) {
      const m = line.match(/^(.+?) — .*?(\d+) m away/);
      if (m) venues.push({ name: m[1].trim(), distance_m: Number(m[2]) });
    }
  }
  return otherVenues(venues, restaurant);
}

/** The other venues of a list: not the restaurant itself (0 m away) and not its own outlets ("GTA (Gjelina Take Away)"). */
export function otherVenues(venues: { name: string; distance_m: number }[], restaurant: string): string[] {
  const self = normalizeText(restaurant);
  const out: string[] = [];
  for (const v of venues) {
    const n = normalizeText(v.name);
    if (!n || v.distance_m === 0) continue;
    if (self && (` ${n} `.includes(` ${self} `) || ` ${self} `.includes(` ${n} `))) continue;
    if (!out.includes(v.name.trim())) out.push(v.name.trim());
  }
  return out;
}

/** What the attribution check needs: the block's venues, the restaurant's own priced items, the checked claims. */
export function attributionContext(
  venues: string[],
  own: { name: string; price: number | null | undefined }[],
  verified: Evidence[],
): AttributionContext {
  return {
    rivals: venues.map((name) => ({ name, aliases: venueAliases(name) })).filter((r) => r.aliases.length),
    own: own.filter((o) => o.price != null).map((o) => ({ aliases: itemAliases(o.name), numbers: numbersIn(String(o.price)) })),
    claims: verified.filter((e) => e.verified).map((e) => e.text),
  };
}

/** The competitor an amount is pinned to without any source pricing it there, or null. */
export function misattributed(clause: string, amount: string, ctx: AttributionContext): string | null {
  const c = ` ${normalizeText(clause)} `;
  const named = ctx.rivals.filter((r) => r.aliases.some((a) => c.includes(` ${a} `)));
  if (!named.length) return null;
  const nums = numbersIn(amount);
  if (!nums.length) return null;
  if (ctx.own.some((o) => o.aliases.some((a) => c.includes(` ${a} `)) && nums.every((n) => o.numbers.includes(n)))) return null;
  for (const r of named) {
    const priced = ctx.claims.some((t) =>
      clauses(t).some((k) => {
        const kn = ` ${normalizeText(k.text)} `;
        return r.aliases.some((a) => kn.includes(` ${a} `)) && nums.every((n) => kn.includes(` ${n} `));
      }),
    );
    if (!priced) return r.name;
  }
  return null;
}

/** One unbacked amount as the owner reads it, `where` already an owner-facing label ("your block"). */
export function unbackedLabel(u: { where: string; amount: string; venue?: string }): string {
  return u.venue ? `${u.amount} (${u.where}: next to ${u.venue}, which no source prices)` : `${u.amount} (${u.where})`;
}

type WrittenPlan = Omit<PlanText, "snapshot" | "moments" | "rivals" | "experience"> & {
  restaurant: { name: string };
  snapshot: { summary: string; loved_for: Evidence[]; watch_outs: Evidence[] };
  moments: { title: string; play: string; evidence: Evidence[] }[];
  rivals: { summary: string; evidence: Evidence[] };
  experience: { event_idea: string; event_why: string; evidence: Evidence[] };
};

/**
 * The competitor-price rule applied to a plan already written, from what the browser holds: the block's venues, the
 * menu shown and the plan's checked claims. Recorded runs made before v7.1 never had it; for them this is the same
 * check, run late. Display only; `where` comes back as the owner-facing label.
 */
export function competitorPriceFlags(
  pb: WrittenPlan,
  venues: { name: string; distance_m: number }[],
  menu: { name: string; price: number | null }[],
): { where: string; amount: string; venue: string }[] {
  const claims = [
    ...pb.snapshot.loved_for,
    ...pb.snapshot.watch_outs,
    ...pb.moments.flatMap((m) => m.evidence),
    ...pb.menu_moves.flatMap((m) => m.evidence),
    ...pb.rivals.evidence,
    ...pb.experience.evidence,
  ];
  const ctx = attributionContext(
    otherVenues(venues, pb.restaurant.name),
    [...pb.menu_moves.map((m) => ({ name: m.dish, price: m.price })), ...menu],
    claims,
  );
  const out: { where: string; amount: string; venue: string }[] = [];
  for (const f of proseFields(pb)) {
    const text = f.get();
    for (const m of text.matchAll(MONEY)) {
      const venue = misattributed(clauseAt(text, m.index ?? 0), m[0].trim(), ctx);
      if (venue) out.push({ where: fieldLabel(f.where), amount: m[0].trim(), venue });
    }
  }
  return out;
}

/** Owner-facing name of a field path ("moments.2.play" → "moment 3, the play"). */
export function fieldLabel(where: string): string {
  const [section, i, key] = where.split(".");
  const n = i != null && /^\d+$/.test(i) ? Number(i) + 1 : null;
  switch (section) {
    case "headline":
      return "headline";
    case "snapshot":
      return "how you come across";
    case "moments":
      return `moment ${n}, ${key === "title" ? "title" : "the play"}`;
    case "menu_moves":
      return `dish ${n}, ${key === "why" ? "the bet" : "description"}`;
    case "rivals":
      return "your block";
    case "experience":
      return "the event";
    case "marketing":
      return "the post";
    case "week_plan":
      return `the week plan, line ${n}`;
    default:
      return where;
  }
}
