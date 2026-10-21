// Re-checks already verified plans with verifier v7, without any model call: which claims marked verified when
// they were written fail now, and why, by rule; which lose the "read across languages" label; and which plans
// schedule something before their own date.
//
//   npx tsx scripts/v7-recheck.ts [--runs runs-v6-languages,runs-tavily] [--demos] [--page <url>=<file>]
//
// Cached runs: each plan's final claims are re-verified against its evidence pack (eval/results/packs; the
// no-Tavily variant against the same pack without Tavily, as it was written) with the production verifier
// (verifierFor). --demos also re-checks the recorded replays (src/data/demos.json). A replay keeps only the first
// 600 characters of each page, so a cite whose sentence lies beyond that can't be re-read; --page gives the full
// text of a page as it was fetched in that run (its sentences must line up with the replay's cites, or it is
// ignored). Prints every change for reading by hand.

import fs from "node:fs";
import path from "node:path";
import { packToday, verifierFor, type EvidencePack } from "../src/lib/agent";
import { pastDates, scheduleFields } from "../src/lib/dates";
import { segment } from "../src/lib/evidence";
import type { AgentEvent, Evidence, Playbook, Source } from "../src/lib/types";
import { argList, argOne, readPack, RESULTS, ROOT } from "./eval-common";
import { withoutTavily } from "./tavily-ablation";

type Change = { plan: string; field: string; claim: string; rule: string; issue: string; across?: string };
type DateFlag = { plan: string; today: string; where: string; text: string };
type Tally = { plans: number; verified: number; changes: Change[]; dates: DateFlag[]; datesChecked: number; unreadable: number };

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

/** Which v7 rule (or earlier check) rejects a claim that was verified when written. */
function ruleOf(issue: string, wasAcross: boolean): string {
  if (/add-on of the dish above it/.test(issue)) return "add-on belongs to the dish above it (v7)";
  if (/don't mention|share no name/.test(issue)) return wasAcross ? "word check now applies: the page is not in another language (v7)" : "word check (unchanged rule)";
  if (/combo or add-on price|never names|is about|not .* in /.test(issue)) return "subject check (added 21 Oct, before v7)";
  return "other";
}

function recheckPlan(plan: string, pb: Playbook, pack: EvidencePack, t: Tally) {
  t.plans += 1;
  const ledger = verifierFor(pack);
  for (const [field, list] of groups(pb)) {
    for (const e of list) {
      if (!e.verified) continue;
      t.verified += 1;
      if (e.cites.some((c) => c.span && ledger.span(c.span)?.text !== c.quote && c.quote)) {
        t.unreadable += 1; // the cited sentence isn't in the text we have (a replay's page cut at 600 characters)
        continue;
      }
      const v = ledger.verifyEvidence({ text: e.text, cites: e.cites.map((c) => ({ source: c.source, span: c.span, quote: "" })) }, field);
      if (!v.verified) t.changes.push({ plan, field, claim: e.text, rule: ruleOf(v.issue ?? "", !!e.across), issue: v.issue ?? "", across: e.across });
      else if (e.across && !v.across) t.changes.push({ plan, field, claim: e.text, rule: "still verified; no longer labelled as read across languages (v7)", issue: "", across: e.across });
    }
  }
  const today = packToday(pack);
  const { checked, past } = pastDates(scheduleFields(pb), today);
  t.datesChecked += checked;
  for (const p of past) t.dates.push({ plan, today, where: p.where, text: p.text });
}

function recheckRuns(dirs: string[]): Tally {
  const t: Tally = { plans: 0, verified: 0, changes: [], dates: [], datesChecked: 0, unreadable: 0 };
  for (const dir of dirs) {
    const full = path.join(RESULTS, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".json"))) {
      const run = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as { slug: string; final?: Playbook | null };
      const cached = readPack(run.slug);
      if (!run.final || !cached) continue;
      const pack = file.includes("no-tavily") ? withoutTavily(cached.pack).pack : cached.pack;
      recheckPlan(`${dir}/${file.replace(/\.json$/, "")}`, run.final, pack, t);
    }
  }
  return t;
}

function recheckDemos(pages: Map<string, string>): Tally {
  const t: Tally = { plans: 0, verified: 0, changes: [], dates: [], datesChecked: 0, unreadable: 0 };
  const file = path.join(ROOT, "src", "data", "demos.json");
  const demos = JSON.parse(fs.readFileSync(file, "utf8")) as { slug: string; restaurant: string; city: string; events: AgentEvent[] }[];
  for (const d of demos) {
    const place = d.events.find((e) => e.type === "place");
    const week = d.events.find((e) => e.type === "week");
    const pbEvent = [...d.events].reverse().find((e) => e.type === "playbook");
    const srcEvent = [...d.events].reverse().find((e) => e.type === "sources");
    if (place?.type !== "place" || pbEvent?.type !== "playbook" || srcEvent?.type !== "sources") continue;
    const cites = groups(pbEvent.playbook).flatMap(([, l]) => l.flatMap((e) => e.cites));
    const sources: Source[] = srcEvent.sources.map((s) => {
      const text = s.url ? pages.get(s.url) : undefined;
      if (!text) return { ...s, text: s.text.replace(/…$/, "") };
      const spans = segment(text);
      const lines = cites.filter((c) => c.source === s.id && c.span).every((c) => spans[Number(c.span!.split(".")[1]) - 1] === c.quote);
      if (!lines) console.warn(`  ! ${d.slug}: the text given for ${s.url} doesn't line up with the replay's cites; ignored`);
      return lines ? { ...s, text } : { ...s, text: s.text.replace(/…$/, "") };
    });
    const firstDay = week?.type === "week" ? week.days[0]?.date : undefined;
    const pack: EvidencePack = {
      req: { restaurant: d.restaurant, city: d.city },
      goal: "",
      language: "English",
      place: place.place,
      context: "",
      sources,
      photoMenu: false,
      tavilyCredits: 0,
      ...(firstDay ? { today: firstDay } : {}),
    };
    recheckPlan(`demo/${d.slug}`, pbEvent.playbook, pack, t);
  }
  return t;
}

function print(title: string, t: Tally) {
  const rejected = t.changes.filter((c) => !c.rule.startsWith("still verified"));
  console.log(`\n## ${title}: ${t.plans} plans, ${t.verified} claims verified when written, ${rejected.length} rejected now${t.unreadable ? ` (${t.unreadable} not re-checkable: cited sentence not in the saved text)` : ""}`);
  const byRule = new Map<string, number>();
  for (const c of t.changes) byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1);
  console.log([...byRule].map(([k, v]) => `   ${k}: ${v}`).join("\n") || "   (no change)");
  console.log(`   dates: ${t.datesChecked} explicit dates checked; ${t.dates.length} fields before the plan's own date, in ${new Set(t.dates.map((x) => x.plan)).size} plans`);
  for (const c of t.changes) console.log(`\n- [${c.plan} · ${c.field}] ${c.rule}${c.across ? ` (was labelled ${c.across})` : ""}\n    claim: ${c.claim}${c.issue ? `\n    why: ${c.issue}` : ""}`);
  for (const x of t.dates) console.log(`\n- [${x.plan}] today ${x.today} · ${x.where}: ${x.text}`);
}

const pages = new Map<string, string>();
for (const p of argList("page") ?? []) {
  const [url, f] = p.split("=");
  if (url && f && fs.existsSync(f)) pages.set(url, fs.readFileSync(f, "utf8"));
}
const runs = recheckRuns(argList("runs") ?? ["runs-v6-languages", "runs-tavily"]);
print("Cached eval runs", runs);
if (process.argv.includes("--demos")) print("Recorded demos", recheckDemos(pages));
const out = argOne("json");
if (out) fs.writeFileSync(out, JSON.stringify({ runs, demos: process.argv.includes("--demos") ? recheckDemos(pages) : null }, null, 1));
