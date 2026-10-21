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
