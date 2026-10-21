// Tavily ablation: what does live web research add to the plan?
//
// For every restaurant in eval/restaurants.json, the cached evidence pack of the routing eval
// (eval/results/packs/<slug>.json — OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, plus Nemotron
// Lightning's research with Tavily Map/Search/Extract) is written into a plan twice by the production Quick
// writer (defaultRouting(): Nemotron Ultra, medium effort) with writeAndVerify, exactly as in the app:
//   full       — the pack as gathered;
//   no-tavily  — the same pack without any Tavily source and without the Tavily Map line of the context
//                (scripts/tavily-ablation.ts, withoutTavily).
// Then both plans are measured in code (planMetrics): verified claims, what they cite, the real menu, rivals'
// prices, what guests say, prices in the text. No Tavily call is made: the packs are reused as cached.
//
// Usage: npx tsx scripts/eval-tavily.ts [--only slug1,slug2] [--variants full,no-tavily] [--repeats 2]
//        [--runs runs-tavily] [--reuse-full runs-v6-languages] [--max-usd 2] [--aggregate-only]
// --repeats 2 adds a second sample of each variant; for the full variant it is taken from the routing eval's
// Ultra-medium run on the same pack (--reuse-full dir) when that exists, so it costs nothing.
// Needs NEBIUS_API_KEY. Raw runs go to eval/results/<runs>/ (gitignored: they hold third-party page text);
// per-plan metrics (no third-party text) go to eval/metrics-tavily.csv.

import fs from "node:fs";
import path from "node:path";
import { writeAndVerify, type EvidencePack, type WriteReport } from "../src/lib/agent";
import { defaultRouting } from "../src/lib/nebius-agent";
import type { AgentEvent, EngineCall, Playbook, Source } from "../src/lib/types";
import { argList, argOne, loadRestaurants, median, pct, readPack, RESULTS, ROOT, secs, slugOf } from "./eval-common";
import { planMetrics, tavilyOnlyFacts, withoutTavily, type PlanMetrics } from "./tavily-ablation";

// Same allowance as the routing eval, so the reused runs and the new ones ran under the same limits.
process.env.NEBIUS_WRITER_MAX_MS ??= "420000";

type Variant = "full" | "no-tavily";
const VARIANTS: Variant[] = ["full", "no-tavily"];
const RUNS_DIR = argOne("runs") ?? "runs-tavily";
const REUSE_DIR = argOne("reuse-full") ?? "runs-v6-languages";
const REPEATS = Math.max(1, Number(argOne("repeats") ?? 1));
const MAX_USD = Number(argOne("max-usd") ?? 2);
const AGGREGATE_ONLY = process.argv.includes("--aggregate-only");

type RunResult = {
  slug: string;
  variant: Variant;
  sample: number;
  origin: string; // where the run came from: this script's runs dir, or the routing eval's run it reuses
  report: Omit<WriteReport, "playbook">;
  final?: Playbook | null;
  calls: EngineCall[];
  usd: number;
  writerMs: number;
  writerPrompt: number;
};

let spent = 0; // US$ of new inference in this invocation
let reserved = 0; // US$ set aside for runs in flight (runs start in parallel)
const RESERVE_USD = 0.2; // above the dearest Ultra-medium plan of the routing eval ($0.17)

function fileOf(slug: string, variant: Variant, sample: number): string {
  return path.join(RESULTS, RUNS_DIR, `${slug}__${variant}${sample > 1 ? `-${sample}` : ""}.json`);
}

function writerStats(calls: EngineCall[]) {
  const writer = calls.filter((c) => c.phase === "synthesize");
  return {
    usd: calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0),
    writerMs: writer.reduce((s, c) => s + c.ms, 0),
    writerPrompt: writer.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0),
  };
}

async function runVariant(slug: string, variant: Variant, sample: number, pack: EvidencePack): Promise<RunResult | null> {
  const file = fileOf(slug, variant, sample);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (variant === "full" && sample === 2) {
    // The routing eval's Ultra-medium run IS the production writer on this same pack and code: reuse it.
    const reused = path.join(RESULTS, REUSE_DIR, `${slug}__ultra-medium.json`);
    if (fs.existsSync(reused)) {
      const r = JSON.parse(fs.readFileSync(reused, "utf8"));
      return { slug, variant, sample, origin: `${REUSE_DIR}/${slug}__ultra-medium.json`, report: r.report, final: r.final, calls: r.calls, ...writerStats(r.calls) };
    }
  }
  if (AGGREGATE_ONLY) return null;
  if (spent + reserved + RESERVE_USD > MAX_USD) {
    console.log(`   ${variant}#${sample}: skipped, it could exceed the budget of $${MAX_USD} ($${spent.toFixed(3)} spent)`);
    return null;
  }
  reserved += RESERVE_USD;
  const calls: EngineCall[] = [];
  const emit = (e: AgentEvent) => {
    if (e.type === "engine") calls.push(e.call);
  };
  let report: WriteReport;
  try {
    report = await writeAndVerify(pack, emit, { routing: defaultRouting() });
  } finally {
    reserved -= RESERVE_USD;
    spent += writerStats(calls).usd;
  }
  const { playbook, ...rest } = report;
  const result: RunResult = { slug, variant, sample, origin: `${RUNS_DIR}/${path.basename(file)}`, report: rest, final: playbook, calls, ...writerStats(calls) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

type Row = RunResult & { m: PlanMetrics };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");

async function main() {
  const only = argList("only");
  const variants = (argList("variants") ?? VARIANTS) as Variant[];
  const rows: Row[] = [];
  const packs: { slug: string; credits: number; tavilySources: number; sources: number; researchUsd: number; removedLines: number }[] = [];
  const examples: Record<string, ReturnType<typeof tavilyOnlyFacts>> = {};

  for (const req of loadRestaurants()) {
    const slug = slugOf(req);
    if (only && !only.includes(slug)) continue;
    const cached = readPack(slug);
    if (!cached) {
      console.log(`\n== ${slug}: no cached pack in eval/results/packs (run the routing eval first); skipped`);
      continue;
    }
    const full = cached.pack;
    const ablated = withoutTavily(full);
    packs.push({
      slug,
      credits: full.tavilyCredits,
      tavilySources: ablated.removedSources,
      sources: full.sources.length,
      researchUsd: cached.calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0),
      removedLines: ablated.removedLines.length,
    });
    console.log(
      `\n== ${req.restaurant}, ${req.city}: ${full.sources.length} sources, ${ablated.removedSources} from Tavily (${full.tavilyCredits} credits); ` +
        `context lines from Tavily: ${ablated.removedLines.length}`,
    );
    const packOf: Record<Variant, EvidencePack> = { full, "no-tavily": ablated.pack };
    const jobs = variants.flatMap((v) => Array.from({ length: REPEATS }, (_, i) => ({ v, sample: i + 1 })));
    const done = await Promise.all(
      jobs.map(({ v, sample }) =>
        runVariant(slug, v, sample, packOf[v]).catch((err) => {
          console.log(`   ${v}#${sample}: ERROR ${String(err).slice(0, 200)}`);
          return null;
        }),
      ),
    );
    for (const r of done) {
      if (!r) continue;
      const sources: Source[] = packOf[r.variant].sources;
      const m = planMetrics(r.report, r.final, sources, full.sources, req.restaurant);
      rows.push({ ...r, m });
      if (r.variant === "full" && r.final && !examples[slug]) examples[slug] = tavilyOnlyFacts(r.final, sources);
      console.log(
        `   ${`${r.variant}#${r.sample}`.padEnd(12)} ${m.published ? "ok " : "FAIL"} verified ${m.verified}/${m.claims} (first ${m.verifiedFirst}) ` +
          `tavily-backed ${m.verifiedTavily} · guests ${m.guestsFromWeb}/${m.verifiedByGroup.guests} · menu ${m.menuChecked}/${m.menuListed} (real ${m.menuOnRealMenu ?? "–"}) · ` +
          `dishes on menu ${m.dishesOnMenuEvidence}/${m.dishes} · rival prices ${m.rivalPriceClaims} · sources ${m.sourcesCited} · $${r.usd.toFixed(4)} ${secs(r.writerMs)}` +
          (r.origin.startsWith(RUNS_DIR) ? "" : ` [reused ${r.origin}]`),
      );
    }
  }

  // ---- aggregate -------------------------------------------------------------------------------
  // The main table pools only the samples both variants have for the same restaurants (paired); every sample is
  // also shown on its own below, to see how much one sample moves.
  const samples = [...new Set(rows.map((r) => r.sample))].sort();
  const keyOf = (v: Variant, s: number) =>
    rows
      .filter((r) => r.variant === v && r.sample === s)
      .map((r) => r.slug)
      .sort()
      .join(",");
  const pairedSamples = samples.filter((s) => keyOf("full", s) && keyOf("full", s) === keyOf("no-tavily", s));
  const agg = (v: Variant, only: number[] = pairedSamples) => {
    const rs = rows.filter((r) => r.variant === v && only.includes(r.sample));
    const ok = rs.filter((r) => r.m.published);
    const M = ok.map((r) => r.m);
    const claims = sum(M.map((m) => m.claims));
    const verified = sum(M.map((m) => m.verified));
    const dishes = sum(M.map((m) => m.dishes));
    const amountsChecked = sum(M.map((m) => m.amounts.checked));
    const week = M.map((m) => m.weekSpecific).filter((x): x is number => x != null);
    return {
      runs: rs.length,
      published: ok.length,
      claimsPerPlan: claims / (ok.length || NaN),
      verifiedPerPlan: verified / (ok.length || NaN),
      firstShare: sum(M.map((m) => m.verifiedFirst)) / claims,
      finalShare: verified / claims,
      tavilyShare: sum(M.map((m) => m.verifiedTavily)) / verified,
      onlyTavilyShare: sum(M.map((m) => m.verifiedOnlyTavily)) / verified,
      guestsPerPlan: mean(M.map((m) => m.verifiedByGroup.guests)),
      byProvider: (p: string) => mean(M.map((m) => m.verifiedByProvider[p] ?? 0)),
      guestsWebPerPlan: mean(M.map((m) => m.guestsFromWeb)),
      plansWithGuestsWeb: M.filter((m) => m.guestsFromWeb > 0).length,
      menuShown: M.filter((m) => m.menuChecked >= 3).length,
      menuListedPerPlan: mean(M.map((m) => m.menuListed)),
      menuChecked: sum(M.map((m) => m.menuChecked)),
      menuOnReal: sum(M.map((m) => m.menuOnRealMenu ?? 0)),
      menuListed: sum(M.map((m) => m.menuListed)),
      dishesOnMenuEvidence: sum(M.map((m) => m.dishesOnMenuEvidence)) / dishes,
      dishesAlreadyOnMenu: sum(M.map((m) => m.dishesAlreadyOnMenu ?? 0)),
      dishesRepeat: sum(M.map((m) => m.dishesRepeatListedMenu)),
      plansWithRepeat: M.filter((m) => m.dishesRepeatListedMenu > 0).length,
      dishes,
      rivalPrices: sum(M.map((m) => m.rivalPriceClaims)),
      plansWithRivalPrices: M.filter((m) => m.rivalPriceClaims > 0).length,
      news: sum(M.map((m) => m.newsClaims)),
      plansWithNews: M.filter((m) => m.newsClaims > 0).length,
      sourcesPerPlan: mean(M.map((m) => m.sourcesCited)),
      week: mean(week),
      amountsChecked,
      amountsFirst: 1 - sum(M.map((m) => m.amounts.unbackedFirst)) / amountsChecked,
      amountsFinal: 1 - sum(M.map((m) => m.amounts.unbackedFinal)) / amountsChecked,
      usd: median(rs.map((r) => r.usd)),
      writerMs: median(rs.map((r) => r.writerMs)),
      prompt: median(rs.map((r) => r.writerPrompt)),
    };
  };
  const F = agg("full");
  const N = agg("no-tavily");
  const line = (label: string, f: string, n: string) => `| ${label} | ${f} | ${n} |`;
  const table = [
    `| Paired: the same ${F.runs} packs, sample${pairedSamples.length > 1 ? "s" : ""} ${pairedSamples.join(", ")} | With Tavily | Without Tavily |`,
    `|---|---|---|`,
    line("Plans published", `${F.published}/${F.runs}`, `${N.published}/${N.runs}`),
    line("Claims written / verified (mean per plan)", `${num(F.claimsPerPlan)} / ${num(F.verifiedPerPlan)}`, `${num(N.claimsPerPlan)} / ${num(N.verifiedPerPlan)}`),
    line("Share verified, first pass → after repair", `${pct(F.firstShare)} → ${pct(F.finalShare)}`, `${pct(N.firstShare)} → ${pct(N.finalShare)}`),
    line("Verified claims citing a Tavily source (only Tavily)", `${pct(F.tavilyShare)} (${pct(F.onlyTavilyShare)})`, "–"),
    line(
      "Verified claims per plan citing: web pages (Tavily) · forecast · events · the block",
      ["Tavily", "Open-Meteo", "Ticketmaster", "OpenStreetMap"].map((p) => num(F.byProvider(p))).join(" · "),
      ["Tavily", "Open-Meteo", "Ticketmaster", "OpenStreetMap"].map((p) => num(N.byProvider(p))).join(" · "),
    ),
    line("Distinct sources behind verified claims (mean)", num(F.sourcesPerPlan), num(N.sourcesPerPlan)),
    line(
      "“Loved for / watch outs” claims verified per plan: citing web pages (Tavily) / citing only forecast, events or the block",
      `${num(F.guestsWebPerPlan)} / ${num(F.guestsPerPlan - F.guestsWebPerPlan)}`,
      `${num(N.guestsWebPerPlan)} / ${num(N.guestsPerPlan - N.guestsWebPerPlan)}`,
    ),
    line("Plans with a verified “loved for / watch outs” claim from the web", `${F.plansWithGuestsWeb}/${F.published}`, `${N.plansWithGuestsWeb}/${N.published}`),
    line(
      "Items the plan lists as its current menu: found on a page of its own sources · found on the real menu (Tavily pages) / listed",
      `${F.menuChecked} · ${F.menuOnReal} / ${F.menuListed}`,
      `${N.menuChecked} · ${N.menuOnReal} / ${N.menuListed}`,
    ),
    line("Plans showing “On your menu now” (≥ 3 checked items)", `${F.menuShown}/${F.published}`, `${N.menuShown}/${N.published}`),
    line("Dishes with a verified cite to the restaurant's menu or site", pct(F.dishesOnMenuEvidence), pct(N.dishesOnMenuEvidence)),
    line("Dishes already on the real menu (exact name, judged on the Tavily pages)", `${F.dishesAlreadyOnMenu} / ${F.dishes}`, `${N.dishesAlreadyOnMenu} / ${N.dishes}`),
    line(
      "“New” dishes named exactly like an item the plan lists as already on the menu (plans)",
      `${F.dishesRepeat} / ${F.dishes} (${F.plansWithRepeat}/${F.published})`,
      `${N.dishesRepeat} / ${N.dishes} (${N.plansWithRepeat}/${N.published})`,
    ),
    line("Verified claims with a competitor's price (plans with any)", `${F.rivalPrices} (${F.plansWithRivalPrices}/${F.published})`, `${N.rivalPrices} (${N.plansWithRivalPrices}/${N.published})`),
    line("Verified claims from this week's local news (plans with any)", `${F.news} (${F.plansWithNews}/${F.published})`, `${N.news} (${N.plansWithNews}/${N.published})`),
    line("Dishes tied to this week (verified cite to forecast, holiday, event or news)", pct(F.week), pct(N.week)),
    line("Prices in the text backed, first → final (amounts)", `${pct(F.amountsFirst)} → ${pct(F.amountsFinal)} (${F.amountsChecked})`, `${pct(N.amountsFirst)} → ${pct(N.amountsFinal)} (${N.amountsChecked})`),
    line("Writer prompt tokens (median)", num(F.prompt, 0), num(N.prompt, 0)),
    line("Writer time (median)", secs(F.writerMs), secs(N.writerMs)),
    line("Nemotron cost per plan, writer + repairs (median)", `$${num(F.usd, 4)}`, `$${num(N.usd, 4)}`),
  ];
  const origins = (v: Variant, s: number) => [...new Set(rows.filter((r) => r.variant === v && r.sample === s).map((r) => r.origin.split("/")[0]))].join(", ");
  const noise = [
    `| Variant · sample (runs from) | Plans | Verified / plan (share) | Citing Tavily | “Loved for / watch outs” from the web / plan | “On your menu now” shown | Dishes citing the menu | “New” dishes repeating the listed menu | Competitor-price claims |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...VARIANTS.flatMap((v) =>
      samples
        .filter((s) => keyOf(v, s))
        .map((s) => {
          const a = agg(v, [s]);
          return `| ${v} · ${s} (${origins(v, s)}) | ${a.published}/${a.runs} | ${num(a.verifiedPerPlan)} (${pct(a.finalShare)}) | ${pct(a.tavilyShare)} | ${num(a.guestsWebPerPlan)} | ${a.menuShown}/${a.published} | ${pct(a.dishesOnMenuEvidence)} | ${a.dishesRepeat}/${a.dishes} | ${a.rivalPrices} |`;
        }),
    ),
  ];
  const slugs = [...new Set(rows.map((r) => r.slug))];
  const paired = [
    `| Restaurant | Verified claims with Tavily | without |`,
    `|---|---|---|`,
    ...slugs.map((slug) => {
      const v = (variant: Variant) =>
        rows
          .filter((r) => r.slug === slug && r.variant === variant)
          .sort((a, b) => a.sample - b.sample)
          .map((r) => (r.m.published ? `${r.m.verified}/${r.m.claims}` : "failed"))
          .join(" · ");
      return `| ${slug} | ${v("full")} | ${v("no-tavily")} |`;
    }),
  ];
  const credits = packs.map((p) => p.credits);
  const research = [
    `Research step per plan (from the cached packs, n=${packs.length}): Tavily credits median ${median(credits)} (range ${Math.min(...credits)}–${Math.max(...credits)}); ` +
      `Tavily sources median ${median(packs.map((p) => p.tavilySources))} of ${median(packs.map((p) => p.sources))}; ` +
      `Nemotron Lightning research cost median $${median(packs.map((p) => p.researchUsd)).toFixed(4)}; ` +
      `context lines produced by Tavily (Tavily Map menu pages): ${sum(packs.map((p) => p.removedLines))} in ${packs.length} packs.`,
  ];
  const md = [...table, "", ...noise, "", ...paired, "", ...research, ""].join("\n");
  fs.writeFileSync(path.join(RESULTS, "tavily-table.md"), md);
  fs.writeFileSync(path.join(RESULTS, "tavily-examples.json"), JSON.stringify(examples, null, 2));

  const header =
    "restaurant,variant,sample,origin,published,claims,verified_first,verified_final,verified_tavily,verified_only_tavily,guests_verified,guests_from_web," +
    "menu_listed,menu_checked,menu_on_real_menu,dishes,dishes_menu_evidence,dishes_already_on_menu,dishes_repeat_listed_menu,rival_price_claims,news_claims," +
    "sources_cited,week_specific,amounts_checked,amounts_unbacked_first,amounts_unbacked_final,writer_prompt_tokens,writer_ms,usd";
  const csv = rows
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.variant.localeCompare(b.variant) || a.sample - b.sample)
    .map((r) =>
      [
        r.slug,
        r.variant,
        r.sample,
        r.origin,
        r.m.published,
        r.m.claims,
        r.m.verifiedFirst,
        r.m.verified,
        r.m.verifiedTavily,
        r.m.verifiedOnlyTavily,
        r.m.verifiedByGroup.guests,
        r.m.guestsFromWeb,
        r.m.menuListed,
        r.m.menuChecked,
        r.m.menuOnRealMenu ?? "",
        r.m.dishes,
        r.m.dishesOnMenuEvidence,
        r.m.dishesAlreadyOnMenu ?? "",
        r.m.dishesRepeatListedMenu,
        r.m.rivalPriceClaims,
        r.m.newsClaims,
        r.m.sourcesCited,
        r.m.weekSpecific == null ? "" : r.m.weekSpecific.toFixed(3),
        r.m.amounts.checked,
        r.m.amounts.unbackedFirst,
        r.m.amounts.unbackedFinal,
        r.writerPrompt,
        r.writerMs,
        r.usd.toFixed(6),
      ].join(","),
    );
  fs.writeFileSync(path.join(ROOT, "eval", "metrics-tavily.csv"), `${[header, ...csv].join("\n")}\n`);
  console.log(`\n${md}\nNew inference this run: $${spent.toFixed(4)}. Table: eval/results/tavily-table.md · examples: eval/results/tavily-examples.json · per plan: eval/metrics-tavily.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
