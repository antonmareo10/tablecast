// Model comparison: the four Nemotron text models on Token Factory, alone and tiered, writing and checking a plan
// from the SAME cached evidence. The design was fixed and committed before any run: eval/MODELS-DESIGN.md.
//
//   npx tsx scripts/eval-models.ts [--strategies ultra,nano] [--only slug1,slug2] [--runs runs-models] [--cap 5] [--parallel 5]
//
// No research and no Tavily: every strategy writes from the evidence packs of the second held-out round
// (eval/results/packs/<slug>.json, gathered on 22 Oct), and the script stops if one is missing.
// "Alone" means one model writes the plan and repairs what fails the check (failed claims, unbacked prices,
// past dates). "Tiered" means a smaller model writes and Ultra repairs. Every claim is verified in code exactly
// as in production (writeAndVerify). Runs are cached in eval/results/<runs>/ (gitignored: third-party page text);
// the per-plan metrics go to eval/metrics-<runs>.csv and the table to eval/results/<runs>-table.md.

import fs from "node:fs";
import path from "node:path";
import { writeAndVerify, type WriteReport } from "../src/lib/agent";
import { defaultRouting } from "../src/lib/nebius-agent";
import type { AgentEvent, EngineCall, Playbook } from "../src/lib/types";
import { argList, argOne, dishMetrics, loadRestaurants, median, pct, readPack, RESULTS, ROOT, secs, slugOf } from "./eval-common";

const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

export const STRATEGIES: Record<string, { writer: string; repair: string; label: string }> = {
  ultra: { writer: ULTRA, repair: ULTRA, label: "Ultra alone (production Quick)" },
  super: { writer: SUPER, repair: SUPER, label: "Super alone" },
  lightning: { writer: LIGHTNING, repair: LIGHTNING, label: "Lightning alone" },
  nano: { writer: NANO, repair: NANO, label: "Nano alone" },
  "super>ultra": { writer: SUPER, repair: ULTRA, label: "Super writes, Ultra repairs (production Economy)" },
  "lightning>ultra": { writer: LIGHTNING, repair: ULTRA, label: "Lightning writes, Ultra repairs" },
  "nano>ultra": { writer: NANO, repair: ULTRA, label: "Nano writes, Ultra repairs" },
};

// As in the earlier eval rounds, one writing attempt may take up to 7 minutes (the live app allows 150-170 s).
process.env.NEBIUS_WRITER_MAX_MS ??= "420000";
// Every repair runs at low effort, whatever the model (production uses "none" only when the repair model is the
// research model, which no production setting does).
process.env.NEBIUS_REPAIR_EFFORT ??= "low";

const RUNS_DIR = argOne("runs") ?? "runs-models";
const CAP_USD = Number(argOne("cap") ?? 5);
const PARALLEL = Number(argOne("parallel") ?? 5);

type Run = {
  slug: string;
  strategy: string;
  writer: string;
  repair: string;
  report: Omit<WriteReport, "playbook">;
  final?: Playbook | null;
  calls: EngineCall[];
  ms: number; // write + check, wall clock
  usd: number;
  writerMs: number;
  writerUsd: number;
  repairUsd: number;
  weekSpecific: number | null;
  newDishes: number | null;
};

const runFile = (slug: string, strategy: string) => path.join(RESULTS, RUNS_DIR, `${slug}__${strategy.replace(">", "-to-")}.json`);

async function runOne(slug: string, strategy: string): Promise<Run> {
  const file = runFile(slug, strategy);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const { writer, repair } = STRATEGIES[strategy];
  const { pack } = readPack(slug)!;
  const calls: EngineCall[] = [];
  const emit = (e: AgentEvent) => {
    if (e.type === "engine") calls.push(e.call);
  };
  const started = Date.now();
  const report = await writeAndVerify(pack, emit, { routing: { ...defaultRouting(), reasoning: writer, repair, effort: "medium" } });
  const { playbook, ...rest } = report;
  const writing = calls.filter((c) => c.phase === "synthesize");
  const cost = (cs: EngineCall[]) => cs.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0);
  const run: Run = {
    slug,
    strategy,
    writer,
    repair,
    report: rest,
    final: playbook,
    calls,
    ms: Date.now() - started,
    usd: cost(calls),
    writerMs: writing.reduce((s, c) => s + c.ms, 0),
    writerUsd: cost(writing),
    repairUsd: cost(calls.filter((c) => c.phase !== "synthesize")),
    ...dishMetrics(playbook, pack.sources),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(run));
  return run;
}

/** True if a failed run looks like the key or the account was refused (no point starting more plans). */
function refused(run: Run): boolean {
  return !run.report.ok && run.calls.some((c) => /\b(401|402|403)\b|insufficient|credit|balance|quota/i.test(c.note ?? ""));
}

async function main() {
  const list = loadRestaurants(argOne("restaurants") ?? path.join("eval", "heldout2.json"));
  const only = argList("only");
  const strategies = argList("strategies") ?? Object.keys(STRATEGIES);
  for (const s of strategies) if (!STRATEGIES[s]) throw new Error(`unknown strategy ${s}`);
  const slugs = list.map(slugOf).filter((s) => !only || only.includes(s));
  const missing = slugs.filter((s) => !readPack(s));
  if (missing.length) throw new Error(`no cached evidence pack for ${missing.join(", ")}: this script never gathers (no Tavily calls)`);

  // Jobs in list order, all strategies of a restaurant together; cached runs cost nothing and are reused.
  const jobs = slugs.flatMap((slug) => strategies.map((strategy) => ({ slug, strategy })));
  const runs: Run[] = [];
  let spent = 0;
  let stop = "";
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !stop) {
      const { slug, strategy } = jobs[next++];
      const cached = fs.existsSync(runFile(slug, strategy));
      if (!cached && spent >= CAP_USD) {
        stop = `spend cap reached ($${spent.toFixed(2)} of $${CAP_USD})`;
        break;
      }
      try {
        const r = await runOne(slug, strategy);
        runs.push(r);
        if (!cached) spent += r.usd;
        const rep = r.report;
        console.log(
          `${slug.padEnd(30)} ${strategy.padEnd(16)} ${rep.ok ? "ok  " : "FAIL"} ${rep.verifiedFinal}/${rep.claims} (first ${rep.verifiedFirstPass}, fixed ${rep.repaired.fixed}, dropped ${rep.repaired.dropped}) ` +
            `writer ${secs(r.writerMs)} total ${secs(r.ms)} $${r.usd.toFixed(4)}${rep.retried ? ` retried(${rep.finish})` : ""}${cached ? " [cached]" : ""} · spent $${spent.toFixed(3)}`,
        );
        if (refused(r)) stop = "Token Factory refused a call (key or credit): stopped";
      } catch (err) {
        console.log(`${slug} ${strategy}: ERROR ${String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (stop) console.log(`\n!! ${stop}`);

  // ---- aggregate (verification shares pooled over the claims of published plans, as in eval-routing.ts) ----
  const rows = strategies.map((strategy) => {
    const rs = runs.filter((r) => r.strategy === strategy);
    const ok = rs.filter((r) => r.report.ok);
    const sum = (f: (r: Run) => number) => ok.reduce((s, r) => s + f(r), 0);
    const claims = sum((r) => r.report.claims);
    const final = sum((r) => r.report.verifiedFinal);
    const first = sum((r) => r.report.verifiedFirstPass);
    const amounts = ok.map((r) => r.report.amounts).filter(Boolean);
    const amountsChecked = amounts.reduce((s, a) => s + a.checked, 0);
    const week = ok.map((r) => r.weekSpecific).filter((x): x is number => x != null);
    return {
      strategy,
      label: STRATEGIES[strategy].label,
      runs: rs.length,
      published: ok.length,
      retries: rs.filter((r) => r.report.retried).length,
      claims,
      claimsPerPlan: ok.length ? claims / ok.length : NaN,
      verifiedPerPlan: ok.length ? final / ok.length : NaN,
      firstPass: claims ? first / claims : NaN,
      final: claims ? final / claims : NaN,
      rejected: claims - first,
      fixed: sum((r) => r.report.repaired.fixed),
      dropped: sum((r) => r.report.repaired.dropped),
      unverified: sum((r) => r.report.claims - r.report.repaired.dropped - r.report.verifiedFinal),
      amountsChecked,
      amountsFirst: amountsChecked ? 1 - amounts.reduce((s, a) => s + a.unbackedFirst, 0) / amountsChecked : NaN,
      amountsFinal: amountsChecked ? 1 - amounts.reduce((s, a) => s + a.unbackedFinal, 0) / amountsChecked : NaN,
      week: week.length ? week.reduce((a, b) => a + b, 0) / week.length : NaN,
      writerMs: median(rs.map((r) => r.writerMs)),
      writerMaxMs: rs.length ? Math.max(...rs.map((r) => r.writerMs)) : NaN,
      totalMs: median(rs.map((r) => r.ms)),
      totalMaxMs: rs.length ? Math.max(...rs.map((r) => r.ms)) : NaN,
      usd: median(rs.map((r) => r.usd)),
      totalUsd: rs.reduce((s, r) => s + r.usd, 0),
      writerShare: rs.reduce((s, r) => s + r.usd, 0) ? rs.reduce((s, r) => s + r.writerUsd, 0) / rs.reduce((s, r) => s + r.usd, 0) : NaN,
    };
  });

  const usd = (x: number, d = 3) => (Number.isFinite(x) ? `$${x.toFixed(d)}` : "–");
  const md = [
    `| Strategy | Plans published | Retries | Claims / plan | Verified, first pass | Verified, after repair | Verified claims / plan | Rejected at first pass → fixed / dropped / left unverified | Prices in the text backed (first → final) | Dishes tied to this week | Writer time (median / slowest) | Write + check (median / slowest) | Cost / plan (median) | Cost, all its plans (writer share) |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.published}/${r.runs} | ${r.retries} | ${Number.isFinite(r.claimsPerPlan) ? r.claimsPerPlan.toFixed(1) : "–"} | ${pct(r.firstPass)} | ${pct(r.final)} | ${Number.isFinite(r.verifiedPerPlan) ? r.verifiedPerPlan.toFixed(1) : "–"} | ${r.rejected} → ${r.fixed} / ${r.dropped} / ${r.unverified} | ${r.amountsChecked ? `${pct(r.amountsFirst)} → ${pct(r.amountsFinal)} (${r.amountsChecked})` : "–"} | ${pct(r.week)} | ${secs(r.writerMs)} / ${secs(r.writerMaxMs)} | ${secs(r.totalMs)} / ${secs(r.totalMaxMs)} | ${usd(r.usd, 4)} | ${usd(r.totalUsd, 2)} (${pct(r.writerShare)}) |`,
    ),
  ].join("\n");
  const total = runs.reduce((s, r) => s + r.usd, 0);
  const tail = `\n${runs.length} plans, $${total.toFixed(2)} of Nemotron in all (this invocation started ${spent ? `$${spent.toFixed(2)} of new plans` : "no new plans"}), 0 Tavily credits.`;
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, `${RUNS_DIR}-table.md`), `${md}\n${tail}\n`);

  // Per-plan metrics without any third-party text, committed so the table can be re-derived.
  const csv = [
    "restaurant,strategy,writer,repair,published,retried,finish,claims,verified_first_pass,fixed,dropped,verified_final,amounts_checked,amounts_unbacked_first,amounts_unbacked_final,week_specific,writer_ms,total_ms,writer_usd,repair_usd,usd",
    ...runs
      .sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug) || strategies.indexOf(a.strategy) - strategies.indexOf(b.strategy))
      .map((r) =>
        [
          r.slug,
          r.strategy,
          r.writer.split("/").pop(),
          r.repair.split("/").pop(),
          r.report.ok,
          r.report.retried,
          r.report.finish ?? "",
          r.report.claims,
          r.report.verifiedFirstPass,
          r.report.repaired.fixed,
          r.report.repaired.dropped,
          r.report.verifiedFinal,
          r.report.amounts?.checked ?? "",
          r.report.amounts?.unbackedFirst ?? "",
          r.report.amounts?.unbackedFinal ?? "",
          r.weekSpecific == null ? "" : r.weekSpecific.toFixed(3),
          r.writerMs,
          r.ms,
          r.writerUsd.toFixed(6),
          r.repairUsd.toFixed(6),
          r.usd.toFixed(6),
        ].join(","),
      ),
  ].join("\n");
  fs.writeFileSync(path.join(ROOT, "eval", `metrics-${RUNS_DIR}.csv`), `${csv}\n`);
  console.log(`\n${md}\n${tail}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
