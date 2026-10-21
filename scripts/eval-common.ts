// Helpers shared by the eval scripts (eval-routing.ts, eval-tavily.ts). No side effects on import.

import fs from "node:fs";
import path from "node:path";
import type { EvidencePack } from "../src/lib/agent";
import { normalizeText } from "../src/lib/evidence";
import type { AgentRequest, EngineCall, Playbook, Source } from "../src/lib/types";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const RESULTS = path.join(ROOT, "eval", "results");

/** Sources that tie a claim to the coming week. */
export const WEEK_KINDS = new Set(["weather", "event", "holiday", "news"]);

export function slugOf(r: AgentRequest): string {
  return `${r.restaurant}-${r.city}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^\w]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** The eval's restaurants: eval/restaurants.json (the 8 used since v3), or another list such as eval/heldout.json. */
export function loadRestaurants(file = path.join("eval", "restaurants.json")): AgentRequest[] {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, file), "utf8")) as AgentRequest[];
}

/** A cached evidence pack (eval/results/packs/<slug>.json), or null if it was never gathered. */
export function readPack(slug: string): { pack: EvidencePack; calls: EngineCall[] } | null {
  const file = path.join(RESULTS, "packs", `${slug}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Text of the restaurant's own menu and site pages, normalised and padded for whole-word lookups. */
export function menuTextOf(sources: Source[]): string {
  return sources
    .filter((s) => s.kind === "menu" || s.kind === "site")
    .map((s) => ` ${normalizeText(s.text)} `)
    .join(" ");
}

/** True if `name` appears as whole words in a text built by menuTextOf. */
export function onMenu(menuText: string, name: string): boolean {
  const n = normalizeText(name);
  return !!n && menuText.includes(` ${n} `);
}

/**
 * Share of the three dishes with a verified cite to this week's data, and share whose name is not already on
 * the restaurant's menu or site pages (null when no such page was found).
 */
export function dishMetrics(pb: Playbook | null, sources: Source[]): { weekSpecific: number | null; newDishes: number | null } {
  if (!pb) return { weekSpecific: null, newDishes: null };
  const kind = new Map(sources.map((s) => [s.id, s.kind] as const));
  const week = pb.menu_moves.filter((m) => m.evidence.some((e) => e.verified && e.cites.some((c) => c.ok && WEEK_KINDS.has(kind.get(c.source) ?? "")))).length;
  const menuText = menuTextOf(sources);
  const fresh = menuText.trim() ? pb.menu_moves.filter((m) => !onMenu(menuText, m.dish)).length : null;
  const n = pb.menu_moves.length || 1;
  return { weekSpecific: week / n, newDishes: fresh == null ? null : fresh / n };
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
export const secs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–");

/** Value of `--name x` on the command line, or null. */
export function argOne(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
/** Comma-separated value of `--name a,b` on the command line, or null. */
export function argList(name: string): string[] | null {
  return argOne(name)?.split(",") ?? null;
}
