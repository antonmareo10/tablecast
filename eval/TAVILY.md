# What Tavily adds to a plan — an ablation

Run on 2026-10-21 with `npx tsx scripts/eval-tavily.ts --repeats 2`. Per-plan numbers: [metrics-tavily.csv](metrics-tavily.csv). Code: [scripts/eval-tavily.ts](../scripts/eval-tavily.ts) (runner) and [scripts/tavily-ablation.ts](../scripts/tavily-ablation.ts) (the ablation and every metric, unit-tested in [tests/tavily-ablation.test.ts](../tests/tavily-ablation.test.ts)).

**Short answer.** Tavily does not make a plan *more checkable by count*: written from the same week without any web page, Nemotron Ultra still produced as many verified claims (13.4 per plan vs 12.3 with Tavily in the paired sample, 17.4 in a second sample of the full pack). What Tavily changes is **what the verified claims are about**. With it, 47% of verified claims cite a page Tavily found, and the plan stands on the restaurant's real menu, what guests and critics say and, sometimes, local news and a competitor. Without it, every verified claim is about the forecast, Ticketmaster listings or the count of venues on the block. The writer then fills the menu and "loved for" sections from memory or with block counts, and in 3 of 8 plans it proposes as "new" dishes items it lists as already on the menu. The competitor side is weak: only 1 of 8 plans (in both samples) cites a competitor's price.

## Method

- **Same evidence, minus Tavily.** The 8 restaurants of the routing eval ([restaurants.json](restaurants.json)) and their evidence packs, gathered once on 20 Oct 2026 and cached. No Tavily call was made for this eval. The *no-Tavily* pack drops every source whose provider is Tavily (median 20 of 34 sources: the restaurant's site and menu pages, reviews and guides, rival pages, local news) and renumbers the rest. It keeps OpenStreetMap (the place, its website URL and the block), the Open-Meteo forecast and Ticketmaster events. No Nager.Date holiday fell in the window.
- **Context string.** The only context line the code builds from Tavily is `MENU PAGES (Tavily Map): …` ([agent.ts](../src/lib/agent.ts), `buildContext`). It is removed in the no-Tavily pack, but none of the 8 packs had one (they predate Map, see *Limits*), so their context is identical in both variants. The separation is exact here, not an approximation.
- **Same writer.** The production Quick writer (`defaultRouting()`: Nemotron 3 Ultra, `reasoning_effort: "medium"`) writes each pack with `writeAndVerify`. Both variants get the same prompt, the same verifier (v6) and the same repair pass as in the app.
- **Samples.** One paired sample: 16 new plans written on 21 Oct, one per restaurant and variant. The full variant also has a free second sample, the routing eval's v6 Ultra-medium plan on the same packs with the same code. The main table pools only the paired sample.
- **Metrics in code**, from the published plan and its draft. *Verified* means the production check passed after the repair pass. Source kinds (menu, review, rival…) are the research model's labels.

## Results (paired: the same 8 packs, sample 1)

| Per plan | With Tavily | Without Tavily |
|---|---|---|
| Plans published (retried at low effort) | 8/8 (1) | 8/8 (1) |
| Claims written / verified (mean per plan) | 15.4 / 12.3 | 18.5 / 13.4 |
| Share verified, first pass → after repair | 45% → 80% | 43% → 72% |
| Verified claims citing a Tavily page (only Tavily) | 47% (43%) | – |
| Verified claims per plan citing: web pages (Tavily) · forecast · events · the block | 5.8 · 3.3 · 1.9 · 2.1 | 0.0 · 5.0 · 4.1 · 4.5 |
| Distinct sources behind verified claims (mean) | 6.9 | 4.9 |
| “Loved for / watch outs” claims verified per plan: citing web pages / citing only forecast, events or the block | 2.6 / 0.0 | 0.0 / 2.1 |
| Plans with a verified “loved for / watch outs” claim from the web | 6/8 | 0/8 |
| Items the plan lists as its current menu: found on a page of its own sources · on the real menu¹ / listed | 117 · 117 / 133 | 0 · 5 / 33 |
| Plans showing “On your menu now” (≥ 3 checked items) | 7/8 | 0/8 |
| Dishes with a verified cite to the restaurant's menu or site | 50% | 0% |
| “New” dishes named exactly like an item the plan lists as already on the menu (plans) | 0 / 24 (0/8) | 8 / 24 (3/8) |
| Dishes already on the real menu (exact name)¹ | 0 / 24 | 1 / 24 |
| Verified claims with a competitor's price² (plans with any) | 1 (1/8) | 0 (0/8) |
| Verified claims from this week's local news (plans with any) | 4 (2/8) | 0 (0/8) |
| Dishes tied to this week (verified cite to the forecast, a holiday, an event or news) | 58% | 75% |
| Prices in the plan's text backed, first → final (amounts) | 83% → 100% (53) | 73% → 97% (97) |
| Writer prompt tokens (median) | 13,949 | 6,821 |
| Writer time (median) | 39.3 s | 23.6 s |
| Nemotron cost per plan, writer + repairs (median) | $0.105 | $0.070 |

¹ Judged by exact (normalised) name against the menu and site pages Tavily fetched for that restaurant, the only menus we have. Paraphrases are missed, and two restaurants' fetched menus are thin (see *Limits*). ² A verified claim with a money amount citing a page labelled "rival" whose URL and title don't name the restaurant itself. Every counted claim was also read by hand.

**One sample moves a lot.** The same writer on the same full packs:

| Variant · sample | Verified / plan (share) | Citing Tavily | “Loved for / watch outs” from the web / plan | “On your menu now” shown | Dishes citing the menu | “New” dishes repeating the listed menu | Competitor-price claims |
|---|---|---|---|---|---|---|---|
| with Tavily · 1 (this eval) | 12.3 (80%) | 47% | 2.6 | 7/8 | 50% | 0/24 | 1 |
| with Tavily · 2 (routing eval v6) | 17.4 (84%) | 47% | 3.4 | 6/8 | 58% | 0/24 | 1 |
| without Tavily · 1 (this eval) | 13.4 (72%) | 0% | 0.0 | 0/8 | 0% | 8/24 | 0 |

So the count of verified claims and the verified share (80–84% vs 72%) are within the noise of one sample of 8. The differences in *content* (menu, guests, repeated dishes) are large and repeat in both samples.

Per restaurant, verified/written claims (with Tavily: sample 1 · sample 2; without: sample 1): Casa Lucio 16/18 · 14/15 vs 14/21; Katz's 14/19 · 20/22 vs 12/20; Gjelina 15/17 · 22/24 vs 8/10; Dishoom 13/13 · 14/16 vs 15/21; Chez Janou 6/8 · 15/20 vs 17/24; Bar Cañete 10/16 · 16/20 vs 13/18; Zuni Café 17/21 · 18/26 vs 16/18; Au Cheval 7/11 · 20/22 vs 12/16.

**What the research step costs** (from the 8 cached packs): **Tavily credits per plan median 5, range 2–6** (Map + Search + Extract, as reported by `include_usage`), plus a median $0.0014 of Nemotron Lightning to drive the research. The bigger prompt then adds about $0.035 and 16 s to the writer.

## Examples: facts only Tavily found

Each is a verified claim from the plan written *with* Tavily (sample 1). Every sentence it cites comes from a Tavily page. The forecast, event and map sources state none of these facts.

**Dishoom Covent Garden, London**
- Competitor prices: *"Masala Zone at 48 Floral Street offers group dinner menus at £32.50–£50.50 per person and lunch at £29.25–£45 per person."* ← masalazone.com/locations/covent-garden: "Dinner party menus £32.50 - £50.50; lunch £29.25-£45".
- Local news that the events API did not list: *"The Ballon d'Or award ceremony moves to London for the first time on 26 October 2026…"* ← a Hankook press release (hankooktire-mediacenter.com): "This year's award ceremony will take place in London for the first time on 26 October 2026." The plan built a dish and its event around it.
- Its own menu: *"Group feasts are served daily for groups of 8 or more, with lunch at £42 per person and dinner from £55 per person."* ← dishoom.com/menu/group-feast-covent-garden.

- **It is now a replay.** Dishoom Covent Garden, recorded 21 Oct with verifier v7 (Quick, 79 s, 8 Tavily credits). The research step's search "London events this week October 2026 footfall" found the same Hankook press release. Ticketmaster's 25 listings for the week didn't include the ceremony. The plan's moment for Mon 26 Oct and its dish for that night (a pistachio kulfi with fizz) both cite it and are verified.

**Katz's Delicatessen, New York**
- A critic's warning: *"A Times reporter described Katz's pastrami as 'tough, rubbery, and barely edible,' flagging consistency risk."* ← dinertheory.substack.com/p/diner-theory-nyc-katzs-deli-review.
- Its own menu: *"Half sandwiches with soup are a listed all‑day special at Katz's."* ← katzsdelicatessen.com/store-menu: "Half sandwich served with soup or salad."
- Without Tavily, the same writer proposed three "new" dishes: Pastrami on Rye, a Classic Reuben ($18) and Matzo Ball Soup. It listed all three as already on the menu, and Katz's sells a Reuben and matzo ball soup (store-menu page).

**Bar Cañete, Barcelona**
- What guests say: *"The waiters are friendly and professional, and quality is infused in every detail."* ← barcelonafoodexperience.com/blog/bar-canete.
- Current prices: *"Galician baby scallops with bellota ham cost €23.10. Marinera clams with fish broth cost €30.55."* ← guidavera.com/spain/barcelona/restaurants/canete. The plan's three dishes are priced €9.50–20 next to them. Without Tavily, the writer wrote "Not provided" for the menu and priced its dishes €12–30 with nothing to compare.

## Limits

- **n = 8, one paired sample.** The full variant's second sample differs from the first by 5 verified claims per plan. Treat count and share differences of that size as noise.
- **Evidence gathered once** (20 Oct). A re-gather finds different pages.
- **It removes the whole research step's output**, so it measures "web research with Tavily vs none", not Tavily against another search API.
- **Same prompt for both.** The writer is still asked for the menu, the guest snapshot and rivals. Without sources it fills them from memory (33 menu items listed, 5 on the real menu, none checkable) or with block and forecast facts. This is what production would publish if Tavily were down.
- **"Real menu" ground truth is only what Tavily fetched.** Casa Lucio's carta page came back without dish text, and Zuni Café's menu PDFs extracted only their service-charge notes. "On the real menu" counts are exact-name matches and miss paraphrases.
- **Source labels are loose.** The research model filed Zuni Café's own reviews (SF Chronicle, Eater, Resy) as "rival" and Frommers as "menu". That is why the guest row counts any web page, and the competitor row excludes pages naming the restaurant: the 3 Zuni "rival" prices were Zuni's own.
- **Verified was not the same as the right subject** when this eval ran. The verifier checked that the cited sentences say what the claim says, not that they are about this restaurant. In sample 1, five verified claims were about another place or item: Masala Zone's "private room seats up to 42" and its accessibility note under Dishoom's loved-for, watch-outs and event (3), a review of Gjelina at the Venetian in Las Vegas under Gjelina Venice's watch-outs, and Katz's "As a Reuben, $33.95" (listed under *Combos*) read as the Reuben's price. A subject check added afterwards ([src/lib/subject.ts](../src/lib/subject.ts)) rejects all five. Re-checked in code with no new model calls ([scripts/subject-recheck.ts](../scripts/subject-recheck.ts)), it rejects 6 of the 543 verified claims of the 38 cached plans written with Tavily sources (these five, and the same Las Vegas review in the routing eval's Super plan), all six genuine on reading, and 0 of the 107 in the no-Tavily plans. Counting the five as unverified, sample 1 with Tavily has 11.6 verified claims per plan (76%), 44% citing Tavily, and 2.1 web "loved for / watch outs" claims per plan (still 6/8 plans). The tables above are as measured, before the check; in the app the repair pass would also get a chance to fix such claims.
- **Tavily Map is not in these packs.** They were gathered on 20 Oct (files written 20:27–20:53) by two routing-eval processes already running by 20:28 and 20:33; Map was added at 20:40, and a running process does not reload code, so no pack ran it. The research model guessed menu URLs instead (`gjelina.com/menu`, `casalucio.es/carta`). Real Map calls made afterwards (21 Oct) found that Map as first shipped had a problem of its own: with Tavily's default `max_breadth` of 20 it returned only the first 20 links of the home page, mostly navigation, other branches and shop items. Dishoom's `/menu/covent-garden-all-day` (one of 137 distinct links in its HTML) was never listed, Gjelina's map put the New York and Las Vegas menus next to the Los Angeles one, and on Katz's site only a catering package matched. Map now asks for menu-like paths only (`select_paths`, `max_breadth` 150, billed per page returned), sets aside other cities' menus and reads the best page with Extract before research. On the same sites: Dishoom, 16 menu pages (2 credits), with the branch's all-day menu first; Gjelina, the Los Angeles menu (3,933 characters with prices), New York and Las Vegas set aside; Casa Lucio, `/carta`, which extracts almost no text (research still searches); Katz's, none, because its menu page is not linked from the home page Map sees. This ablation does not measure the fixed Map. Those checks cost 9 Tavily credits.
- Verification measures support by sources, not whether a dish would sell.

**Spend.** $1.47 of Nemotron inference for the 16 new plans (writer + repairs, at published Token Factory prices). No Tavily credits, since the cached packs were reused.
