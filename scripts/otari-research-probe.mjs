// Sends one research turn shaped like the app's (in-loop Otari search + the deployed Tablecast MCP server, no function
// tools) and prints how Otari answered and how long it took. Never prints secrets.
//   node --env-file=.env.local scripts/otari-research-probe.mjs tablecast-otari.vercel.app [model] [tool_choice]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [domain, model = "tablecast-research", toolChoice = "auto"] = process.argv.slice(2);
const API = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
const body = {
  model,
  messages: [
    { role: "system", content: "You are the research step of a restaurant planner. Find what guests say about the restaurant and what is on nearby this week: search the web, then read the 1-2 best pages with the tablecast read_page tool. Reply READY when done." },
    { role: "user", content: "Restaurant: Taberna La Bola, Madrid (Calle de la Bola 5). Website: https://labola.es" },
  ],
  tools: [{ type: "otari_web_search", max_uses: 2 }],
  tool_choice: toolChoice,
  temperature: 0.3,
  max_tokens: 2048,
  max_tool_iterations: 3,
  mcp_servers: [{ name: "tablecast", url: `https://${domain}/api/mcp`, authorization_token: process.env.TABLECAST_MCP_TOKEN, allowed_tools: ["read_page", "find_menu_pages"], purpose_hint: "Use read_page to read a web page." }],
  metadata: { app: "tablecast", role: "probe:research" },
};
const t0 = Date.now();
const res = await fetch(`${API}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${process.env.OTARI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const text = await res.text();
let data = {};
try {
  data = JSON.parse(text);
} catch {
  data = { raw: text.slice(0, 400) };
}
const h = (k) => res.headers.get(k);
console.log(`${res.status} in ${Date.now() - t0} ms · ${h("otari-provider")}:${h("otari-model")} attempts=${h("otari-attempt-count")} fallback=${h("otari-fallback")} code=${h("otari-error-code")}`);
console.log("tool calls:", JSON.stringify((data.otari_tool_calls ?? []).map((c) => ({ type: c.type, status: c.status, name: c.name, query: c.query, error: c.error }))).slice(0, 800));
console.log("answer:", JSON.stringify(data.choices?.[0]?.message ?? data.detail ?? data.raw).slice(0, 400));
const cost = Number(data?.usage?.cost_usd);
fs.appendFileSync(path.join(os.homedir(), "data", "otari", "usage.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), path: "/v1/chat/completions", role: "probe:research", model, cost_usd: Number.isFinite(cost) ? cost : null, ...(Number.isFinite(cost) ? {} : { estimate_usd: 0.02 }) })}\n`);
