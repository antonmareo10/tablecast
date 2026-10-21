// Re-checks already verified claims with the subject check (src/lib/subject.ts), without any model call:
// which claims that passed would now fail because they cite a page about another place, branch or item.
//
//   npx tsx scripts/subject-recheck.ts [--runs runs-v6-languages,runs-tavily] [--demos]
//
// Cached runs: each plan's final claims are re-verified against its evidence pack (eval/results/packs) with the
// production verifier (verifierFor). Only plans written from the full pack are read (the no-Tavily variant has
// no web pages to check). --demos also checks the recorded demos (src/data/demos.json): those keep only the
// cited sentence and the neighbouring lines it used, not whole pages, so the check runs on that (lines before a
// cited sentence are unknown there). Prints every rejected claim with its reason, for reading by hand.

import fs from "node:fs";
import path from "node:path";
import { verifierFor, type EvidencePack } from "../src/lib/agent";
import { subjectIssue, subjectProfile, type CitedLines } from "../src/lib/subject";
import type { AgentEvent, Evidence, Playbook, Source } from "../src/lib/types";
import { argList, readPack, RESULTS, ROOT } from "./eval-common";

type Flag = { plan: string; field: string; claim: string; issue: string; cites: string };

function groups(pb: Playbook): [string, Evidence[]][] {
  return [
    ["loved_for", pb.snapshot.loved_for],
    ["watch_outs", pb.snapshot.watch_outs],
    ...pb.moments.map((m, i) => [`moment ${i + 1}`, m.evidence] as [string, Evidence[]]),
    ...pb.menu_moves.map((m, i) => [`dish ${i + 1}`, m.evidence] as [string, Evidence[]]),
    ["rivals", pb.rivals.evidence],
    ["experience", pb.experience.evidence],
  ];
}

function citeLabel(e: Evidence, sources: Map<string, Source>): string {
  return e.cites.map((c) => `${c.span ?? c.source} ${sources.get(c.source)?.kind ?? "?"} ${sources.get(c.source)?.url ?? ""}`).join(" | ");
}

function recheckRuns(dirs: string[]): { plans: number; verified: number; flags: Flag[]; stillVerified: number } {
  let plans = 0;
  let verified = 0;
  let stillVerified = 0;
  const flags: Flag[] = [];
  for (const dir of dirs) {
    const full = path.join(RESULTS, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".json") && !f.includes("no-tavily"))) {
      const run = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as { slug: string; final?: Playbook | null };
      const cached = readPack(run.slug);
      if (!run.final || !cached) continue;
      plans += 1;
      const pack: EvidencePack = cached.pack;
      const ledger = verifierFor(pack);
      const check = ledger.subjectCheck;
      const sources = new Map(pack.sources.map((s) => [s.id, s]));
      for (const [field, list] of groups(run.final)) {
        for (const e of list) {
          if (!e.verified) continue;
          verified += 1;
          // The same check without the subject step must still pass (same verifier as when the plan was written).
          ledger.subjectCheck = undefined;
          const before = ledger.verifyEvidence(e, field).verified;
          ledger.subjectCheck = check;
          const after = ledger.verifyEvidence(e, field);
          if (before) stillVerified += 1;
          if (before && !after.verified) flags.push({ plan: `${dir}/${file.replace(/\.json$/, "")}`, field, claim: e.text, issue: after.issue ?? "", cites: citeLabel(e, sources) });
        }
      }
    }
  }
  return { plans, verified, flags, stillVerified };
}

function recheckDemos(): { plans: number; verified: number; flags: Flag[] } {
  const file = path.join(ROOT, "src", "data", "demos.json");
  const demos = JSON.parse(fs.readFileSync(file, "utf8")) as { slug: string; restaurant: string; city: string; events: AgentEvent[] }[];
  let verified = 0;
  const flags: Flag[] = [];
  for (const d of demos) {
    const place = d.events.find((e) => e.type === "place");
    const pbEvent = [...d.events].reverse().find((e) => e.type === "playbook");
    const srcEvent = [...d.events].reverse().find((e) => e.type === "sources");
    if (!pbEvent || pbEvent.type !== "playbook" || !srcEvent || srcEvent.type !== "sources") continue;
    const p = place?.type === "place" ? place.place : null;
    const profile = subjectProfile({ restaurant: d.restaurant, city: p?.city ?? d.city, address: p?.address, website: p?.website });
    const sources = new Map(srcEvent.sources.map((s) => [s.id, s]));
    for (const [field, list] of groups(pbEvent.playbook)) {
      for (const e of list) {
        if (!e.verified) continue;
        verified += 1;
        const cites: CitedLines[] = e.cites
          .filter((c) => c.ok !== false && sources.has(c.source))
          .map((c) => ({ id: c.source, source: sources.get(c.source)!, sentence: c.quote, before: [], after: c.context ?? [] }));
        const issue = subjectIssue(e.text, field, cites, profile);
        if (issue) flags.push({ plan: `demo/${d.slug}`, field, claim: e.text, issue, cites: citeLabel(e, sources) });
      }
    }
  }
  return { plans: demos.length, verified, flags };
}

function print(title: string, r: { plans: number; verified: number; flags: Flag[] }) {
  console.log(`\n## ${title}: ${r.plans} plans, ${r.verified} verified claims, ${r.flags.length} now rejected by the subject check`);
  const byReason = new Map<string, number>();
  for (const f of r.flags) {
    const reason = /never names/.test(f.issue)
      ? "page never names the restaurant"
      : /combo or add-on/.test(f.issue)
        ? "combo / add-on price"
        : /^the claim is about/.test(f.issue)
          ? "claim names another city"
          : "page or sentence about another city/branch";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  console.log([...byReason].map(([k, v]) => `   ${k}: ${v}`).join("\n"));
  for (const f of r.flags) console.log(`\n- [${f.plan} · ${f.field}] ${f.claim}\n    why: ${f.issue}\n    cites: ${f.cites}`);
}

const runs = recheckRuns(argList("runs") ?? ["runs-v6-languages", "runs-tavily"]);
console.log(`(sanity: ${runs.stillVerified}/${runs.verified} verified claims still pass without the subject check)`);
print("Cached eval runs", runs);
if (process.argv.includes("--demos")) print("Recorded demos", recheckDemos());
