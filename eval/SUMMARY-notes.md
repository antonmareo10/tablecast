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
