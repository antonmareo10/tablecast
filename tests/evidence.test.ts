import { describe, expect, it } from "vitest";
import { SourceLedger, normalizeText, numbersIn } from "@/lib/evidence";

function ledger() {
  const l = new SourceLedger();
  l.add({
    kind: "weather",
    provider: "Open-Meteo",
    title: "7-day forecast",
    text: "Thu 23 Oct: rain, max 14°C / min 9°C, 6.2 mm, 80% chance of rain\nFri 24 Oct: clear, max 19°C / min 10°C, 0.0 mm",
  });
  l.add({
    kind: "review",
    provider: "Tavily",
    title: "Guide",
    url: "https://example.com/guide",
    text: "Locals queue for the huevos rotos, and the cochinillo is a Sunday ritual. Service can feel rushed on weekends.",
  });
  return l;
}

describe("normalizeText", () => {
  it("folds accents, case and punctuation but keeps decimals as one token", () => {
    expect(normalizeText("Jamón Ibérico, 6.2 mm!")).toBe("jamon iberico 6d2 mm");
    expect(normalizeText("6,2 mm")).toBe("6d2 mm");
  });
  it("extracts numbers in the same normal form", () => {
    expect(numbersIn("Rain of 6.2 mm on Thu 23 Oct (80%)")).toEqual(["6d2", "23", "80"]);
  });
});

describe("SourceLedger", () => {
  it("numbers sources S1, S2… and merges the same URL", () => {
    const l = ledger();
    const again = l.add({ kind: "menu", provider: "Tavily", title: "Same page", url: "https://example.com/guide", text: "Huevos rotos 18,50 €" });
    expect(again.id).toBe("S2");
    expect(l.size).toBe(2);
    expect(l.checkCite({ source: "S2", quote: "Huevos rotos 18,50 €" }).ok).toBe(true);
  });

  it("verifies a verbatim quote, ignoring case, accents and punctuation", () => {
    const l = ledger();
    expect(l.checkCite({ source: "S2", quote: "locals queue for the huevos rotos" }).ok).toBe(true);
    expect(l.checkCite({ source: "s1", quote: "Thu 23 Oct: rain" }).ok).toBe(true);
  });

  it("rejects paraphrases, unknown sources and quotes too short to check", () => {
    const l = ledger();
    expect(l.checkCite({ source: "S2", quote: "people line up for huevos rotos" }).ok).toBe(false);
    expect(l.checkCite({ source: "S9", quote: "locals queue for the huevos rotos" }).ok).toBe(false);
    expect(l.checkCite({ source: "S1", quote: "rain" }).ok).toBe(false);
  });

  it("does not match across word boundaries or split decimals", () => {
    const l = ledger();
    expect(l.checkCite({ source: "S1", quote: "6 2 mm" }).ok).toBe(false);
    expect(l.checkCite({ source: "S1", quote: "ain, max 14" }).ok).toBe(false);
  });

  it("verifies a claim only if every number is in a cited source", () => {
    const l = ledger();
    const good = l.verifyEvidence({ text: "Thursday brings 6.2 mm of rain and an 80% chance of showers.", cites: [{ source: "S1", quote: "6.2 mm, 80% chance of rain" }] });
    expect(good.verified).toBe(true);
    const bad = l.verifyEvidence({ text: "Thursday brings 12 mm of rain.", cites: [{ source: "S1", quote: "Thu 23 Oct: rain" }] });
    expect(bad.verified).toBe(false);
    expect(bad.issue).toMatch(/12/);
  });

  it("marks each cite and explains the first failure", () => {
    const l = ledger();
    const v = l.verifyEvidence({
      text: "Guests love the cochinillo.",
      cites: [
        { source: "S2", quote: "the cochinillo is a Sunday ritual" },
        { source: "S2", quote: "best suckling pig in town" },
      ],
    });
    expect(v.cites.map((c) => c.ok)).toEqual([true, false]);
    expect(v.verified).toBe(false);
    expect(v.issue).toMatch(/not found in S2/);
  });

  it("finds the passage closest to a failed quote", () => {
    const l = new SourceLedger();
    const long = `${"Filler sentence about nothing in particular. ".repeat(30)}The tarta de queso is the most ordered dessert. ${"More filler text here. ".repeat(30)}`;
    l.add({ kind: "review", provider: "Tavily", title: "Long", url: "https://x.test", text: long });
    expect(l.excerpt("S1", "tarta queso most ordered")).toContain("tarta de queso");
  });

  it("re-attributes a verbatim quote to the source that really contains it", () => {
    const l = ledger();
    const e = { text: "Locals queue for the huevos rotos.", cites: [{ source: "S1", quote: "Locals queue for the huevos rotos" }] };
    expect(l.verifyEvidence(e).verified).toBe(false);
    expect(l.reattribute([e])).toBe(1);
    expect(e.cites[0].source).toBe("S2");
    expect(l.verifyEvidence(e).verified).toBe(true);
  });

  it("does not re-attribute a quote found nowhere", () => {
    const l = ledger();
    const e = { text: "Best paella in town.", cites: [{ source: "S2", quote: "best paella in town" }] };
    expect(l.reattribute([e])).toBe(0);
    expect(e.cites[0].source).toBe("S2");
  });

  it("ranks related sources by shared words, numbers weighing more", () => {
    const l = ledger();
    expect(l.related("rain 6.2 mm on Thursday", 1)).toEqual(["S1"]);
    expect(l.related("cochinillo Sunday", 1)).toEqual(["S2"]);
  });
});
