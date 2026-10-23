# Verifier audit (v7): 150 claims read one by one

**What "verified" is worth.** Of 100 claims the v7 verifier marked verified, picked at random, **94 were correct** on reading their cited lines, 4 had a minor slip and **2 were wrong** (precision 94%, 95% CI 87–97%; 98% if minor slips count as right). Of 50 claims it rejected, 37 (74%) really did say more than their cited lines; **12 (24%) were true and fully cited**, so they were rejected for wording.

**Who did this.** I did this audit myself, the author, claim by claim, with Claude Code's help, on 21 Oct 2026. A script printed each claim with the lines it cites. I decided each verdict by reading those lines, and opened the rest of the page when the verdict depended on it. **This is not an independent human audit.** There was one reader, and that reader built the verifier. Every verdict is listed in [audit-verdicts.tsv](audit-verdicts.tsv) with a one-line reason, so anyone can disagree with a specific one.

## Sample

[`scripts/audit-sample.ts`](../scripts/audit-sample.ts), seed `20261021`. Every claim is re-checked now with the production verifier (`verifierFor`, v7):

| Pool | Plans | Claims in pool | Sampled |
|---|---|---|---|
| Verified · held-out round ([SUMMARY.md](SUMMARY.md#v7-held-out-round): 8 new restaurants, Quick and Economy) | 16 | 197 final claims that pass v7 | 50 |
| Verified · tuning set (the 8 restaurants of v3–v6: routing v6 and Tavily-ablation plans) | 46 | 605 | 50 |
| Rejected · held-out round | 16 | 134 first-draft claims that fail v7 | 25 |
| Rejected · tuning set | 46 | 441 | 25 |

Half of each sample comes from plans written for restaurants never used to tune the verifier. "Rejected" claims come from the writers' first drafts, before the repair pass, which is where the check rejects. Each pool is put in a fixed order (file, field, position), shuffled with the seeded generator, and the first N are taken. The cached runs hold third-party page text, so they stay out of the repository (eval/results is gitignored). The script and the verdicts are committed.

## How each claim was judged

- **Verified claims.** **C** (correct): every fact in the claim is on the cited lines, and paraphrase is fine. **M** (minor slip): the main fact is right, but a detail is slightly off. **W** (wrong): the claim states something the cited lines don't say, or say differently.
- **Rejected claims.** **U** (wrong or overstated): a fact is false, invented or inflated. **G** (cite gap): the fact may be true on that page or another one, but the cited lines don't hold it (this includes sentence ids that don't exist). **I** (inference): the facts are right, but the claim adds the plan's own reading ("ideal for brunch", "may deter a quiet lunch"). **T** (false rejection): the cited lines hold everything the claim says. **A**: ambiguous.

## Results

| | Held-out (50) | Tuning set (50) | All (100) |
|---|---|---|---|
| Verified: correct (C) | 47 | 47 | **94** |
| Verified: minor slip (M) | 2 | 2 | 4 |
| Verified: wrong (W) | 1 | 1 | **2** |

**Precision of "verified":** 94/100 correct (Wilson 95% CI 87.5–97.2%), or 98/100 (93.0–99.5%) if minor slips count as right. The held-out and tuning halves come out the same (47 C, 2 M, 1 W each).

| | Held-out (25) | Tuning set (25) | All (50) |
|---|---|---|---|
| Rejected: wrong or overstated (U) | 9 | 8 | 17 |
| Rejected: cite gap (G) | 4 | 8 | 12 |
| Rejected: adds an inference (I) | 4 | 4 | 8 |
| Rejected: true and fully cited (T) | 8 | 4 | **12** |
| Ambiguous (A) | 0 | 1 | 1 |

**Precision of "rejected":** 37/50 (74%, CI 60–84%) of rejected claims said more than their cited lines (U + G + I). 17/50 (34%) were wrong or overstated outright. **12/50 (24%, CI 14–37%) were false rejections.** Strictness has a real cost, and it is higher on the held-out round (8 of 25) than on the tuning set (4 of 25). In the app, a rejected claim goes to the repair pass once. A false rejection gets one chance to come back rephrased, and only what still fails is shown as unverified.

## Every error found among the verified claims

| # | Pool | Restaurant · writer · field | Claim | What the source says |
|---|---|---|---|---|
| 26 | held-out | Commander's Palace · Super · loved for | "The Jazz Brunch features live jazz music." | **W.** The cited line is a metaphor ("New Orleans cooking is like jazz … our legendary Jazz Brunch"). It is true in reality, but the cited text doesn't say it. |
| 74 | tuning | Chez Janou · Lightning · watch-outs | "Some report inconsistent quality of dishes such as duck, escargot, and chocolate mousse." | **W.** The sentence says those dishes "earn rave reviews, though some report inconsistent quality". The claim turns praise into a complaint about the same dishes. |
| 2 | held-out | Hawksmoor Manchester · Ultra · rivals | "There are 5 restaurants nearby, including Hawksmoor and Fogo de Chão." | **M.** "5 restaurants available nearby" is OpenTable's steakhouse search count. Fogo de Chão comes from a second list of 6. |
| 28 | held-out | Salumeria Roscioli · Super · moment | "Thursday morning brings fog with just 0.0 mm of rain." | **M.** The forecast is for the whole day, not the morning. |
| 56 | tuning | Gjelina · Ultra low · dish | "… Fri through Mon run clear with highs 23–30°C." | **M.** Monday is partly cloudy. |
| 91 | tuning | Zuni Café · Ultra · dish | "… the wood-fired oven is a signature asset." | **M.** The source is a photo caption about a pizza for kids. "Inspired by traditional French and Italian cuisine" is right. |

Three more verified claims are true as written but sit in the wrong section: #88 (Bestia) and #98 (Gjusta) under Gjelina's watch-outs, and #97 (a block count) under Zuni's "loved for". The subject check (v6.1) rejects competitor facts that pretend to be about the restaurant. These pass because they name the competitor openly.

**Before this sample**, the replay a judge found had two errors of the same kinds. "Add egg $3", listed under the BLT, had been paired with the Vegetable Sandwich, and v7's add-on rule now rejects that. A second claim gave "Honeynut Squash … at $27", which is the next dish's price on that page. The word and number check still can't see that (see *Limits*). That replay was re-recorded with v7, and I read its six menu facts against the page by hand. All six are right. Its "On your menu now" list still showed "Cacio e Pepe $28" (the page prints $27 for that dish). The app now shows a menu price only if the page prints it next to that dish. For recorded runs, the browser drops a price that the saved page text contradicts.

## The false rejections, and why

| # | Claim (shortened) | Why it failed |
|---|---|---|
| 106, 108, 118 | "Reviewers call / highlight …", "Guests call …" | Attribution words ("reviewers", "call", "highlight") aren't on the cited line. |
| 125 | Stubs BBQ and Stubb's BBQ "are both tagged restaurant · barbecue" | "tagged" |
| 140, 142 | "the week's coolest, wettest lunch", "the heaviest rain" | Superlatives computed over the week's lines. True, but the words aren't there. |
| 144 | the combo on rye "lets diners hedge against brisket inconsistency" | The critic's reasoning, put in other words. |
| 134 | "… at least 160 venues (S37.1)." | The writer typed the source id into the sentence, so "37.1" was read as a number. |
| 111 | Marisqueira do Lis "has a 4.6 rating … on Uber Eats" | The name and "Uber Eats" are in the page's title and URL, not on the cited line. |
| 115 | "rude management and poor service" | The review title is Portuguese ("Gerente mal educado e agressivo"). Words can't be matched across languages on an English page. |
| 112 | waiters "attentive but not hovering" | Paraphrased across two reviews. |
| 107 | Marisqueira do Lis "serves arroz de marisco as a weekday lunch dish" | The subject rule: a rival's page backs a dish claim. The claim names the rival itself, so nothing is misattributed. |

## What this changes, and what it doesn't

- **The two wrong verified claims are the class code can't see.** Every word of the claim is on the cited line, but the claim inverts or literalises it. That is a named limit (README, *Known limitations*), not something to tune away.
- **The audit didn't change v7.** The obvious next calibration is to let attribution words ("reviewers call", "guests note") through, and to send claims that name a competitor to rivals. I haven't done it, because this audit would then be grading its own tuning. It needs a fresh sample afterwards.
- Earlier verifier versions were never audited this way, so there is no "before" precision to compare with.

## The flagship replay, read in full (22 Oct)

The audit above samples. The Gjelina replay is the run a judge opens first, so on 22 Oct I read all of it: every verified claim against its cited lines, every menu fact and money amount against gjelina.com/los-angeles-menus as fetched that day, and the free text around them. This is the same reader as above (the author, with Claude Code's help), not an independent one.

**The 24 verified claims: 20 correct, 4 minor slips, 0 wrong.**

| Claim (shortened) | Verdict | Why |
|---|---|---|
| "Reviewers highlight the labneh toast …, ricotta pancakes and crispy eggs … as standout brunch dishes" | M | One review lists them as brunch dishes. "Standout" and the plural "reviewers" are the plan's. |
| "The takeaway counter GTA is an alternative to sit-down dining …" (twice) | M, M | The cited line says "the takeaway counter Gjelina has next door". The name GTA is true (the block lists "GTA (Gjelina Take Away)") but isn't on that line. |
| "Saturday through Tuesday are dry, 0 mm rain, warming to 28°C" | M | It peaks at 29°C on Monday, then 28°C. |
| The other 20: seven forecast claims, the block's counts and distances (2), the takeaway counter, the no-substitutions policy, the 8am opening, the sharing habit, Abbot Kinney as "the place to be", the labneh toast at brunch, the wine and corkage prices (see below), and four claims holding six menu facts | C | Le Puy Lentil Soup $22, Cured Chorizo $28, Fennel Salami $29, Braised Pork Meatball $24 (lunch; $23 at dinner), Grilled Peach Burrata $28 and the Pomodoro pizza $22 are all on the page as stated. |

One of the 20 correct claims is **stale**: "a glass of wine costs around $8, and you can bring your own bottle for a $20 corkage fee". That is exactly what its source says, but the source is an undated blog post. Gjelina's own list, on the same menu page, sells wine by the glass from $14 (dessert wines) and $18 (the rest). The verifier checks a claim against what it cites, not the age of the source or a conflict with the restaurant's own page.

**The free text (not claims) had one error code could catch and one it can't.**

1. **An invented competitor price.** The block summary says "the nearest pizza is $22 at Abbot's, while Gjelina's Pomodoro is also $22". No source prices Abbot's Pizza Company. The price check only asked whether $22 was a price the plan could back, and Gjelina's Pomodoro is $22. This became **v7.1** ([SUMMARY.md](SUMMARY.md#v71-a-price-next-to-a-competitors-name)): an amount next to a competitor's name has to come from that competitor. The replay now lists it under Proof as not backed.
2. **A misread menu.** Dish 2, a sharing board, is justified as showcasing "cured meats already on the dinner menu (Cured Chorizo $28, Fennel Salami $29)". The prices are right, but on the menu both are pizzas. The verified claim says only what the menu says; the plan's reasoning reads it wrong. Code can't see that.
3. Smaller things a careful owner would notice: moment 1 calls the rain dish "lentil-based" while dish 1 is a white bean and kale stew; the plan orders and launches that stew on the same Wednesday (its ingredients are pantry staples, but it doesn't say so); and the event compares the $25 bowl-and-coffee deal with that stale $8 glass of wine.

## Every verified claim of a new held-out round (22–23 Oct)

A sample can be lucky. So for the second held-out round (8 more restaurants, listed before any run) I read **all 212 claims** its 16 plans show as verified, with the same categories as above: **186 correct (88%, CI 83–92%), 19 minor slips, 7 wrong**; correct or minor slip, 97%. That is lower than this sample's 94 of 100, and it is the number I'd quote first. Every verdict, with its reason: [heldout2-verdicts.tsv](heldout2-verdicts.tsv). Results and the 7 errors: [SUMMARY.md](SUMMARY.md#v71-held-out-round-2-every-verified-claim-read-by-hand). Reading them also found an empty claim that every check passed (v7.1 now rejects it) and a news page about Florence, Alabama accepted for a restaurant in Florence, Italy.

## Limits

- **One reader, who also built the verifier.** The verdicts are in the open so they can be checked, but they are not independent.
- **Verified = the cited lines say it, not that the world is so.** Two sources in the sample are weak: an AI-generated "scenario" page (#52) and a 2016 Eater guide (#48). Both claims are correct readings of their page. The flagship's "$8 glass of wine" is the same case, from an undated blog that the restaurant's own list contradicts.
- **Menu layout.** A price on the line after a dish's description can belong to the next dish. The number check allows the line before and the two after, so a wrong pairing can pass (the old Gjelina dish 2). None turned up in this sample.
- **Same city name, other country.** The place check accepts a page that names the restaurant's city. "Florence" let a Florence, Alabama news page into a plan for Florence, Italy, and three verified claims stood on it.
- n = 100 + 50 in the sample, 212 in the full read. The confidence intervals are wide, especially for rejections.
