# Routing eval — which Nemotron should write the plan?

Run on 2026-10-21 with `npx tsx scripts/eval-routing.ts`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).

**Method.** For each restaurant the evidence is gathered once (OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, Tavily Map, then Nemotron 3.5 Lightning researching the web with Tavily Search/Extract). Every writer configuration then writes a plan from that same evidence pack, and every claim is verified in code exactly as in production: each cited sentence must exist, every number in the claim must appear in a cited sentence (or its neighbouring lines), and the cited sentences must contain the claim's content words — at most one in five may be missing (one for claims of 4–9 words, none for shorter ones). "First pass" is the writer alone; then one repair pass (the same for every configuration: Nemotron Ultra at low effort, one call per failing claim) fixes or drops what failed; "final" is what the owner sees. Verification shares are pooled over all claims of a configuration (verified claims ÷ claims), not medians of per-plan rates. Money amounts in the plan's free text (headline, plays, event, post, reasoning) must equal a dish price, a price printed next to the dish on the menu, or a number in a verified claim; one repair call fixes or removes the rest. Costs are measured token counts × published Token Factory prices (writer + repair calls; the shared research step is reported separately).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, final | Prices in the text backed (first → final) | Dishes tied to this week | Dishes new to the menu | Writer time (median / slowest) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ultra-medium | 8/8 | 0 | 20.9 | 47% | 89% | 78% → 97% (58) | 83% | 100% | 27.2 s / 36.5 s | $0.1052 |
| ultra-low | 8/8 | 1 | 17.1 | 41% | 81% | 82% → 100% (72) | 75% | 100% | 25.5 s / 47.5 s | $0.1045 |
| super-medium | 8/8 | 2 | 16.9 | 56% | 82% | 38% → 100% (8) | 50% | 100% | 118.1 s / 177.2 s | $0.0487 |
| lightning-low | 8/8 | 0 | 16.0 | 71% | 88% | 78% → 100% (9) | 13% | 54% | 99.8 s / 199.3 s | $0.0233 |

Shared research step (once per restaurant): median 34 sources, median $0.0014 of Nemotron Lightning, median 5 Tavily credits.

**Definitions.** *Retries*: the writer ran out of tokens while reasoning or got stuck repeating itself, and production retried it with `reasoning_effort: "low"`. *Dishes tied to this week*: share of the three dishes with at least one verified cite to the forecast, a holiday, a nearby event or local news. *Dishes new to the menu*: share of dishes whose name does not appear on the restaurant's own menu or site pages (only where those were found).

**Limits.** 32 plans over 8 restaurants is a small sample; verification measures whether claims are backed by the sources, not whether the dishes would sell. Web content changes daily, so a re-run gathers different evidence.

## What changed between rounds, and the routing decision

Every round uses the same 8 restaurants and the same cached evidence packs; only the writer setting and the verifier change. Verification shares are pooled over all claims (verified ÷ claims).

| Round | What the verifier required | Ultra · low, first pass → final | Ultra · medium | Super · medium | Lightning · low |
|---|---|---|---|---|---|
| v3 (copied quotes) | quote word for word in the cited source; numbers present; one shared word | 35% → 93% | 53% → 98% | 97% → 98% | 89% → 97% |
| v4 (sentence ids) | cited sentence exists; numbers present; one shared word | 73% → 96% | 76% → 96% | 94% → 98% | 89% → 94% |
| **v5 (coverage, this table)** | cited sentence exists; numbers present; **the claim's content words are in the cited sentences** (at most one in five missing); **prices in the plan's text checked** | 41% → 81% | 47% → 89% | 56% → 82% | 71% → 88% |

**v3 → v4: cite sentence ids instead of copying quotes.** Ultra's first pass doubled at low effort: most of its failures had been copy errors, not unsupported claims.

**v4 → v5: a strict check, after a judge-style audit of our own demos.** v4 passed a claim if it shared a single word with its cited sentences. On our showcase run that let through "Pomodoro Crudo with confit tomato, oregano, basil" citing a menu line that mentions neither oregano nor basil, and a headline price ($24) that matched no dish ($22). v5 requires the claim's specific words to be in what it cites (the restaurant's own name, connective words and forecast vocabulary don't count; "Wednesday" matches "Wed"), shows the owner any neighbouring line it needed, and checks every money amount in the free text. Every writer lost first-pass points; that is the honest price of a check that means what it says. The repair pass now drops unsupported details instead of keeping them.

**Routing (from v5).**
- **Quick (default): Nemotron Ultra, medium effort.** Most claims verified after repair (89%), as fast as low effort (median 27 s vs 26 s) at the same cost. Under v4 the two efforts tied, so low won on speed; the stricter check separates them, so medium wins now.
- **Economy: Nemotron Super, medium effort.** About half of Ultra's cost per plan ($0.049 vs $0.105) but a median 118 s to write, 82% verified and fewer dishes tied to the week (50% vs 83%). Its stream went silent for over a minute in 2 of 8 plans (after ~145 s); the stall watchdog cut it and a low-effort retry finished. Good for a scheduled weekly run where nobody waits.
- **Lightning stays the research model.** Highest first pass (it writes fewer, simpler claims), but only 13% of its dishes tie to the coming week and about half are already on the menu.

**Prices in the plan's text.** Before repair, 78–82% of the money amounts Ultra wrote in headlines, plays, events and posts matched a dish price, a menu price next to its dish, or a number in a verified claim; after one repair call, 97–100%. Anything still unbacked is listed to the owner.
