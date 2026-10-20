# Routing eval — which Nemotron should write the plan?

Run on 2026-10-20 with `npx tsx scripts/eval-routing.ts`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).

**Method.** For each restaurant the evidence is gathered once (OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, Tavily Map, then Nemotron 3.5 Lightning researching the web with Tavily Search/Extract). Every writer configuration then writes a plan from that same evidence pack, and every claim is verified in code exactly as in production: each cited sentence must exist, every number in the claim must appear in a cited sentence, and the cited sentences must share content with the claim. "First pass" is the writer alone; then one repair pass (the same for every configuration: Nemotron Ultra at low effort, one call per failing claim) fixes or drops what failed; "final" is what the owner sees. Costs are measured token counts × published Token Factory prices (writer + repair calls; the shared research step is reported separately).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, final | Dishes tied to this week | Dishes new to the menu | Writer time (median) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|
| ultra-medium | 8/8 | 0 | 18.8 | 76% | 96% | 67% | 100% | 38.9 s | $0.0653 |
| ultra-low | 8/8 | 1 | 17.5 | 73% | 96% | 71% | 100% | 32.9 s | $0.0752 |
| super-medium | 8/8 | 0 | 20.3 | 94% | 98% | 71% | 100% | 126.8 s | $0.0233 |
| lightning-low | 8/8 | 0 | 15.4 | 89% | 94% | 25% | 75% | 93.9 s | $0.0079 |

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
- **Thorough: Nemotron Super, medium effort.** Most faithful first time (94%) and a third of Ultra's cost per plan, but a median 127 s to write. If it runs out of time, Ultra takes over for the retry.
- **Lightning stays the research model.** It is the cheapest writer but tied only 25% of its dishes to the coming week.
