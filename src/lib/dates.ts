// Date guard: a plan for the coming week can't schedule anything before today, the restaurant's own local date.
//
// The forecast (Open-Meteo, timezone=auto) starts on the restaurant's local today, so that is the date the writer
// is told and the date the plan is checked against. Code reads every explicit date in the plan's scheduling
// fields (the day-by-day plan, each moment's "when", each dish's days, the event, when to post) and lists those
// before today; one repair call re-dates them, code re-checks, and what is still in the past is dropped (a line
// of the day-by-day plan) or listed to the owner.

import { addDaysIso, dayLabel, parseIsoDate, toIsoDate } from "./sources/format";

/** Today's date (YYYY-MM-DD) where the restaurant is: from its IANA time zone, else from its longitude. */
export function localToday(opts: { timezone?: string; lon?: number; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  if (opts.timezone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", { timeZone: opts.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
      // unknown zone: fall through
    }
  }
  const offsetHours = typeof opts.lon === "number" && Number.isFinite(opts.lon) ? Math.round(opts.lon / 15) : 0;
  return toIsoDate(new Date(now.getTime() + offsetHours * 3_600_000));
}

/** "Wed 21 Oct 2026" for an ISO date. */
export function longDayLabel(iso: string): string {
  return `${dayLabel(iso)} ${iso.slice(0, 4)}`;
}

/** The 7 days from `today`, as "Wed 21 Oct" labels (the calendar the writer and the repair get). */
export function weekOf(today: string, days = 7): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDaysIso(today, i);
    if (iso) out.push({ iso, label: dayLabel(iso) });
  }
  return out;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, ene: 0, enero: 0,
  feb: 1, february: 1, febrero: 1,
  mar: 2, march: 2, marzo: 2,
  apr: 3, april: 3, abr: 3, abril: 3,
  may: 4, mayo: 4,
  jun: 5, june: 5, junio: 5,
  jul: 6, july: 6, julio: 6,
  aug: 7, august: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septiembre: 8, set: 8, setiembre: 8,
  oct: 9, october: 9, octubre: 9,
  nov: 10, november: 10, noviembre: 10,
  dec: 11, december: 11, dic: 11, diciembre: 11,
};
const MONTH = `(${Object.keys(MONTH_INDEX).sort((a, b) => b.length - a.length).join("|")})`;
const WEEKDAY = "(?:mon|tue|wed|thu|fri|sat|sun|lun|mar|mi[eé]|jue|vie|s[aá]b|dom)[a-zé]*\\.?,?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const TO = "\\s*(?:[–—-]|to|al|y|and)\\s*";
// "20 Oct", "Wed 21–Thu 22 Oct", "21-22 October", "20 de octubre"
const DAY_MONTH = new RegExp(`\\b${DAY}(?:${TO}(?:${WEEKDAY}\\s*)?${DAY})?\\s+(?:de\\s+)?${MONTH}\\b\\.?`, "gi");
// "Oct 20", "October 20–22", "Oct. 20th"
const MONTH_DAY = new RegExp(`\\b${MONTH}\\.?\\s+${DAY}(?:${TO}${DAY})?\\b`, "gi");
const ISO = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;

/** The date with this day and month nearest to `today` (so late-December plans can name early January). */
function nearest(day: number, month: number, today: string): string | null {
  const t = parseIsoDate(today);
  if (!t || day < 1 || day > 31) return null;
  let best: string | null = null;
  let bestGap = Infinity;
  for (const y of [t.getUTCFullYear() - 1, t.getUTCFullYear(), t.getUTCFullYear() + 1]) {
    const d = new Date(Date.UTC(y, month, day));
    if (d.getUTCMonth() !== month) continue; // 31 Nov
    const gap = Math.abs(d.getTime() - t.getTime());
    if (gap < bestGap) {
      bestGap = gap;
      best = toIsoDate(d);
    }
  }
  return best;
}

/** Every explicit calendar date in a text (day and month, or ISO), as YYYY-MM-DD, in order. Weekdays alone are not dates. */
export function datesIn(text: string, today: string): string[] {
  const found: { at: number; end: number; iso: string }[] = [];
  const taken = (at: number, end: number) => found.some((f) => at < f.end && end > f.at);
  for (const m of (text ?? "").matchAll(DAY_MONTH)) {
    const month = MONTH_INDEX[m[3].toLowerCase()];
    for (const d of [m[1], m[2]]) {
      const iso = d ? nearest(Number(d), month, today) : null;
      if (iso) found.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, iso });
    }
  }
  for (const m of (text ?? "").matchAll(MONTH_DAY)) {
    const at = m.index ?? 0;
    if (taken(at, at + m[0].length)) continue; // "mar 20 oct": "mar" is Tuesday, "20 oct" the date
    const month = MONTH_INDEX[m[1].toLowerCase()];
    for (const d of [m[2], m[3]]) {
      const iso = d ? nearest(Number(d), month, today) : null;
      if (iso) found.push({ at, end: at + m[0].length, iso });
    }
  }
  for (const m of (text ?? "").matchAll(ISO)) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (parseIsoDate(iso)) found.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, iso });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso);
}

export type DatedField = { where: string; get: () => string; set: (text: string) => void };
export type PastDate = { where: string; text: string; date: string };

/** The plan fields that schedule something: each line of the day-by-day plan, moments, dishes, the event, the post. */
export function scheduleFields(pb: {
  moments: { when: string }[];
  menu_moves: { when: string }[];
  experience: { event_why: string };
  marketing: { post_when: string };
  week_plan: { day: string; action: string }[];
}): DatedField[] {
  const f = (where: string, obj: Record<string, unknown>, key: string): DatedField => ({
    where,
    get: () => String(obj[key] ?? ""),
    set: (text) => {
      obj[key] = text;
    },
  });
  return [
    ...pb.week_plan.flatMap((w, i) => [f(`week_plan.${i}.day`, w, "day"), f(`week_plan.${i}.action`, w, "action")]),
    ...pb.moments.map((m, i) => f(`moments.${i}.when`, m, "when")),
    ...pb.menu_moves.map((m, i) => f(`menu_moves.${i}.when`, m, "when")),
    f("experience.event_why", pb.experience, "event_why"),
    f("marketing.post_when", pb.marketing, "post_when"),
  ];
}

/** Fields that name a date before `today`, with the earliest such date. */
export function pastDates(fields: DatedField[], today: string): { checked: number; past: PastDate[] } {
  let checked = 0;
  const past: PastDate[] = [];
  for (const f of fields) {
    const dates = datesIn(f.get(), today);
    checked += dates.length;
    const before = dates.filter((d) => d < today).sort()[0];
    if (before) past.push({ where: f.where, text: f.get(), date: before });
  }
  return { checked, past };
}

/** Owner-facing name of a scheduling field ("week_plan.0.day" → "the week plan, line 1"). */
export function dateFieldLabel(where: string): string {
  const [section, i, key] = where.split(".");
  const n = i != null && /^\d+$/.test(i) ? Number(i) + 1 : null;
  switch (section) {
    case "week_plan":
      return `the week plan, line ${n}`;
    case "moments":
      return `moment ${n}, when`;
    case "menu_moves":
      return `dish ${n}, when it runs`;
    case "experience":
      return "the event";
    case "marketing":
      return key === "post_when" ? "when to post" : "the post";
    default:
      return where;
  }
}
