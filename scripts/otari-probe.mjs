// One-off probes of how a single Otari model selector answers a few request shapes (to choose policy candidates).
//   node --env-file=.env.local scripts/otari-probe.mjs <selector> [shape,shape…]
// Shapes: plain, effort, tool-auto, tool-forced, tool-forced-effort, stream-tool-forced. Each sends a few tokens.
// Never prints the key; spend goes to the local ledger (~/data/otari/usage.jsonl).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
const [model, list = "plain,effort,tool-auto,tool-forced,tool-forced-effort"] = process.argv.slice(2);
const LEDGER = path.join(os.homedir(), "data", "otari", "usage.jsonl");
const tool = { type: "function", function: { name: "answer", description: "Answer.", parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } } };
const msg = [{ role: "user", content: "Call the answer tool with the word ok, or just say ok." }];
const shapes = {
  plain: { messages: msg, max_tokens: 40 },
  effort: { messages: msg, max_tokens: 200, reasoning_effort: "low" },
  "tool-auto": { messages: msg, tools: [tool], tool_choice: "auto", max_tokens: 200 },
  "tool-forced": { messages: msg, tools: [tool], tool_choice: { type: "function", function: { name: "answer" } }, max_tokens: 200 },
  "tool-forced-effort": { messages: msg, tools: [tool], tool_choice: { type: "function", function: { name: "answer" } }, reasoning_effort: "medium", max_tokens: 400 },
  "stream-tool-forced-noeffort": { messages: msg, tools: [tool], tool_choice: { type: "function", function: { name: "answer" } }, max_tokens: 400, stream: true, stream_options: { include_usage: true } },
  "stream-tool-forced": { messages: msg, tools: [tool], tool_choice: { type: "function", function: { name: "answer" } }, reasoning_effort: "medium", max_tokens: 400, stream: true, stream_options: { include_usage: true } },
};
for (const s of list.split(",")) {
  const body = { model, ...shapes[s], metadata: { app: "tablecast", role: "probe" } };
  const t0 = Date.now();
  const res = await fetch(`${API}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${process.env.OTARI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let cost = null;
  const m = /"cost_usd":\s*"([\d.]+)"/.exec(text);
  if (m) cost = Number(m[1]);
  fs.appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), path: "/v1/chat/completions", role: "probe", model, cost_usd: cost, ...(cost == null ? { estimate_usd: 0.002 } : {}) })}\n`);
  const h = ["otari-provider", "otari-model", "otari-attempt-count", "otari-fallback", "otari-error-code"].map((k) => res.headers.get(k)).join(" ");
  const tc = /"arguments":\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  console.log(`${s.padEnd(20)} ${res.status} ${String(Date.now() - t0).padStart(5)}ms ${h} ${cost != null ? `$${cost}` : ""} ${res.ok ? (tc ? `tool:${tc}` : text.replace(/\s+/g, " ").slice(0, 160)) : text.slice(0, 300)}`);
}
