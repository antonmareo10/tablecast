// Re-checks the money amounts in already written plans with the competitor-price rule (v7.1), without any model
// call: an amount whose clause names a venue from the block must come from that venue (a checked claim that puts
// the venue's name and the amount in one clause), or from the restaurant's own dish named in the same clause.
//
//   npx tsx scripts/amounts-recheck.ts [--runs runs-v5-coverage,runs-v6-languages,runs-tavily,runs-v7-heldout] [--demos]
//
// Cached runs are re-checked against their evidence pack (the no-Tavily variant against the same pack without
// Tavily). The plan's menu is its writer's menu_seen, kept only where a menu page prints that price next to the
// dish, as in production. --demos also re-checks the recorded replays (src/data/demos.json) the way the browser
// does. Prints every amount the rule flags, with its sentence, for reading by hand.

import fs from "node:fs";
import path from "node:path";
import { allowedAmounts, attributionContext, blockVenueNames, clauses, competitorPriceFlags, fieldLabel, moneyIn, proseFields, unbackedAmounts, type AttributionContext, type PlanText } from "../src/lib/amounts";
import { normalizeText } from "../src/lib/evidence";
import { verifierFor } from "../src/lib/agent";
import { dropContradictedPrices } from "../src/lib/menu";
import type { AgentEvent, Evidence, Playbook } from "../src/lib/types";
import { argList, readPack, RESULTS, ROOT } from "./eval-common";
import { withoutTavily } from "./tavily-ablation";

type Flag = { plan: string; where: string; amount: string; venue: string; text: string };

function claimsOf(pb: Playbook): Evidence[] {
  return [
    ...pb.snapshot.loved_for,
    ...pb.snapshot.watch_outs,
    ...pb.moments.flatMap((m) => m.evidence),
    ...pb.menu_moves.flatMap((m) => m.evidence),
    ...pb.rivals.evidence,
    ...pb.experience.evidence,
  ].filter((e) => e.verified);
}

function textOf(pb: Playbook, where: string): string {
  return proseFields(pb as unknown as PlanText).find((f) => f.where === where)?.get() ?? "";
}

/** Amounts whose clause names a venue of the block, whatever the verdict: how often plans price competitors at all. */
function nextToVenue(texts: string[], ctx: AttributionContext): string[] {
  const out: string[] = [];
  for (const t of texts)
    for (const c of clauses(t)) {
      if (!moneyIn(c.text).length) continue;
      const n = ` ${normalizeText(c.text)} `;
      if (ctx.rivals.some((r) => r.aliases.some((a) => n.includes(` ${a} `)))) out.push(c.text.trim());
    }
  return out;
}

function recheckRuns(dirs: string[]): { plans: number; amounts: number; nearVenue: string[]; withVenue: number; flags: Flag[] } {
  const out = { plans: 0, amounts: 0, nearVenue: [] as string[], withVenue: 0, flags: [] as Flag[] };
  for (const dir of dirs) {
    const full = path.join(RESULTS, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".json"))) {
      const run = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as {
        slug: string;
        final?: Playbook | null;
        report?: { draft?: { menu_seen?: { name: string; price: number | null }[] } };
      };
      const cached = readPack(run.slug);
      if (!run.final || !cached) continue;
      const pack = file.includes("no-tavily") ? withoutTavily(cached.pack).pack : cached.pack;
      const ledger = verifierFor(pack);
      const pb = run.final;
      const menu = (run.report?.draft?.menu_seen ?? []).filter((m) => m.price != null && ledger.hasPriceFor(m.name, m.price));
      const claims = claimsOf(pb);
      const plan = { ...(pb as unknown as PlanText), menu_seen: menu };
      const { numbers } = allowedAmounts(plan, claims);
      const venues = blockVenueNames(ledger.list(), pb.restaurant.name);
      const ctx = attributionContext(venues, [...pb.menu_moves.map((m) => ({ name: m.dish, price: m.price })), ...menu], claims);
      const fields = proseFields(plan);
      const { checked, unbacked } = unbackedAmounts(fields, numbers, ctx);
      out.plans += 1;
      out.amounts += checked;
      out.nearVenue.push(...nextToVenue(fields.map((f) => f.get()), ctx).map((c) => `${dir}/${file.replace(/\.json$/, "")}: ${c}`));
      const name = `${dir}/${file.replace(/\.json$/, "")}`;
      for (const u of unbacked) {
        if (!u.venue) continue;
        out.withVenue += 1;
        out.flags.push({ plan: name, where: fieldLabel(u.where), amount: u.amount, venue: u.venue, text: textOf(pb, u.where) });
      }
    }
  }
  return out;
}

function recheckDemos(): Flag[] {
  const file = path.join(ROOT, "src", "data", "demos.json");
  if (!fs.existsSync(file)) return [];
  const demos = JSON.parse(fs.readFileSync(file, "utf8")) as { slug: string; events: AgentEvent[] }[];
  const flags: Flag[] = [];
  for (const d of demos) {
    const pbEvent = [...d.events].reverse().find((e) => e.type === "playbook");
    const block = d.events.find((e) => e.type === "block");
    const menu = d.events.find((e) => e.type === "menu");
    const sources = [...d.events].reverse().find((e) => e.type === "sources");
    if (pbEvent?.type !== "playbook") continue;
    const pb = pbEvent.playbook;
    const venues = block?.type === "block" ? block.venues : [];
    const items = menu?.type === "menu" ? dropContradictedPrices(menu.items, sources?.type === "sources" ? sources.sources : []) : [];
    for (const f of competitorPriceFlags(pb, venues, items.map((m) => ({ name: m.name, price: m.price ?? null })))) {
      const where = proseFields(pb as unknown as PlanText).find((x) => fieldLabel(x.where) === f.where)?.where ?? "";
      flags.push({ plan: `demo/${d.slug}`, ...f, text: textOf(pb, where) });
    }
  }
  return flags;
}

const dirs = argList("runs") ?? ["runs-v5-coverage", "runs-v6-languages", "runs-tavily", "runs-v7-heldout"];
const runs = recheckRuns(dirs);
console.log(`## Cached eval runs (${dirs.join(", ")}): ${runs.plans} plans, ${runs.amounts} money amounts in their text, ${runs.nearVenue.length} clauses with an amount next to a block venue's name, ${runs.withVenue} flagged by the competitor-price rule`);
if (process.argv.includes("--near")) for (const c of runs.nearVenue) console.log(`   · ${c}`);
for (const f of runs.flags) console.log(`\n- [${f.plan} · ${f.where}] ${f.amount} next to ${f.venue}\n    ${f.text}`);
if (process.argv.includes("--demos")) {
  const demos = recheckDemos();
  console.log(`\n## Recorded demos: ${demos.length} flagged`);
  for (const f of demos) console.log(`\n- [${f.plan} · ${f.where}] ${f.amount} next to ${f.venue}\n    ${f.text}`);
}
