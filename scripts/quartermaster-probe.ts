// Runs the quartermaster (code execution in Otari's sandbox) on the plan of a recorded or captured run.
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/quartermaster-probe.ts <run.ndjson>
import fs from "node:fs";
import { runQuartermaster } from "../src/lib/quartermaster";
import type { Playbook } from "../src/lib/types";

async function main() {
  const file = process.argv[2];
  const events = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; playbook?: Playbook });
  const pb = events.find((e) => e.type === "playbook")?.playbook;
  if (!pb) throw new Error("no playbook in that run");
  const t0 = Date.now();
  const q = await runQuartermaster({ model: "tablecast-quartermaster", playbook: pb, timeoutMs: 120_000 });
  console.log(`${Date.now() - t0} ms · served ${q.served.provider}:${q.served.model} · $${q.served.cost_usd} · ${q.calls.length} code runs · why=${q.why ?? "-"}`);
  for (const c of q.calls) console.log(`  run ${c.status} exit=${c.exit_code} stdout=${(c.stdout ?? "").slice(-300).replace(/\n/g, " | ")} stderr=${(c.stderr ?? "").slice(0, 200)}`);
  if (q.report) console.log(JSON.stringify({ total: q.report.result.grand_total, checks: q.report.checks, dishes: q.report.result.dishes }, null, 1));
}
void main();
