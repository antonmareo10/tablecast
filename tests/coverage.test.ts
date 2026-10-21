import { describe, expect, it } from "vitest";
import { allowedAmounts, fieldLabel, moneyIn, proseFields, unbackedAmounts, type PlanText } from "@/lib/amounts";
import { SourceLedger, languageOf, pageLanguage } from "@/lib/evidence";

const ledger = () => {
  const l = new SourceLedger();
  l.add({
    kind: "menu",
    provider: "Tavily",
    title: "Gjelina dinner menu",
    url: "https://gjelina.com/menu",
    text: ["Pomodoro Crudo", "$28", "Burrata, Cherry Tomato, Confit Garlic, Olive Oil", "Housemade Chorizo $28", "Tomatillo, Confit Garlic, Cilantro, Grilled Baguette"].join("\n"),
  });
  l.add({
    kind: "weather",
    provider: "Open-Meteo",
    title: "Forecast",
    text: "Wed 22 Oct: rain, max 21°C / min 14°C, 20.6 mm, 57% chance of rain\nThu 23 Oct: drizzle, max 20°C / min 17°C, 2.1 mm, 94% chance of rain",
  });
  l.add({ kind: "event", provider: "Ticketmaster", title: "Events", text: "Fri 23 Oct 19:00 — Tablao Flamenco at Corral de la Morería (1.2 km)" });
  l.ignoreWords("Casa Lucio", "Madrid", "Calle de la Cava Baja 35");
  return l;
};
const cite = (span: string) => ({ source: span.split(".")[0], quote: "", span });

describe("coverage: the cited sentences must say most of what the claim says", () => {
  it("fails a claim that adds ingredients its source doesn't list, and names them", () => {
    const v = ledger().verifyEvidence({ text: "Pomodoro Crudo with oregano, basil and anchovy is $28.", cites: [cite("S1.1")] });
    expect(v.verified).toBe(false);
    expect(v.issue).toMatch(/don't mention .*oregano/);
  });

  it("passes the same dish when the claim sticks to the source, and shows the neighbouring lines it needed", () => {
    const v = ledger().verifyEvidence({ text: "Pomodoro Crudo is $28 with burrata, cherry tomatoes and confit garlic.", cites: [cite("S1.1")] });
    expect(v.verified).toBe(true);
    expect(v.cites[0].context).toEqual(["$28", "Burrata, Cherry Tomato, Confit Garlic, Olive Oil"]);
  });

  it("does not attach context when the cited sentence says it all", () => {
    const v = ledger().verifyEvidence({ text: "Housemade Chorizo costs $28.", cites: [cite("S1.4")] });
    expect(v.verified).toBe(true);
    expect(v.cites[0].context).toBeUndefined();
  });

  it("matches full day names to the forecast's short ones and forecast words to their synonyms", () => {
    const v = ledger().verifyEvidence({ text: "Wednesday brings heavy storms and flooding, 20.6 mm.", cites: [cite("S2.1")] });
    expect(v.issue).toMatch(/don't mention heavy, storms, flooding/);
    const ok = ledger().verifyEvidence({ text: "Wednesday brings rain: 20.6 mm expected, highs of 21°C.", cites: [cite("S2.1")] });
    expect(ok.verified).toBe(true);
  });

  it("attaches no neighbour when the claim cites both lines it uses", () => {
    const v = ledger().verifyEvidence({ text: "Rain Wednesday, 20.6 mm; drizzle Thursday, 2.1 mm.", cites: [cite("S2.1"), cite("S2.2")] });
    expect(v.verified).toBe(true);
    expect(v.cites.map((c) => c.context)).toEqual([undefined, undefined]);
  });

  it("checks numbers and names, not words, when the cited sentence is in another language", () => {
    const l = new SourceLedger();
    l.add({ kind: "site", provider: "Tavily", title: "Casa Lucio", url: "https://casalucio.es", text: "Precio medio: de 35 a 45 euros, por persona.\nSopa Castellana de Casa Lucio." });
    const ok = l.verifyEvidence({ text: "Average spend is 35–45 € per person.", cites: [cite("S1.1")] });
    expect(ok.verified).toBe(true);
    expect(ok.across).toBe("es");
    const wrongNumber = l.verifyEvidence({ text: "Average spend is 30–45 € per person.", cites: [cite("S1.1")] });
    expect(wrongNumber.issue).toMatch(/30/);
    const nothingShared = l.verifyEvidence({ text: "Guests love the quiet terrace.", cites: [cite("S1.1")] });
    expect(nothingShared.issue).toMatch(/in Spanish\) share no name or number/);
  });

  // Lines as Tavily Extract returned gjelina.com/los-angeles-menus on 21 Oct: an English menu whose only function
  // words are Italian ("Le Puy", "Cacio e Pepe"). v6 called it Italian and skipped the word check on the showcase.
  const gjelinaLA = () => {
    const l = new SourceLedger();
    l.ignoreWords("Gjelina", "Los Angeles", "Abbot Kinney Boulevard 1429, 90291 Los Angeles");
    l.add({
      kind: "menu",
      provider: "Tavily",
      title: "gjelina.com/los-angeles-menus",
      url: "https://www.gjelina.com/los-angeles-menus",
      text: [
        " Le Puy Lentil Soup", "$22", "Cilantro, Dill, Spice Blend Oil",
        " Agnolotti", "$30", "Honeynut Squash, Miso Butter, Pepita Gremolata, Belper Knolle Cheese",
        " Bucatini", "$27", "Cacio e Pepe",
        " Orecchiette", "$32", "Wagyu Beef Cheek Bolognese, Whipped Ricotta",
        "Plates",
        " Le Puy Lentil Soup", "$22", "Cilantro, Dill, Spice Blend Oil",
        " Bucatini", "$27", "Cacio e Pepe",
        " Vegetable Sandwich", "$19", "Avocado, Pickled Turnip, Sprouts, Fennel, Tahini",
        " BLT", "$19", "Bacon, Arugula, Tomato, Lemon Aioli",
        "Add egg $3",
        " Blackened Vermilion Rockfish Sandwich", "$25", "Napa Cabbage Slaw, Fermented Chili Aioli",
      ].join("\n"),
    });
    return l;
  };

  it("does not call an English menu Italian because of its dish names (Gjelina, Los Angeles)", () => {
    const l = gjelinaLA();
    // Embellished: the soup has no whipped ricotta or crispy shallots. v6 passed it as "Source in Italian".
    const embellished = l.verifyEvidence({ text: "Le Puy Lentil Soup with whipped ricotta, crispy shallots and chili crunch is $22.", cites: [cite("S1.1")] });
    expect(embellished.verified).toBe(false);
    expect(embellished.across).toBeUndefined();
    expect(embellished.issue).toMatch(/don't mention .*whipped/);
    const ok = l.verifyEvidence({ text: "Le Puy Lentil Soup with cilantro, dill and spice blend oil is $22.", cites: [cite("S1.1")] });
    expect(ok.verified).toBe(true);
    expect(ok.across).toBeUndefined();
    const italianName = l.verifyEvidence({ text: "Bucatini cacio e pepe costs $27.", cites: [cite("S1.7")] });
    expect(italianName.verified).toBe(true);
    expect(italianName.across).toBeUndefined();
  });

  it("runs the word check first: a claim that passes it is never labelled as read across languages", () => {
    const l = new SourceLedger();
    l.add({ kind: "site", provider: "Tavily", title: "Casa Lucio", url: "https://casalucio.es", text: "Precio medio: de 35 a 45 euros, por persona.\nSopa Castellana de Casa Lucio." });
    const sameWords = l.verifyEvidence({ text: "Sopa Castellana is on the menu.", cites: [cite("S1.2")] });
    expect(sameWords.verified).toBe(true);
    expect(sameWords.across).toBeUndefined();
  });

  it("treats the lines Tablecast writes (events, forecast, the block) as English, whatever names they carry (Casa Lucio)", () => {
    const l = new SourceLedger();
    l.ignoreWords("Casa Lucio", "Madrid", "Calle de la Cava Baja 35");
    l.add({ kind: "event", provider: "Ticketmaster", title: "Una Cena Cantada", text: "Fri 23 Oct 20:30 — Una Cena Cantada at El Café de la Ópera, 0.7 km away (Music · Classical)" });
    l.add({ kind: "block", provider: "OpenStreetMap", title: "Venues", text: "Taberna Tempranillo — bar, 38 m away\nLa Cuevina de Leon — bar, 39 m away" });
    const event = l.verifyEvidence({ text: "Una Cena Cantada plays at El Café de la Ópera on Friday 23 Oct at 20:30, 0.7 km away.", cites: [cite("S1.1")] });
    expect(event.verified).toBe(true);
    expect(event.across).toBeUndefined();
    const invented = l.verifyEvidence({ text: "Una Cena Cantada is a sold-out flamenco dinner show on Friday at 20:30.", cites: [cite("S1.1")] });
    expect(invented.verified).toBe(false);
    expect(invented.across).toBeUndefined();
    // A plan in Spanish reads these English lines across languages.
    const es = new SourceLedger();
    es.claimLanguage = "es";
    es.add({ kind: "weather", provider: "Open-Meteo", title: "Forecast", text: "Thu 22 Oct: rain, max 14°C / min 9°C, 6.2 mm, 80% chance of rain" });
    const lluvia = es.verifyEvidence({ text: "El jueves llueve con fuerza: 6,2 mm y 14 °C de máxima.", cites: [cite("S1.1")] });
    expect(lluvia.verified).toBe(true);
    expect(lluvia.across).toBe("en");
  });

  it("does not count the restaurant's own name as another language (Au Cheval, Chicago)", () => {
    expect(pageLanguage("Skip to Content Au Cheval Au Cheval Chicago New York City Nashville Food & Drink Order Online Au Cheval Nashville Au Cheval Chicago", "en")).toBe("fr");
    expect(pageLanguage("Skip to Content Au Cheval Au Cheval Chicago New York City Nashville Food & Drink Order Online Au Cheval Nashville Au Cheval Chicago", "en", ["au cheval"])).toBeNull();
    expect(pageLanguage("Precio medio: de 35 a 45 euros, por persona. Sopa Castellana de Casa Lucio.", "en")).toBe("es");
  });

  it("tells languages apart from their function words", () => {
    expect(languageOf("Precio medio: de 35 a 45 euros, por persona.")).toBe("es");
    expect(languageOf("The rain comes in on Wednesday and the market is busy.")).toBe("en");
    expect(languageOf("Pomodoro Crudo")).toBeNull();
  });

  it("lets a claim name the restaurant and its street without the source repeating them", () => {
    const v = ledger().verifyEvidence({ text: "Tablao Flamenco plays Friday at 19:00, 1.2 km from Casa Lucio on Cava Baja.", cites: [cite("S3.1")] });
    expect(v.verified).toBe(true);
  });

  it("knows when a menu source prints a dish with a given price", () => {
    const l = ledger();
    expect(l.hasPriceFor("Pomodoro Crudo", 28)).toBe(true);
    expect(l.hasPriceFor("Pomodoro Crudo", 24)).toBe(false);
    expect(l.hasPriceFor("Saffron Spaghetti", 28)).toBe(false);
  });
});

describe("prices in the plan's free text", () => {
  const plan = (): PlanText => ({
    headline: "Launch a $24 lunch-only pasta for rainy Wednesday",
    snapshot: { summary: "Loved for its pastas." },
    moments: [{ title: "Rain Wednesday", play: "Offer a $12 half-portion of the lunch pasta; 20.6 mm of rain" }],
    menu_moves: [{ dish: "Pomodoro Crudo Lunch Portion", description: "Lunch-size, $22", why: "Sits below the $28 dinner plate", price: 22, evidence: [] }],
    menu_seen: [{ name: "Pomodoro Crudo", price: 28 }],
    rivals: { summary: "Felix pastas around $30" },
    experience: { event_idea: "Rainy-day pasta lunch", event_why: "Runs Wednesday 11:30–2:30" },
    marketing: { instagram_post: "Rain outside, pasta inside. 12,50 € glass of wine" },
    week_plan: [{ action: "Prep 40 portions" }],
  });

  it("finds money amounts but not temperatures, rain or times", () => {
    expect(moneyIn("Offer a $12 half-portion; 20.6 mm of rain at 21°C, 11:30–2:30, 12,50 € wine, 28 EUR, 57%")).toEqual(["$12", "12,50 €", "28 EUR"]);
  });

  it("accepts dish prices, menu prices and numbers of checked claims; lists the rest by field", () => {
    const pb = plan();
    const verified = [{ text: "Felix pastas around $30 and entrees $70.", cites: [], verified: true }];
    const { numbers } = allowedAmounts(pb, verified);
    const { checked, unbacked } = unbackedAmounts(proseFields(pb), numbers);
    expect(checked).toBe(6);
    expect(unbacked).toEqual([
      { where: "headline", amount: "$24" },
      { where: "moments.0.play", amount: "$12" },
      { where: "marketing.instagram_post", amount: "12,50 €" },
    ]);
  });

  it("names fields the way the owner sees them", () => {
    expect(fieldLabel("moments.0.play")).toBe("moment 1, the play");
    expect(fieldLabel("menu_moves.2.why")).toBe("dish 3, the bet");
    expect(fieldLabel("headline")).toBe("headline");
  });
});
