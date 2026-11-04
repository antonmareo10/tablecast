# Tablecast on Otari

Tablecast plans an independent restaurant's coming week. It reads the forecast at its door, the public holidays, events nearby, the venues on its block, its own menu and what guests say online, and turns that into three dishes to test, an event, a post, a supplier order and a day-by-day plan. Every claim in the plan points to the exact sentences it stands on, and code checks that those sentences contain its numbers and its words.

This branch (`otari-wilding`) is the version I built for MozFest Developers Wilding. Every model call, web search, MCP call, guardrail check and code run goes through [Otari](https://otari.ai), the gateway by Mozilla.ai, and every model is open-weight. The version before it ran on Nebius Token Factory and Tavily; its README and measured figures are in [docs/NEBIUS_VERSION.md](docs/NEBIUS_VERSION.md).

- Live app: https://tablecast-otari.vercel.app (two recorded Otari runs play for everyone; live runs are kept for me, so the public page can't spend the credit)
- Setup on the Otari side (budgets, service key, routing policies): [docs/OTARI_SETUP.md](docs/OTARI_SETUP.md)
- What I submit, the video scripts and my feedback on Otari: [docs/OTARI_SUBMISSION.md](docs/OTARI_SUBMISSION.md)

## Built on Otari

Every row is something a normal run does. The last column says where to look.

| Otari feature | What Tablecast does with it | Code | How to see it |
|---|---|---|---|
| Open-weight models, several roles | Each role runs on the open-weight model that suits it: Qwen3 235B researches, Nemotron 3 Ultra writes (Nemotron 3 Super in Economy) and repairs, gpt-oss-120b computes the supplier order, gpt-oss-safeguard-20b judges prompt injection, Qwen3 VL reads a menu photo. | [src/lib/model-runtime.ts](src/lib/model-runtime.ts) | App: Proof & engine, "What Otari did in this run", one row per role with the model and provider that answered. Dashboard: Overview, Requests. |
| Routing policies and fallbacks | The app never names a model. It asks for `tablecast-research`, `tablecast-write`, `tablecast-economy`, `tablecast-check` and `tablecast-quartermaster`, each falling back to another provider and another model family. `tablecast-write` also tiers down to Nemotron 3 Super once a restaurant has used 60% of its weekly budget. The app reads `Otari-Model`, `Otari-Provider`, `Otari-Attempt-Count` and `Otari-Fallback` on every answer. A drill policy, `tablecast-drill`, fails over on purpose: its first model refuses a parameter I send. | [src/lib/model-runtime.ts](src/lib/model-runtime.ts), [src/lib/otari.ts](src/lib/otari.ts), [src/app/api/failover-drill/route.ts](src/app/api/failover-drill/route.ts) | App: the engine room shows "policy → provider" per call; the Failover drill button. Dashboard: Routing, and Requests (the drill shows two attempts). |
| Web search and web fetch | The researcher searches with `otari_web_search` inside Otari's tool loop (on my organization's Exa key, at most 5 searches a run). When my own reader can't open a page, the app reads it with Otari's web fetch through the Messages API, where the fetched text comes back. | [src/lib/agent.ts](src/lib/agent.ts), [src/lib/sources/otari-fetch.ts](src/lib/sources/otari-fetch.ts) | App: "Searching the web … (Otari web search)" steps. Dashboard: Agent traces, the search spans. |
| MCP | Tablecast's page reader is an MCP server (`/api/mcp`, tools `read_page` and `find_menu_pages`). Every research turn names it in `mcp_servers`; Otari connects to it, runs the model's calls on it inside its tool loop, and the exact page text comes back in `otari_tool_calls`, where the app turns it into a source. | [src/lib/mcp-server.ts](src/lib/mcp-server.ts), [src/app/api/mcp/route.ts](src/app/api/mcp/route.ts) | App: "Reading … (Tablecast MCP, via Otari)" steps. Dashboard: Agent traces, the MCP spans. |
| Guardrails | Every page and search result the researcher read goes alone through an Otari guardrail in block mode before the writer can see it, and flagged ones are withheld. otari.ai's EU deployment runs no guardrails service and Otari's built-in guardrails all need a vendor key, so I used Otari's documented extension point: the guardrail entry's `url` names Tablecast's own service, which speaks Otari's guardrails contract (a few rules, then gpt-oss-safeguard-20b through Otari). Otari runs the check and enforces it (`403 guardrail_violation`). A button in the app sends a poisoned review through the same check, live. | [src/lib/screen.ts](src/lib/screen.ts), [src/lib/injection-detector.ts](src/lib/injection-detector.ts), [src/lib/guardrail-service.ts](src/lib/guardrail-service.ts) | App: the 🛡️ line in the log and the Guardrails card. Dashboard: Requests (refused with `guardrail_violation`), Agent traces. |
| Code execution | gpt-oss-120b writes one Python program and Otari runs it with `otari_code_execution`: the supplier order by supplier, its total, and how many portions of each new dish pay for its ingredients. The app shows the program and its own stdout and checks every sum against the plan in code. | [src/lib/quartermaster.ts](src/lib/quartermaster.ts) | App: "Computed in Otari's code sandbox" under the shopping list, with the program. Dashboard: Agent traces, the code execution span. |
| Budgets and spending limits | The app's key has a $12 monthly budget. Before each live run the app checks the key with a free call; a spent budget or an empty balance pauses live runs. On my machine a local ledger also refuses requests past a cap. | [src/lib/limits.ts](src/lib/limits.ts), [src/lib/otari-ledger.ts](src/lib/otari-ledger.ts) | App: the message a visitor gets. Dashboard: Spend & budgets. |
| Per-user budgets | The key is a service key, and every request names the restaurant as an Otari end user (`user: "restaurant:<name>-<city>"`), each with its own $1 weekly budget. The app reads it before a run (and refuses a run the restaurant can't afford, before spending anything) and after it (to show what Otari billed). | [src/lib/otari-budget.ts](src/lib/otari-budget.ts), [src/app/api/agent/route.ts](src/app/api/agent/route.ts) | App: "This restaurant's budget on Otari", with the bar. Dashboard: Spend & budgets, end users. |
| Sessions | Every request of a run carries the same `Otari-Conversation-Id`, so a run is one session in Otari's agent traces. | [src/lib/otari.ts](src/lib/otari.ts) | App: the session id in the Otari panel. Dashboard: Agent traces, search the id. |

## The models

All of them are open-weight and run on otari.ai's own hosted providers (EU region), billed to the Otari balance.

| Role | Policy | First choice | Fallbacks |
|---|---|---|---|
| Research | `tablecast-research` | Qwen3 235B A22B Instruct (DeepInfra) | Mistral Small 4 (Mistral), Nemotron Nano 3 30B (Bedrock) |
| Write, Quick | `tablecast-write` | Nemotron 3 Ultra (Fireworks) | GLM 5.2 (DeepInfra), Mistral Small 4 (Mistral); Nemotron 3 Super (DeepInfra) past 60% of the budget |
| Write, Economy | `tablecast-economy` | Nemotron 3 Super (Bedrock) | DeepSeek V4 Flash (DeepInfra), Nemotron 3 Ultra (Fireworks) |
| Check and repair | `tablecast-check` | Nemotron 3 Ultra (Fireworks) | GLM 5.2 (DeepInfra), Mistral Small 4 (Mistral) |
| Supplier order | `tablecast-quartermaster` | gpt-oss-120b (DeepInfra) | gpt-oss-120b (Fireworks), Mistral Small 4 (Mistral) |
| Prompt-injection judge | catalog id `openai/gpt-oss-safeguard-20b` | Bedrock | |
| Guardrail checks | catalog id `mistralai/ministral-3-3b` | one token per check | |
| Menu photo | catalog id `alibaba/qwen3-vl-235b-a22b-instruct` | Otari picks DeepInfra or Bedrock | the other one |
| Failover drill | `tablecast-drill` | Mistral Large 3 (refuses `reasoning_effort`) | Nemotron 3 Ultra (Fireworks) |

If a policy does not exist in the workspace, the app uses the role's catalog id and says so in its log, so it still runs.

## How a run works

1. Context, in code and in parallel: OpenStreetMap finds the restaurant and the venues within 600 m, Open-Meteo gives the 7-day forecast, Nager.Date the holidays, Ticketmaster the events within 5 km (with a key). The reader opens the restaurant's own menu page. Each item becomes a numbered source.
2. Research: the researcher searches through Otari and reads pages through the Tablecast MCP server. Search results are only leads; what the plan uses has to be read. Every page passes the guardrail first.
3. Write: the writer plans the week as one streamed, forced function call. Every claim cites sentence ids, never quotes.
4. Verify: code checks every claim against the sentences it cites (numbers, words, subject, dates, prices). What fails goes to the checker once; a fix is kept only if it passes the same check. What still fails is marked in the plan.
5. Supplier order: the quartermaster's program runs in Otari's sandbox, and code checks its sums.

The verifier is the same as in the Nebius version; how it works, and how I measured it there, is in [docs/NEBIUS_VERSION.md](docs/NEBIUS_VERSION.md#how-every-cited-claim-is-verified-code-decides-not-a-model).

## What I measured on Otari

These are single runs from 4 Nov 2026, not an eval.

| Run | Where | Sources | Claims verified after repair (first pass) | Time | Billed to the restaurant by Otari |
|---|---|---|---|---|---|
| Dishoom Covent Garden, London (recorded) | deployed app, MCP and guardrail service on | 7 (menu, 2 reviews, local news, a rival, forecast, block) | 12 of 16 (4) | 217 s | $0.174 |
| Taberna La Bola, Madrid (recorded) | deployed app, MCP and guardrail service on | 5 | 11 of 12 (6) | 165 s | $0.099 |
| Taberna La Bola, Madrid | my laptop, MCP and guardrail service on the deployment | 5 | 14 of 14 (12) | 137 s | $0.076 |
| Dishoom Covent Garden, London | my laptop, pages read in-process | 6 | 11 of 14 (6) | 247 s | $0.100 |

In both recorded runs the guardrail passed every web source (6 of 6 and 3 of 3), and the sandbox's supplier order matched the plan's own lines in every sum. Other checks: the failover drill was served by Nemotron 3 Ultra after 2 attempts (`Otari-Fallback: true`) for $0.00005; through Otari, Tablecast's guardrail service passed a clean review and refused a subtle and a plain injection with `403 guardrail_violation` (a handful of texts, not a benchmark). Twice in my first runs, the writer's first streamed attempt stopped after about 14,000 characters and stayed silent until the app cut it and wrote again; the stall cut is now 30 s.

Development on Otari cost about $1 of the $20 credit (Otari's end-user records plus my local ledger).

The verification figures in the Nebius README (for example 186 of 212 verified claims right when I read a whole held-out round) were measured with Nemotron on Nebius. The Otari version uses the same verifier but other models for research and another page reader, and I have not re-run those evals on it.

## Run it yourself

```bash
git clone https://github.com/antonmareo10/tablecast.git && cd tablecast
git checkout otari-wilding
npm install
cp .env.example .env.local      # then add your OTARI_API_KEY
npm run dev                     # http://localhost:3000
```

| Variable | Needed | What it is |
|---|---|---|
| `OTARI_API_KEY` | yes | An Otari service key (see [docs/OTARI_SETUP.md](docs/OTARI_SETUP.md)). An ordinary key works too, but then runs are not billed per restaurant. |
| `OTARI_BASE_URL` | no | `https://eu.api.otari.ai/api/v1` (default) or `https://api.otari.ai/api/v1` for a US account |
| `TABLECAST_MCP_URL`, `TABLECAST_MCP_TOKEN` | for MCP | The public HTTPS address of `/api/mcp` and a long random token. Without them the reader runs in-process. |
| `TABLECAST_GUARDRAIL_URL`, `TABLECAST_GUARDRAIL_TOKEN` | for guardrails | `https://<deployment>/api/guardrails/<token>` and the same token. Without them, web sources are marked as not screened. |
| `LIVE_RUNS_TOKEN` | no | When set, live runs need `?live=<token>` in the page's address; recorded runs stay open to everyone. |
| `TICKETMASTER_API_KEY` | no | Events within 5 km |
| `OTARI_LOCAL_CAP_USD` | no | The local spending cap (default 6), on top of Otari's budgets |

Checks: `npm test` (unit tests with Otari's answers mocked, including the MCP route and the guardrails service against their protocols), `npm run typecheck`, `npm run lint`, `npm run build`. Live checks: `node --env-file=.env.local scripts/otari-smoke.mjs --paid` (every feature, a few cents) and `node --env-file=.env.local scripts/otari-e2e.mjs <deployment domain>` (Otari connecting to the deployed MCP server and guardrail service). Record a replay: `node --env-file=.env.local scripts/record-demo.mjs "Casa Lucio" "Madrid" "Fill quiet weeknights" <base url>`.

## Known limitations

- The MCP server and the guardrail service have to be reachable by Otari over HTTPS, so on a laptop they need a deployed copy (the app falls back to the in-process reader, and marks sources as not screened).
- The guardrail judge is mine (rules plus an open-weight safety model), checked on a handful of texts. It screens a source as far as the writer will read it, in pieces of 2,000 characters. If it can't run, the source is kept and counted as unscreened, not as passed.
- Otari's search results reach the app as URLs and titles, so the researcher has to read a page before the plan can use it; when it reads little, the plan stands on few sources (5 to 7 in the recorded runs).
- My reader does not run JavaScript; when it fails, Otari's fetch gets a second try.
- The supplier order's matching of ingredients to order lines is the model's (names never match exactly); code checks the sums and the break-even arithmetic, not the matching. The shopping list's own costs come from the writer.
- Nothing here measures sales. A plan is a set of bets to test for a week, and verification proves that each cited claim matches its sentences, not that the plan is right.

## Credits

Models, web search and fetch, guardrails and the code sandbox through Otari by Mozilla.ai. Map data © OpenStreetMap contributors (ODbL), weather by Open-Meteo (CC BY 4.0), holidays by Nager.Date, events by Ticketmaster. Recorded runs contain third-party page excerpts, so they ship with the deployment and are kept out of this repository. License: MIT.
