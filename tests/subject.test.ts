import { describe, expect, it } from "vitest";
import { verifierFor } from "@/lib/agent";
import { SourceLedger } from "@/lib/evidence";
import { brandWords, citiesIn, placeAnchors } from "@/lib/place";
import { isSelfField, subjectIssue, subjectProfile, type CitedLines } from "@/lib/subject";
import type { Source } from "@/lib/types";

// The three real cases come from the Tavily eval (eval/TAVILY.md): claims that passed the verifier while about
// another place or item. Cited sentences are quoted as the pages had them.
const dishoom = subjectProfile({
  restaurant: "Dishoom Covent Garden",
  city: "London",
  address: "Upper St Martin's Lane 12, WC2H 9FB City of Westminster",
  website: "http://www.dishoom.com/covent-garden/",
});
const gjelina = subjectProfile({ restaurant: "Gjelina", city: "Los Angeles", address: "Abbot Kinney Boulevard 1429, 90291 Los Angeles", website: "https://www.gjelina.com/" });
const katz = subjectProfile({ restaurant: "Katz's Delicatessen", city: "New York", address: "East Houston Street 205, 10002 New York", website: "https://www.katzsdelicatessen.com" });
const auCheval = subjectProfile({ restaurant: "Au Cheval", city: "Chicago", address: "West Randolph Street 800, 60607 Chicago", website: "http://auchevalchicago.com/" });

const cite = (id: string, source: CitedLines["source"], sentence: string, before: string[] = [], after: string[] = []): CitedLines => ({ id, source, sentence, before, after });
const masalaZone = { kind: "rival" as const, url: "https://www.masalazone.com/locations/covent-garden", title: "Masala Zone Covent Garden| Best Indian Restaurant London" };
const opentable = { kind: "menu" as const, url: "https://www.opentable.com/gjelina", title: "Gjelina Restaurant - Venice, CA | OpenTable" };
const katzMenu = { kind: "menu" as const, url: "https://katzsdelicatessen.com/store-menu", title: "Menu & Local Delivery - NYC's oldest deli" };

describe("subject check: real cases from the eval", () => {
  it("Dishoom: a competitor's private room is not Dishoom's (loved for, event)", () => {
    const room = [cite("S36", masalaZone, "The truly glamorous private room seats up to 42."), cite("S36", masalaZone, "Exclusive use for parties of 27 & above.")];
    const loved = subjectIssue("The private room seats up to 42 guests and offers exclusive use for parties of 27 or more.", "loved_for", room, dishoom);
    expect(loved).toMatch(/S36 \(masalazone\.com.*never names Dishoom Covent Garden.*competitor facts belong under rivals/);
    const news = { kind: "news" as const, url: "https://press.example/ballon-dor", title: "Ballon d'Or moves to London" };
    const event = "Ballon d'Or ceremony moves to London for the first time on 26 Oct 2026; Dishoom private room seats up to 42 with exclusive use for 27+.";
    expect(subjectIssue(event, "experience", [cite("S32", news, "The ceremony will take place in London for the first time on 26 October 2026."), room[0]], dishoom)).toMatch(/never names/);
    // The same fact about Masala Zone, filed under rivals, is fine.
    expect(subjectIssue("Masala Zone's private room seats up to 42.", "rivals", room, dishoom)).toBeNull();
  });

  it("Gjelina: a review of the Las Vegas branch is not about the one in Venice, LA", () => {
    const vegas = cite(
      "S7",
      opentable,
      "July 23, 2025 #### Gjelina at the Venetian: a pricey lunch with auto-gratuity and small portions Las Vegas Advisor reviews Gjelina at the Venetian, praising some flavors but calling the lunch pricey with small portions.",
    );
    expect(subjectIssue("Gjelina at the Venetian in Las Vegas was criticized for a pricey lunch.", "watch_outs", [vegas], gjelina)).toMatch(/about Las Vegas, not Gjelina in Los Angeles/);
    // Rephrased without naming the city, the cited sentence still gives it away.
    expect(subjectIssue("One review calls the lunch pricey with small portions.", "watch_outs", [vegas], gjelina)).toMatch(/sentence cited from S7 is about Las Vegas/);
    // The same page's sentence about Venice is fine.
    const venice = cite("S7", opentable, "Gjelina Delivers Consistent Cal-Italian Fare and Seasonal Flair on Venice's Abbot Kinney.");
    expect(subjectIssue("Critics call Gjelina consistent, seasonal Cal-Italian cooking.", "loved_for", [venice], gjelina)).toBeNull();
  });

  it("Katz's: a combo price is not the Reuben's price", () => {
    const combo = cite("S28", katzMenu, "As a Reuben, $33.95.", ["Hot, moist, and tender.", "Combos", "Choose your favorite combination."]);
    expect(subjectIssue("Katz's might be a little overinflated in price; the Reuben is $33.95.", "watch_outs", [combo], katz)).toMatch(
      /33\.95 on S28 is a combo or add-on price \(“Combos … As a Reuben, \$33\.95\.”\)/,
    );
    // Said as a combo, it is fine; so is a plain price line.
    expect(subjectIssue("A combo made as a Reuben costs $33.95.", "dish 1", [combo], katz)).toBeNull();
    const plain = cite("S28", katzMenu, "$28.95", ["Pastrami", "Our signature, hand-carved."]);
    expect(subjectIssue("The pastrami sandwich is $28.95.", "dish 1", [plain], katz)).toBeNull();
    // An add-on line: "With pastrami, add $1.00" is not a price of the Reuben.
    const addOn = cite("S28", katzMenu, "With pastrami, add $1.00.", ["Reuben", "Corned beef, Swiss cheese, Russian dressing, and sauerkraut."]);
    expect(subjectIssue("The Reuben is $1.00.", "dish 2", [addOn], katz)).toMatch(/combo or add-on/);
    expect(subjectIssue("Pastrami can be added to the Reuben for $1.00.", "dish 2", [addOn], katz)).toBeNull();
  });
});

describe("subject check: no false alarms on the restaurant's own pages", () => {
  it("trusts names, not research labels: Zuni's own reviews filed as 'rival' still count", () => {
    const zuni = subjectProfile({ restaurant: "Zuni Café", city: "San Francisco", address: "Market Street 1658, 94143 San Francisco", website: "https://zunicafe.com/" });
    const review = { kind: "rival" as const, url: "https://blog.resy.com/2024/01/zuni-cafe", title: "Long Live Zuni Cafe, San Francisco's Dining Room" };
    expect(subjectIssue("Critics call it the dining room table of California cuisine.", "loved_for", [cite("S20", review, "It is the dining room table of California cuisine.")], zuni)).toBeNull();
  });

  it("accepts the restaurant's own site, even on another host that names it (Au Cheval)", () => {
    const own = { kind: "site" as const, url: "https://www.auchevaldiner.com/chicago/menus", title: "Food & Drink — Au Cheval | Chicago" };
    expect(subjectIssue("Chopped Chicken Liver is on the menu at $14.99.", "dish 1", [cite("S15", own, "Chopped Chicken Liver $14.99")], auCheval)).toBeNull();
    const dishoomMenu = { kind: "menu" as const, url: "https://www.dishoom.com/menu/group-feast-covent-garden", title: "Dishoom Covent Garden Group Feast Menus" };
    expect(subjectIssue("Lunch Spread is £42 per person.", "loved_for", [cite("S13", dishoomMenu, "Our Lunch Spread is £42 per person.")], dishoom)).toBeNull();
  });

  it("flags the restaurant's own page for another branch (Au Cheval New York)", () => {
    const nyc = { kind: "site" as const, url: "https://www.auchevaldiner.com/nyc/home", title: "Au Cheval — New York City" };
    expect(subjectIssue("Au Cheval opens at 11am daily.", "loved_for", [cite("S18", nyc, "Open daily from 11am.")], auCheval)).toMatch(/S18 is about New York, not Au Cheval in Chicago/);
  });

  it("finds the restaurant's name on the line before a cited sentence (list pages)", () => {
    const guide = { kind: "review" as const, url: "https://guide.example/best-delis", title: "The best delis in town" };
    expect(subjectIssue("The pastrami is hand-carved to order.", "loved_for", [cite("S9", guide, "The pastrami is hand-carved to order.", ["Katz's Delicatessen"])], katz)).toBeNull();
    expect(subjectIssue("The lox is cured in-house.", "loved_for", [cite("S9", guide, "The lox is cured in-house.", ["Russ & Daughters"])], katz)).toMatch(/never names/);
  });

  it("lets a claim about the street or city cite a page about it", () => {
    const street = { kind: "rival" as const, url: "https://cava.example/cava-baja", title: "7 Best Tapas Bars on Cava Baja" };
    const lucio = subjectProfile({ restaurant: "Casa Lucio", city: "Madrid", address: "Calle de la Cava Baja 35, 28005 Madrid", website: "http://casalucio.es/" });
    expect(subjectIssue("Cava Baja has about 50 tapas bars in 300 metres.", "watch_outs", [cite("S21", street, "There are about 50 tapas bars in 300 metres.")], lucio)).toBeNull();
    // …but not a claim about the restaurant itself from the same page.
    expect(subjectIssue("Casa Lucio's tapas are the best on the street.", "loved_for", [cite("S21", street, "The tapas are the best on the street.")], lucio)).toMatch(/never names Casa Lucio/);
  });

  it("only checks claims about the restaurant itself, and only web pages", () => {
    expect(["loved_for", "watch_outs", "experience", "dish 1", "dish 3"].every(isSelfField)).toBe(true);
    expect(["moment 1", "rivals"].some(isSelfField)).toBe(false);
    const room = cite("S36", masalaZone, "The truly glamorous private room seats up to 42.");
    expect(subjectIssue("The private room seats up to 42.", "moment 2", [room], dishoom)).toBeNull();
    const weather = cite("S1", { kind: "weather", url: "https://open-meteo.com", title: "7-day forecast" }, "Thu 23 Oct: rain 6.2 mm");
    expect(subjectIssue("Rain on Thursday, 6.2 mm.", "dish 1", [weather], dishoom)).toBeNull();
  });
});

describe("place words", () => {
  it("brand words skip generic words and the place itself", () => {
    expect(brandWords("Dishoom Covent Garden", placeAnchors({ city: "London" }))).toEqual(["dishoom"]);
    expect(brandWords("Katz's Delicatessen")).toEqual(["katz"]);
    expect(brandWords("Casa Lucio")).toEqual(["lucio"]);
    expect(brandWords("Bar Cañete")).toEqual(["canete"]);
  });

  it("cities: names, not styles or newspapers", () => {
    expect(citiesIn("Gjelina at the Venetian, Las Vegas")).toEqual(["las vegas"]);
    expect(citiesIn("Au Cheval — New York City")).toEqual(["new york"]);
    expect(citiesIn("A New York-style cheesecake, says the Los Angeles Times")).toEqual([]);
  });
});

describe("in the verifier", () => {
  const sources: Source[] = [
    { id: "S1", kind: "rival", provider: "Tavily", title: masalaZone.title, url: masalaZone.url, text: "Private Dining\nThe truly glamorous private room seats up to 42.\nExclusive use for parties of 27 & above." },
    { id: "S2", kind: "menu", provider: "Tavily", title: "Dishoom Covent Garden Group Feast Menus", url: "https://www.dishoom.com/menu/group-feast-covent-garden", text: "Our Lunch Spread is £42 per person." },
  ];
  const pack = {
    req: { restaurant: "Dishoom Covent Garden", city: "London" },
    place: { name: "Dishoom Covent Garden", city: "London", lat: 51.5, lon: -0.13, website: "http://www.dishoom.com/covent-garden/", match: "exact" as const },
    language: "English",
    sources,
  };
  const claim = { text: "The private room seats up to 42 guests.", cites: [{ source: "S1", quote: "", span: "S1.2" }] };

  it("fails a claim about the restaurant that stands on a competitor's page, with the reason", () => {
    const v = verifierFor(pack).verifyEvidence(claim, "loved_for");
    expect(v.verified).toBe(false);
    expect(v.issue).toMatch(/never names Dishoom Covent Garden/);
  });

  it("passes the same claim under rivals, and when no field is given (older callers)", () => {
    const ledger = verifierFor(pack);
    expect(ledger.verifyEvidence(claim, "rivals").verified).toBe(true);
    expect(ledger.verifyEvidence(claim).verified).toBe(true);
    expect(SourceLedger.from(sources).verifyEvidence(claim, "loved_for").verified).toBe(true); // no subject check configured
  });

  it("passes a claim from the restaurant's own menu", () => {
    expect(verifierFor(pack).verifyEvidence({ text: "The Lunch Spread is £42 per person.", cites: [{ source: "S2", quote: "", span: "S2.1" }] }, "dish 1").verified).toBe(true);
  });
});
