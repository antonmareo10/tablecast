# Setting up Otari for Tablecast

Everything Tablecast needs on the Otari side, in the order to do it. Steps marked
"dashboard" are done at https://otari.ai in the default workspace. Nothing here
adds funds or payment details. The app reads one secret, `OTARI_API_KEY`, from
`.env.local` (never committed).

## 1. Budgets (dashboard: Organization > Spend & budgets)

Create these two budgets with **Add budget**. Do this before the key, because the
key form picks them.

| Name | Limit (USD) | Resets | What it is for |
|---|---|---|---|
| `tablecast-restaurant-week` | 1.00 | Weekly | Each restaurant gets its own copy of this budget (end-user budget). |
| `tablecast-app-month` | 12.00 | Monthly | The ceiling on the app's key, which pools every restaurant. |

If the form also offers per-minute limits, set `rpm_limit` 30 on
`tablecast-restaurant-week` (optional).

## 2. The API key (dashboard: API keys > Create key)

1. Name: `tablecast-otari`.
2. Open **Advanced** and turn on **Service key** (the key may name end users).
   End-user budgets: `tablecast-restaurant-week`; default:
   `tablecast-restaurant-week`. Leave max end users at its default.
3. Budget: pick `tablecast-app-month` (or set Limit 12, Resets Monthly).
4. Create, copy the key once, and save it as a line `OTARI_API_KEY=otk_...` in
   `C:\Users\anton\repos\tablecast-otari\.env.local`. Never paste it in a chat.

Why a service key: Tablecast sends `user: "restaurant:<name>-<city>"` on every
request so each restaurant gets its own spend and its own weekly budget. An
ordinary key refuses a `user` that is not its own (403).

## 3. Routing policies (dashboard: Routing > Create policy > Fallback)

The app asks Otari for a policy name, never for a model. If a policy is missing,
the app falls back to the model's catalog id and says so in its log, so these are
needed for the routing feature but not for the app to run.

The account is in the EU region (`https://eu.api.otari.ai/api/v1`), whose hosted
catalog differs from the US one: no Nebius offerings, no Nemotron Lightning, no
Nemotron Super VL, and Nemotron Ultra only on Fireworks. Every selector below is in
the EU catalog, and each policy keeps its main model and its backups on different
providers.

| Policy | Main model | If unavailable, use (in order) |
|---|---|---|
| `tablecast-research` | `deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507` | `mistral:mistral-small-2603`, `bedrock:nvidia.nemotron-nano-3-30b` |
| `tablecast-write` | `fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4` | `deepinfra:zai-org/GLM-5.2`, `mistral:mistral-large-2512` |
| `tablecast-economy` | `bedrock:nvidia.nemotron-super-3-120b` | `mistral:mistral-small-2603`, `fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4` |
| `tablecast-check` | `fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4` | `deepinfra:zai-org/GLM-5.2`, `bedrock:nvidia.nemotron-super-3-120b` |
| `tablecast-quartermaster` | `deepinfra:openai/gpt-oss-120b` | `fireworks:accounts/fireworks/models/gpt-oss-120b`, `bedrock:nvidia.nemotron-super-3-120b` |

Then open `tablecast-write` from the list and, in its **budget tier-down**
section, add: when budget used is at least 60%, use
`bedrock:nvidia.nemotron-super-3-120b`. A restaurant that has used most of its
weekly budget then gets the cheaper writer automatically.

The menu photo reader uses the catalog id `alibaba/qwen3-vl-235b-a22b-instruct`
directly (Otari picks DeepInfra or Bedrock and falls back between them), so it
needs no policy.

In the dashboard picker, these are: Qwen3 235B A22B Instruct 2507 (DeepInfra),
Mistral Small 4 (Mistral), Nemotron Nano 3 30B (Amazon Bedrock), Nemotron 3 Ultra
550B A55B (Fireworks AI), GLM 5.2 (DeepInfra), Mistral Large 3 (Mistral), Nemotron
3 Super 120B A12B (Amazon Bedrock or DeepInfra), gpt-oss-120b (DeepInfra or
Fireworks AI).

All of them are open-weight models on otari.ai's own hosted providers
(`credential: hosted` in `GET /api/v1/catalog/models/{id}` on the EU API, checked
4 Nov 2026), so they are billed to the Otari balance. No organization provider
key is needed or wanted: do not add one.

## 4. Tools (dashboard: Tools)

- Web search: **Allow in workspace** on (it is on by default).
- Code execution: **Allow in workspace** on (on by default).
- Nothing to add under MCP servers: the app sends its MCP server inline with each
  request (see 5).

## 5. The Tablecast MCP server (needs a public deployment)

Otari has to reach the MCP server over HTTPS, so it only works once the app is
deployed. On the deployment set:

- `TABLECAST_MCP_URL=https://<deployment>/api/mcp`
- `TABLECAST_MCP_TOKEN=<a long random string>` (the same value in the app that
  sends it and the route that checks it)

A local run can point `TABLECAST_MCP_URL` at the deployed route. Without these two
variables the researcher reads pages in-process instead, and the app's log says so.

Everything a deployment needs:

| Variable | Value |
|---|---|
| `OTARI_API_KEY` | the service key |
| `OTARI_BASE_URL` | `https://eu.api.otari.ai/api/v1` |
| `TABLECAST_MCP_URL` | `https://<deployment>/api/mcp` |
| `TABLECAST_MCP_TOKEN` | a long random string |
| `TICKETMASTER_API_KEY` | optional, events within 5 km |
| `LIVE_RUNS_PER_IP_PER_HOUR`, `LIVE_RUNS_DAILY_CAP`, `LIVE_RUNS_MAX_CONCURRENT` | optional public-demo limits (defaults 4, 80, 3) |

Recorded runs live in `src/data/demos.json`, which is kept out of git (it holds
third-party page excerpts) and has to be shipped with the deployment.

If the dashboard's Routing page can't be used, `scripts/otari-policies.mjs`
creates the same policies through `POST /api/v1/organizations/me/routing-policies`
(dry run by default; it needs an API key of an organization owner as
`OTARI_ADMIN_KEY`).

## 6. What to check in the dashboard after a run

- Overview > Requests: one row per call, with the policy name, the model that
  served it, tokens and cost. A failover shows the attempted models.
- Agent traces: one session per run, named `tablecast-<run id>`, with every
  model call, search, code execution, MCP call and guardrail check inside it.
- Spend & budgets: `tablecast-app-month` spend; the end users list shows one
  entry per restaurant with its own spend against `tablecast-restaurant-week`.
