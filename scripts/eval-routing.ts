// Routing eval: which Nemotron should write the plan?
//
// For every restaurant in eval/restaurants.json (fixed before any run), the evidence is gathered ONCE
// (context in code + Lightning-driven Tavily research). Then each writer configuration below writes a
// plan from that SAME evidence pack, so the only thing that varies is the writer model / reasoning effort.
// Every claim is verified in code exactly as in production.
//
// Usage: npx tsx scripts/eval-routing.ts [--only slug1,slug2] [--configs a,b]
// Needs NEBIUS_API_KEY, TAVILY_API_KEY (and optionally TICKETMASTER_API_KEY) in the environment.
// Raw packs and runs go to eval/results/ (gitignored: they hold third-party page text);
// only the aggregate eval/SUMMARY.md is meant to be committed.

import fs from "node:fs";
import path from "node:path";
import { gatherEvidence, writeAndVerify, type EvidencePack, type WriteReport } from "../src/lib/agent";
import { normalizeText } from "../src/lib/evidence";
import { defaultRouting, type Routing } from "../src/lib/nebius-agent";
import type { AgentEvent, AgentRequest, EngineCall, Playbook, Source } from "../src/lib/types";

const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";

const CONFIGS: Record<string, Partial<Routing>> = {
  "ultra-medium": { reasoning: ULTRA, effort: "medium" },
  "ultra-low": { reasoning: ULTRA, effort: "low" },
  "super-medium": { reasoning: SUPER, effort: "medium" },
  "lightning-low": { reasoning: LIGHTNING, effort: "low" },
};

const ROOT = path.resolve(import.meta.dirname, "..");
// The eval measures each writer as it is, so it allows slower writers more time than the live app does.
process.env.NEBIUS_WRITER_MAX_MS ??= "420000";
const OUT = path.join(ROOT, "eval", "results");
// --runs <dir> keeps each design's runs apart (re-running with an existing dir only re-aggregates cached runs);
// --summary <file> chooses where the table goes.
const RUNS_DIR = argOne("runs") ?? "runs";
const SUMMARY_FILE = argOne("summary") ?? "eval/SUMMARY.md";

function argOne(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const WEEK_KINDS = new Set(["weather", "event", "holiday", "news"]);

function slugOf(r: AgentRequest): string {
  return `${r.restaurant}-${r.city}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^\w]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function arg(name: string): string[] | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(",") : null;
}

type RunResult = {
  slug: string;
  config: string;
  report: Omit<WriteReport, "playbook">;
  calls: EngineCall[];
  ms: number;
  usd: number;
  writerMs: number;
  writerOut: number;
  writerReasoning: number;
  weekSpecific: number | null; // share of dishes with a verified cite to this week's data
  newDishes: number | null; // share of dishes not already on the restaurant's menu (when a menu was found)
};

function dishMetrics(pb: Playbook | null, sources: Source[]): { weekSpecific: number | null; newDishes: number | null } {
  if (!pb) return { weekSpecific: null, newDishes: null };
  const kind = new Map(sources.map((s) => [s.id, s.kind] as const));
  const week = pb.menu_moves.filter((m) => m.evidence.some((e) => e.verified && e.cites.some((c) => c.ok && WEEK_KINDS.has(kind.get(c.source) ?? "")))).length;
  const menuText = sources
    .filter((s) => s.kind === "menu" || s.kind === "site")
    .map((s) => ` ${normalizeText(s.text)} `)
    .join(" ");
  const fresh = menuText.trim() ? pb.menu_moves.filter((m) => !menuText.includes(` ${normalizeText(m.dish)} `)).length : null;
  const n = pb.menu_moves.length || 1;
  return { weekSpecific: week / n, newDishes: fresh == null ? null : fresh / n };
}

async function packFor(req: AgentRequest, slug: string): Promise<{ pack: EvidencePack; calls: EngineCall[] } | null> {
  const file = path.join(OUT, "packs", `${slug}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const calls: EngineCall[] = [];
  const emit = (e: AgentEvent) => {
    if (e.type === "engine") calls.push(e.call);
    if (e.type === "tool_end" && e.error) console.log(`   ! ${e.tool}: ${e.summary}`);
  };
  const pack = await gatherEvidence(req, emit, { routing: defaultRouting() });
  if (!pack) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pack, calls }));
  return { pack, calls };
}

async function runConfig(slug: string, config: string, pack: EvidencePack): Promise<RunResult> {
  const file = path.join(OUT, RUNS_DIR, `${slug}__${config}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const calls: EngineCall[] = [];
  const emit = (e: AgentEvent) => {
    if (e.type === "engine") calls.push(e.call);
  };
  const started = Date.now();
  const report = await writeAndVerify(pack, emit, { routing: { ...defaultRouting(), ...CONFIGS[config] } });
  const writer = calls.filter((c) => c.phase === "synthesize");
  const { playbook, ...rest } = report;
  const result: RunResult = {
    slug,
    config,
    report: rest,
    calls,
    ms: Date.now() - started,
    usd: calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0),
    writerMs: writer.reduce((s, c) => s + c.ms, 0),
    writerOut: writer.reduce((s, c) => s + (c.completion_tokens ?? 0), 0),
    writerReasoning: writer.reduce((s, c) => s + (c.reasoning_tokens ?? 0), 0),
    ...dishMetrics(playbook, pack.sources),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
const secs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–");

async function main() {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "restaurants.json"), "utf8")) as AgentRequest[];
  const only = arg("only");
  const configs = arg("configs") ?? Object.keys(CONFIGS);
  const results: RunResult[] = [];
  const gatherStats: { slug: string; sources: number; usd: number; credits: number }[] = [];

  for (const req of list) {
    const slug = slugOf(req);
    if (only && !only.includes(slug)) continue;
    console.log(`\n== ${req.restaurant}, ${req.city}`);
    const got = await packFor({ ...req, language: "English" }, slug);
    if (!got) {
      console.log("   could not gather evidence; skipped");
      continue;
    }
    gatherStats.push({
      slug,
      sources: got.pack.sources.length,
      usd: got.calls.reduce((s, c) => s + (c.est_cost_usd ?? 0), 0),
      credits: got.pack.tavilyCredits,
    });
    console.log(`   evidence: ${got.pack.sources.length} sources, ${got.pack.tavilyCredits} Tavily credits`);
    const runs = await Promise.all(configs.map((c) => runConfig(slug, c, got.pack).catch((err) => ({ slug, config: c, error: String(err) }))));
    for (const r of runs) {
      if ("error" in r) {
        console.log(`   ${r.config}: ERROR ${r.error}`);
        continue;
      }
      results.push(r);
      const rep = r.report;
      console.log(
        `   ${r.config.padEnd(14)} ${rep.ok ? "ok " : "FAIL"} claims ${rep.verifiedFinal}/${rep.claims} (first pass ${rep.verifiedFirstPass}) ` +
          `writer ${secs(r.writerMs)} out ${r.writerOut} (reasoning ${r.writerReasoning}) $${r.usd.toFixed(4)}${rep.retried ? ` retried(${rep.finish})` : ""}`,
      );
    }
  }

  // ---- aggregate ----
  const rows = configs.map((config) => {
    const rs = results.filter((r) => r.config === config);
    const ok = rs.filter((r) => r.report.ok);
    const claims = ok.reduce((s, r) => s + r.report.claims, 0);
    const first = ok.reduce((s, r) => s + r.report.verifiedFirstPass, 0);
    const final = ok.reduce((s, r) => s + r.report.verifiedFinal, 0);
    const week = ok.map((r) => r.weekSpecific).filter((x): x is number => x != null);
    const fresh = ok.map((r) => r.newDishes).filter((x): x is number => x != null);
    return {
      config,
      runs: rs.length,
      published: ok.length,
      retries: rs.filter((r) => r.report.retried).length,
      firstPass: claims ? first / claims : NaN,
      final: claims ? final / claims : NaN,
      claimsPerPlan: ok.length ? claims / ok.length : NaN,
      week: week.length ? week.reduce((a, b) => a + b, 0) / week.length : NaN,
      fresh: fresh.length ? fresh.reduce((a, b) => a + b, 0) / fresh.length : NaN,
      writerMs: median(rs.map((r) => r.writerMs)),
      usd: median(rs.map((r) => r.usd)),
      totalUsd: rs.reduce((s, r) => s + r.usd, 0),
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  const md = [
    `# Routing eval — which Nemotron should write the plan?`,
    ``,
    `Run on ${date} with \`npx tsx scripts/eval-routing.ts\`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).`,
    ``,
    `**Method.** For each restaurant the evidence is gathered once (OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, Tavily Map, then Nemotron 3.5 Lightning researching the web with Tavily Search/Extract). Every writer configuration then writes a plan from that same evidence pack, and every claim is verified in code exactly as in production: each cited sentence must exist, every number in the claim must appear in a cited sentence, and the cited sentences must share content with the claim. "First pass" is the writer alone; then one repair pass (the same for every configuration: Nemotron Ultra at low effort, one call per failing claim) fixes or drops what failed; "final" is what the owner sees. Costs are measured token counts × published Token Factory prices (writer + repair calls; the shared research step is reported separately).`,
    ``,
    `| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, final | Dishes tied to this week | Dishes new to the menu | Writer time (median) | Cost / plan (median) |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.config} | ${r.published}/${r.runs} | ${r.retries} | ${Number.isFinite(r.claimsPerPlan) ? r.claimsPerPlan.toFixed(1) : "–"} | ${pct(r.firstPass)} | ${pct(r.final)} | ${pct(r.week)} | ${pct(r.fresh)} | ${secs(r.writerMs)} | ${Number.isFinite(r.usd) ? `$${r.usd.toFixed(4)}` : "–"} |`,
    ),
    ``,
    `Shared research step (once per restaurant): median ${gatherStats.length ? median(gatherStats.map((g) => g.sources)) : "–"} sources, median $${gatherStats.length ? median(gatherStats.map((g) => g.usd)).toFixed(4) : "–"} of Nemotron Lightning, median ${gatherStats.length ? median(gatherStats.map((g) => g.credits)) : "–"} Tavily credits.`,
    ``,
    `**Definitions.** *Retries*: the writer ran out of tokens while reasoning or got stuck repeating itself, and production retried it with \`reasoning_effort: "low"\`. *Dishes tied to this week*: share of the three dishes with at least one verified cite to the forecast, a holiday, a nearby event or local news. *Dishes new to the menu*: share of dishes whose name does not appear on the restaurant's own menu or site pages (only where those were found).`,
    ``,
    `**Limits.** ${results.length} plans over ${gatherStats.length} restaurants is a small sample; verification measures whether claims are backed by the sources, not whether the dishes would sell. Web content changes daily, so a re-run gathers different evidence.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.resolve(ROOT, SUMMARY_FILE), md);
  console.log(`\n${md}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
