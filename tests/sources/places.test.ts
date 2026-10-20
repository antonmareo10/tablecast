import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockLine,
  buildVenueQuery,
  nearbyVenues,
  OVERPASS_ENDPOINTS,
  overpassQuery,
  summarizeVenues,
  venueLine,
  type Venue,
} from "../../src/lib/sources/places";
import { _resetNominatimThrottle } from "../../src/lib/sources/nominatim";
import { hang, header, jsonResponse, mockFetch, silenceWarnings } from "./helpers";

beforeEach(() => {
  silenceWarnings();
  _resetNominatimThrottle();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SOL = { lat: 40.4169, lon: -3.7035 };
// 1 m of latitude = 1 / 111,195 °
const north = (m: number) => SOL.lat + m / 111_195;
const isOverpass = (url: string) => OVERPASS_ENDPOINTS.includes(url);
const queryOf = (init: RequestInit | undefined) => new URLSearchParams(String(init?.body)).get("data") ?? "";

const elements = [
  { type: "node", id: 1, lat: north(240), lon: SOL.lon, tags: { amenity: "restaurant", name: "Trattoria Sora Lella", cuisine: "italian" } },
  { type: "way", id: 2, center: { lat: north(100), lon: SOL.lon }, tags: { amenity: "bar", name: "  Bar  El Sol ", website: "https://elsol.example" } },
  { type: "node", id: 3, lat: north(120), lon: SOL.lon, tags: { amenity: "fast_food", name: "Pizza Rápida", cuisine: "Pizza;pizza_al_taglio;italian" } },
  { type: "node", id: 4, lat: north(50), lon: SOL.lon, tags: { amenity: "cafe", name: "Café Central", opening_hours: "Mo-Su 08:00-23:00", cuisine: "coffee_shop" } },
  // Same café mapped again as the building way, 10 m away: de-duplicated.
  { type: "way", id: 5, center: { lat: north(60), lon: SOL.lon }, tags: { amenity: "cafe", name: "Cafe Central" } },
  // Unnamed venues and venues in the bbox corners but outside the radius are ignored.
  { type: "node", id: 6, lat: north(30), lon: SOL.lon, tags: { amenity: "restaurant" } },
  { type: "node", id: 7, lat: north(900), lon: SOL.lon, tags: { amenity: "pub", name: "Far Pub" } },
  { type: "node", id: 8, lat: north(400), lon: SOL.lon, tags: { amenity: "pub", name: "The Irish Rover", cuisine: "irish" } },
];

describe("buildVenueQuery", () => {
  it("asks for named food & drink nodes and ways in the radius's bounding square", () => {
    const q = buildVenueQuery(SOL.lat, SOL.lon, 600);
    expect(q.startsWith("[out:json][timeout:15][maxsize:67108864];(node[\"amenity\"~\"^(restaurant|cafe|bar|pub|fast_food)$\"][\"name\"](")).toBe(true);
    expect(q.endsWith(");out center tags qt;")).toBe(true);
    const boxes = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/g)].map((m) => m.slice(1).map(Number));
    expect(boxes).toHaveLength(2);
    const [s, w, n, e] = boxes[0];
    expect(boxes[1]).toEqual(boxes[0]);
    expect((s + n) / 2).toBeCloseTo(SOL.lat, 5);
    expect((w + e) / 2).toBeCloseTo(SOL.lon, 5);
    expect((n - s) * 111_195).toBeCloseTo(1_200, -1);
    expect((e - w) * 111_195 * Math.cos((SOL.lat * Math.PI) / 180)).toBeCloseTo(1_200, -1);
  });
});

describe("nearbyVenues via Overpass", () => {
  it("POSTs the query to the main instance and summarises the answer", async () => {
    const { calls } = mockFetch(() => jsonResponse({ elements }));
    const s = await nearbyVenues(SOL.lat, SOL.lon);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://overpass-api.de/api/interpreter");
    expect(calls[0].init?.method).toBe("POST");
    expect(header(calls[0].init, "content-type")).toContain("application/x-www-form-urlencoded");
    expect(queryOf(calls[0].init)).toBe(buildVenueQuery(SOL.lat, SOL.lon, 600));

    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ radius_m: 600, total: 5, source: "overpass", complete: true });
    expect(s!.venues.map((v) => [v.osm_id, v.name, v.kind, v.distance_m])).toEqual([
      ["node/4", "Café Central", "cafe", 50],
      ["way/2", "Bar El Sol", "bar", 100],
      ["node/3", "Pizza Rápida", "fast food", 120],
      ["node/1", "Trattoria Sora Lella", "restaurant", 240],
      ["node/8", "The Irish Rover", "pub", 400],
    ]);
    expect(s!.venues[0]).toMatchObject({ cuisine: ["coffee shop"], opening_hours: "Mo-Su 08:00-23:00" });
    expect(s!.venues[1]).toMatchObject({ website: "https://elsol.example", cuisine: [] });
    expect(s!.venues[2].cuisine).toEqual(["pizza", "pizza al taglio", "italian"]);
    expect(s!.by_kind).toEqual([
      { kind: "bar", count: 1 },
      { kind: "cafe", count: 1 },
      { kind: "fast food", count: 1 },
      { kind: "pub", count: 1 },
      { kind: "restaurant", count: 1 },
    ]);
    expect(s!.by_cuisine[0]).toEqual({ cuisine: "italian", count: 2 });
  });

  it("returns at most 40 venues but counts all of them", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      type: "node",
      id: 100 + i,
      lat: north(5 + i * 10),
      lon: SOL.lon,
      tags: { amenity: i % 2 ? "bar" : "restaurant", name: `Venue ${i}`, cuisine: i % 3 ? "spanish" : "japanese" },
    }));
    const s = summarizeVenues(many, SOL, 600);
    expect(s.venues).toHaveLength(40);
    expect(s.venues[39].name).toBe("Venue 39");
    expect(s.total).toBe(55);
    expect(s.by_kind).toEqual([
      { kind: "restaurant", count: 28 },
      { kind: "bar", count: 27 },
    ]);
    expect(s.by_cuisine).toEqual([
      { cuisine: "spanish", count: 36 },
      { cuisine: "japanese", count: 19 },
    ]);
  });

  it("falls back to the next mirror when the main instance fails fast", async () => {
    const { calls } = mockFetch((url) => (url.includes("overpass-api.de") ? jsonResponse("at capacity", 502) : jsonResponse({ elements })));
    const s = await nearbyVenues(SOL.lat, SOL.lon);
    expect(calls.map((c) => c.url)).toEqual([OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[1]]);
    expect(s).toMatchObject({ total: 5, source: "overpass" });
  });

  it("hedges to a mirror when the main instance hangs, and aborts the loser", async () => {
    let mainSignal: AbortSignal | undefined;
    const { calls } = mockFetch((url, init) => {
      if (url === "https://a.example/api") {
        mainSignal = init?.signal ?? undefined;
        return hang(init);
      }
      return jsonResponse({ elements: [] });
    });
    const res = await overpassQuery("[out:json];", { endpoints: ["https://a.example/api", "https://b.example/api"], hedgeMs: 20, timeoutMs: 5_000 });
    expect(res).toEqual({ elements: [] });
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/api", "https://b.example/api"]);
    expect(mainSignal?.aborted).toBe(true);
  });

  it("treats a 200 with a runtime-error remark as a failure", async () => {
    const { calls } = mockFetch((url) =>
      url.includes("overpass-api.de")
        ? jsonResponse({ elements: [elements[0]], remark: 'runtime error: Query timed out in "query" at line 1 after 21 seconds.' })
        : jsonResponse({ elements }),
    );
    const s = await nearbyVenues(SOL.lat, SOL.lon);
    expect(calls).toHaveLength(2);
    expect(s?.total).toBe(5);
  });

  it("returns null when every instance fails and the fallback is disabled", async () => {
    const { calls } = mockFetch(() => jsonResponse("at capacity", 504));
    await expect(nearbyVenues(SOL.lat, SOL.lon, 600, { nominatim: false })).resolves.toBeNull();
    expect(calls.map((c) => c.url)).toEqual(OVERPASS_ENDPOINTS);
  });

  it("returns an empty summary (not null) when nothing is mapped", async () => {
    mockFetch(() => jsonResponse({ elements: [] }));
    const s = await nearbyVenues(SOL.lat, SOL.lon, 300);
    expect(s).toEqual({ venues: [], total: 0, by_kind: [], by_cuisine: [], radius_m: 300, source: "overpass", complete: true });
    expect(blockLine(s!)).toBe("Within 300 m: no named food & drink venues mapped in OpenStreetMap");
  });

  it("clamps the radius", async () => {
    const { calls } = mockFetch(() => jsonResponse({ elements: [] }));
    const s = await nearbyVenues(SOL.lat, SOL.lon, 50_000);
    expect(s?.radius_m).toBe(1500);
    expect(queryOf(calls[0].init)).toBe(buildVenueQuery(SOL.lat, SOL.lon, 1500));
  });
});

describe("nearbyVenues Nominatim fallback", () => {
  const poi = (id: number, type: string, name: string, metersNorth: number, extratags: Record<string, string> = {}, category = "amenity") => ({
    osm_type: "node",
    osm_id: id,
    lat: String(north(metersNorth)),
    lon: String(SOL.lon),
    category,
    type,
    name,
    extratags,
  });
  // 40 raw restaurant hits (the cap): 39 inside 600 m, one beyond it.
  const restaurants = Array.from({ length: 40 }, (_, i) =>
    i === 39 ? poi(1_000 + i, "restaurant", "Far Away Grill", 900) : poi(1_000 + i, "restaurant", `Casa ${i}`, 10 + i * 10, i < 10 ? { cuisine: "spanish" } : {}),
  );
  const byQuery: Record<string, unknown[]> = {
    restaurant: restaurants,
    bar: [poi(100, "bar", "Bar Paco", 120), poi(200, "pub", "The Hat", 130)],
    cafe: [poi(300, "cafe", "Café Comercial", 140, { opening_hours: "Mo-Su 08:00-24:00" }), poi(301, "residential", "Calle Café", 10, {}, "highway")],
    pub: [poi(200, "pub", "The Hat", 130), poi(100, "bar", "Bar Paco", 120)],
    fast_food: [poi(400, "fast_food", "Burger Sol", 150, { cuisine: "burger" }), poi(401, "fast_food", "", 20)],
  };
  const nominatimRoute = (lists: Record<string, unknown[]>) => (url: string) => {
    if (isOverpass(url)) return jsonResponse("at capacity", 502);
    return jsonResponse(lists[new URL(url).searchParams.get("q") ?? ""] ?? []);
  };
  const nominatimCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith("https://nominatim.openstreetmap.org/"));

  it("runs one bounded search per kind (1 req/s), de-duplicates, and reports a capped list as partial", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch(nominatimRoute(byQuery));
    const pending = nearbyVenues(SOL.lat, SOL.lon, 600);
    await vi.advanceTimersByTimeAsync(0);
    expect(nominatimCalls(calls)).toHaveLength(1); // Overpass failed fast: fallback started at once
    await vi.advanceTimersByTimeAsync(999);
    expect(nominatimCalls(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const s = await pending;

    const nom = nominatimCalls(calls);
    expect(nom.map((c) => new URL(c.url).searchParams.get("q"))).toEqual(["restaurant", "bar", "cafe", "pub", "fast_food"]);
    const p = Object.fromEntries(new URL(nom[0].url).searchParams.entries());
    expect(p).toMatchObject({ format: "jsonv2", bounded: "1", limit: "40", extratags: "1" });
    const [w, n, e, so] = p.viewbox.split(",").map(Number);
    expect(w).toBeLessThan(SOL.lon);
    expect(e).toBeGreaterThan(SOL.lon);
    expect(n).toBeGreaterThan(SOL.lat);
    expect(so).toBeLessThan(SOL.lat);
    expect((n - so) * 111_195).toBeCloseTo(1_200, -1);

    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ source: "nominatim", complete: false, total: 43, radius_m: 600 });
    expect(s!.by_kind).toEqual([
      { kind: "restaurant", count: 39, at_least: true },
      { kind: "bar", count: 1 },
      { kind: "cafe", count: 1 },
      { kind: "fast food", count: 1 },
      { kind: "pub", count: 1 },
    ]);
    expect(s!.venues).toHaveLength(40);
    expect(s!.venues.find((v) => v.osm_id === "node/300")).toMatchObject({ name: "Café Comercial", kind: "cafe", distance_m: 140, opening_hours: "Mo-Su 08:00-24:00" });
    expect(s!.venues.some((v) => v.name === "Far Away Grill" || v.name === "Calle Café")).toBe(false);
    expect(blockLine(s!)).toBe(
      "Within 600 m: at least 43 food & drink venues (OpenStreetMap via Nominatim; partial list) — 39+ restaurants, 1 bar, 1 cafe, 1 fast-food place, 1 pub; top cuisines: spanish 10, burger 1",
    );
  });

  it("says so when the Nominatim list is complete", async () => {
    vi.useFakeTimers();
    mockFetch(nominatimRoute({ restaurant: [poi(1, "restaurant", "Casa Pepe", 50)], bar: [poi(2, "bar", "Bar Paco", 80)] }));
    const pending = nearbyVenues(SOL.lat, SOL.lon, 600);
    await vi.advanceTimersByTimeAsync(6_000);
    const s = await pending;
    expect(s).toMatchObject({ source: "nominatim", complete: true, total: 2 });
    expect(blockLine(s!)).toBe("Within 600 m: 2 food & drink venues (OpenStreetMap via Nominatim) — 1 bar, 1 restaurant");
  });

  it("starts the fallback after 3 s of Overpass silence and aborts Overpass when it wins", async () => {
    vi.useFakeTimers();
    const overpassSignals: AbortSignal[] = [];
    const { calls } = mockFetch((url, init) => {
      if (isOverpass(url)) {
        if (init?.signal) overpassSignals.push(init.signal);
        return hang(init);
      }
      return jsonResponse(byQuery[new URL(url).searchParams.get("q") ?? ""] ?? []);
    });
    const pending = nearbyVenues(SOL.lat, SOL.lon, 600);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(nominatimCalls(calls)).toHaveLength(0);
    expect(calls.filter((c) => isOverpass(c.url)).map((c) => c.url)).toEqual(OVERPASS_ENDPOINTS.slice(0, 2)); // hedged at 2.5 s
    await vi.advanceTimersByTimeAsync(1);
    expect(nominatimCalls(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const s = await pending;
    expect(s).toMatchObject({ source: "nominatim", complete: false, total: 43 });
    expect(overpassSignals.length).toBeGreaterThan(0);
    expect(overpassSignals.every((sig) => sig.aborted)).toBe(true);
  });

  it("prefers Overpass if it answers while the fallback is still running", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch((url, init) => {
      if (url === OVERPASS_ENDPOINTS[0]) return new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse({ elements })), 3_500));
      if (isOverpass(url)) return hang(init);
      return jsonResponse(byQuery[new URL(url).searchParams.get("q") ?? ""] ?? []);
    });
    const pending = nearbyVenues(SOL.lat, SOL.lon, 600);
    await vi.advanceTimersByTimeAsync(3_600);
    const s = await pending;
    expect(s).toMatchObject({ source: "overpass", complete: true, total: 5 });
    expect(nominatimCalls(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(nominatimCalls(calls)).toHaveLength(1); // the fallback stopped
  });

  it("returns null when both sources fail", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch(() => jsonResponse("down", 503));
    const pending = nearbyVenues(SOL.lat, SOL.lon, 600);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toBeNull();
    expect(nominatimCalls(calls)).toHaveLength(5);
  });

  it("never runs past its time budget", async () => {
    mockFetch((_url, init) => hang(init));
    const t0 = Date.now();
    const s = await nearbyVenues(SOL.lat, SOL.lon, 600, { budgetMs: 1_500, fallbackAfterMs: 100, overpass: { hedgeMs: 100 } });
    const elapsed = Date.now() - t0;
    expect(s).toBeNull();
    expect(elapsed).toBeLessThan(2_500);
  });
});

describe("canonical lines", () => {
  const v: Venue = { osm_id: "node/1", name: "Trattoria Sora Lella", kind: "restaurant", cuisine: ["italian"], lat: 0, lon: 0, distance_m: 240 };

  it("venueLine", () => {
    expect(venueLine(v)).toBe("Trattoria Sora Lella — restaurant, italian, 240 m away");
    expect(venueLine({ ...v, name: "Bar El Sol", kind: "bar", cuisine: [], distance_m: 85 })).toBe("Bar El Sol — bar, 85 m away");
    expect(venueLine({ ...v, cuisine: ["a", "b", "c", "d"] })).toBe("Trattoria Sora Lella — restaurant, a, b, c, 240 m away");
  });

  it("blockLine", () => {
    expect(
      blockLine({
        radius_m: 600,
        total: 87,
        by_kind: [
          { kind: "restaurant", count: 41 },
          { kind: "bar", count: 22 },
          { kind: "cafe", count: 15 },
          { kind: "pub", count: 6 },
          { kind: "fast food", count: 3 },
        ],
        by_cuisine: [
          { cuisine: "spanish", count: 12 },
          { cuisine: "italian", count: 7 },
          { cuisine: "japanese", count: 5 },
        ],
      }),
    ).toBe(
      "Within 600 m: 87 food & drink venues — 41 restaurants, 22 bars, 15 cafes, 6 pubs, 3 fast-food places; top cuisines: spanish 12, italian 7, japanese 5",
    );
    expect(blockLine({ radius_m: 200, total: 1, by_kind: [{ kind: "fast food", count: 1 }], by_cuisine: [] })).toBe(
      "Within 200 m: 1 food & drink venue — 1 fast-food place",
    );
  });

  it("blockLine is honest about partial Nominatim lists", () => {
    expect(
      blockLine({
        radius_m: 600,
        total: 109,
        source: "nominatim",
        complete: false,
        by_kind: [
          { kind: "restaurant", count: 40, at_least: true },
          { kind: "bar", count: 40, at_least: true },
          { kind: "cafe", count: 29 },
        ],
        by_cuisine: [{ cuisine: "spanish", count: 9 }],
      }),
    ).toBe("Within 600 m: at least 109 food & drink venues (OpenStreetMap via Nominatim; partial list) — 40+ restaurants, 40+ bars, 29 cafes; top cuisines: spanish 9");
    expect(blockLine({ radius_m: 600, total: 0, source: "nominatim", complete: false, by_kind: [], by_cuisine: [] })).toBe(
      "Within 600 m: no named food & drink venues found (OpenStreetMap via Nominatim; partial list)",
    );
  });
});
