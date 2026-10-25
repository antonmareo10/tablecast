# Model comparison: design (fixed before any run)

Written and committed on 25 Oct 2026, before any plan of this round was written. The results go in [SUMMARY.md](SUMMARY.md) whatever they show.

## Question

For the stage that writes the plan and repairs what fails the check, how do the four Nemotron text models on Token Factory compare, alone and tiered, on the same evidence and with measured cost?

## Fixed set

The 8 restaurants of the second held-out round ([heldout2.json](heldout2.json), committed in c5c31e2 before that round ran), with the evidence packs gathered for that round on 22 Oct (`eval/results/packs/<slug>.json`, gitignored because they hold third-party page text). There is no new research: [scripts/eval-models.ts](../scripts/eval-models.ts) stops if a pack is missing, so this round makes no Tavily calls and no research calls. Every strategy writes from the same pack, with the same prompt and the same production code (`writeAndVerify`, verifier v7.1, branch `model-compare` cut from main at 7af310c).

## Strategies (7 × 8 = 56 plans, all run on 25 Oct)

| Strategy | Writes the plan (`reasoning_effort: "medium"`; one retry at `"low"` if cut, as in production) | Repairs failed claims, unbacked prices and past dates (`"low"`) | Note |
|---|---|---|---|
| `ultra` | Nemotron 3 Ultra | Ultra | production Quick |
| `super` | Nemotron 3 Super | Super | |
| `lightning` | Nemotron 3.5 Lightning | Lightning | |
| `nano` | Nemotron 3 Nano 30B-A3B | Nano | |
| `super>ultra` | Super | Ultra | production Economy (as in earlier eval rounds, a cut Super retries on Super, not Ultra) |
| `lightning>ultra` | Lightning | Ultra | |
| `nano>ultra` | Nano | Ultra | |

The same for every strategy: the writer's temperature (0.4); one writing attempt may take up to 420 s, as in earlier eval rounds; a repair pass is cut after 45 s, as in production; the rare schema repair stays on Lightning, as in production. The research step behind every pack ran on Lightning with Tavily on 22 Oct and is shared by all strategies.

## Metrics

Computed by the script, pooled over the claims of published plans, as in [eval-routing.ts](../scripts/eval-routing.ts):

- **Primary:** share of written claims verified after repair.
- Plans published (of 8), retries, claims per plan, verified claims per plan, share verified at first pass.
- What the check did: claims rejected at first pass, then fixed by repair, dropped by repair, or left shown as unverified.
- Money amounts in the plan's free text backed by a price (first draft → final), and the share of dishes tied to this week's data.
- Writer time and write-plus-check time (median and slowest).
- Cost per plan (median) and for all 8 plans, with the writer's share. Cost is Token Factory's measured token counts × the public catalog prices, re-read on 25 Oct and unchanged since 20 Oct: Ultra $1 / $3, Super $0.30 / $0.90, Lightning and Nano $0.06 / $0.24 per million input / output tokens. Cached-input discounts are ignored, so costs are an upper bound. The shared research step is not included (on 22 Oct: median $0.0018 of Lightning and 6.5 Tavily credits per restaurant, the same for every strategy).

## Precision sample

A verified share counts claims that passed the check, not claims that are right. After the runs, [scripts/models-sample.ts](../scripts/models-sample.ts) draws 15 verified claims per strategy (seed 20261025, 105 in all) and shuffles them together. They are read against their cited lines with the strategy hidden, using the categories of [AUDIT.md](AUDIT.md) (correct, minor slip, wrong), and only then joined back to their strategies. 15 claims per strategy can't rank strategies by precision. The sample is there to catch a strategy whose verified claims are often wrong.

## Noise

The 22 Oct runs of `ultra` and `super>ultra` on the same packs are a second sample of those two strategies. Earlier rounds moved up to 6 points between two samples of the same setting, so with 8 restaurants I treat gaps under about 6 points as noise.

## What the result can and can't change

Production routing doesn't change before judging, whatever this shows. A strategy is called as good as `ultra` here only if it publishes 8 of 8 plans, verifies within 6 points of `ultra` after repair in this round, and has no more wrong claims than `ultra` in the sample.

## Budget

The script stops starting new plans once the measured spend of the round passes $5 (expected $2.50 to $3.50; the hard limit for this experiment is $6). Tavily: 0 credits. Up to 5 plans run at once, restaurants in list order.
