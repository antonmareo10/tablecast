// Prints every verified claim of every plan in a runs directory, with the lines it cites (and any neighbouring line
// the check needed), for reading all of them by hand rather than a sample.
//
//   npx tsx scripts/read-all-claims.ts --runs runs-v71-heldout2 [--configs ultra-medium] [--out eval/results/heldout2-claims.txt]
//
// Every claim verified when its plan was written is listed in plan order ("plan#claim" ids line up with the verdicts
// file) and re-checked with the current production verifier (verifierFor); a claim it now rejects is marked.

import fs from "node:fs";
import path from "node:path";
import { evidenceGroups, verifierFor, type PlaybookOut } from "../src/lib/agent";
import type { Playbook } from "../src/lib/types";
import { argList, argOne, readPack, RESULTS } from "./eval-common";

const RUNS = argOne("runs") ?? "runs-v71-heldout2";
const CONFIGS = argList("configs");
const OUT = argOne("out") ?? path.join(RESULTS, `${RUNS}-claims.txt`);

const dir = path.join(RESULTS, RUNS);
const lines: string[] = [];
let plans = 0;
let total = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("baseline")).sort()) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { slug: string; config: string; final?: Playbook | null };
  if (!run.final || (CONFIGS && !CONFIGS.includes(run.config))) continue;
  const cached = readPack(run.slug);
  if (!cached) continue;
  const ledger = verifierFor(cached.pack);
  plans += 1;
  const plan = file.replace(/\.json$/, "");
  lines.push(`\n=================== ${plan} (today ${cached.pack.today ?? "?"})`);
  let n = 0;
  for (const g of evidenceGroups(run.final as unknown as PlaybookOut)) {
    for (const e of g.list) {
      // Listed if it was verified when the plan was written, so the numbering doesn't move when the verifier changes;
      // the line says when the current verifier rejects it.
      if (!e.verified) continue;
      const v = ledger.verifyEvidence({ text: e.text, cites: e.cites.map((c) => ({ source: c.source, span: c.span, quote: "" })) }, g.label);
      n += 1;
      total += 1;
      lines.push(`\n[${plan}#${n}] (${g.label}) ${e.text}${v.verified ? "" : `   <<< rejected now: ${v.issue}`}`);
      for (const c of v.cites) {
        const src = ledger.get(c.source);
        lines.push(`    ${c.span ?? c.source} · ${src?.kind ?? "?"} · ${src?.title?.slice(0, 70) ?? ""}${src?.url ? ` · ${src.url}` : ""}`);
        lines.push(`      » ${c.quote}`);
        for (const x of c.context ?? []) lines.push(`      + ${x}`);
      }
    }
  }
}
fs.writeFileSync(OUT, `${plans} plans, ${total} verified claims\n${lines.join("\n")}\n`);
console.log(`${plans} plans, ${total} verified claims → ${OUT}`);
