import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeAnchors } from "@/lib/place";
import { findMenuPages, mappable, pickMenuPages, readMenuPage, shortUrl } from "@/lib/site-map";
import mapFixture from "./fixtures/tavily-map.json";
import { jsonResponse, mockFetch, silenceWarnings } from "./sources/helpers";

// Real Tavily Map responses (tests/fixtures/tavily-map.json, recorded 21 Oct 2026).
const urls = (key: keyof typeof mapFixture) => (mapFixture[key] as { response: { results: string[] } }).response.results;
const la = placeAnchors({ city: "Los Angeles", address: "Abbot Kinney Boulevard 1429, 90291 Los Angeles" });
const london = placeAnchors({ city: "London", address: "Upper St Martin's Lane 12, WC2H 9FB City of Westminster" });
const ny = placeAnchors({ city: "New York", address: "East Houston Street 205, 10002 New York" });

describe("pickMenuPages", () => {
  it("keeps this branch's menu and sets aside other cities' (Gjelina: Los Angeles, not New York or Las Vegas)", () => {
    const pick = pickMenuPages(urls("gjelina.com default"), la);
    expect(pick.pages).toEqual(["https://www.gjelina.com/los-angeles-menus"]);
    expect(pick.otherBranches).toEqual(["https://www.gjelina.com/new-york-menus", "https://www.gjelina.com/las-vegas-menus"]);
  });

  it("ranks the branch's everyday food menu first, drinks and side menus after (Dishoom Covent Garden)", () => {
    const pick = pickMenuPages(urls("dishoom.com/covent-garden select"), london);
    expect(pick.pages[0]).toBe("https://www.dishoom.com/menu/covent-garden-all-day");
    expect(pick.pages).toHaveLength(5);
    expect(pick.pages.indexOf("https://www.dishoom.com/menu/drinks-covent-garden")).not.toBe(0);
    expect(pick.pages).not.toContain("https://www.dishoom.com/menu/children-main");
  });

  it("with Tavily's default breadth, Dishoom's home page links never reach a /menu/ page", () => {
    const pick = pickMenuPages(urls("dishoom.com/covent-garden default"), london);
    expect(pick.pages.some((u) => u.includes("/menu/"))).toBe(false);
  });

  it("does not take shop items or a catering package for the menu (Katz's)", () => {
    expect(pickMenuPages(urls("katzsdelicatessen.com default"), ny).pages).toEqual([]);
    expect(pickMenuPages(["https://katzsdelicatessen.com/store-menu", "https://katzsdelicatessen.com/gift-cards"], ny).pages).toEqual(["https://katzsdelicatessen.com/store-menu"]);
  });

  it("reads the path, not the host, and decodes it", () => {
    expect(pickMenuPages(["https://menu.example.com/about", "https://casalucio.es/men%C3%BA-del-d%C3%ADa"], placeAnchors({ city: "Madrid" })).pages).toEqual([
      "https://casalucio.es/men%C3%BA-del-d%C3%ADa",
    ]);
  });
});

describe("mappable", () => {
  it("maps the restaurant's own site, not a profile on a platform", () => {
    expect(mappable("http://casalucio.es/")).toBe(true);
    expect(mappable("www.dishoom.com/covent-garden")).toBe(true);
    expect(mappable("https://www.instagram.com/barcanete")).toBe(false);
    expect(mappable("https://www.opentable.com/gjelina")).toBe(false);
    expect(mappable(undefined)).toBe(false);
  });
});

describe("findMenuPages + readMenuPage (Tavily Map → Extract)", () => {
  beforeEach(() => {
    silenceWarnings();
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks Map for menu paths only, ranks them and reports credits", async () => {
    const { calls } = mockFetch(() => jsonResponse(mapFixture["dishoom.com/covent-garden select"].response));
    const r = await findMenuPages("http://www.dishoom.com/covent-garden/", london);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ max_depth: 1, max_breadth: 150, limit: 150 });
    expect(body.select_paths[0]).toContain("menu");
    expect(r.pages[0]).toBe("https://www.dishoom.com/menu/covent-garden-all-day");
    expect(r.credits).toBe(2);
    expect(r.error).toBeUndefined();
  });

  it("passes Map's failure on instead of returning a silent empty list", async () => {
    mockFetch(() => jsonResponse({ detail: "boom" }, 500));
    const r = await findMenuPages("https://casalucio.es", placeAnchors({ city: "Madrid" }));
    expect(r.pages).toEqual([]);
    expect(r.error).toMatch(/500/);
  });

  it("reads the chosen page with Extract, focused on dishes and prices", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ results: [{ url: "https://casalucio.es/carta", raw_content: "Huevos estrellados 18 €" }], failed_results: [], usage: { credits: 1 } }),
    );
    const r = await readMenuPage("https://casalucio.es/carta");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ urls: ["https://casalucio.es/carta"], query: "menu dishes and prices", chunks_per_source: 5 });
    expect(r).toEqual({ page: { url: "https://casalucio.es/carta", content: "Huevos estrellados 18 €" }, credits: 1, failed: false });
  });
});

it("shortUrl", () => {
  expect(shortUrl("https://www.dishoom.com/menu/covent-garden-all-day/")).toBe("dishoom.com/menu/covent-garden-all-day");
});
