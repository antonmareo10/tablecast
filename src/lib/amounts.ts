// Money amounts in a plan's free text (headline, plays, the event, the post, the reasoning) are not
// evidence claims, but an owner reads them as facts. Each one must equal a price the plan can back:
// one of its proposed dishes, a dish on the restaurant's current menu, or a number inside a checked claim.
// Anything else is repaired once by the model and re-checked here; what still fails is listed to the owner.

import { numbersIn } from "./evidence";
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

export type Unbacked = { where: string; amount: string };

/** Money amounts in the free text that are none of the allowed prices. */
export function unbackedAmounts(fields: ProseField[], allowed: Set<string>): { checked: number; unbacked: Unbacked[] } {
  let checked = 0;
  const unbacked: Unbacked[] = [];
  for (const f of fields) {
    for (const amount of moneyIn(f.get())) {
      checked += 1;
      if (!numbersIn(amount).every((n) => allowed.has(n))) unbacked.push({ where: f.where, amount });
    }
  }
  return { checked, unbacked };
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
