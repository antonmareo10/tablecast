// Held-out round (verifier v7): the 8 restaurants of eval/heldout.json, committed before any run and never used
// while tuning v3–v6 (those used eval/restaurants.json).
//
//   1. npx tsx scripts/eval-routing.ts --restaurants eval/heldout.json --runs runs-v7-heldout --configs ultra-medium,super-medium \
//        --summary eval/results/heldout-routing.md      (evidence packs once, then Quick and Economy plans)
//   2. npx tsx scripts/eval-heldout.ts                    (the no-data baseline, then the table)
//
// The baseline is the app's own comparison: the same writer model (Ultra for Quick, Super for Economy) asked the
// same question with no tools and no data (agent.ts, baselinePrompt). It has no sources, so nothing in it can be
// verified; its three dishes were read by hand for "tied to this week" (eval/heldout-baseline-labels.json, written
// after reading each answer next to that week's forecast, events and holidays) and matched by code against the
// restaurant's fetched menu. Raw runs stay in eval/results (gitignored); the table goes to stdout and
// eval/results/heldout-table.md, the per-plan numbers to eval/metrics-v7-heldout.csv.

import fs from "node:fs";
import path from "node:path";
import { baselinePrompt, packToday, type EvidencePack } from "../src/lib/agent";
import { moneyIn } from "../src/lib/amounts";
import { pastDates, scheduleFields } from "../src/lib/dates";
import { baseline, defaultRouting, type Routing } from "../src/lib/nebius-agent";
import type { AgentEvent, EngineCall, Playbook } from "../src/lib/types";
import { argOne, loadRestaurants, median, menuTextOf, onMenu, pct, readPack, RESULTS, ROOT, secs, slugOf } from "./eval-common";

const RUNS = argOne("runs") ?? "runs-v7-heldout";
const LIST = argOne("restaurants") ?? path.join("eval", "heldout.json");
const LABELS = path.join(ROOT, "eval", "heldout-baseline-labels.json");
const MODELS: Record<string, string> = { "ultra-medium": "nvidia/Nemotron-3-Ultra-550b-a55b", "super-medium": "nvidia/nemotron-3-super-120b-a12b" };

type Run = {
  slug: string;
  config: string;
  report: { ok: boolean; retried: boolean; claims: number; verifiedFirstPass: number; verifiedFinal: number; amounts?: { checked: number; unbackedFirst: number; unbackedFinal: number }; dates?: { checked: number; pastFirst: number; pastFinal: number; dropped: number }; draft?: unknown };
  final?: Playbook | null;
  calls: EngineCall[];
  ms: number;
  usd: number;
  writerMs: number;
  weekSpecific: number | null;
  newDishes: number | null;
};
type Base = { slug: string; config: string; model: string; text: string; ms: number; usd: number };
type Labels = Record<string, Record<string, { dishes: string[]; week: boolean[]; note?: string }>>;

async function runBaseline(slug: string, config: string, req: { restaurant: string; city: string; goal?: string }): Promise<Base> {
  const file = path.join(RESULTS, RUNS, `${slug}__baseline-${config}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const calls: EngineCall[] = [];
  const routing: Routing = { ...defaultRouting(), reasoning: MODELS[config] };
  const emit = (e: AgentEvent) => {
    if (e.type === "engine") calls.push(e.call);
  };
  const t0 = Date.now();
  const text = await baseline(baselinePrompt(req.restaurant, req.city, req.goal?.trim() || "a stronger week", "English"), routing, emit);
  const out: Base = { slug, config, model: MODELS[config], text, ms: Date.now() - t0, usd: calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0) };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Whether a pack's own menu or site pages hold any text to compare dish names with. */
const hasMenu = (pack: EvidencePack) => menuTextOf(pack.sources).trim().length > 0;

async function main() {
  const list = loadRestaurants(LIST);
  const labels: Labels = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, "utf8")) : {};
  const rows: string[] = [];
  const csv = ["restaurant,writer,published,retried,claims,verified_first_pass,verified_final,amounts_checked,amounts_unbacked_first,amounts_unbacked_final,dates_checked,dates_past_first,dates_past_final,dates_dropped,writer_ms,write_and_verify_ms,gather_ms,usd_writer,usd_research,tavily_credits"];
  const perConfig = new Map<string, { runs: Run[]; gatherMs: number[]; researchUsd: number[] }>();
  const bases: Base[] = [];
  const perRestaurant: string[] = [];

  for (const req of list) {
    const slug = slugOf(req);
    const cached = readPack(slug) as ({ pack: EvidencePack; calls: EngineCall[]; gatherMs?: number } | null);
    if (!cached) {
      console.log(`${slug}: no evidence pack (run eval-routing first)`);
      continue;
    }
    const researchUsd = cached.calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0);
    const cells: string[] = [];
    for (const config of Object.keys(MODELS)) {
      const file = path.join(RESULTS, RUNS, `${slug}__${config}.json`);
      const b = await runBaseline(slug, config, req);
      bases.push(b);
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as Run;
      const agg = perConfig.get(config) ?? { runs: [], gatherMs: [], researchUsd: [] };
      agg.runs.push(run);
      if (cached.gatherMs) agg.gatherMs.push(cached.gatherMs);
      agg.researchUsd.push(researchUsd);
      perConfig.set(config, agg);
      const r = run.report;
      cells.push(`${r.ok ? `${r.verifiedFinal}/${r.claims}` : "not published"}`);
      csv.push(
        [slug, config, r.ok, r.retried, r.claims, r.verifiedFirstPass, r.verifiedFinal, r.amounts?.checked ?? "", r.amounts?.unbackedFirst ?? "", r.amounts?.unbackedFinal ?? "", r.dates?.checked ?? "", r.dates?.pastFirst ?? "", r.dates?.pastFinal ?? "", r.dates?.dropped ?? "", run.writerMs, run.ms, cached.gatherMs ?? "", run.usd.toFixed(6), researchUsd.toFixed(6), cached.pack.tavilyCredits].join(","),
      );
    }
    perRestaurant.push(`${req.restaurant} (${req.city}): ${cells.join(" · ")} · ${cached.pack.sources.length} sources, ${cached.pack.tavilyCredits} Tavily credits${hasMenu(cached.pack) ? "" : ", no menu page fetched"}`);
  }

  // ---- the table ----
  for (const [config, agg] of perConfig) {
    const ok = agg.runs.filter((r) => r.report.ok);
    const claims = ok.reduce((s, r) => s + r.report.claims, 0);
    const first = ok.reduce((s, r) => s + r.report.verifiedFirstPass, 0);
    const final = ok.reduce((s, r) => s + r.report.verifiedFinal, 0);
    const amounts = ok.map((r) => r.report.amounts).filter((a) => !!a) as NonNullable<Run["report"]["amounts"]>[];
    const aChecked = amounts.reduce((s, a) => s + a.checked, 0);
    const week = ok.map((r) => r.weekSpecific).filter((x): x is number => x != null);
    // Dishes proposed as new that the restaurant's fetched menu already sells (exact name), and menu items the
    // plan lists as current that are really on its fetched pages.
    let onMenuAlready = 0;
    let dishesChecked = 0;
    let seenListed = 0;
    let seenFound = 0;
    let datesPastFirst = 0;
    let datesPastFinal = 0;
    let datesChecked = 0;
    for (const r of ok) {
      const pack = readPack(r.slug)!.pack;
      const menu = menuTextOf(pack.sources);
      if (menu.trim() && r.final) {
        dishesChecked += r.final.menu_moves.length;
        onMenuAlready += r.final.menu_moves.filter((m) => onMenu(menu, m.dish)).length;
      }
      const draft = r.report.draft as { menu_seen?: { name: string }[] } | undefined;
      for (const m of draft?.menu_seen ?? []) {
        seenListed += 1;
        if (onMenu(menu, m.name.replace(/\s*\([^)]*\)\s*/g, " ").trim())) seenFound += 1;
      }
      if (r.report.dates) {
        datesChecked += r.report.dates.checked;
        datesPastFirst += r.report.dates.pastFirst + 0;
        datesPastFinal += r.report.dates.pastFinal;
      } else if (r.final) {
        datesChecked += pastDates(scheduleFields(r.final), packToday(pack)).checked;
      }
    }
    const e2e = agg.runs.map((r, i) => (agg.gatherMs[i] ?? NaN) + r.ms);
    rows.push(
      `| ${config === "ultra-medium" ? "Quick (Ultra · medium)" : "Economy (Super · medium)"} | ${ok.length}/${agg.runs.length} | ${agg.runs.filter((r) => r.report.retried).length} | ${(claims / (ok.length || 1)).toFixed(1)} | ${pct(first / claims)} | ${pct(final / claims)} | ${aChecked ? `${pct(1 - amounts.reduce((s, a) => s + a.unbackedFirst, 0) / aChecked)} → ${pct(1 - amounts.reduce((s, a) => s + a.unbackedFinal, 0) / aChecked)} (${aChecked})` : "–"} | ${pct(week.reduce((a, b) => a + b, 0) / (week.length || NaN))} | ${onMenuAlready}/${dishesChecked} | ${seenFound}/${seenListed} | ${datesPastFirst} → ${datesPastFinal} (${datesChecked}) | ${secs(median(agg.runs.map((r) => r.writerMs)))} / ${secs(Math.max(...agg.runs.map((r) => r.writerMs)))} | ${secs(median(e2e))} / ${secs(Math.max(...e2e))} | $${median(agg.runs.map((r) => r.usd)).toFixed(3)} + $${median(agg.researchUsd).toFixed(3)} |`,
    );
  }
  for (const config of Object.keys(MODELS)) {
    const bs = bases.filter((b) => b.config === config);
    if (!bs.length) continue;
    let tied = 0;
    let named = 0;
    let onMenuAlready = 0;
    let checked = 0;
    let labelled = 0;
    for (const b of bs) {
      const l = labels[b.slug]?.[config];
      if (!l) continue;
      labelled += 1;
      named += l.dishes.length;
      tied += l.week.filter(Boolean).length;
      const pack = readPack(b.slug)!.pack;
      const menu = menuTextOf(pack.sources);
      if (menu.trim()) {
        checked += l.dishes.length;
        onMenuAlready += l.dishes.filter((d) => onMenu(menu, d)).length;
      }
    }
    const amounts = bs.reduce((s, b) => s + moneyIn(b.text).length, 0);
    rows.push(
      `| Baseline: ${config === "ultra-medium" ? "Ultra" : "Super"}, no tools, no data | ${bs.length}/${bs.length} | – | 0 | – | – (nothing cited) | 0% (${amounts} amounts, none checkable) | ${labelled ? `${pct(tied / named)} (by hand)` : "not labelled"} | ${labelled ? `${onMenuAlready}/${checked}` : "–"} | – | – | ${secs(median(bs.map((b) => b.ms)))} / ${secs(Math.max(...bs.map((b) => b.ms)))} | – | $${median(bs.map((b) => b.usd)).toFixed(4)} |`,
    );
  }

  const md = [
    `| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, after repair | Prices in the text backed (first → final) | Dishes tied to this week | New dishes already on the fetched menu | Listed menu items found on the fetched pages | Fields dated before today (first → final) | Writer time (median / slowest) | End to end (median / slowest) | Cost / plan (median, writer + research) |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `Per restaurant (verified/written, Quick · Economy): ${perRestaurant.join("; ")}.`,
  ].join("\n");
  fs.writeFileSync(path.join(RESULTS, "heldout-table.md"), `${md}\n`);
  fs.writeFileSync(path.join(ROOT, "eval", "metrics-v7-heldout.csv"), `${csv.join("\n")}\n`);
  console.log(md);
  if (process.argv.includes("--baselines")) for (const b of bases) console.log(`\n### ${b.slug} · ${b.config}\n${b.text}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
