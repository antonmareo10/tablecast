import { describe, expect, it } from "vitest";
import { readableThought } from "../src/lib/nebius-agent";

describe("readableThought", () => {
  it("returns the last whole sentence", () => {
    expect(readableThought("Now the moments array needs three items. The forecast shows rain on Thursday evening. ")).toBe(
      "The forecast shows rain on Thursday evening.",
    );
  });

  it("does not cut a sentence at a decimal point", () => {
    expect(readableThought("Thursday has 4.5 mm of rain, so the terrace stays closed. ")).toBe("Thursday has 4.5 mm of rain, so the terrace stays closed.");
  });

  it("skips JSON, source ids and fragments", () => {
    const t = 'Dish two needs a warm sauce for cold nights. {"item": "Puff pastry", "qty": 2}. 4), Rich Table (176 m) (S40.2). Short one.';
    expect(readableThought(t)).toBe("Dish two needs a warm sauce for cold nights.");
  });

  it("turns schema field names into words", () => {
    expect(readableThought("Now week_plan needs five to ten items for the owner. ")).toBe("Now week plan needs five to ten items for the owner.");
  });

  it("returns undefined when nothing is readable", () => {
    expect(readableThought('{"a": 1}')).toBeUndefined();
  });
});
