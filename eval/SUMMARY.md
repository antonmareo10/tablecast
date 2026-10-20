# Routing eval — which Nemotron should write the plan?

Run on 2026-10-20 with `npx tsx scripts/eval-routing.ts`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).

**Method.** For each restaurant the evidence is gathered once (OpenStreetMap, Open-Meteo, Nager.Date, Ticketmaster, then Nemotron 3.5 Lightning researching the web with Tavily). Every writer configuration then writes a plan from that same evidence pack, and every claim is verified in code exactly as in production: the quote must appear word for word in the cited source and every number in the sentence must appear in a cited source. "First pass" is before the verifier's re-attribution and one Lightning repair pass; "final" is what the owner sees. Costs are measured token counts × published Token Factory prices (writer + repair calls; the shared research step is reported separately).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, final | Dishes tied to this week | Dishes new to the menu | Writer time (median) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|
| ultra-medium | 8/8 | 1 | 16.8 | 51% | 83% | 67% | 100% | 41.4 s | $0.0417 |
| ultra-low | 8/8 | 0 | 18.5 | 55% | 89% | 96% | 100% | 37.9 s | $0.0447 |
| super-medium | 8/8 | 1 | 16.4 | 88% | 91% | 63% | 100% | 132.4 s | $0.0202 |
| lightning-low | 7/8 | 0 | 13.9 | 65% | 80% | 14% | 86% | 110.7 s | $0.0054 |

Shared research step (once per restaurant): median 34 sources, median $0.0014 of Nemotron Lightning, median 5 Tavily credits.

**Definitions.** *Retries*: the writer ran out of tokens while reasoning or got stuck repeating itself, and production retried it with `reasoning_effort: "low"`. *Dishes tied to this week*: share of the three dishes with at least one verified cite to the forecast, a holiday, a nearby event or local news. *Dishes new to the menu*: share of dishes whose name does not appear on the restaurant's own menu or site pages (only where those were found).

**Limits.** 32 plans over 8 restaurants is a small sample; verification measures whether claims are backed by the sources, not whether the dishes would sell. Web content changes daily, so a re-run gathers different evidence.
