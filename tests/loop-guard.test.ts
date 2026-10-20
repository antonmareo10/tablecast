import { describe, expect, it } from "vitest";
import { LoopGuard } from "@/lib/loop-guard";

function feed(g: LoopGuard, text: string, chunk = 37): boolean {
  let hit = false;
  for (let i = 0; i < text.length; i += chunk) hit = g.push(text.slice(i, i + chunk)) || hit;
  return hit;
}

const varied = (i: number) => `Source S${i} mentions the cochinillo and a price of ${10 + i} euros for the main course. `;

describe("LoopGuard", () => {
  it("fires on the same sentence repeated back to back", () => {
    const g = new LoopGuard();
    const intro = Array.from({ length: 40 }, (_, i) => varied(i)).join("");
    const loop = "But Gjelina is at 1429 Abbot Kinney Blvd per S18? ".repeat(8);
    expect(feed(g, intro + loop)).toBe(true);
  });

  it("does not fire on ordinary reasoning that repeats a short line now and then", () => {
    const g = new LoopGuard();
    const text = Array.from({ length: 80 }, (_, i) => `${varied(i)}${i % 5 === 0 ? "Need to cite exactly.\n" : ""}`).join("");
    expect(feed(g, text)).toBe(false);
  });

  it("does not fire on repeated long lines interleaved with new content", () => {
    const g = new LoopGuard();
    const text = Array.from({ length: 60 }, (_, i) => `${varied(i)}Now check the forecast line for Thursday again.\n`).join("");
    expect(feed(g, text)).toBe(false);
  });

  it("fires on a two-sentence cycle that fills the window", () => {
    const g = new LoopGuard();
    const intro = Array.from({ length: 40 }, (_, i) => varied(i)).join("");
    const cycle = "Maybe the address is on Abbot Kinney Boulevard instead. Actually S18 says it is the bakery next door. ".repeat(10);
    expect(feed(g, intro + cycle)).toBe(true);
  });

  it("never fires before enough text has been seen", () => {
    const g = new LoopGuard({ minChars: 10_000 });
    expect(feed(g, "The same long sentence that keeps coming back again. ".repeat(20))).toBe(false);
  });
});
