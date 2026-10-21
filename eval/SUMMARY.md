# Routing eval — which Nemotron should write the plan?

Run on 2026-10-21 with `npx tsx scripts/eval-routing.ts`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).

**Method.** For each restaurant the evidence is gathered once (OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, Tavily Map, then Nemotron 3.5 Lightning researching the web with Tavily Search/Extract). Every writer configuration then writes a plan from that same evidence pack, and every claim is verified in code exactly as in production: each cited sentence must exist, every number in the claim must appear in a cited sentence (or its neighbouring lines), and the cited sentences must contain the claim's content words — at most one in five may be missing (one for claims of 4–9 words, none for shorter ones). "First pass" is the writer alone; then one repair pass (the same for every configuration: Nemotron Ultra at low effort, one call per failing claim) fixes or drops what failed; "final" is what the owner sees. Verification shares are pooled over all claims of a configuration (verified claims ÷ claims), not medians of per-plan rates. Money amounts in the plan's free text (headline, plays, event, post, reasoning) must equal a dish price, a price printed next to the dish on the menu, or a number in a verified claim; one repair call fixes or removes the rest. Costs are measured token counts × published Token Factory prices (writer + repair calls; the shared research step is reported separately).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, final | Prices in the text backed (first → final) | Dishes tied to this week | Dishes new to the menu | Writer time (median / slowest) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ultra-medium | 8/8 | 0 | 20.6 | 45% | 84% | 83% → 100% (123) | 71% | 100% | 31.4 s / 41.6 s | $0.0947 |
| ultra-low | 8/8 | 0 | 16.5 | 44% | 84% | 83% → 100% (54) | 67% | 100% | 22.2 s / 52.9 s | $0.0849 |
| super-medium | 8/8 | 2 | 16.8 | 64% | 88% | 80% → 100% (5) | 67% | 100% | 123.2 s / 223.3 s | $0.0333 |
| lightning-low | 6/8 | 2 | 15.8 | 59% | 81% | 40% → 40% (5) | 28% | 67% | 67.0 s / 193.8 s | $0.0248 |

Shared research step (once per restaurant): median 34 sources, median $0.0014 of Nemotron Lightning, median 5 Tavily credits.

**Definitions.** *Retries*: the writer ran out of tokens while reasoning or got stuck repeating itself, and production retried it with `reasoning_effort: "low"`. *Dishes tied to this week*: share of the three dishes with at least one verified cite to the forecast, a holiday, a nearby event or local news. *Dishes new to the menu*: share of dishes whose name does not appear on the restaurant's own menu or site pages (only where those were found).

**Limits.** 32 plans over 8 restaurants is a small sample; verification measures whether claims are backed by the sources, not whether the dishes would sell. Web content changes daily, so a re-run gathers different evidence.

## What changed between rounds, and the routing decision

Every round uses the same 8 restaurants and the same cached evidence packs; only the writer setting and the verifier change. Verification shares are pooled over all claims (verified ÷ claims).

| Round | What the verifier required | Ultra · low, first pass → final | Ultra · medium | Super · medium | Lightning · low |
|---|---|---|---|---|---|
| v3 (copied quotes) | quote word for word in the cited source; numbers present; one shared word | 35% → 93% | 53% → 98% | 97% → 98% | 89% → 97% |
| v4 (sentence ids) | cited sentence exists; numbers present; one shared word | 73% → 96% | 76% → 96% | 94% → 98% | 89% → 94% |
| v5 (coverage) | cited sentence exists; numbers present; **the claim's content words are in the cited sentences** (at most one in five missing); **prices in the plan's text checked** | 41% → 81% | 47% → 89% | 56% → 82% | 71% → 88% |
| **v6 (coverage + languages, this table)** | as v5; when most of the cited text is in another language than the plan, words can't be matched, so the check keeps every number and requires a shared name or number | 44% → 84% | 45% → 84% | 64% → 88% | 59% → 81% |

**v3 → v4: cite sentence ids instead of copying quotes.** Ultra's first pass doubled at low effort: most of its failures had been copy errors, not unsupported claims.

**v4 → v5: a strict check, after a judge-style audit of our own demos.** v4 passed a claim if it shared a single word with its cited sentences. On our showcase run that let through "Pomodoro Crudo with confit tomato, oregano, basil" citing a menu line that mentions neither oregano nor basil, and a headline price ($24) that matched no dish ($22). v5 requires the claim's specific words to be in what it cites (the restaurant's own name, connective words and forecast vocabulary don't count; "Wednesday" matches "Wed"), shows the owner any neighbouring line it needed, and checks every money amount in the free text. Every writer lost first-pass points; that is the honest price of a check that means what it says. The repair pass now drops unsupported details instead of keeping them.

**v5 → v6: claims about sources in another language.** A plan in English citing a Spanish menu can't share words with it ("eggs" vs "huevos"), so v5 failed correct claims for Madrid, Barcelona and Paris. v6 detects the language of the cited text from its function words and, across languages, checks numbers and names; those claims are labelled as such in the app.

**How much is noise.** v5 and v6 are two independent samples of every writer on the same evidence (the language change only touches non-English sources), and final verification moved by up to 6 points between them for the same setting (Ultra · medium 89% → 84%, Super 82% → 88%). With 8 restaurants, differences under about 5 points between writers are not meaningful; we only act on larger or repeated gaps.

**Routing (from v5 and v6).**
- **Quick (default): Nemotron Ultra, medium effort.** Best average over the two strict rounds (89% and 84% verified after repair) and fast (median 27–31 s). Low effort is a little faster and ended 81% and 84%.
- **Economy: Nemotron Super, medium effort.** About a third to a half of Ultra's cost per plan ($0.033–0.049) and as faithful (82% and 88%), but a median ~2 min to write, and its stream went silent for over a minute mid-plan in 2 of 8 plans in each round; the stall watchdog cut it and a low-effort retry finished. Good when nobody is waiting, such as a scheduled weekly run.
- **Lightning stays the research model.** It ties few of its dishes to the coming week (13–28%) and as a writer it stalled in 2 of 8 v6 plans.

**Prices in the plan's text.** Before repair, about 80% of the money amounts Ultra wrote in headlines, plays, events and posts matched a dish price, a menu price next to its dish, or a number in a verified claim; after one repair call, 97–100%. Anything still unbacked is listed to the owner.
