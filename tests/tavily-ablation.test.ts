import { describe, expect, it } from "vitest";
import type { EvidencePack } from "@/lib/agent";
import type { Evidence, Playbook, Source } from "@/lib/types";
import { isCompetitorPage, ownNameWord, planMetrics, tavilyOnlyFacts, withoutTavily } from "../scripts/tavily-ablation";

const sources: Source[] = [
  { id: "S1", kind: "weather", provider: "Open-Meteo", title: "Forecast", text: "Thu 22 Oct: light rain, max 14°C / min 9°C, 5.7 mm" },
  { id: "S2", kind: "menu", provider: "Tavily", title: "Menu", url: "https://example.com/menu", text: "Huevos rotos\n14.50\nCochinillo asado\n28" },
  { id: "S3", kind: "event", provider: "Ticketmaster", title: "Derby", text: "Thu 22 Oct 21:00 — Derby at the stadium, 1.2 km away" },
  { id: "S4", kind: "review", provider: "Tavily", title: "Guide", url: "https://example.com/guide", text: "Locals queue for the huevos rotos." },
  { id: "S5", kind: "rival", provider: "Tavily", title: "Rival", url: "https://rival.example/menu", text: "Croquetas caseras 9.50" },
  { id: "S6", kind: "block", provider: "OpenStreetMap", title: "Block", text: "Within 600 m: 120 food & drink venues" },
];

function pack(): EvidencePack {
  return {
    req: { restaurant: "Casa Test", city: "Madrid" },
    goal: "Fill quiet weeknights",
    language: "English",
    place: { name: "Casa Test", city: "Madrid", lat: 40.4, lon: -3.7, match: "exact" },
    context: ["Restaurant: Casa Test — Madrid", "Website: https://example.com", "MENU PAGES (Tavily Map): https://example.com/menu", "MENU PAGE ALREADY READ: S4 (https://example.com/menu)", "FORECAST:", "Thu 22 Oct: light rain"].join("\n"),
    sources: structuredClone(sources),
    photoMenu: false,
    tavilyCredits: 5,
  };
}

const claim = (text: string, ...ids: string[]): Evidence => ({
  text,
  verified: true,
  cites: ids.map((id) => ({ source: id.split(".")[0], span: id, quote: "", ok: true })),
});

function plan(): Playbook {
  return {
    restaurant: { name: "Casa Test", city: "Madrid", concept: "tavern", website: null },
    currency: "EUR",
    headline: "Rainy Thursday: lean on the huevos rotos",
    snapshot: { summary: "", loved_for: [claim("Locals queue for the huevos rotos.", "S4.1")], watch_outs: [] },
    moments: [{ when: "Thu", title: "Rain", play: "", evidence: [claim("Thursday brings 5.7 mm of rain.", "S1.1")] }],
    menu_moves: [
      { dish: "Huevos rotos", description: "", price: 14.5, when: "", why: "", ingredients: [], evidence: [claim("Huevos rotos cost 14.50.", "S2.1")] },
      { dish: "Rainy-day stew", description: "", price: 16, when: "", why: "", ingredients: [], evidence: [claim("Rain on Thursday.", "S1.1"), claim("Derby nearby.", "S3.1")] },
      { dish: "Derby plate", description: "", price: 12, when: "", why: "", ingredients: [], evidence: [{ ...claim("Made-up fact.", "S3.1"), verified: false }] },
    ],
    rivals: { summary: "", evidence: [claim("The rival sells croquetas at €9.50.", "S5.1"), claim("120 venues within 600 m.", "S6.1")] },
    experience: { event_idea: "", event_why: "", evidence: [] },
    marketing: { instagram_post: "", post_when: "", audience: "" },
    shopping_list: [],
    week_plan: [],
    caveats: [],
  };
}

describe("withoutTavily", () => {
  it("drops Tavily sources and the Tavily Map line, renumbers the rest in order, leaves the input alone", () => {
    const input = pack();
    const before = JSON.stringify(input);
    const { pack: out, removedSources, removedLines } = withoutTavily(input);
    expect(removedSources).toBe(3);
    expect(removedLines).toEqual(["MENU PAGES (Tavily Map): https://example.com/menu", "MENU PAGE ALREADY READ: S4 (https://example.com/menu)"]);
    expect(out.sources.map((s) => `${s.id}:${s.provider}`)).toEqual(["S1:Open-Meteo", "S2:Ticketmaster", "S3:OpenStreetMap"]);
    expect(out.context).not.toMatch(/Tavily|MENU PAGE/);
    expect(out.context).toContain("Website: https://example.com"); // from OpenStreetMap or the owner, not Tavily
    expect(out.tavilyCredits).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("competitor pages", () => {
  it("keeps the distinctive word of a restaurant's name", () => {
    expect(ownNameWord("Zuni Café")).toBe("zuni");
    expect(ownNameWord("Au Cheval")).toBe("cheval");
    expect(ownNameWord("Katz's Delicatessen")).toBe("katz");
    expect(ownNameWord("Dishoom Covent Garden")).toBe("dishoom");
  });
  it("does not count the restaurant's own pages filed as rival", () => {
    const rival = (url: string, title = ""): Source => ({ id: "S9", kind: "rival", provider: "Tavily", url, title, text: "" });
    expect(isCompetitorPage(rival("https://www.opentable.com/zuni-cafe"), "zuni")).toBe(false);
    expect(isCompetitorPage(rival("https://en.wikipedia.org/wiki/Katz%27s_Delicatessen"), "katz")).toBe(false);
    expect(isCompetitorPage(rival("https://www.masalazone.com/locations/covent-garden", "Masala Zone Covent Garden"), "dishoom")).toBe(true);
    expect(isCompetitorPage({ ...rival("https://x.example"), kind: "review" }, "dishoom")).toBe(false);
  });
});

describe("planMetrics", () => {
  const report = {
    ok: true,
    claims: 9,
    verifiedFirstPass: 6,
    verifiedFinal: 8,
    amounts: { checked: 2, unbackedFirst: 1, unbackedFinal: 0 },
    draft: {
      menu_seen: [
        { name: "Huevos rotos", price: 14.5, source: "S2" },
        { name: "Tortilla (half)", price: null, source: "S2" },
        { name: "Carta", price: null, source: "S2" },
        { name: "Casa Test", price: null, source: "S2" },
      ],
    },
  } as unknown as Parameters<typeof planMetrics>[0];

  it("counts what verified claims cite, the real menu and rivals' prices", () => {
    const m = planMetrics(report, plan(), sources, sources, "Casa Test");
    expect(m.verifiedTavily).toBe(3); // guide, menu, rival
    expect(m.verifiedOnlyTavily).toBe(3);
    expect(m.verifiedByGroup).toEqual({ guests: 1, moments: 1, dishes: 3, rivals: 2, event: 0 });
    expect(m.verifiedByProvider).toEqual({ Tavily: 3, "Open-Meteo": 2, Ticketmaster: 1, OpenStreetMap: 1 });
    expect(m.guestsFromWeb).toBe(1);
    expect(m.rivalPriceClaims).toBe(1);
    expect(m.sourcesCited).toBe(6);
    expect(m.providersCited).toEqual(["Open-Meteo", "OpenStreetMap", "Tavily", "Ticketmaster"]);
    expect(m.menuListed).toBe(2); // a heading and the restaurant's own name are not menu items
    expect(m.menuChecked).toBe(1); // "Tortilla" is not on the page
    expect(m.dishesOnMenuEvidence).toBe(1);
    expect(m.dishesAlreadyOnMenu).toBe(1); // "Huevos rotos" is already sold
    expect(m.dishesRepeatListedMenu).toBe(1); // …and the plan itself lists it in menu_seen
    expect(m.weekSpecific).toBeCloseTo(1 / 3);
  });

  it("judges a plan written without Tavily against the real menu", () => {
    const { pack: ablated } = withoutTavily(pack());
    const m = planMetrics(report, plan(), ablated.sources, sources, "Casa Test");
    expect(m.menuChecked).toBe(0); // no menu page in its own sources
    expect(m.menuOnRealMenu).toBe(1); // but "Huevos rotos" is on the real one
  });

  it("lists the facts only Tavily sources back, with their sentence and URL", () => {
    const facts = tavilyOnlyFacts(plan(), sources);
    expect(facts.map((f) => f.group)).toEqual(["guests", "dishes", "rivals"]);
    expect(facts[2].cites[0]).toMatchObject({ url: "https://rival.example/menu", sentence: "Croquetas caseras 9.50" });
  });
});
