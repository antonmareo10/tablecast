import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeAnchors } from "@/lib/place";
import { findMenuPages, mappable, pickMenuPages, readMenuPage, shortUrl } from "@/lib/site-map";
import mapFixture from "./fixtures/tavily-map.json";
import { mockFetch, silenceWarnings } from "./sources/helpers";

// The reader checks that every host resolves to a public address; tests resolve every name to one.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

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

describe("findMenuPages + readMenuPage (the reader: site links → menu page)", () => {
  beforeEach(() => {
    silenceWarnings();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const html = (body: string) => new Response(`<html><head><title>Casa Lucio</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

  it("lists the home page's links and the sitemap, then ranks the menu pages for this branch", async () => {
    mockFetch((url) => {
      if (url.endsWith("/sitemap.xml"))
        return new Response("<urlset><url><loc>https://www.gjelina.com/las-vegas-menus</loc></url><url><loc>https://www.gjelina.com/press</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      return html('<nav><a href="/los-angeles-menus">Menus</a></nav><a href="/new-york-menus">NY</a><a href="https://elsewhere.com/menu">x</a>');
    });
    const r = await findMenuPages("https://www.gjelina.com", la);
    expect(r.pages).toEqual(["https://www.gjelina.com/los-angeles-menus"]);
    expect(r.otherBranches.sort()).toEqual(["https://www.gjelina.com/las-vegas-menus", "https://www.gjelina.com/new-york-menus"]);
    expect(r.credits).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it("passes the site's failure on instead of returning a silent empty list", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const r = await findMenuPages("https://casalucio.es", placeAnchors({ city: "Madrid" }));
    expect(r.pages).toEqual([]);
    expect(r.error).toMatch(/500/);
  });

  it("reads the chosen page's text, exactly as the page has it", async () => {
    mockFetch(() => html("<main><h2>Carta</h2><ul><li>Huevos estrellados <span>18 €</span></li><li>Callos a la madrileña &ndash; 21 €</li></ul><p>Reservas: 913 653 252, todos los días.</p></main>"));
    const r = await readMenuPage("https://casalucio.es/carta");
    expect(r.failed).toBe(false);
    expect(r.page?.url).toBe("https://casalucio.es/carta");
    expect(r.page?.content).toContain("Huevos estrellados 18 €");
    expect(r.page?.content).toContain("Callos a la madrileña – 21 €");
  });
});

it("shortUrl", () => {
  expect(shortUrl("https://www.dishoom.com/menu/covent-garden-all-day/")).toBe("dishoom.com/menu/covent-garden-all-day");
});
