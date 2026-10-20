// Records a REAL run of the live agent into src/data/demos.json.
// Usage: node scripts/record-demo.mjs "Casa Lucio" "Madrid" "Fill quiet weeknights" [baseUrl]
import fs from "node:fs";

const [restaurant, city, goal, baseUrl = "http://localhost:3000"] = process.argv.slice(2);
if (!restaurant || !city) {
  console.error('Usage: node scripts/record-demo.mjs "<restaurant>" "<city>" "<goal>" [baseUrl]');
  process.exit(1);
}

const started = Date.now();
const res = await fetch(`${baseUrl}/api/agent`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ restaurant, city, goal }),
});
if (!res.ok || !res.body) {
  console.error("Agent failed:", res.status, await res.text());
  process.exit(1);
}

const events = [];
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    events.push({ ...ev, t: Date.now() - started });
    process.stdout.write(ev.type === "tool_start" ? `\n→ ${ev.label}` : ev.type === "error" ? `\n✗ ${ev.message}` : ".");
  }
}

if (!events.some((e) => e.type === "playbook")) {
  console.error("\nNo playbook in this run; not saving.");
  process.exit(1);
}

const slug = `${restaurant}-${city}`.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/(^-|-$)/g, "");
const file = new URL("../src/data/demos.json", import.meta.url);
const demos = JSON.parse(fs.readFileSync(file, "utf8")).filter((d) => d.slug !== slug);
demos.push({ slug, restaurant, city, goal, recordedAt: new Date().toISOString(), events });
fs.writeFileSync(file, JSON.stringify(demos, null, 0) + "\n");
console.log(`\nSaved demo "${slug}" with ${events.length} events (${((Date.now() - started) / 1000).toFixed(0)}s).`);
