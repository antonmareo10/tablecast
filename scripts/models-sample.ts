// Blind precision sample for the model comparison (eval/MODELS-DESIGN.md): N verified claims per strategy, drawn with a
// seeded generator, then shuffled together so they can be read against their cited lines without knowing which
// strategy wrote them.
//
//   npx tsx scripts/models-sample.ts [--runs runs-models] [--per 15] [--seed 20261025]
//   npx tsx scripts/models-sample.ts --tally eval/models-sample-verdicts.tsv
//
// Writes eval/results/<runs>-sample.txt (claims with their cited lines, labelled S001…, no strategy) and
// eval/results/<runs>-sample-key.json (which plan and strategy each id came from). With --tally, joins a verdicts
// file (id, verdict C/M/W, why) to the key and prints the counts per strategy, plus the verdicts with their plans.

import fs from "node:fs";
import path from "node:path";
import { evidenceGroups, verifierFor, type PlaybookOut } from "../src/lib/agent";
import type { Playbook } from "../src/lib/types";
import { argOne, readPack, RESULTS } from "./eval-common";

const RUNS = argOne("runs") ?? "runs-models";
const PER = Number(argOne("per") ?? 15);
const SEED = Number(argOne("seed") ?? 20261025);
const TALLY = argOne("tally");
const KEY = path.join(RESULTS, `${RUNS}-sample-key.json`);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Item = { plan: string; strategy: string; restaurant: string; field: string; text: string; body: string[] };

if (TALLY) {
  const key = JSON.parse(fs.readFileSync(KEY, "utf8")) as Record<string, { plan: string; strategy: string; field: string }>;
  const rows = fs
    .readFileSync(TALLY, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const by = new Map<string, { C: number; M: number; W: number }>();
  for (const [id, verdict] of rows) {
    const k = key[id];
    if (!k) throw new Error(`unknown id ${id}`);
    const t = by.get(k.strategy) ?? { C: 0, M: 0, W: 0 };
    t[verdict as "C" | "M" | "W"] += 1;
    by.set(k.strategy, t);
  }
  for (const [s, t] of by) console.log(`${s.padEnd(16)} C ${t.C}  M ${t.M}  W ${t.W}  (n ${t.C + t.M + t.W})`);
  console.log("\nid\tstrategy\tplan\tfield\tverdict\twhy");
  for (const [id, verdict, why] of rows) console.log([id, key[id].strategy, key[id].plan, key[id].field, verdict, why].join("\t"));
} else {
  const dir = path.join(RESULTS, RUNS);
  const pools = new Map<string, Item[]>();
  // Fixed order before shuffling: file name, then field, then position.
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { slug: string; strategy: string; final?: Playbook | null };
    if (!run.final) continue;
    const cached = readPack(run.slug);
    if (!cached) continue;
    const ledger = verifierFor(cached.pack);
    const pool = pools.get(run.strategy) ?? [];
    for (const g of evidenceGroups(run.final as unknown as PlaybookOut)) {
      for (const e of g.list) {
        if (!e.verified) continue;
        // Re-checked with the current verifier, which also returns each cite's line and any neighbour it used.
        const v = ledger.verifyEvidence({ text: e.text, cites: e.cites.map((c) => ({ source: c.source, span: c.span, quote: "" })) }, g.label);
        if (!v.verified) continue;
        const body: string[] = [];
        for (const c of v.cites) {
          const src = ledger.get(c.source);
          body.push(`    ${c.span ?? c.source} · ${src?.kind ?? "?"} · ${src?.title?.slice(0, 70) ?? ""}${src?.url ? ` · ${src.url}` : ""}`);
          body.push(`      » ${c.quote}`);
          for (const x of c.context ?? []) body.push(`      + ${x}`);
        }
        pool.push({ plan: file.replace(/\.json$/, ""), strategy: run.strategy, restaurant: cached.pack.req.restaurant, field: g.label, text: e.text, body });
      }
    }
    pools.set(run.strategy, pool);
  }
  const rnd = mulberry32(SEED);
  const picked: Item[] = [];
  for (const s of [...pools.keys()].sort()) picked.push(...shuffle(pools.get(s)!, rnd).slice(0, PER));
  const order = shuffle(picked, rnd);
  const key: Record<string, { plan: string; strategy: string; field: string }> = {};
  const out: string[] = [];
  order.forEach((it, i) => {
    const id = `S${String(i + 1).padStart(3, "0")}`;
    key[id] = { plan: it.plan, strategy: it.strategy, field: it.field };
    out.push(`\n[${id}] ${it.restaurant} (${it.field}) ${it.text}`, ...it.body);
  });
  fs.writeFileSync(path.join(RESULTS, `${RUNS}-sample.txt`), `${order.length} verified claims, ${PER} per strategy, seed ${SEED}, strategies hidden\n${out.join("\n")}\n`);
  fs.writeFileSync(KEY, JSON.stringify(key, null, 1));
  console.log(
    `${order.length} claims → ${path.join(RESULTS, `${RUNS}-sample.txt`)} (pools: ${[...pools.entries()].map(([s, p]) => `${s} ${p.length}`).join(", ")})`,
  );
}
