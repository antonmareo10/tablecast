// Shows which claims fail verification, and why, before and after the repair pass, for one cached
// evidence pack. Usage: npx tsx scripts/debug-verify.ts <slug> [reasoningModel] [effort]
import fs from "node:fs";
import path from "node:path";
import { writeAndVerify, type EvidencePack } from "../src/lib/agent";
import { defaultRouting, type Routing } from "../src/lib/nebius-agent";
import type { AgentEvent, Evidence } from "../src/lib/types";

const [slug, model, effort] = process.argv.slice(2);
const file = path.resolve(import.meta.dirname, "..", "eval", "results", "packs", `${slug}.json`);
const { pack } = JSON.parse(fs.readFileSync(file, "utf8")) as { pack: EvidencePack };
const routing: Routing = { ...defaultRouting(), ...(model ? { reasoning: model } : {}), ...(effort ? { effort: effort as Routing["effort"] } : {}) };

const emit = (e: AgentEvent) => {
  if (e.type === "note" && e.text.startsWith("🔎")) console.log(e.text);
  if (e.type === "engine") console.log(`[engine] ${e.call.phase} ${e.call.label} ${e.call.ms}ms ${e.call.note ?? ""}`);
};
async function main() {
  const report = await writeAndVerify(pack, emit, { routing });
  console.log(
    JSON.stringify({
      ok: report.ok,
      claims: report.claims,
      firstPass: report.verifiedFirstPass,
      reattributed: report.reattributed,
      repaired: report.repaired,
      final: report.verifiedFinal,
    }),
  );
  const pb = report.playbook;
  if (pb) {
    const all: [string, Evidence[]][] = [
      ["loved", pb.snapshot.loved_for],
      ["watch", pb.snapshot.watch_outs],
      ...pb.moments.map((m, i) => [`moment${i}`, m.evidence] as [string, Evidence[]]),
      ...pb.menu_moves.map((m, i) => [`dish${i}`, m.evidence] as [string, Evidence[]]),
      ["rivals", pb.rivals.evidence],
      ["exp", pb.experience.evidence],
    ];
    for (const [label, list] of all)
      for (const e of list)
        if (!e.verified)
          console.log(`FAIL ${label}: ${e.text}\n     cites: ${e.cites.map((c) => `${c.source}:"${c.quote}"`).join(" ; ")}\n     issue: ${e.issue}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
