// What Tavily contributes to a plan: build a "no Tavily" evidence pack, and measure a verified plan in code.
// Pure functions (no network, no model), used by scripts/eval-tavily.ts and tests/tavily-ablation.test.ts.

import type { EvidencePack, WriteReport } from "../src/lib/agent";
import { moneyIn } from "../src/lib/amounts";
import { SourceLedger, normalizeText } from "../src/lib/evidence";
import type { Evidence, Playbook, Source } from "../src/lib/types";
import { dishMetrics, menuTextOf, onMenu } from "./eval-common";

/**
 * The lines of the pack's context that Tavily produces (agent.ts, buildContext): the menu pages Tavily Map found
 * on the restaurant's site, and which of them Extract already read. Every other context line comes from the
 * owner's request, OpenStreetMap, Open-Meteo, Nager.Date or Ticketmaster.
 */
export const TAVILY_CONTEXT_LINE = /^MENU PAGES? (\(Tavily Map\)|ALREADY READ|READ, LITTLE TEXT):/;

/**
 * The same pack as if Tavily were not there: its sources are dropped (the rest renumbered S1…Sn in their
 * original order, as a ledger without them would have numbered them), the Tavily Map line leaves the context,
 * and no credits are spent. The input pack is not modified.
 */
export function withoutTavily(pack: EvidencePack): { pack: EvidencePack; removedSources: number; removedLines: string[] } {
  const kept = pack.sources.filter((s) => s.provider !== "Tavily");
  const lines = pack.context.split("\n");
  const removedLines = lines.filter((l) => TAVILY_CONTEXT_LINE.test(l));
  return {
    pack: {
      ...pack,
      sources: kept.map((s, i) => ({ ...s, id: `S${i + 1}` })),
      context: lines.filter((l) => !TAVILY_CONTEXT_LINE.test(l)).join("\n"),
      tavilyCredits: 0,
    },
    removedSources: pack.sources.length - kept.length,
    removedLines,
  };
}

export type ClaimGroup = "guests" | "moments" | "dishes" | "rivals" | "event";

/** Every evidence claim of a published plan, labelled by where it sits. */
export function claimsOf(pb: Playbook): { group: ClaimGroup; e: Evidence }[] {
  return [
    ...[...pb.snapshot.loved_for, ...pb.snapshot.watch_outs].map((e) => ({ group: "guests" as const, e })),
    ...pb.moments.flatMap((m) => m.evidence.map((e) => ({ group: "moments" as const, e }))),
    ...pb.menu_moves.flatMap((m) => m.evidence.map((e) => ({ group: "dishes" as const, e }))),
    ...pb.rivals.evidence.map((e) => ({ group: "rivals" as const, e })),
    ...pb.experience.evidence.map((e) => ({ group: "event" as const, e })),
  ];
}

/** Words in a restaurant's name that say nothing about which restaurant it is. */
const GENERIC_NAME = new Set("restaurant restaurante cafe bistro brasserie trattoria osteria pizzeria taberna tavern casa chez delicatessen deli diner kitchen grill house bar".split(" "));

/** The first distinctive word of a restaurant's name ("Zuni Café" → "zuni", "Au Cheval" → "cheval"), or null. */
export function ownNameWord(name: string): string | null {
  return normalizeText(name).split(" ").find((w) => w.length >= 4 && !GENERIC_NAME.has(w)) ?? null;
}

/**
 * A page the research step labelled "rival" that is really about a competitor: its URL and title don't name the
 * restaurant itself. (The labels are the research model's: reviews of the restaurant are sometimes filed as "rival".)
 */
export function isCompetitorPage(src: Source | undefined, ownWord: string | null): boolean {
  if (!src || src.kind !== "rival" || src.provider !== "Tavily") return false;
  if (!ownWord) return true;
  return !` ${normalizeText(`${(src.url ?? "").replace(/[/._%-]+/g, " ")} ${src.title}`)} `.includes(` ${ownWord} `);
}

const okCites = (e: Evidence) => (e.verified ? e.cites.filter((c) => c.ok) : []);

/** Menu-heading names production never shows as dishes (agent.ts, "On your menu now"). */
const MENU_HEADING = /\b(menu|men[uú]|carta|dinner|lunch|brunch|drinks|bebidas)\b/i;
function cleanMenuName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

export type PlanMetrics = {
  published: boolean;
  claims: number;
  verifiedFirst: number;
  verified: number;
  /** Verified claims with at least one checked cite to a Tavily source / with only Tavily cites. */
  verifiedTavily: number;
  verifiedOnlyTavily: number;
  verifiedByGroup: Record<ClaimGroup, number>;
  /** Verified claims with a checked cite to each provider (a claim citing two providers counts for both). */
  verifiedByProvider: Record<string, number>;
  /** Verified "loved for / watch outs" claims citing a web page found by Tavily (no other source can say what guests think). */
  guestsFromWeb: number;
  tavilyByGroup: Record<ClaimGroup, number>;
  /** Distinct sources (and providers) behind the verified claims. */
  sourcesCited: number;
  providersCited: string[];
  /** menu_seen as written, how many of those are on a menu/site page of THIS pack (production's check), how many on the real menu. */
  menuListed: number;
  menuChecked: number;
  menuOnRealMenu: number | null;
  /** Dishes with a verified cite to the restaurant's own menu or site page. */
  dishesOnMenuEvidence: number;
  /** Dishes whose name is already on the real menu (by whole name), judged against the full pack's pages. */
  dishesAlreadyOnMenu: number | null;
  /** "New" dishes whose name is one of the items the plan itself lists as already on the menu (menu_seen). */
  dishesRepeatListedMenu: number;
  dishes: number;
  weekSpecific: number | null;
  /** Verified claims that state a money amount and cite a competitor's page (isCompetitorPage). */
  rivalPriceClaims: number;
  /** Verified claims citing local news found this week. */
  newsClaims: number;
  amounts: { checked: number; unbackedFirst: number; unbackedFinal: number };
};

/**
 * Metrics of one verified plan. `sources` are the sources the writer saw; `realMenuSources` are the full pack's
 * sources (with Tavily), used as ground truth for "is this on the restaurant's real menu?" in both variants.
 */
export function planMetrics(
  report: Pick<WriteReport, "ok" | "claims" | "verifiedFirstPass" | "verifiedFinal" | "amounts" | "draft">,
  final: Playbook | null | undefined,
  sources: Source[],
  realMenuSources: Source[],
  restaurant: string,
): PlanMetrics {
  const ownWord = ownNameWord(restaurant);
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const groups: ClaimGroup[] = ["guests", "moments", "dishes", "rivals", "event"];
  const zero = () => Object.fromEntries(groups.map((g) => [g, 0])) as Record<ClaimGroup, number>;
  const m: PlanMetrics = {
    published: !!report.ok && !!final,
    claims: report.claims,
    verifiedFirst: report.verifiedFirstPass,
    verified: report.verifiedFinal,
    verifiedTavily: 0,
    verifiedOnlyTavily: 0,
    verifiedByGroup: zero(),
    verifiedByProvider: {},
    guestsFromWeb: 0,
    tavilyByGroup: zero(),
    sourcesCited: 0,
    providersCited: [],
    menuListed: 0,
    menuChecked: 0,
    menuOnRealMenu: null,
    dishesOnMenuEvidence: 0,
    dishesAlreadyOnMenu: null,
    dishesRepeatListedMenu: 0,
    dishes: 0,
    weekSpecific: null,
    rivalPriceClaims: 0,
    newsClaims: 0,
    amounts: report.amounts ?? { checked: 0, unbackedFirst: 0, unbackedFinal: 0 },
  };
  if (!final || !report.ok) return m;

  const cited = new Set<string>();
  for (const { group, e } of claimsOf(final)) {
    const oks = okCites(e);
    if (!e.verified) continue;
    m.verifiedByGroup[group] += 1;
    const provs = oks.map((c) => byId.get(c.source)?.provider);
    const kinds = oks.map((c) => byId.get(c.source)?.kind);
    if (provs.includes("Tavily")) {
      m.verifiedTavily += 1;
      m.tavilyByGroup[group] += 1;
    }
    if (provs.length && provs.every((p) => p === "Tavily")) m.verifiedOnlyTavily += 1;
    for (const p of new Set(provs)) if (p) m.verifiedByProvider[p] = (m.verifiedByProvider[p] ?? 0) + 1;
    if (group === "guests" && provs.includes("Tavily")) m.guestsFromWeb += 1;
    if (moneyIn(e.text).length && oks.some((c) => isCompetitorPage(byId.get(c.source), ownWord))) m.rivalPriceClaims += 1;
    if (kinds.includes("news")) m.newsClaims += 1;
    for (const c of oks) cited.add(c.source);
  }
  m.sourcesCited = cited.size;
  m.providersCited = [...new Set([...cited].map((id) => byId.get(id)?.provider).filter((p): p is Source["provider"] => !!p))].sort();

  const menuHere = menuTextOf(sources);
  const realMenu = menuTextOf(realMenuSources);
  // What the writer lists as the current menu, minus headings and the restaurant's own name.
  const seen = (report.draft?.menu_seen ?? [])
    .map((x) => cleanMenuName(x.name))
    .filter((n) => n.length > 2 && !MENU_HEADING.test(n) && normalizeText(n) !== normalizeText(restaurant));
  m.menuListed = seen.length;
  m.menuChecked = menuHere.trim() ? seen.filter((n) => onMenu(menuHere, n)).length : 0;
  m.menuOnRealMenu = realMenu.trim() ? seen.filter((n) => onMenu(realMenu, n)).length : null;

  m.dishes = final.menu_moves.length;
  m.dishesOnMenuEvidence = final.menu_moves.filter((d) =>
    d.evidence.some((e) => okCites(e).some((c) => ["menu", "site"].includes(byId.get(c.source)?.kind ?? ""))),
  ).length;
  m.dishesAlreadyOnMenu = realMenu.trim() ? final.menu_moves.filter((d) => onMenu(realMenu, d.dish)).length : null;
  const listed = new Set(seen.map((n) => normalizeText(n)));
  m.dishesRepeatListedMenu = final.menu_moves.filter((d) => listed.has(normalizeText(cleanMenuName(d.dish)))).length;
  m.weekSpecific = dishMetrics(final, sources).weekSpecific;
  return m;
}

/** Verified claims backed only by Tavily sources, with the sentences they cite: facts no other source had. */
export function tavilyOnlyFacts(final: Playbook, sources: Source[]): { group: ClaimGroup; claim: string; cites: { span: string; kind: string; url?: string; sentence: string }[] }[] {
  const ledger = SourceLedger.from(sources);
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  return claimsOf(final)
    .filter(({ e }) => e.verified && okCites(e).length && okCites(e).every((c) => byId.get(c.source)?.provider === "Tavily"))
    .map(({ group, e }) => ({
      group,
      claim: e.text,
      cites: okCites(e).map((c) => {
        const src = byId.get(c.source);
        return { span: c.span ?? c.source, kind: src?.kind ?? "", url: src?.url, sentence: c.span ? (ledger.span(c.span)?.text ?? c.quote) : c.quote };
      }),
    }));
}
