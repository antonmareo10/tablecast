// Live smoke test against the keyless APIs. Skipped unless LIVE=1:
//   LIVE=1 vitest run tests/sources/live.test.ts
// Tavily and Ticketmaster are not called (they need keys and spend quota).

import { describe, expect, it } from "vitest";
import { geocodeCity, geocodePlace, placeLine } from "../../src/lib/sources/geo";
import { forecastLine, weekForecast } from "../../src/lib/sources/weather";
import { blockLine, nearbyVenues, venueLine } from "../../src/lib/sources/places";
import { holidayLine, upcomingHolidays } from "../../src/lib/sources/holidays";

const live = process.env.LIVE === "1";
const PUERTA_DEL_SOL = { lat: 40.41689, lon: -3.70348 };
const show = (title: string, lines: string[]) => console.log(`\n[live] ${title}\n${lines.map((l) => `  ${l}`).join("\n")}`);

describe.skipIf(!live)("live keyless sources", () => {
  it("geocodes Madrid with Open-Meteo", async () => {
    const g = await geocodeCity("Madrid");
    show("geocodeCity('Madrid')", [JSON.stringify(g)]);
    expect(g).toMatchObject({ country_code: "ES", timezone: "Europe/Madrid", source: "open-meteo" });
    expect(g!.lat).toBeCloseTo(40.42, 1);
    expect(g!.lon).toBeCloseTo(-3.7, 1);
  }, 30_000);

  it("gets a 7-day forecast for Madrid", async () => {
    const days = await weekForecast(40.4165, -3.70256);
    show("weekForecast(Madrid)", days.map(forecastLine));
    expect(days.length).toBe(7);
    for (const d of days) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.tmax).toBeGreaterThanOrEqual(d.tmin);
      expect(forecastLine(d)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}: .+, max -?\d+°C \/ min -?\d+°C, \d+\.\d mm/);
    }
  }, 30_000);

  it("lists food & drink venues around Puerta del Sol via Overpass", async () => {
    const t0 = Date.now();
    const s = await nearbyVenues(PUERTA_DEL_SOL.lat, PUERTA_DEL_SOL.lon, 600);
    const elapsed = Date.now() - t0;
    show(
      `nearbyVenues(Puerta del Sol, 600 m) in ${elapsed} ms`,
      s ? [`source=${s.source} complete=${s.complete}`, blockLine(s), ...s.venues.slice(0, 8).map(venueLine)] : ["null"],
    );
    expect(elapsed).toBeLessThan(13_000); // ~12 s budget
    expect(s).not.toBeNull();
    expect(s!.total).toBeGreaterThan(50);
    expect(s!.venues.length).toBe(40);
    expect(s!.venues[0].distance_m).toBeLessThanOrEqual(s!.venues[39].distance_m);
    expect(s!.venues.every((v) => v.distance_m <= 600)).toBe(true);
    expect(s!.by_kind.map((k) => k.kind)).toContain("restaurant");
  }, 30_000);

  it("lists Spanish holidays in the next weeks (Nager.Date)", async () => {
    const list = await upcomingHolidays("ES", "2026-10-20", 30);
    show("upcomingHolidays('ES', '2026-10-20', 30)", list.map(holidayLine));
    expect(list.some((h) => h.date === "2026-11-01" && h.national)).toBe(true);
    // Wording comes from Nager.Date ("All Saints Day (Día de todos los Santos)"); check the shape, not the text.
    expect(holidayLine(list.find((h) => h.date === "2026-11-01")!)).toMatch(/^Sun 1 Nov: .+, national holiday$/);
  }, 30_000);

  it("finds Casa Lucio, Madrid on Nominatim", async () => {
    const p = await geocodePlace("Casa Lucio", "Madrid");
    show("geocodePlace('Casa Lucio', 'Madrid')", [JSON.stringify(p), p ? placeLine(p) : "null"]);
    expect(p).toMatchObject({ name: "Casa Lucio", country_code: "ES" });
    expect(p!.lat).toBeCloseTo(40.412, 2);
    expect(p!.lon).toBeCloseTo(-3.7097, 2);
  }, 60_000);
});
