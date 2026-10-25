# Routing eval — which Nemotron should write the plan?

Run on 2026-10-21 with `npx tsx scripts/eval-routing.ts`. Restaurants: [eval/restaurants.json](restaurants.json) (fixed before running).

> **Latest (25 Oct):** a [model comparison](#model-comparison-four-nemotrons-alone-and-tiered-with-cost-25-oct): Ultra, Super, Lightning and Nano, alone and tiered, on the same 8 held-out packs, with cost and a blind precision sample. Lightning writing with Ultra repairing verified 82% for $0.025 a plan, Ultra alone 79% for $0.106, but Lightning tied 13% of its dishes to the week against Ultra's 58%; Nano published 12 of 16 plans; and the same setting moved 11 points between two runs.
>
> **Before (22–23 Oct, verifier v7.1):** a [rule for prices next to a competitor](#v71-a-price-next-to-a-competitors-name) after reading my whole showcase, and a [second held-out round](#v71-held-out-round-2-every-verified-claim-read-by-hand) on 8 more new restaurants (Quick 74%, Economy 80% verified after repair) with **every** verified claim read by hand: 186 of 212 correct, 19 minor slips, 7 wrong. Before that (21 Oct, v7): [what changed](#v7-what-my-own-showcase-taught-the-verifier), the [first held-out round](#v7-held-out-round) (73%, 74%) and a [sampled audit](AUDIT.md) (94 of 100). The table right below is the v6 round on the 8 tuning restaurants.

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
| v7 held-out (8 *new* restaurants, [below](#v7-held-out-round)) | as v6, but numbers-and-names only for pages written in another language; an add-on goes with the dish above it; no date before today | – | 38% → 73% | 63% → 74% | – |

**v3 → v4: cite sentence ids instead of copying quotes.** Ultra's first pass doubled at low effort: most of its failures had been copy errors, not unsupported claims.

**v4 → v5: a strict check, after a judge-style audit of our own demos.** v4 passed a claim if it shared a single word with its cited sentences. On our showcase run that let through "Pomodoro Crudo with confit tomato, oregano, basil" citing a menu line that mentions neither oregano nor basil, and a headline price ($24) that matched no dish ($22). v5 requires the claim's specific words to be in what it cites (the restaurant's own name, connective words and forecast vocabulary don't count; "Wednesday" matches "Wed"), shows the owner any neighbouring line it needed, and checks every money amount in the free text. Every writer lost first-pass points; that is the honest price of a check that means what it says. The repair pass now drops unsupported details instead of keeping them.

**v5 → v6: claims about sources in another language.** A plan in English citing a Spanish menu can't share words with it ("eggs" vs "huevos"), so v5 failed correct claims for Madrid, Barcelona and Paris. v6 detects the language of the cited text from its function words and, across languages, checks numbers and names; those claims are labelled as such in the app.

**How much is noise.** v5 and v6 are two independent samples of every writer on the same evidence (the language change only touches non-English sources), and final verification moved by up to 6 points between them for the same setting (Ultra · medium 89% → 84%, Super 82% → 88%). With 8 restaurants, differences under about 5 points between writers are not meaningful; we only act on larger or repeated gaps.

**Routing (from v5 and v6).**
- **Quick (default): Nemotron Ultra, medium effort.** Best average over the two strict rounds (89% and 84% verified after repair) and fast (median 27–31 s). Low effort is a little faster and ended 81% and 84%.
- **Economy: Nemotron Super, medium effort.** About a third to a half of Ultra's cost per plan ($0.033–0.049) and as faithful (82% and 88%), but a median ~2 min to write, and its stream went silent for over a minute mid-plan in 2 of 8 plans in each round; the stall watchdog cut it and a low-effort retry finished. Good when nobody is waiting, such as a scheduled weekly run.
- **Lightning stays the research model.** It ties few of its dishes to the coming week (13–28%) and as a writer it stalled in 2 of 8 v6 plans.

**Prices in the plan's text.** Before repair, about 80% of the money amounts Ultra wrote in headlines, plays, events and posts matched a dish price, a menu price next to its dish, or a number in a verified claim; after one repair call, 97–100%. Anything still unbacked is listed to the owner.

## v7: what my own showcase taught the verifier

A strict review of the flagship replay (Gjelina, Quick) found three things the v6 check let through. Each became a rule in code, with tests.

1. **An English menu read as Italian.** Dish names like "Cacio e Pepe" and "Le Puy" made v6 call gjelina.com's English menu Italian, so it skipped the word check on both verified dish claims. v7 runs the word check first. It falls back to numbers and names only if that check fails *and* the cited page is clearly written in another language: at least 4 function words of that language, twice the plan language's count, and at least 8% of the page's words. On the eval packs, Spanish and French pages score 16–37% and Gjelina's English menus 0.7–1.2%. Lines Tablecast writes itself (forecast, events, holidays, the block) count as English whatever names they carry, and the restaurant's own name doesn't count ("Au Cheval").
2. **An add-on paired with the wrong dish.** The replay said the Vegetable Sandwich had "an add-egg option for $3". On the page, "Add egg $3" sits under the BLT. An add-on line ("Add …", "+ …", "Extra …") now belongs to the dish right above it. A claim that pairs it with another dish fails.
3. **A plan dated before its own run.** The writer was told the server's date, with no weekday, and asked for "the next 7 days from today". The replay, recorded on Wednesday 21 Oct in Los Angeles, ordered supplies on Tuesday 20 Oct and posted that afternoon. The writer now gets the restaurant's local date (from its time zone, confirmed by the forecast's first day) and the week as a calendar. Code reads every explicit date in the day-by-day plan, the moments, the dishes, the event and the post. Dates before today get one repair call. A day-plan line still in the past is dropped, and anything else is listed under Proof. Ticketmaster items outside the week (a season pass dated 25 Sep) are now dropped too.

**Re-check with no model calls** ([scripts/v7-recheck.ts](../scripts/v7-recheck.ts)): the 46 cached plans of the v6 and Tavily rounds, and the 3 replays of the time.

| What changed | Cached plans (650 claims verified when written) | Replays (47) |
|---|---|---|
| Rejected: the word check now applies (the page is not in another language) | 39 | 0 |
| Rejected: the add-on belongs to the dish above | 0 | 1 (the showcase claim) |
| Rejected: subject check (added 21 Oct, before v7) | 6 | 0 |
| Still verified, no longer labelled "read across languages" | 52 | 6 |
| Scheduling fields dated before the plan's own date | 28, in 16 of 46 plans | 2, in 1 of 3 (Gjelina) |

The replays keep only 600 characters of each page, so 15 of their 47 claims couldn't be re-read. Gjelina's menu was re-supplied from the same day's fetch. I read the 39 language-rule rejections by hand:

- **15 had a wrong or unsupported detail that v6 let through.** Examples: "Creamy Polenta" on a meatball dish that has none, a "blueberry compote" nowhere on the menu, "nearest bars" when a pub is closer, block venues called "Spanish/regional restaurants", "theatre-goers from Mon night" for Tuesday shows, and "8 cafés" for "coffee shop 8".
- **24 had their facts right but used words the lines don't contain.** Examples: "takes place", "sits", "begin", and commentary like "so lunch competition is fierce". This is the cost of the stricter check. English-named listings always got this treatment; v6 was lenient only when a listing carried Spanish or French names. In the app, the repair pass gets one chance to rephrase such claims.

All 28 past-dated fields in the cached plans are "Mon 19 Oct" in plans made on Tuesday 20 Oct, except one no-Tavily plan dated in 2025. Two plans even called Monday "today". **Effect on the tuning-set numbers:** the v6 plans re-checked with v7, with no new repair pass, go from 84% to 82% verified (Quick) and from 88% to 82% (Economy).

## v7.1: a price next to a competitor's name

On 22 Oct I read the Gjelina replay in full ([AUDIT.md](AUDIT.md#the-flagship-replay-read-in-full-22-oct)). Its 24 verified claims held up (20 correct, 4 minor slips, none wrong), but its block summary said "the nearest pizza is $22 at Abbot's, while Gjelina's Pomodoro is also $22". No source prices Abbot's Pizza Company. The price check only asked whether each amount in the free text was a price the plan could back, and $22 is Gjelina's own Pomodoro.

**The rule.** When the clause around an amount names a venue from the block, the amount has to come from that venue: a checked claim that puts the venue's name and the amount in one clause. The restaurant's own dish named in the same clause at that price also counts ("our $22 Pomodoro against Abbot's slices"). A clause ends at a sentence end, a semicolon, a comma, a spaced dash, "+" or a joining word ("and", "while", "than"…), so "the nearest pizza is $22 at Abbot's" is judged apart from "Gjelina's Pomodoro is also $22". Names are matched as the block writes them, plus short forms ("Abbot's", "The Brig" or "Brig"), never a street that shares a word ("Abbot Kinney"). A failure goes to the same one-shot repair, with a note saying why; what still fails is listed under Proof. Code: [src/lib/amounts.ts](../src/lib/amounts.ts), tests: [tests/competitor-price.test.ts](../tests/competitor-price.test.ts).

**Re-check with no model calls** ([scripts/amounts-recheck.ts](../scripts/amounts-recheck.ts)) over every cached plan of the v5, v6, Tavily and v7 held-out rounds, and the 4 replays:

| | Plans | Money amounts in the text | Amounts next to a block venue | Flagged by v7.1 |
|---|---|---|---|---|
| Cached eval plans | 94 | 482 | 10 | 1 |
| Recorded replays | 4 | – | – | 1 (Gjelina's "$22 at Abbot's") |

Of the 10 cached amounts next to a venue, 8 are the name of a New York pizzeria called "$1.50 Pizza" and 1 is Masala Zone's group feasts at £32.50–£50.50, which a checked claim gives. The one flagged is a proposal, not a fact: "Gjelina patrons get $1 off at The Brig", in a plan written without Tavily. The number check had passed it only because a checked claim contains a 1. The new rule treats it like any proposed amount the plan can't back: in a live run it goes to the repair pass, and it is listed under Proof if it survives. Competitor prices are rare in the free text, and the rule touches almost nothing else.

**Recorded runs.** The replays were recorded before v7.1, so their saved check never ran this rule. The browser runs it on what the replay already holds (the block's venues, the menu it shows, the plan's checked claims) and lists the result under Proof, labelled as a check added after the run was recorded. The run itself is not edited.

## v7 held-out round

The v3–v6 numbers above come from the same 8 restaurants the verifier was tuned on. To check them, I committed 8 new restaurants to [heldout.json](heldout.json) before any run: Franklin Barbecue (Austin), Commander's Palace (New Orleans), Pai Northern Thai Kitchen (Toronto), Hawksmoor Manchester, Chin Chin (Melbourne), Cervejaria Ramiro (Lisbon), Contramar (Mexico City) and Salumeria Roscioli (Rome). They come from 8 cities, 3 of them with non-English pages, and 2 are multi-branch groups. The evidence was gathered once on 21 Oct. The production Quick and Economy writers then wrote from it with v7, next to the app's no-data baseline (the same writer model, no tools, no data). Code: [eval-routing.ts](../scripts/eval-routing.ts) `--restaurants eval/heldout.json`, then [eval-heldout.ts](../scripts/eval-heldout.ts). Per-plan numbers: [metrics-v7-heldout.csv](metrics-v7-heldout.csv).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, after repair | Prices in the text backed (first → final) | Dishes tied to this week | New dishes already on the fetched menu | Listed menu items found on the fetched pages | Fields dated before today | Writer time (median / slowest) | End to end (median / slowest) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Quick (Ultra · medium) | 8/8¹ | 0 | 17.9 | 38% | **73%** | 88% → 100% (99) | 42% | 0/24 | 129/140 | 0 of 165 dates | 20 s / 25 s | 59 s / 75 s | $0.096 + $0.002 research |
| Economy (Super · medium) | 8/8 | 2 | 15.5 | 63% | **74%** | 33% → 100% (3) | 33% | 0/24 | 57/61 | 0 of 154 | 127 s / 178 s | 157 s / 203 s | $0.041 + $0.002 |
| Baseline: Ultra, no tools, no data | 8/8 | – | 0 | – | nothing cited | 0 amounts | 0/24 (by hand) | 0/24 | – | – | 3 s | – | $0.004 |
| Baseline: Super, no tools, no data | 8/8 | – | 0 | – | nothing cited | 3 amounts, none checkable | 0/24 (by hand) | 0/24 | – | – | 2 s | – | <$0.001 |

¹ Franklin Barbecue's first Quick attempt failed. Token Factory's stream errored with "Exceeds the limit (4300 digits) for integer string conversion": the model's JSON held a 4,305-digit number. Production had no retry for an exception, so the whole plan was lost. I added one (commit 13c6471), re-ran that plan, and it published (12/23 verified).

Per restaurant, verified/written (Quick · Economy): Franklin Barbecue 12/23 · 11/17; Commander's Palace 17/18 · 14/17; Pai 9/12 · 14/15; Hawksmoor 18/25 · 6/19; Chin Chin 8/13 · 13/13; Cervejaria Ramiro 19/23 · 8/14; Contramar 16/16 · 15/15; Roscioli 6/13 · 11/14. Research took a median of 23 s and 7 Tavily credits (range 6–9) per restaurant.

**What it says.**
- **Held-out is lower.** After repair, Quick verified 73% and Economy 74%. On the tuning set, the same writers verified 84% and 88% under v6, or 82% and 82% with those plans re-checked under v7. So about 8–9 points of the gap come from new restaurants, not from the stricter check. Two plans per writer did badly: Roscioli (6/13) and Franklin (12/23) for Quick, and Hawksmoor (6/19) and Ramiro (8/14) for Economy.
- **Hand audit.** Of verified claims sampled from this round, 47 of 50 were correct ([AUDIT.md](AUDIT.md)), the same as on the tuning set.
- **Fewer dishes tied to the week:** 42% and 33%, against 71% and 67% on the tuning set. Lisbon and Rome had no Ticketmaster events, and several weeks were dry and uneventful.
- **No scheduling before today:** none of the 319 explicit dates in 16 plans, against 16 of 46 tuning-set plans before the date fix. Melbourne's plan correctly starts on Thu 22 Oct, its local date when the round ran.
- **Grounded in the real menu:** no proposed dish was already on the fetched menu (0/24 for each writer), and 92% of the items a plan listed as on the menu were on the fetched pages.
- **The baseline isn't anchored to the week.** None of its 48 dishes was tied to that week's data. Roscioli's answer starts with "Assuming hot sunny days" for a week that opens with a hailstorm (27.6 mm). Nothing in it can be checked. The exact-name menu check misses paraphrases, so its 0/48 "already on the menu" is a floor.
- **Routing still holds:** Quick is fast (writer 20 s median, about a minute end to end), and Economy is as faithful at under half the cost but takes 2–3 minutes. Economy retried 2 of 8 plans at low effort, and both published.

**Spend for this round:** $1.14 of Nemotron for writers, repairs and baselines, plus $0.015 for research, plus 56 Tavily credits. The failed first Franklin attempt reported no usage.

## v7.1 held-out round 2, every verified claim read by hand

Round 1 above was the held-out set the audit sampled from, and v7.1 came after reading my own showcase. So on 22 Oct I committed 8 more restaurants to [heldout2.json](heldout2.json) before any run (commit c5c31e2): Lilia (New York), Kasama (Chicago), Brat (London), Septime (Paris), Sobrino de Botín (Madrid), Trattoria Sostanza (Florence), Burnt Ends (Singapore) and Zahav (Philadelphia). Three have pages in another language. The same Quick and Economy writers planned them with the production code of the `final-polish` branch (v7.1). Code: [eval-routing.ts](../scripts/eval-routing.ts) `--restaurants eval/heldout2.json --runs runs-v71-heldout2`. Per-plan numbers: [metrics-runs-v71-heldout2.csv](metrics-runs-v71-heldout2.csv).

| Writer | Plans published | Retries | Claims / plan | Verified, first pass | Verified, after repair | Prices in the text backed (first → final) | Dishes tied to this week | Writer time (median / slowest) | Cost / plan (median) |
|---|---|---|---|---|---|---|---|---|---|
| Quick (Ultra · medium) | 8/8 | 2 | 16.3 | 47% | **74%** | 85% → 100% (62) | 38% | 38 s / 314 s | $0.087 |
| Economy (Super · medium) | 8/8 | 1 | 18.1 | 51% | **80%** ¹ | 50% → 100% (8) | 63% | 79 s / 135 s | $0.055 |

¹ 81% as the run counted it: one Economy claim (Septime) was empty text with a valid cite, and nothing in an empty claim can fail a check. v7.1 now rejects an empty claim ([evidence.ts](../src/lib/evidence.ts), test in [evidence.test.ts](../tests/evidence.test.ts)); it was the only one in 1,651 cached claims.

Per restaurant, verified/written (Quick · Economy): Lilia 6/13 · 14/17; Kasama 15/18 · 8/11; Brat 12/14 · 12/18; Septime 15/20 · 20/23; Botín 9/14 · 13/20; Sostanza 18/23 · 20/23; Burnt Ends 12/14 · 16/17; Zahav 9/14 · 13/16. Research: median 27 sources and 6.5 Tavily credits per restaurant. Two Quick plans needed a low-effort retry (Botín, Burnt Ends) and both published. All 13 unbacked prices of the first drafts were fixed by the repair pass.

**Precision, read in full.** Instead of a sample, I read all 212 claims these 16 plans show as verified, each against its cited lines and any neighbouring line the check used ([heldout2-verdicts.tsv](heldout2-verdicts.tsv), one line per claim with the reason; categories as in [AUDIT.md](AUDIT.md)).

| | Quick | Economy | Both |
|---|---|---|---|
| Correct | 82 of 96 (85%, CI 77–91%) | 104 of 116 (90%, CI 83–94%) | **186 of 212 (88%, CI 83–92%)** |
| Minor slip | 12 | 7 | 19 |
| Wrong | 2 | 5 | **7** |
| Correct or minor slip | 98% | 96% | 97% |

This is lower than the sampled audit (94 of 100). The 7 wrong ones: a theatre time taken from the line next to it (Brat), a Paris brasserie called "Rival" read as a rival of Septime, Botín's own Guía Repsol price range presented as "nearby spots", a weekly calendar's festival given a Saturday it doesn't state (Zahav), and three claims on one news article about a Halloween festival in **Florence, Alabama**, which the place check let into a plan for a trattoria in Florence, Italy because the page names "Florence". That last one is a gap in the place check, not in the claim check: a page that names the right city name in the wrong country passes. Most minor slips are a word the plan adds ("signature", "guests", "evening"). As in the audit, one reader did this, the author with Claude Code's help.

**Spend for this round:** $1.16 of Nemotron for writers and repairs, $0.015 for research, and 52 Tavily credits. No baseline was run this time.

## Model comparison: four Nemotrons, alone and tiered, with cost (25 Oct)

Which Nemotron should write the plan, and which should repair what fails the check? I wrote the design in [MODELS-DESIGN.md](MODELS-DESIGN.md) and committed it (40eae2b) before any plan of this round was written. Seven strategies wrote plans for the 8 restaurants of held-out round 2, all from the evidence packs gathered for that round on 22 Oct, so there was no new research and no Tavily call. "Alone" means one model writes the plan and repairs what fails; "→ Ultra" means a smaller model writes and Ultra repairs. Every writer ran at medium effort and every repair at low, with production's checks (v7.1). Code: [eval-models.ts](../scripts/eval-models.ts). Per-plan numbers: [metrics-runs-models.csv](metrics-runs-models.csv).

| Strategy | Plans published | Retries | Claims / plan | Verified, first pass | Verified, after repair | Verified claims / plan | Failed the first check → fixed / dropped / left unverified | Prices in the text backed (first → final) | Dishes tied to this week | Writer time (median / slowest) | Write + check (median / slowest) | Cost / plan (median) | Cost of its 8 plans (writer's share) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ultra alone (production Quick) | 8/8 | 0 | 18.6 | 35% | **79%** | 14.8 | 97 → 66 / 6 / 25 | 80% → 95% (87) | 58% | 19 s / 28 s | 39 s / 55 s | $0.106 | $0.84 (32%) |
| Super alone | 8/8 | 1 | 15.9 | 50% | **66%** | 10.5 | 63 → 20 / 19 / 24 | 33% → 100% (9) | 17% | 89 s / 162 s | 98 s / 172 s | $0.021 | $0.17 (83%) |
| Lightning alone | 8/8 | 0 | 18.9 | 67% | **76%** | 14.4 | 50 → 14 / 6 / 30 | 50% → 100% (4) | 21% | 44 s / 152 s | 50 s / 152 s | $0.005 | $0.04 (68%) |
| Nano alone | 7/8 | 4 | 13.7 | 53% | **73%** | 10.0 | 45 → 19 / 5 / 21 | – | 71% | 292 s / 572 s | 308 s / 590 s | $0.011 | $0.09 (84%) |
| Super → Ultra (production Economy) | 8/8 | 0 | 17.1 | 27% | **69%** | 11.9 | 100 → 58 / 13 / 29 | 0% → 100% (4) | 33% | 84 s / 123 s | 97 s / 141 s | $0.065 | $0.52 (26%) |
| Lightning → Ultra | 8/8 | 0 | 16.9 | 56% | **82%** | 13.9 | 59 → 35 / 5 / 19 | 25% → 75% (4) | 13% | 59 s / 118 s | 72 s / 127 s | $0.025 | $0.24 (12%) |
| Nano → Ultra | 5/8 | 4 | 11.6 | 24% | **62%** | 7.2 | 44 → 22 / 3 / 19 | 100% → 100% (2) | 20% | 240 s / 471 s | 244 s / 471 s | $0.029 | $0.23 (29%) |

Verification shares are pooled over the claims of published plans; times and costs count every attempt, failed ones included. Nano's plans used a median of 20,000 to 22,500 output tokens against Ultra's 6,500, and Token Factory reports no `reasoning_tokens` for Nano, so its share of reasoning can't be measured.

**Precision, read blind.** [scripts/models-sample.ts](../scripts/models-sample.ts) drew 15 verified claims per strategy (seed 20261025) and shuffled all 105 together. Claude Code, the coding agent I build with, read them against their cited lines without knowing which strategy wrote each, and only then were the verdicts joined back to their strategies. Every verdict has its reason in [models-sample-verdicts.tsv](models-sample-verdicts.tsv). It is a model's reading with the same categories as [AUDIT.md](AUDIT.md), not an independent human audit.

| | Ultra alone | Super alone | Lightning alone | Nano alone | Super → Ultra | Lightning → Ultra | Nano → Ultra | All |
|---|---|---|---|---|---|---|---|---|
| Correct | 13 | 14 | 14 | 13 | 14 | 15 | 13 | **96 of 105 (91%)** |
| Minor slip | 0 | 0 | 0 | 2 | 0 | 0 | 2 | 4 |
| Wrong | 2 | 1 | 1 | 0 | 1 | 0 | 0 | **5** |

The 5 wrong ones. Two cite a line where the page extract joined two parts of a page with "[...]", so one item's details went to another: a Halloween attraction's dates, hours and prices given to Singapore's film festival, and a bagna cauda dish described as Lilia's mafaldini. 31 of the 629 verified claims of this round cite such a joined line. One is the Florence, Alabama festival again, in a plan for Florence, Italy. One calls the T-bone "the stuff of legends" when the line says it of the butter chicken. One passed as an Italian page, where only numbers and names are checked, and adds a chickpea and cod dish that isn't on it.

**What it says.**
- **Ultra is the repairer that makes tiering work.** Of the claims that failed the first check, Ultra fixed 68% of its own, 58% of Super's, 59% of Lightning's and 50% of Nano's. Repairing their own, Super fixed 32%, Lightning 28% and Nano 42%. Repairs are most of Quick's cost: 68% of the $0.84 its 8 plans cost.
- **Lightning → Ultra verified the most, for a quarter of the cost.** 82% after repair, 8 of 8 plans, 72 s end to end and $0.025 a plan, against $0.106 for Ultra alone. But only 13% of its dishes were tied to this week's data, against 58% for Ultra alone, and tying the plan to the week is what Tablecast is for. Lightning alone: 76% for half a cent a plan, with 21% of its dishes tied to the week. v6 found the same thing (28%).
- **Nano can't write this plan reliably.** At medium effort it ran out of its 28,000-token budget or looped in 8 of 16 first attempts. With a low-effort retry, 12 of 16 plans published, and writing took a median of 4 to 5 minutes.
- **Super alone is the weakest strategy that published all 8 plans** (66%): it fixes a third of its own failed claims and drops 19.
- **The noise is bigger than I thought.** The two production strategies ran on the same evidence on 22 Oct and again today: Quick went from 74% to 79%, and Economy from 80% to 69%. An 11-point swing between two runs of one setting is almost twice the 6 points I had seen between rounds. So this round doesn't rank Ultra alone, Lightning alone, Nano alone and Lightning → Ultra (73% to 82%) on verified share. What separates the strategies is whether they publish, how long they take, what they cost and how many dishes they tie to the week.
- **Routing.** Production doesn't change before judging, as the design said. By the design's rule (8 of 8 published, within 6 points of Ultra alone, no more wrong claims in the sample), Lightning alone and Lightning → Ultra count as good as Ultra alone here, and this round's Economy run doesn't. The rule left out dishes tied to the week, where both Lightning strategies are far behind. Lightning → Ultra is the candidate for a cheaper Economy once its dishes are tied to the week as often as Ultra's, measured the same way.

**Limits.** This is 56 plans for 8 restaurants and one week of evidence, not a benchmark. The same strategy moved 11 points between two runs on the same evidence, and 15 claims per strategy can't rank precision.

**Spend for this round:** $2.14 of Nemotron for 56 plans (writers and repairs) and 0 Tavily credits (the account read 525 of 1,000 this month before and after the run).
