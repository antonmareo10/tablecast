// Quick smoke test for the Nebius Token Factory (NVIDIA Nemotron) integration.
// Validates: fast model tool-calling, reasoning model generation, and forced-tool
// structured output — before running a full (costlier) end-to-end playbook.
// Run from the repo root: node scripts/nebius-smoke.mjs
import OpenAI from "openai";
import fs from "node:fs";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();

const apiKey = get("NEBIUS_API_KEY");
const baseURL = get("NEBIUS_BASE_URL") || "https://api.tokenfactory.nebius.com/v1/";
const REASONING = get("NEBIUS_MODEL") || "nvidia/Nemotron-3-Ultra-550b-a55b";
const FAST = get("NEBIUS_FAST_MODEL") || "nvidia/Nemotron-3_5-Lightning";

if (!apiKey) {
  console.error("No NEBIUS_API_KEY in .env.local");
  process.exit(1);
}
const client = new OpenAI({ baseURL, apiKey });

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

async function run(label, fn) {
  const s = Date.now();
  try {
    const r = await fn();
    console.log(`✅ ${label} (${Date.now() - s}ms): ${r}`);
  } catch (e) {
    console.log(`❌ ${label} (${Date.now() - s}ms): status=${e.status || "?"} ${e.message}`);
    const body = e.error ?? e.response?.data;
    if (body) console.log("   body:", JSON.stringify(body).slice(0, 300));
  }
}

await run(`FAST tool-call [${FAST}]`, async () => {
  const r = await client.chat.completions.create({
    model: FAST,
    messages: [{ role: "user", content: "What's the weather in Madrid? Use the get_weather tool." }],
    tools,
    tool_choice: "auto",
    reasoning_effort: "none",
    max_tokens: 512,
  });
  const tc = r.choices[0].message.tool_calls;
  return tc?.length
    ? `tool_calls=${tc.map((c) => `${c.function.name}(${c.function.arguments})`).join(", ")}`
    : `NO tool_calls; content="${(r.choices[0].message.content || "").slice(0, 80)}"`;
});

await run(`REASONING generate [${REASONING}]`, async () => {
  const r = await client.chat.completions.create({
    model: REASONING,
    messages: [{ role: "user", content: "Reply with exactly the two letters: OK" }],
    reasoning_effort: "low",
    max_tokens: 3000,
  });
  return `content="${(r.choices[0].message.content || "").replace(/\s+/g, " ").trim().slice(0, 60)}" finish=${r.choices[0].finish_reason}`;
});

await run(`REASONING forced-tool JSON [${REASONING}]`, async () => {
  const r = await client.chat.completions.create({
    model: REASONING,
    messages: [{ role: "user", content: "Call get_weather for Barcelona." }],
    tools,
    tool_choice: { type: "function", function: { name: "get_weather" } },
    reasoning_effort: "low",
    max_tokens: 3000,
  });
  const tc = r.choices[0].message.tool_calls;
  return tc?.length ? `args=${tc[0].function.arguments}` : `NO tool_calls; content="${(r.choices[0].message.content || "").slice(0, 80)}"`;
});

console.log("\nSmoke test done.");
