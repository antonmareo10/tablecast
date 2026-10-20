import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetNominatimThrottle, geocodeCity, geocodePlace, nameMatches, placeLine } from "../../src/lib/sources/geo";
import { jsonResponse, mockFetch, params, silenceWarnings } from "./helpers";

beforeEach(() => {
  silenceWarnings();
  _resetNominatimThrottle();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const madrid = { name: "Madrid", latitude: 40.4165, longitude: -3.70256, country_code: "ES", country: "Spain", admin1: "Madrid", timezone: "Europe/Madrid" };

describe("geocodeCity", () => {
  it("queries Open-Meteo geocoding and returns country code + timezone", async () => {
    const { calls } = mockFetch(() => jsonResponse({ results: [madrid] }));
    const g = await geocodeCity("Madrid");
    expect(calls[0].url.startsWith("https://geocoding-api.open-meteo.com/v1/search?")).toBe(true);
    expect(params(calls[0].url)).toEqual({ name: "Madrid", count: "1", language: "en", format: "json" });
    expect(g).toEqual({ lat: 40.4165, lon: -3.70256, label: "Madrid, Spain", country_code: "ES", timezone: "Europe/Madrid", source: "open-meteo" });
  });

  it("uses an ISO country hint as countryCode", async () => {
    const { calls } = mockFetch(() => jsonResponse({ results: [madrid] }));
    await geocodeCity("Madrid, es");
    expect(params(calls[0].url)).toMatchObject({ name: "Madrid", count: "1", countryCode: "ES" });
  });

  it("uses a country-name hint to pick among candidates", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({
        results: [
          { name: "Valencia", latitude: 39.47, longitude: -0.38, country_code: "ES", country: "Spain", admin1: "Valencia", timezone: "Europe/Madrid" },
          { name: "Valencia", latitude: 10.16, longitude: -68.0, country_code: "VE", country: "Venezuela", admin1: "Carabobo", timezone: "America/Caracas" },
        ],
      }),
    );
    const g = await geocodeCity("Valencia, Venezuela");
    expect(params(calls[0].url)).toMatchObject({ name: "Valencia", count: "10" });
    expect(g).toMatchObject({ country_code: "VE", label: "Valencia, Carabobo, Venezuela", timezone: "America/Caracas" });
  });

  it("returns null for no results, upstream failure, or empty input", async () => {
    mockFetch(() => jsonResponse({ generationtime_ms: 0.1 }));
    await expect(geocodeCity("Nowhereville")).resolves.toBeNull();
    mockFetch(() => jsonResponse("down", 503));
    await expect(geocodeCity("Madrid")).resolves.toBeNull();
    const { calls } = mockFetch(() => jsonResponse({ results: [madrid] }));
    await expect(geocodeCity("   ")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

const casaLucio = {
  osm_type: "node",
  osm_id: 4684485889,
  lat: "40.4120917",
  lon: "-3.7096742",
  category: "amenity",
  type: "restaurant",
  name: "Casa Lucio",
  display_name: "Casa Lucio, 35, Calle de la Cava Baja, Barrio de la Latina, Palacio, Centro, Madrid, Comunidad de Madrid, 28005, España",
  address: { amenity: "Casa Lucio", house_number: "35", road: "Calle de la Cava Baja", city: "Madrid", postcode: "28005", country_code: "es" },
  extratags: { phone: "+34 913653252", website: "http://casalucio.es/", opening_hours: "Mo-Su 13:00-16:00, 20:30-24:00", cuisine: "spanish;Regional_Food" },
};
const lucioStreet = {
  osm_type: "way",
  osm_id: 1,
  lat: "40.41",
  lon: "-3.70",
  category: "highway",
  type: "residential",
  name: "Calle de Casa Lucio",
  display_name: "Calle de Casa Lucio, Madrid, España",
  address: { road: "Calle de Casa Lucio", city: "Madrid", country_code: "es" },
  extratags: {},
};

describe("geocodePlace", () => {
  it("queries Nominatim and prefers the food amenity", async () => {
    const { calls } = mockFetch(() => jsonResponse([lucioStreet, casaLucio]));
    const p = await geocodePlace("Casa Lucio", "Madrid");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith("https://nominatim.openstreetmap.org/search?")).toBe(true);
    expect(params(calls[0].url)).toEqual({ q: "Casa Lucio, Madrid", format: "jsonv2", limit: "5", addressdetails: "1", extratags: "1" });
    expect(p).toEqual({
      lat: 40.4120917,
      lon: -3.7096742,
      label: "Casa Lucio, Madrid",
      name: "Casa Lucio",
      country_code: "ES",
      source: "nominatim",
      address: "Calle de la Cava Baja 35, 28005 Madrid",
      osm_type: "node",
      osm_id: "4684485889",
      website: "http://casalucio.es/",
      cuisine: ["spanish", "regional food"],
      phone: "+34 913653252",
      opening_hours: "Mo-Su 13:00-16:00, 20:30-24:00",
    });
    expect(placeLine(p!)).toBe(
      "Casa Lucio — Calle de la Cava Baja 35, 28005 Madrid; cuisine: spanish, regional food; opening hours: Mo-Su 13:00-16:00, 20:30-24:00; website: http://casalucio.es/",
    );
  });

  it("falls back to Photon when Nominatim fails", async () => {
    const photon = {
      type: "FeatureCollection",
      features: [
        {
          geometry: { type: "Point", coordinates: [-3.6187819, 40.6789583] },
          properties: { osm_type: "N", osm_id: 13259992578, osm_key: "amenity", osm_value: "restaurant", name: "Café23 La casa de comidas de San Agus", city: "San Agustín del Guadalix" },
        },
        {
          geometry: { type: "Point", coordinates: [-3.7096742, 40.4120917] },
          properties: { osm_type: "N", osm_id: 4684485889, osm_key: "amenity", osm_value: "restaurant", name: "Casa Lucio", street: "Calle de la Cava Baja", housenumber: "35", postcode: "28005", city: "Madrid", countrycode: "ES" },
        },
      ],
    };
    const { calls } = mockFetch((url) => (url.includes("nominatim") ? jsonResponse("overloaded", 503) : jsonResponse(photon)));
    vi.useFakeTimers();
    const pending = geocodePlace("Casa Lucio", "Madrid");
    await vi.advanceTimersByTimeAsync(5_000);
    const p = await pending;
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["nominatim.openstreetmap.org", "nominatim.openstreetmap.org", "photon.komoot.io"]);
    expect(params(calls[2].url)).toEqual({ q: "Casa Lucio, Madrid", limit: "5" });
    expect(p).toEqual({
      lat: 40.4120917,
      lon: -3.7096742,
      label: "Casa Lucio, Madrid",
      name: "Casa Lucio",
      country_code: "ES",
      source: "photon",
      address: "Calle de la Cava Baja 35, 28005 Madrid",
      osm_type: "node",
      osm_id: "4684485889",
    });
  });

  it("returns null when nothing plausible comes back", async () => {
    mockFetch((url) =>
      url.includes("nominatim")
        ? jsonResponse([{ ...lucioStreet, name: "Plaza Mayor", category: "place", type: "square" }])
        : jsonResponse({
            features: [
              {
                geometry: { coordinates: [-3.6, 40.6] },
                properties: { osm_key: "highway", osm_value: "residential", name: "Calle Benito Lucio", city: "San Agustín del Guadalix" },
              },
            ],
          }),
    );
    await expect(geocodePlace("Casa Lucio", "Madrid")).resolves.toBeNull();
  });

  it("returns null on empty answers from both services", async () => {
    mockFetch((url) => (url.includes("nominatim") ? jsonResponse([]) : jsonResponse({ features: [] })));
    await expect(geocodePlace("Casa Lucio", "Madrid")).resolves.toBeNull();
  });

  it("spaces Nominatim requests at least 1 s apart, process-wide", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch(() => jsonResponse([casaLucio]));
    const a = geocodePlace("Casa Lucio", "Madrid");
    const b = geocodePlace("Casa Lucio", "Madrid");
    const c = geocodePlace("Casa Lucio", "Madrid");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    await expect(Promise.all([a, b, c])).resolves.toHaveLength(3);
  });
});

describe("nameMatches", () => {
  it("forgives accents, articles, one typo and partial names", () => {
    expect(nameMatches("Casa Lucio", "Casa Lucio")).toBe(true);
    expect(nameMatches("casa lucío", "Casa Lucio")).toBe(true);
    expect(nameMatches("Restaurante Botín", "Sobrino de Botín")).toBe(true);
    expect(nameMatches("Sora Lella", "Trattoria Sora Lella")).toBe(true);
    expect(nameMatches("Casa Luccio", "Casa Lucio")).toBe(true);
  });

  it("rejects different venues", () => {
    expect(nameMatches("Casa Lucio", "Café23 La casa de comidas de San Agus")).toBe(false);
    expect(nameMatches("Casa Lucio", "Plaza Mayor")).toBe(false);
    expect(nameMatches("Bar Pepe", "Bar Manolo")).toBe(false);
  });
});
