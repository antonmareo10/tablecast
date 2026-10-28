// The writer: turns a Tablecast plan into posts for Buffer, with no model call.
// One post per moment, one for the event, one for each dish that no moment already features. Each post has an
// exact local date and time (checked by code, see checkPostTimes), a "why now" tied to the plan's verified
// evidence and its source, and one text per kind of network. It runs the same on a recorded plan and on a live one.
//
// Everything customer-facing is built from fields the plan already verified (dish names, prices, forecast, the
// listed events); nothing is invented. When a moment has no dish or listed event to talk about, the post falls back
// to the plan's own wording and says so in `issues`, so the owner edits it before it goes out.

import { datesIn, localToday } from "./dates";
import { addDaysIso, dayLabel, parseIsoDate, weekdayOf } from "./sources/format";
import type { DayForecast, Evidence, MenuMove, Moment, NearbyEvent, Playbook, Source } from "./types";

export type NetworkKey = "instagram" | "facebook" | "linkedin" | "google" | "bluesky" | "threads" | "mastodon" | "twitter" | "default";

export type PostSpec = {
  id: string;
  kind: "moment" | "event" | "dish";
  /** Owner-facing label for the board, e.g. "Heavy rain · Wed 4 Nov". */
  title: string;
  /** Buffer tag name; one per reason, reused every week (tag count is limited by the Buffer plan). */
  tag: string;
  post_at: { date: string; time: string; timezone: string; utc: string; basis: string };
  text: string;
  variants: Record<NetworkKey, string>;
  image: ImageSpec;
  why_now: WhyNow;
  /** Things the owner should look at before this goes out. */
  issues: string[];
};

export type ImageSpec = { restaurant: string; kicker: string; headline: string; detail: string; tone: "rain" | "sun" | "event" | "dish" };
export type WhyNow = { text: string; verified: boolean; cites: { source: string; title?: string; url?: string; quote: string }[] };

export type WriterInput = {
  playbook: Playbook;
  days: DayForecast[];
  events: NearbyEvent[];
  sources: Source[];
  /** IANA zone of the restaurant: the post times are its local times. */
  timezone: string;
  now: Date;
  /** Replays: move the whole plan forward by whole weeks (weekdays stay the same) so it lies ahead of `now`. */
  rebase?: boolean;
};

export type WriterResult = {
  posts: PostSpec[];
  skipped: { id: string; title: string; reason: string }[];
  /** Whole days the plan was moved forward (a multiple of 7), 0 for a live plan. */
  shiftDays: number;
  today: string;
};

// ---- Time helpers -----------------------------------------------------------------------

function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant for a wall-clock date and time in an IANA zone (DST-safe; a time skipped by DST moves forward). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return new Date(guess);
}

/** The wall-clock date and time of an instant in an IANA zone. */
export function utcToZoned(utc: Date, tz: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(utc).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "10:00 AM", "16:00", "5pm" -> "HH:MM", else null. Only a time that follows a date in the text counts. */
function explicitTime(text: string): string | null {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(text);
  if (!m) return null;
  if (m[3]) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[3])) h += 12;
    return `${pad(h)}:${m[2] ?? "00"}`;
  }
  return `${pad(Number(m[4]))}:${m[5]}`;
}

/** When in the day a moment happens, from its words; the post goes out ahead of it. */
function leadTime(text: string): { time: string; basis: string } {
  if (/\b(evening|dinner|tonight|night|noche|cena)\b/i.test(text)) return { time: "16:00", basis: "evening moment: posted at 16:00, ahead of dinner" };
  if (/\b(breakfast|morning|brunch|desayuno|ma[nñ]ana)\b/i.test(text)) return { time: "08:00", basis: "morning moment: posted at 08:00" };
  return { time: "10:00", basis: "lunch or all-day moment: posted at 10:00, ahead of lunch" };
}

// ---- Text helpers -----------------------------------------------------------------------

const LIMITS: Record<NetworkKey, number> = { instagram: 2200, facebook: 1500, linkedin: 1500, google: 1500, bluesky: 300, threads: 500, mastodon: 500, twitter: 280, default: 1000 };
const SHORT: NetworkKey[] = ["bluesky", "threads", "mastodon", "twitter"];

/** Cuts at the last sentence end that fits, else at the last word, with an ellipsis. */
export function fit(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > limit * 0.5) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, (space > limit * 0.5 ? space : limit - 1)).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function variantsFor(short: string, long: string): Record<NetworkKey, string> {
  const out = {} as Record<NetworkKey, string>;
  for (const k of Object.keys(LIMITS) as NetworkKey[]) out[k] = fit(SHORT.includes(k) ? short : long, LIMITS[k]);
  return out;
}

/** Guests read these texts: no em or en dashes (the plan's dish names carry them). */
function plain(s: string): string {
  return s.replace(/\s[—–]\s/g, ", ").replace(/[—–]/g, "-");
}

function money(amount: number, currency: string): string {
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2 }).format(amount);
  } catch {
    return `${amount}`;
  }
}

/** "Rain Bowl — Braised White Bean…" -> name and the rest. */
function splitDish(dish: string): { name: string; rest: string } {
  const [name, ...rest] = dish.split(/\s[—–-]\s/);
  return { name: name.trim(), rest: rest.join(" – ").trim() };
}

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m ? m[1] : s).trim();
}

function dayName(iso: string): string {
  return dayLabel(iso); // "Wed 4 Nov"
}

// ---- Evidence -> why_now ----------------------------------------------------------------

function whyNow(evidence: Evidence[], sources: Source[]): WhyNow {
  const ev = evidence.find((e) => e.verified && e.cites.length) ?? evidence.find((e) => e.cites.length) ?? evidence[0];
  if (!ev) return { text: "", verified: false, cites: [] };
  return {
    text: ev.text,
    verified: ev.verified === true,
    cites: ev.cites.slice(0, 2).map((c) => {
      const s = sources.find((x) => x.id === c.source);
      return { source: c.source, title: s?.title, url: s?.url, quote: c.quote };
    }),
  };
}

// ---- Dates in the plan ------------------------------------------------------------------

/** First and last explicit date of a scheduling phrase, or null when it names none. */
function span(text: string, planDay0: string): { first: string; last: string } | null {
  const ds = datesIn(text, planDay0);
  if (ds.length === 0) return null;
  const sorted = [...ds].sort();
  return { first: ds[0], last: sorted[sorted.length - 1] };
}

function shiftIso(iso: string, days: number): string {
  return days === 0 ? iso : (addDaysIso(iso, days) ?? iso);
}

function condWord(d: DayForecast): { word: string; tone: ImageSpec["tone"] } {
  const c = d.condition.toLowerCase();
  if (/rain|drizzle|shower|thunder|snow/.test(c)) return { word: c, tone: "rain" };
  if (/clear/.test(c)) return { word: c, tone: "sun" };
  return { word: c, tone: "sun" };
}

// ---- The writer -------------------------------------------------------------------------

export function writePosts(input: WriterInput): WriterResult {
  const { playbook: pb, days, events, sources, timezone, now } = input;
  const planDay0 = days[0]?.date ?? localToday({ timezone, now });
  const today = localToday({ timezone, now });
  let shiftDays = 0;
  if (input.rebase && planDay0 < today) {
    const gap = Math.round((parseIsoDate(today)!.getTime() - parseIsoDate(planDay0)!.getTime()) / 86_400_000);
    shiftDays = Math.ceil(gap / 7) * 7;
  }
  const shift = (iso: string) => shiftIso(iso, shiftDays);
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  const currency = pb.currency || "USD";
  const restaurant = pb.restaurant.name;

  const usedDishes = new Set<number>();
  type Draft = Omit<PostSpec, "post_at"> & { date: string; time: string; basis: string };
  const out: Draft[] = [];

  const dishLine = (m: MenuMove, withDesc: boolean) => {
    const { name, rest } = splitDish(m.dish);
    const price = m.price > 0 ? ` ${money(m.price, currency)}` : "";
    const desc = withDesc ? firstSentence(m.description || rest) : "";
    return `${name}${price}.${desc ? ` ${desc}` : ""}`.replace(/\.\./g, ".");
  };

  // Moments
  pb.moments.forEach((mo: Moment, i) => {
    const sp = span(mo.when, planDay0);
    const issues: string[] = [];
    const origDate = sp?.first ?? planDay0;
    if (!sp) issues.push("The plan gave this moment no date; the first day of the week was used.");
    const date = shift(origDate);
    const day = dayByDate.get(origDate);
    const lead = leadTime(`${mo.when} ${mo.title}`);

    // Hook: a listed event this moment is about, else the day's forecast.
    const ev = events.find((e) => e.date === origDate && mo.title.toLowerCase().includes(e.name.toLowerCase()));
    let hook = "";
    let tone: ImageSpec["tone"] = "event";
    if (ev) {
      const when = ev.time ? `${Number(ev.time.slice(0, 2)) >= 17 ? "tonight" : "today"} at ${ev.time}` : "today";
      hook = `${ev.name} ${when}${ev.distance_km != null ? `, ${ev.distance_km} km away` : ""}.`;
    } else if (day) {
      const c = condWord(day);
      tone = c.tone;
      hook = `${c.word.charAt(0).toUpperCase()}${c.word.slice(1)} today, ${Math.round(day.tmax)}°C.`;
    }

    // The dish that runs on this day, if any (each dish is used once).
    const dishIdx = pb.menu_moves.findIndex((m, k) => {
      if (usedDishes.has(k)) return false;
      const ds = span(m.when, planDay0);
      return ds != null && origDate >= ds.first && origDate <= ds.last;
    });
    let body = "";
    let headline = mo.title;
    if (dishIdx >= 0) {
      usedDishes.add(dishIdx);
      body = dishLine(pb.menu_moves[dishIdx], true);
      headline = splitDish(pb.menu_moves[dishIdx].dish).name;
    } else if (ev) {
      body = `Come early, we are ${ev.distance_km != null ? `${ev.distance_km} km from the door` : "close by"}.`;
      issues.push("No dish or offer is attached to this moment; the line after the event name is generic. Add one.");
    } else {
      body = firstSentence(mo.play);
      issues.push("No dish or listed event for this moment; the text is the plan's own note to you. Rewrite it for guests.");
    }

    const short = `${hook} ${body}`.replace(/\s+/g, " ").trim();
    const long = `${hook} ${body}\n\n${restaurant}, ${pb.restaurant.city}.`.replace(/ +/g, " ").trim();
    out.push({
      id: `moment-${i + 1}`,
      kind: "moment",
      title: `${(day ? day.condition : mo.title.split(",")[0]).replace(/^./, (c) => c.toUpperCase())} · ${dayName(date)}`,
      tag: `Tablecast · ${tone === "rain" ? "rain" : tone === "sun" ? "sun" : "event"}`,
      date,
      time: lead.time,
      basis: lead.basis,
      text: short,
      variants: variantsFor(short, long),
      image: { restaurant, kicker: dayName(date), headline, detail: hook, tone },
      why_now: whyNow(mo.evidence, sources),
      issues,
    });
  });

  // The event
  {
    const ex = pb.experience;
    const sp = span(`${pb.marketing.post_when} ${ex.event_why}`, planDay0) ?? span(pb.moments[0]?.when ?? "", planDay0);
    const origDate = sp?.first ?? planDay0;
    const date = shift(origDate);
    const issues: string[] = [];
    const whenText = pb.marketing.post_when;
    const t = datesIn(whenText, planDay0).length ? explicitTime(whenText.replace(/^.*?\b\d{1,2}\s+\w{3}\b/, "")) : null;
    const text = `${ex.event_idea.trim().replace(/\s*[.!]*$/, ".")}`;
    const long = `${text}\n\n${restaurant}, ${pb.restaurant.city}.`;
    out.push({
      id: "event",
      kind: "event",
      title: `${firstSentence(ex.event_idea).split(":")[0].slice(0, 60)} · ${dayName(date)}`,
      tag: "Tablecast · event",
      date,
      time: t ?? "16:00",
      basis: t ? `time taken from the plan's "when to post": ${whenText}` : "no time in the plan: posted at 16:00",
      text,
      variants: variantsFor(text, long),
      image: { restaurant, kicker: dayName(date), headline: ex.event_idea.split(":")[0].slice(0, 70), detail: ex.event_idea, tone: "event" },
      why_now: whyNow(ex.evidence, sources),
      issues,
    });
  }

  // Dishes no moment features
  pb.menu_moves.forEach((m, k) => {
    if (usedDishes.has(k)) return;
    const sp = span(m.when, planDay0);
    const origDate = sp?.first ?? planDay0;
    const date = shift(origDate);
    const lead = leadTime(m.when);
    const short = `New this week: ${dishLine(m, false)}`;
    const long = `New this week: ${dishLine(m, true)}\n\n${restaurant}, ${pb.restaurant.city}.`;
    out.push({
      id: `dish-${k + 1}`,
      kind: "dish",
      title: `${splitDish(m.dish).name} · ${dayName(date)}`,
      tag: "Tablecast · dish",
      date,
      time: lead.time === "10:00" ? "11:00" : lead.time,
      basis: sp ? lead.basis : "no date in the plan: first day of the week",
      text: short,
      variants: variantsFor(short, long),
      image: { restaurant, kicker: dayName(date), headline: splitDish(m.dish).name, detail: m.price > 0 ? `${money(m.price, currency)} · ${m.when}` : m.when, tone: "dish" },
      why_now: whyNow(m.evidence, sources),
      issues: sp ? [] : ["The plan gave this dish no date."],
    });
  });

  // Exact UTC instants, no two posts at the same minute, nothing already past.
  const taken = new Set<string>();
  const posts: PostSpec[] = [];
  const skipped: WriterResult["skipped"] = [];
  out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  for (const o of out) {
    let { date, time } = o;
    let utc = zonedToUtc(date, time, timezone);
    while (taken.has(utc.toISOString())) {
      utc = new Date(utc.getTime() + 30 * 60_000);
      ({ date, time } = utcToZoned(utc, timezone));
    }
    if (utc.getTime() <= now.getTime() + 15 * 60_000) {
      skipped.push({ id: o.id, title: o.title, reason: `${date} ${time} (${timezone}) is already past` });
      continue;
    }
    taken.add(utc.toISOString());
    const { date: _d, time: _t, basis, ...rest } = o;
    void _d; void _t;
    const variants = Object.fromEntries(Object.entries(rest.variants).map(([k, v]) => [k, plain(v)])) as Record<NetworkKey, string>;
    posts.push({ ...rest, text: plain(rest.text), variants, post_at: { date, time, timezone, utc: utc.toISOString(), basis } });
  }
  return { posts, skipped, shiftDays, today };
}

/**
 * The date guard for post times, in the same spirit as the plan's own date check: every post lies in the future,
 * its UTC instant really is the stated local date and time, and the weekday in its title matches that date.
 * Returns what is wrong (empty when all is well).
 */
export function checkPostTimes(posts: PostSpec[], now: Date): string[] {
  const problems: string[] = [];
  for (const p of posts) {
    const back = utcToZoned(new Date(p.post_at.utc), p.post_at.timezone);
    if (back.date !== p.post_at.date || back.time !== p.post_at.time) problems.push(`${p.id}: ${p.post_at.utc} is ${back.date} ${back.time} in ${p.post_at.timezone}, not ${p.post_at.date} ${p.post_at.time}`);
    if (new Date(p.post_at.utc).getTime() <= now.getTime()) problems.push(`${p.id}: ${p.post_at.utc} is in the past`);
    const day = p.title.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/)?.[1];
    if (day && day !== weekdayOf(p.post_at.date)) problems.push(`${p.id}: title says ${day} but ${p.post_at.date} is a ${weekdayOf(p.post_at.date)}`);
  }
  return problems;
}
