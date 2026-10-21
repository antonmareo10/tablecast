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

## What changed between runs, and the routing decision

**Citing sentence ids instead of copying quotes.** In the previous run (same 8 restaurants and evidence packs; 7 published plans per writer), the writer had to copy each supporting quote word for word. Now every source is cut into numbered sentences, the writer cites ids such as `S9.4`, and the server fills in the quote. The repair pass and the checks are the same.

| Writer | Verified, first pass (before → now) | Verified, final (before → now) |
|---|---|---|
| ultra-medium | 53% → 76% | 98% → 96% |
| ultra-low | 35% → 73% | 93% → 96% |
| super-medium | 97% → 94% | 98% → 98% |
| lightning-low | 89% → 89% | 97% → 94% |

Ultra's first pass doubled at low effort: most of its failures had been copy errors, not unsupported claims. Super and Lightning already copied faithfully.

**Routing.** The app now offers two writers, chosen by whether the owner is waiting:
- **Quick (default): Nemotron Ultra, low effort.** Fastest writer (median 33 s); 96% of claims verified after the code-checked repair. Low and medium effort end equally faithful after repair (96%); low writes faster (33 s vs 39 s median), medium costs slightly less. Speed decides it when someone is waiting.
- **Thorough: Nemotron Super, medium effort.** Most faithful first time (94%) and a third of Ultra's cost per plan, but a median 127 s to write, and the slowest write here took 207 s. The app caps one Super attempt at 170 s; past that, Ultra takes over for the retry.
- **Lightning stays the research model.** It is the cheapest writer but tied only 25% of its dishes to the coming week.
