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
  it("treats 142,00 as 142 and 37,50 as 37.5", () => {
    expect(normalizeText("Menú 142,00€")).toBe("menu 142");
    expect(numbersIn("37.50 € and 142 €")).toEqual(["37d5", "142"]);
    expect(normalizeText("37,5 €")).toBe("37d5");
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

  it("ranks related sentences by shared words, numbers weighing more", () => {
    const l = ledger();
    expect(l.relatedSpans("rain 6.2 mm on Thursday", 1)).toEqual(["S1.1"]);
    expect(l.relatedSpans("cochinillo Sunday ritual", 1)).toEqual(["S2.1"]);
    expect(l.spansWithNumbers(["80"], 1)).toEqual(["S1.1"]);
  });
});

describe("sentence citations", () => {
  const menu = () => {
    const l = new SourceLedger();
    l.add({ kind: "menu", provider: "Tavily", title: "Carta", url: "https://casalucio.es/carta", text: ["## Entrantes", "Croquetas caseras", "12,50 €", "Huevos estrellados 18 €. Rabo de toro guisado 24 €."].join("\n") });
    l.add({ kind: "weather", provider: "Open-Meteo", title: "Forecast", text: "Wed 21 Oct: rain, max 16°C / min 11°C, 5.4 mm, 65% chance of rain" });
    return l;
  };

  it("cuts sources into stable, numbered sentences", () => {
    const l = menu();
    expect(l.spansOf("S1")).toEqual(["## Entrantes", "Croquetas caseras", "12,50 €", "Huevos estrellados 18 €.", "Rabo de toro guisado 24 €."]);
    expect(l.span("s1.4")?.text).toBe("Huevos estrellados 18 €.");
    expect(l.span("S1.9")).toBeNull();
  });

  it("verifies a claim that cites the sentence stating it, and fills the exact quote", () => {
    const v = menu().verifyEvidence({ text: "Huevos estrellados sell at €18.", cites: [{ source: "S1", quote: "", span: "S1.4" }] });
    expect(v.verified).toBe(true);
    expect(v.cites[0]).toMatchObject({ source: "S1", span: "S1.4", quote: "Huevos estrellados 18 €.", ok: true });
  });

  it("accepts a price on the line next to the dish (menus split them)", () => {
    const v = menu().verifyEvidence({ text: "Croquetas caseras cost €12.50.", cites: [{ source: "S1", quote: "", span: "S1.2" }] });
    expect(v.verified).toBe(true);
  });

  it("fails an unknown sentence, a number not in the cited sentences, and an irrelevant citation", () => {
    const l = menu();
    expect(l.verifyEvidence({ text: "Huevos estrellados.", cites: [{ source: "S1", quote: "", span: "S1.42" }] }).issue).toMatch(/unknown sentence/);
    expect(l.verifyEvidence({ text: "Rabo de toro costs €26.", cites: [{ source: "S1", quote: "", span: "S1.5" }] }).issue).toMatch(/26/);
    expect(l.verifyEvidence({ text: "Wednesday brings heavy rain.", cites: [{ source: "S1", quote: "", span: "S1.5" }] }).issue).toMatch(/don't mention/);
    expect(l.verifyEvidence({ text: "Wednesday brings rain, 5.4 mm.", cites: [{ source: "S2", quote: "", span: "S2.1" }] }).verified).toBe(true);
  });

  it("renders sources for the prompt as numbered sentences within a budget", () => {
    const out = menu().forPrompt(() => 20);
    expect(out).toContain("[S1] Tavily · menu · Carta");
    expect(out).toContain("S1.1 ## Entrantes");
    expect(out).toContain("S1.2 Croquetas caseras");
    expect(out).not.toContain("S1.5");
  });
});
