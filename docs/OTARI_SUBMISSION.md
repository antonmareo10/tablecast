# Tablecast on Otari: submission notes

Everything I send for MozFest Developers Wilding, in one place: the email fields, what each Otari feature does in the app and where to see it, the two video scripts, my written feedback, draft issues for the Otari repo, and what I checked.

Live app: https://tablecast-otari.vercel.app (two recorded Otari runs play for everyone; live runs need my owner link, so the public page can't spend the credit).

## 1. The email (reply to the sign-up thread)

- Project: Tablecast
- Otari account email: antonmareo@gmail.com
- One line: An agent that plans an independent restaurant's week from the forecast, events, its block, its menu and what guests say online, with every claim checked against its sources, and every model call, search, MCP call, guardrail check and code run going through Otari on open-weight models.
- Repository: https://github.com/antonmareo10/tablecast
- Branch: `otari-wilding` (https://github.com/antonmareo10/tablecast/tree/otari-wilding)
- First commit where Otari comes in: https://github.com/antonmareo10/tablecast/commit/d4160e2981f93921f47e9270e47205575c9191ca ("Otari: route all model calls through the Otari gateway")
- Otari features used: open-weight models in several roles; routing policies with fallbacks and a budget tier-down; web search and web fetch; MCP; guardrails; code execution; budgets and spending limits; per-user budgets.
- PRs or issues on mozilla-ai/otari: none opened (drafts in section 6, if I decide to open them)
- Demo video: (link)
- Feedback: (video link) and the written answers in section 5

## 2. Feature by feature

What the app does with each feature, the file, and where a judge sees it. The two recorded runs (4 Nov 2026) play as replays on the live app: Dishoom Covent Garden, London (Otari session `tablecast-mw1ypp84-ln0umw`) and Taberna La Bola, Madrid (`tablecast-mw1zflga-3stcae`).

| Rubric item | What Tablecast does | Code | In the app | In the Otari dashboard |
|---|---|---|---|---|
| Open-weight model (20) | Every model is open-weight: Qwen3 235B, Nemotron 3 Ultra and Super, gpt-oss-120b, gpt-oss-safeguard-20b, Ministral 3B, Qwen3 VL, and GLM 5.2, Mistral Small 4, DeepSeek V4 Flash, Nemotron Nano as fallbacks. | `src/lib/model-runtime.ts` | Engine room: the model of every call | Overview > Requests |
| Two or more open-weight models for different purposes (10) | Researcher (Qwen3 235B), writer and checker (Nemotron 3 Ultra; Nemotron 3 Super in Economy), quartermaster that writes code (gpt-oss-120b), prompt-injection judge (gpt-oss-safeguard-20b), menu photo reader (Qwen3 VL). | `src/lib/model-runtime.ts`, `src/lib/quartermaster.ts`, `src/lib/injection-detector.ts` | "What Otari did in this run": one row per role | Requests, with the `role` tag |
| Model routing and fallbacks | The app asks for policies, never models: `tablecast-research`, `-write`, `-economy`, `-check`, `-quartermaster`, each falling back to another provider and model family. `tablecast-write` tiers down to Nemotron 3 Super once a restaurant has used 60% of its weekly budget. The app reads `Otari-Model`, `Otari-Provider`, `Otari-Attempt-Count`, `Otari-Fallback` on every answer. `tablecast-drill` shows a failover on demand. | `src/lib/model-runtime.ts`, `src/lib/otari.ts`, `src/app/api/failover-drill/route.ts`, `docs/OTARI_SETUP.md` | Engine room "policy → provider"; the Failover drill button | Routing (six policies); Requests (the drill: 2 attempts) |
| Multiple models serving distinct roles | The five roles above in every run, plus the guardrail judge. | as above | Otari panel, one row per role | Requests |
| Web search or web fetch | The researcher searches with `otari_web_search` inside Otari's tool loop (my organization's Exa key, at most 5 searches a run). When my reader can't open a page, the app reads it with Otari's web fetch on the Messages API, where the fetched text comes back. | `src/lib/agent.ts`, `src/lib/sources/otari-fetch.ts` | "Searching the web … (Otari web search)" steps | Agent traces (search spans) |
| MCP | Tablecast's page reader is an MCP server (`/api/mcp`, tools `read_page`, `find_menu_pages`). Each research turn names it in `mcp_servers`; Otari connects to it and runs the model's calls; the exact page text comes back in `otari_tool_calls` and becomes a source. | `src/lib/mcp-server.ts`, `src/app/api/mcp/route.ts`, `src/lib/agent.ts` | "Reading … (Tablecast MCP, via Otari)" steps | Agent traces (MCP spans) |
| Code execution | gpt-oss-120b writes one Python program and Otari runs it with `otari_code_execution`: the supplier order by supplier, its total, the portions that pay for each new dish. The app shows the program and its stdout and checks every sum in code. | `src/lib/quartermaster.ts` | "Computed in Otari's code sandbox" under the shopping list | Agent traces (code execution span) |
| Guardrails | Every web source goes alone through an Otari guardrail in block mode before the writer sees it. otari.ai's EU deployment has no guardrails service, so the entry's `url` names Tablecast's own, built on Otari's documented guardrails contract (rules, then gpt-oss-safeguard-20b through Otari). Otari runs the check and enforces it: 403 `guardrail_violation`. | `src/lib/screen.ts`, `src/lib/injection-detector.ts`, `src/lib/guardrail-service.ts`, `src/app/api/guardrail-check/route.ts` | 🛡️ line in the log, Guardrails card, the "Try it" button | Requests (blocked ones), Agent traces |
| Budgets and spending limits | The app's key has a $12 monthly budget. A spent key budget or an empty balance pauses live runs. A local ledger capped my development spend. | `src/lib/limits.ts`, `src/lib/otari-ledger.ts` | The message a visitor gets | Spend & budgets |
| Per-user budgets | A service key; every request names the restaurant as an Otari end user, each with its own $1 weekly budget. The app reads it before a run (refusing a run the restaurant can't afford) and after it (what Otari billed). | `src/lib/otari-budget.ts`, `src/app/api/agent/route.ts` | "This restaurant's budget on Otari" | Spend & budgets, end users |

Honest notes on the weak spots:

- Guardrails: the check runs through Otari's mechanism, but the judge is mine, because the hosted EU deployment has none. The app and the README say so. I tested the judge on a handful of texts, not on a benchmark. In the recorded runs nothing was flagged; the "Try it" button and `scripts/otari-e2e.mjs` show a block.
- Web search: Otari's search results reach my app as URLs and titles only, so they are leads; only the pages the researcher reads become sources. Web fetch is the fallback for pages my reader can't open, so in a normal run it may not fire.
- Routing: in a normal run no fallback happens unless a provider fails, so the drill policy shows one on purpose (its first model refuses a parameter). In the first Dishoom recording, the researcher's first turn failed and the app's own fallback gave the research to the checker's model (Nemotron 3 Ultra); the Madrid recording has Qwen3 researching.
- The tier-down needs a restaurant past 60% of its weekly budget. Neither recorded run reached it, so it is configured and visible in the Routing page but not shown happening.
- The verification figures in the Nebius README were measured on the Nebius version. On Otari I have a few runs, not an eval.

## 3. Demo video script (about 4 and a half minutes)

Before recording: open https://tablecast-otari.vercel.app in Chrome at 110% zoom, and the otari.ai dashboard (EU, default workspace) in a second tab. Speak slowly. My own voice, screen recording only.

1. (0:00, home page) "Hi, I'm Antón, a student in Madrid. This is Tablecast. It plans the coming week of an independent restaurant: the weather, the events nearby, its menu and what guests say online. Every model call, every search and every tool goes through Otari, and every model is open-weight."
2. (0:20, click the replay "Taberna La Bola, Madrid") "This is a real run I recorded on Otari. It replays fast so you don't wait. First, code reads the open data: the map, the forecast, the holidays."
3. (0:35, point at the agent log) "Then the researcher, Qwen3, searches the web with Otari's web search. The results are only leads. To use a page, it reads it with my MCP server. Otari connects the model to my MCP server inside its own tool loop, and the exact page text comes back to my app."
4. (0:55, point at the 🛡️ line) "Before the writer sees any page, Otari runs a prompt-injection check on it. Here every page passed."
5. (1:05, the plan appears) "Then Nemotron 3 Ultra writes the plan, and my code checks every claim against the sentences it cites. Here 11 of 12 claims passed. A claim that fails is marked, not hidden."
6. (1:25, hover a source chip) "Every claim shows the exact sentence it stands on."
7. (1:35, scroll to the shopping list, open "The program the sandbox ran") "The supplier order is not written by a language model. gpt-oss writes a small Python program, Otari runs it in its code sandbox, and my code checks every sum against the list."
8. (2:00, scroll to "What Otari did in this run") "This panel comes from Otari's own answers. Each step asks Otari for a routing policy, not a model, and Otari tells me which model and provider answered, and the cost."
9. (2:20, point at the budget bar) "Each restaurant is an Otari end user with its own budget of one dollar a week. This run cost the restaurant about 10 cents. If a restaurant can't afford a plan, the run stops before it spends anything. And once a restaurant has used 60 percent, the writer policy moves it to the cheaper Nemotron Super."
10. (2:45, click "Send one request to tablecast-drill") "This is a failover drill. Its first model, Mistral Large, refuses one of my parameters. Otari moves to the next one by itself: Nemotron Ultra answered, after two attempts."
11. (3:00, click "Try it: send a poisoned review through the same check") "And this is a review with a hidden instruction. Otari blocks it before any model sees it. The clean review passes."
12. (3:15, dashboard tab, Routing) "In the Otari dashboard: here are my routing policies, each with fallbacks on other providers and other models."
13. (3:30, Overview, Requests) "Every request is here, with the policy, the model that answered and the cost. This is the drill, with two attempts."
14. (3:45, Agent traces, search the session id shown in the panel) "One run is one session. Inside it you see every model call, the searches, the MCP calls and the code run."
15. (4:00, Spend & budgets) "The app's key has a budget of 12 dollars a month, and here are the restaurants as end users, each with its own spend."
16. (4:15, back to the app) "Without Otari I would need five provider accounts, my own fallback code and my own budgets. With Otari it is one key. The code is on GitHub, branch otari-wilding. Thank you."

For a live run instead of the replay in steps 2 to 7: open the owner link (`?live=` plus the `LIVE_RUNS_TOKEN` from `.env.local`), choose Quick and start it before step 1. A run takes about three minutes, so start it first and come back to it at step 5. Each live run costs about 10 to 20 cents.

## 4. Feedback video script (about 4 minutes)

1. What I built (0:00) "I moved Tablecast, a planning agent for restaurants, onto Otari. It uses open-weight models in five roles, routing policies with fallbacks, web search, an MCP server, code execution, a guardrail on every web page, and a budget per restaurant."
2. What worked well (0:30) "One OpenAI-compatible key gave me models from four providers. The response headers tell me which model and provider answered and if a fallback did, so my engine room was easy. The cost comes in every answer. End users on a service key gave me a budget per restaurant in one afternoon. Inline MCP servers and the code sandbox worked the first time."
3. What didn't work, with steps (1:15)
   - "The Routing page froze Chrome. Create policy, Fallback, main model Nemotron 3 Super on Bedrock, then type the same model on DeepInfra as backup 1: the tab froze, and a new tab too. We created all the policies with the API instead, and that worked."
   - "Bedrock refuses reasoning_effort for non-Claude models, and Mistral Large refuses it too. My Economy policy had Bedrock first, so every request quietly failed over to the second model. Otari kept the app working, but nothing told me. I found it only in the Otari-Fallback header."
   - "On the EU deployment, POST /v1/search says no search tools are configured, even with my organization's Exa key. Search works inside the tool loop, but the error sends me to a page I can't use."
   - "Our first Exa key was saved with the asterisks from the form. Otari stored it, and every search failed with a 401 that only shows inside otari_tool_calls."
   - "There is no guardrails service on the hosted EU deployment, and every built-in guardrail needs a vendor key. I wrote my own guardrail service on Otari's contract."
   - "Twice, the writer's stream stopped in the middle of the plan and stayed silent for a minute. My app cuts it and writes again."
4. What's missing (3:00) "My app checks claims against the exact text of its sources. On Chat Completions, Otari's search and fetch don't give me that text, only the URL. On Messages, the fetch does. I would like the text in otari_tool_calls, a direct fetch endpoint like the search one, a hosted prompt-injection check, and a warning when a policy candidate can't take a parameter I send."

## 5. Written feedback (my answers, to edit before sending)

When were you most tempted to skip Otari and call the provider directly?

When I needed the text of the pages my agent reads. Tablecast checks every claim against the exact sentences of its sources. On Chat Completions, Otari's search and fetch give the text to the model but only report the URL back to me, and the direct search endpoint doesn't work on the EU deployment with an organization key. I was close to calling a search API from my own code. In the end I kept Otari: the researcher searches inside Otari's loop, reads pages through my own MCP server (Otari returns the MCP output), and when my reader fails I use Otari's fetch through the Messages API, where the fetched text does come back.

What did you build yourself that Otari should have done?

A page reader that returns the exact text, served as an MCP server, because fetched text isn't returned on Chat Completions. A prompt-injection guardrail service on Otari's guardrails contract, because the hosted EU deployment has no guardrails service and every built-in guardrail needs a vendor key. A one-token completion to run a guardrail on a piece of text, because there is no validate endpoint for API keys. And a before-and-after read of each restaurant's end-user record to know what a whole run cost, because the searches and tool calls are not in the cost of each model answer.

Would you keep using Otari without the rule?

Yes, for this app. One key gives me open-weight models from four providers, fallbacks I don't have to write, a budget per restaurant, sessions in the traces, and the model and cost in every answer. What would make me sure: a direct fetch (or the page text in otari_tool_calls), a hosted prompt-injection check, and a Routing page that doesn't freeze.

## 6. Draft issues for mozilla-ai/otari (not opened)

### Draft 1: Routing page freezes the browser when a fallback backup is the main model on another provider

Environment: otari.ai EU dashboard, Chrome on Windows 11, 4 Nov 2026 around 09:40 Madrid time.

Steps:
1. Routing > Create policy > Fallback.
2. Main model: Nemotron 3 Super 120B A12B, provider Amazon Bedrock.
3. In Backup 1, type `deepinfra:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`.

Result: the tab stops responding; a new otari.ai tab stays frozen too. Later the same day, typing a policy name in the New fallback dialog hung the renderer as well.

Expected: the form refuses a backup that is the same model as the main one (the routing docs say each backup must be a model other than the main one), and never hangs.

Workaround: `POST /api/v1/organizations/me/routing-policies` with the same spec works (200).

### Draft 2: A candidate that rejects reasoning_effort fails over silently on every request

Two hosted offerings answer 400 when a chat completion carries `reasoning_effort`: `bedrock:nvidia.nemotron-super-3-120b` ("'reasoning_effort' is not supported for bedrock. reasoning_effort is only translated for Anthropic Claude models on Bedrock...") and `mistral:mistral-large-2512` ("reasoning_effort is not enabled for this model"). In a fallback policy whose first candidate is one of these, every request fails over (`Otari-Fallback: true`), so the policy never uses its first model, and nothing says so outside the response headers and the usage rows.

Repro: a policy with `select: [{default: "mistral:mistral-large-2512"}]`, `on_failure: ["fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4"]`, and a chat completion with `"reasoning_effort": "low"`: 200, `Otari-Attempt-Count: 2`, `Otari-Fallback: true`.

Suggestions: translate `reasoning_effort` for Bedrock's reasoning models (or drop it per candidate, the way unsupported betas are dropped), and have the policy explain step or the Routing page warn when a candidate rejects a common parameter.

### Draft 3: Page text of gateway-run search and fetch on Chat Completions

On Chat Completions, `otari_tool_calls` reports a web search's sources (URL, title, date) and a fetch's URL, but not the text the model read. On Messages, a gateway-run fetch returns the text in `web_fetch_tool_result`, while search results have an empty `encrypted_content`. An app that has to keep what its sources say (to check claims, to cite, to cache) has to fetch every page again itself. An opt-in to include the text in `otari_tool_calls`, or a direct fetch endpoint like `POST /v1/search`, would fix it. Related: on otari.ai EU, `POST /v1/search` answers "No search tools are configured" even when the workspace's organization search key serves `otari_web_search`.

## 7. What I checked

- Tests: `npm test`, 257 passing and 5 live tests skipped (unit tests with Otari's JSON and SSE answers mocked; the MCP route and the guardrails service tested against their protocols), green on 4 Nov 2026. `npm run typecheck`, `npm run lint` and `npm run build` pass.
- The MCP route against the official MCP TypeScript SDK client (initialize, tools/list, tools/call on real pages).
- Live, through Otari (EU): a smoke test of every role with the app's own request shapes, the failover drill, `scripts/otari-e2e.mjs` against the deployed app (Otari connected to the Tablecast MCP server; the guardrail service passed a clean review and blocked two injections), four full runs on my laptop and four on the deployed app (two kept as replays).
- Spend: about $1 of the $20 credit for all of the above (Otari's end-user records plus my local ledger). Each full run costs the restaurant 8 to 18 cents.
