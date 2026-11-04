// Creates or updates Tablecast's routing policies in the Otari workspace through Otari's API, for when the dashboard's
// Routing page can't be used. Dry run by default: it prints the exact JSON it would send and sends nothing.
//
//   node --env-file=.env.local scripts/otari-policies.mjs                 # dry run: print every request body
//   node --env-file=.env.local scripts/otari-policies.mjs --apply         # send them
//   ... --only tablecast-economy,tablecast-check                          # just these
//   ... --drill                                                           # also the failover drill policy
//   ... --workspace <uuid>                                                # skip the workspace lookup
//
// API: POST /api/v1/organizations/me/routing-policies (OpenAPI operation routing-set_organization_routing_policy),
// "create or update a stored policy in one of the organization's workspaces; organization owners and admins only",
// authenticated with an API key in the Otari-Key header. The app's service key belongs to a service user, not to an
// owner, so this needs a key of the organization owner's own: set OTARI_ADMIN_KEY to one (Antón creates it; it is
// never printed). The spec is the same schema as a routing.policies entry in config.yml (docs/routing.md).

const API = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
const KEY = process.env.OTARI_ADMIN_KEY || process.env.OTARI_API_KEY;
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRILL = args.includes("--drill");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
let workspace = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : null;

const ULTRA = "fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4";
const SUPER = "bedrock:nvidia.nemotron-super-3-120b"; // takes no reasoning_effort: the Economy writer sends none
const SUPER_DI = "deepinfra:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"; // takes reasoning_effort
const SMALL = "mistral:mistral-small-2603";

// docs/OTARI_SETUP.md, section 3: every selector is an EU hosted offering of an open-weight model.
const POLICIES = [
  { name: "tablecast-research", spec: { select: [{ default: "deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507" }], on_failure: ["mistral:mistral-small-2603", "bedrock:nvidia.nemotron-nano-3-30b"] } },
  {
    name: "tablecast-write",
    spec: {
      // A restaurant that has used 60% of its weekly budget gets the cheaper writer. The default must be last.
      select: [{ when: { budget_used_pct: { gte: 60 } }, target: SUPER_DI }, { default: ULTRA }],
      on_failure: ["deepinfra:zai-org/GLM-5.2", SMALL],
    },
  },
  { name: "tablecast-economy", spec: { select: [{ default: SUPER }], on_failure: ["deepinfra:deepseek-ai/DeepSeek-V4-Flash", ULTRA] } },
  { name: "tablecast-check", spec: { select: [{ default: ULTRA }], on_failure: ["deepinfra:zai-org/GLM-5.2", SMALL] } },
  { name: "tablecast-quartermaster", spec: { select: [{ default: "deepinfra:openai/gpt-oss-120b" }], on_failure: ["fireworks:accounts/fireworks/models/gpt-oss-120b", SMALL] } },
];
if (DRILL)
  // A failover drill: Mistral Large refuses reasoning_effort with a 400, so a request that carries it (the app's
  // /api/failover-drill) always fails over to the second candidate.
  POLICIES.push({ name: "tablecast-drill", spec: { select: [{ default: "mistral:mistral-large-2512" }], on_failure: [ULTRA] } });

const todo = POLICIES.filter((p) => !only || only.includes(p.name));

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "otari-key": KEY, "content-type": "application/json", "user-agent": "tablecast-policies/0.8" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

if (!APPLY) {
  console.log(`Dry run: nothing is sent. With --apply, each body goes to POST ${API}/v1/organizations/me/routing-policies (workspace_id filled in from the workspace that already holds tablecast-research, or --workspace).\n`);
  for (const p of todo) console.log(JSON.stringify({ name: p.name, workspace_id: workspace ?? "<workspace uuid>", spec: p.spec }, null, 2), "\n");
  process.exit(0);
}

if (!KEY) {
  console.error("Set OTARI_ADMIN_KEY (a key of the organization owner) or OTARI_API_KEY.");
  process.exit(1);
}
if (!process.env.OTARI_ADMIN_KEY) console.warn("OTARI_ADMIN_KEY is not set: trying OTARI_API_KEY, which a service key will be refused for (owners and admins only).");

if (!workspace) {
  const list = await api("GET", "/v1/organizations/me/routing-policies");
  if (list.status !== 200) {
    console.error(`Listing the organization's policies failed (${list.status}): ${JSON.stringify(list.data).slice(0, 300)}`);
    process.exit(1);
  }
  const existing = (Array.isArray(list.data) ? list.data : []).filter((p) => p.workspace_id);
  console.log("Stored policies now:", existing.map((p) => `${p.name} (workspace ${p.workspace_id})`).join(", ") || "none");
  workspace = existing.find((p) => p.name === "tablecast-research")?.workspace_id ?? existing[0]?.workspace_id ?? null;
  if (!workspace) {
    const ws = await api("GET", "/v1/workspaces");
    const items = Array.isArray(ws.data) ? ws.data : (ws.data?.data ?? ws.data?.workspaces ?? []);
    if (items.length === 1) workspace = items[0].id;
    else {
      console.error(`Can't tell which workspace to use (${ws.status}, ${items.length} listed). Pass --workspace <uuid>.`);
      process.exit(1);
    }
  }
}
console.log(`Workspace ${workspace}\n`);
for (const p of todo) {
  const r = await api("POST", "/v1/organizations/me/routing-policies", { name: p.name, workspace_id: workspace, spec: p.spec });
  console.log(`${r.status === 200 ? "ok " : "ERR"} ${p.name} ${r.status} ${r.status === 200 ? JSON.stringify(r.data.spec) : JSON.stringify(r.data).slice(0, 400)}`);
}
