# Tablecast on Otari

Tablecast plans an independent restaurant's coming week. It reads the forecast at its door, the public holidays, events nearby, the venues on its block, its own menu and what guests say online, and turns that into three dishes to test, an event, a post, a supplier order and a day-by-day plan. Every claim in the plan points to the exact sentences it stands on, and code checks that those sentences contain its numbers and its words.

This branch (`otari-wilding`) is the version I built for MozFest Developers Wilding. Every model call, web search, MCP call, guardrail check and code run goes through [Otari](https://otari.ai), the gateway by Mozilla.ai, and every model is open-weight. The version before it ran on Nebius Token Factory and Tavily; its README and measured figures are in [docs/NEBIUS_VERSION.md](docs/NEBIUS_VERSION.md).

- Setup on the Otari side (budgets, service key, routing policies): [docs/OTARI_SETUP.md](docs/OTARI_SETUP.md)
- What I submit, the video script and my feedback on Otari: [docs/OTARI_SUBMISSION.md](docs/OTARI_SUBMISSION.md)

## Built on Otari

Every row is something a normal run does. The last column says where to look.

| Otari feature | What Tablecast does with it | Code | How to see it |
|---|---|---|---|
| Open-weight models, several roles | Five roles, each on the open-weight model that suits it: Qwen3 235B researches, Nemotron 3 Ultra writes (Nemotron 3 Super in Economy), Nemotron 3 Ultra checks and repairs, gpt-oss-120b computes the supplier order, Qwen3 VL reads a menu photo. A small Ministral model carries the guardrail checks. | [src/lib/model-runtime.ts](src/lib/model-runtime.ts) | App: Proof & engine, "What Otari did in this run" lists each role, the model that answered and its provider. Dashboard: Overview, Requests. |
| Routing policies and fallbacks | The app never names a model. It asks for `tablecast-research`, `tablecast-write`, `tablecast-economy`, `tablecast-check` and `tablecast-quartermaster`. Each policy falls back to another provider and another model family. `tablecast-write` also tiers down to Nemotron 3 Super once a restaurant has used 60% of its weekly budget. The app reads `Otari-Model`, `Otari-Provider`, `Otari-Attempt-Count` and `Otari-Fallback` on every answer. | [src/lib/model-runtime.ts](src/lib/model-runtime.ts), [src/lib/otari.ts](src/lib/otari.ts), [docs/OTARI_SETUP.md](docs/OTARI_SETUP.md) | App: the engine room shows "policy → provider" per call, and any fallback. Dashboard: Routing (the policies), Overview, Requests (attempted models). |
| Web search | Research searches go through `POST /v1/search`, billed to the restaurant. Every result becomes a numbered source the verifier checks claims against. | [src/lib/sources/otari-search.ts](src/lib/sources/otari-search.ts) | App: "Searching the web" steps in the agent log, Otari web search rows in the engine room. Dashboard: Requests (`/v1/search`). |
| MCP | Tablecast's page reader is an MCP server (`/api/mcp`, tools `read_page` and `find_menu_pages`). Every research turn names it in `mcp_servers`; Otari runs the model's calls on it inside its tool loop, and the exact page text comes back in `otari_tool_calls`, where the app turns it into a source. | [src/lib/mcp-server.ts](src/lib/mcp-server.ts), [src/app/api/mcp/route.ts](src/app/api/mcp/route.ts), [src/lib/agent.ts](src/lib/agent.ts) | App: "Reading … (Tablecast MCP, via Otari)" steps. Dashboard: Agent traces, the research turns, MCP tool spans. |
| Guardrails | Every search result and page the researcher read is sent alone through Otari's `prompt-injection` guardrail in block mode before the writer can see it. Flagged sources are withheld and listed. A button in the app sends a poisoned review through the same check, live. | [src/lib/screen.ts](src/lib/screen.ts), [src/app/api/guardrail-check/route.ts](src/app/api/guardrail-check/route.ts) | App: the Guardrails card and the 🛡️ line in the agent log. Dashboard: Requests (refused with `guardrail_violation`), Agent traces (guardrail spans). |
| Code execution | gpt-oss-120b writes one Python program and Otari runs it with `otari_code_execution`: the supplier order by supplier, its total, and how many portions of each new dish pay for its ingredients. The app shows the program's own stdout and checks every sum against the plan in code. | [src/lib/quartermaster.ts](src/lib/quartermaster.ts) | App: "Computed in Otari's code sandbox" under the shopping list, with the program. Dashboard: Agent traces (code execution span). |
| Budgets and spending limits | The app's key has a monthly budget. Before each live run the app checks the key with a free call, and a spent budget or an empty balance pauses live runs for everyone. On my machine a local ledger also refuses requests past a cap. | [src/lib/limits.ts](src/lib/limits.ts), [src/lib/otari-ledger.ts](src/lib/otari-ledger.ts) | App: the error a visitor gets. Dashboard: Spend & budgets. |
| Per-user budgets | The key is a service key, and every request names the restaurant as an Otari end user (`user: "restaurant:<name>-<city>"`). Each restaurant gets its own copy of a weekly budget. The app reads it before a run (and refuses a run the restaurant can't afford, before spending anything) and after it (to show what Otari billed). | [src/lib/otari-budget.ts](src/lib/otari-budget.ts), [src/app/api/agent/route.ts](src/app/api/agent/route.ts) | App: "This restaurant's budget on Otari", with the bar. Dashboard: Spend & budgets, end users. |
| Sessions | Every request of a run carries the same `Otari-Conversation-Id`, so a run is one session in Otari's agent traces. | [src/lib/otari.ts](src/lib/otari.ts) | App: the session id in the Otari panel. Dashboard: Agent traces, search the id. |

## The models

All of them are open-weight and run on otari.ai's own hosted providers (EU region), billed to the Otari balance.

| Role | Policy | First choice | Fallbacks |
|---|---|---|---|
| Research | `tablecast-research` | Qwen3 235B A22B Instruct (DeepInfra) | Mistral Small 4 (Mistral), Nemotron Nano 3 30B (Bedrock) |
| Write, Quick | `tablecast-write` | Nemotron 3 Ultra (Fireworks) | GLM 5.2 (DeepInfra), Mistral Large 3 (Mistral); Nemotron 3 Super (Bedrock) past 60% of the budget |
| Write, Economy | `tablecast-economy` | Nemotron 3 Super (Bedrock) | Mistral Small 4 (Mistral), Nemotron 3 Ultra (Fireworks) |
| Check and repair | `tablecast-check` | Nemotron 3 Ultra (Fireworks) | GLM 5.2 (DeepInfra), Nemotron 3 Super (Bedrock) |
| Supplier order | `tablecast-quartermaster` | gpt-oss-120b (DeepInfra) | gpt-oss-120b (Fireworks), Nemotron 3 Super (Bedrock) |
| Menu photo | catalog id `alibaba/qwen3-vl-235b-a22b-instruct` | Otari picks DeepInfra or Bedrock | the other one |
| Guardrail checks | catalog id `mistralai/ministral-3-3b` | one token per check | |

If a policy does not exist in the workspace, the app uses the role's catalog id and says so in its log, so it still runs.

## How a run works

1. Context, in code and in parallel: OpenStreetMap finds the restaurant and the venues within 600 m, Open-Meteo gives the 7-day forecast, Nager.Date the holidays, Ticketmaster the events within 5 km (with a key). The reader opens the restaurant's own menu page. Each item becomes a numbered source.
2. Research: the researcher decides what to look up. It searches through Otari and reads pages through the Tablecast MCP server. Every web source passes Otari's guardrail first.
3. Write: the writer plans the week as one streamed, forced function call. Every claim cites sentence ids, never quotes.
4. Verify: code checks every claim against the sentences it cites (numbers, words, subject, dates, prices). What fails goes to the checker once; a fix is kept only if it passes the same check. What still fails is marked in the plan.
5. Supplier order: the quartermaster runs its program in Otari's sandbox, and code checks the sums.

The verifier is the same as in the Nebius version; how it works, and how I measured it, is in [docs/NEBIUS_VERSION.md](docs/NEBIUS_VERSION.md#how-every-cited-claim-is-verified-code-decides-not-a-model).

## What I measured on Otari

MEASURED-ON-OTARI

The verification figures in the Nebius README (for example 186 of 212 verified claims right when I read a whole held-out round) were measured with Nemotron on Nebius. The Otari version uses the same verifier but other models for research and a different page reader, and I have not re-run those evals on it.

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
| `TICKETMASTER_API_KEY` | no | Events within 5 km |
| `OTARI_LOCAL_CAP_USD` | no | The local spending cap (default 6), on top of Otari's budgets |

Checks: `npm test` (unit tests with Otari's answers mocked, including the MCP route against the MCP protocol), `npm run typecheck`, `npm run lint`, `npm run build`. A live check of every Otari feature the app uses, for a few cents: `node --env-file=.env.local scripts/otari-smoke.mjs --paid`. Record a replay: `node scripts/record-demo.mjs "Casa Lucio" "Madrid" "Fill quiet weeknights" http://localhost:3000`.

## Known limitations

- The MCP server has to be reachable by Otari over HTTPS, so on a laptop the reader runs in-process unless `TABLECAST_MCP_URL` points at a deployed copy.
- Otari's guardrail checks the text it is given; a source is screened as far as the writer will read it, cut into pieces of 2,000 characters. If the guardrail can't run, the source is kept and counted as unscreened, not as passed.
- My reader is simpler than a search provider's extractor: it does not run JavaScript and does not open PDFs, so some menus come back empty.
- The supplier order's matching of ingredients to order lines is the model's (names never match exactly); code checks the sums and the break-even arithmetic, not the matching.
- Nothing here measures sales. A plan is a set of bets to test for a week, and verification proves that each cited claim matches its sentences, not that the plan is right.

## Credits

Models, web search, guardrails and the code sandbox through Otari by Mozilla.ai. Map data © OpenStreetMap contributors (ODbL), weather by Open-Meteo (CC BY 4.0), holidays by Nager.Date, events by Ticketmaster. Recorded runs contain third-party page excerpts, so they ship with the deployment and are kept out of this repository. License: MIT.
