// Verifier audit: a reproducible random sample of claims the v7 verifier marked verified and claims it rejected,
// printed with the lines they cite, for reading one by one (eval/AUDIT.md has the method and the verdicts).
//
//   npx tsx scripts/audit-sample.ts [--seed 20261021] [--verified 100] [--rejected 50] [--out eval/results/audit-sample.txt]
//
// Pools (every claim re-checked now with the production verifier, verifierFor):
//   verified · held-out: final claims of the held-out round (eval/results/runs-v7-heldout) that pass v7
//   verified · tuning set: final claims of the cached v6 and Tavily-ablation plans (the 8 tuning restaurants) that pass v7
//   rejected · held-out / tuning set: claims of the same plans' first drafts (before any repair) that v7 rejects
// Half of each sample comes from the held-out round and half from the tuning set. The order inside a pool is fixed
// (file name, field, position), then shuffled with a seeded generator, and the first N are taken.

import fs from "node:fs";
import path from "node:path";
import { evidenceGroups, verifierFor, type EvidencePack, type PlaybookOut } from "../src/lib/agent";
import type { SourceLedger } from "../src/lib/evidence";
import type { Evidence, Playbook } from "../src/lib/types";
import { argOne, readPack, RESULTS, ROOT } from "./eval-common";
import { withoutTavily } from "./tavily-ablation";

const SEED = Number(argOne("seed") ?? 20261021);
const N_VERIFIED = Number(argOne("verified") ?? 100);
const N_REJECTED = Number(argOne("rejected") ?? 50);
const OUT = argOne("out") ?? path.join(RESULTS, "audit-sample.txt");
const HELDOUT = ["runs-v7-heldout"];
const TUNING = ["runs-v6-languages", "runs-tavily"];

type Item = { pool: string; plan: string; field: string; claim: string; verified: boolean; issue?: string; across?: string; cites: string[] };

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function finalGroups(pb: Playbook): [string, Evidence[]][] {
  return [
    ["loved_for", pb.snapshot.loved_for],
    ["watch_outs", pb.snapshot.watch_outs],
    ...pb.moments.map((m, i) => [`moment ${i + 1}`, m.evidence] as [string, Evidence[]]),
    ...pb.menu_moves.map((m, i) => [`dish ${i + 1}`, m.evidence] as [string, Evidence[]]),
    ["rivals", pb.rivals.evidence],
    ["experience", pb.experience.evidence],
  ];
}

/** The cited lines of a claim as the reader sees them: 2 lines before each cited sentence, the sentence, 3 after. */
function citedText(ledger: SourceLedger, e: Evidence): string[] {
  return e.cites.map((c) => {
    const s = c.span ? ledger.span(c.span) : null;
    if (!s) return `${c.span ?? c.source}: (not found)`;
    const all = ledger.spansOf(s.source.id);
    const win = [...all.slice(Math.max(0, s.index - 2), s.index).map((x) => `   ${x}`), `>> ${s.text}`, ...all.slice(s.index + 1, s.index + 4).map((x) => `   ${x}`)];
    return `${c.span} [${s.source.kind} · ${s.source.url ?? s.source.title}]\n${win.map((x) => `      ${x.slice(0, 400)}`).join("\n")}`;
  });
}

function collect(dirs: string[], label: string): { verified: Item[]; rejected: Item[]; plans: number } {
  const verified: Item[] = [];
  const rejected: Item[] = [];
  let plans = 0;
  for (const dir of dirs) {
    const full = path.join(RESULTS, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".json") && !f.includes("baseline")).sort()) {
      const run = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as { slug: string; final?: Playbook | null; report?: { draft?: PlaybookOut } };
      const cached = readPack(run.slug);
      if (!cached || !run.final) continue;
      plans += 1;
      const pack: EvidencePack = file.includes("no-tavily") ? withoutTavily(cached.pack).pack : cached.pack;
      const ledger = verifierFor(pack);
      const plan = `${dir}/${file.replace(/\.json$/, "")}`;
      for (const [field, list] of finalGroups(run.final)) {
        for (const e of list) {
          const v = ledger.verifyEvidence({ text: e.text, cites: e.cites.map((c) => ({ source: c.source, span: c.span, quote: "" })) }, field);
          if (v.verified) verified.push({ pool: `verified · ${label}`, plan, field, claim: e.text, verified: true, across: v.across, cites: citedText(ledger, v) });
        }
      }
      if (run.report?.draft) {
        for (const g of evidenceGroups(structuredClone(run.report.draft))) {
          for (const e of g.list) {
            const v = ledger.verifyEvidence(e, g.label);
            if (!v.verified) rejected.push({ pool: `rejected · ${label}`, plan, field: g.label, claim: e.text, verified: false, issue: v.issue, cites: citedText(ledger, v) });
          }
        }
      }
    }
  }
  return { verified, rejected, plans };
}

const held = collect(HELDOUT, "held-out");
const tune = collect(TUNING, "tuning set");
const pick = (xs: Item[], n: number, salt: number) => shuffle(xs, SEED + salt).slice(0, n);
const sample = [
  ...pick(held.verified, N_VERIFIED / 2, 1),
  ...pick(tune.verified, N_VERIFIED / 2, 2),
  ...pick(held.rejected, N_REJECTED / 2, 3),
  ...pick(tune.rejected, N_REJECTED / 2, 4),
];
const lines = [
  `Seed ${SEED}. Pools: held-out ${held.plans} plans (${held.verified.length} verified final claims, ${held.rejected.length} rejected first-draft claims); tuning set ${tune.plans} plans (${tune.verified.length} verified, ${tune.rejected.length} rejected).`,
  ...sample.map((it, i) => `\n#${String(i + 1).padStart(3, "0")} ${it.pool} · ${it.plan} · ${it.field}${it.across ? ` · across ${it.across}` : ""}\nCLAIM: ${it.claim}${it.issue ? `\nWHY REJECTED: ${it.issue}` : ""}\n${it.cites.map((c) => `  ${c}`).join("\n")}`),
];
fs.writeFileSync(path.resolve(ROOT, OUT), `${lines.join("\n")}\n`);
fs.writeFileSync(path.resolve(ROOT, OUT).replace(/\.txt$/, ".json"), JSON.stringify(sample.map((it, i) => ({ id: i + 1, pool: it.pool, plan: it.plan, field: it.field, claim: it.claim, issue: it.issue ?? null })), null, 1));
console.log(lines[0]);
console.log(`Wrote ${sample.length} claims to ${OUT}`);
