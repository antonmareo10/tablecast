import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holidayLine, upcomingHolidays, type Holiday } from "../../src/lib/sources/holidays";
import { jsonResponse, mockFetch, silenceWarnings } from "./helpers";

beforeEach(() => {
  silenceWarnings();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const h = (date: string, name: string, localName: string, global: boolean, counties: string[] | null = null, types = ["Public"]) => ({
  date,
  localName,
  name,
  countryCode: "ES",
  fixed: false,
  global,
  counties,
  launchYear: null,
  types,
});

const es2026 = [
  h("2026-10-12", "National Day", "Fiesta Nacional de España", true),
  h("2026-11-01", "All Saints' Day", "Todos los Santos", true),
  h("2026-11-09", "Our Lady of Almudena", "Nuestra Señora de la Almudena", false, ["ES-MD"]),
  h("2026-12-08", "Immaculate Conception", "La Inmaculada Concepción", true),
  h("2026-12-25", "Christmas Day", "Navidad", true),
  h("2026-12-26", "St. Stephen's Day", "Sant Esteve", false, ["ES-CT", "ES-IB"]),
];
const es2027 = [
  h("2027-01-01", "New Year's Day", "Año Nuevo", true),
  h("2027-01-06", "Epiphany", "Día de Reyes / Epifanía del Señor", true),
  h("2027-01-11", "Too late", "Too late", true),
];

describe("upcomingHolidays", () => {
  it("fetches Nager.Date for the year and keeps the window", async () => {
    const { calls } = mockFetch(() => jsonResponse(es2026));
    const list = await upcomingHolidays("es", "2026-10-28", 14);
    expect(calls.map((c) => c.url)).toEqual(["https://date.nager.at/api/v3/PublicHolidays/2026/ES"]);
    expect(list).toEqual<Holiday[]>([
      { date: "2026-11-01", name: "All Saints' Day", local_name: "Todos los Santos", national: true },
      { date: "2026-11-09", name: "Our Lady of Almudena", local_name: "Nuestra Señora de la Almudena", national: false, regions: ["ES-MD"] },
    ]);
  });

  it("treats the window as [from, from + days)", async () => {
    mockFetch(() => jsonResponse(es2026));
    const list = await upcomingHolidays("ES", "2026-10-27", 6); // 27 Oct … 1 Nov inclusive
    expect(list.map((x) => x.date)).toEqual(["2026-11-01"]);
    const shorter = await upcomingHolidays("ES", "2026-10-27", 5); // 27 … 31 Oct
    expect(shorter).toEqual([]);
  });

  it("handles a window that crosses New Year", async () => {
    const { calls } = mockFetch((url) => jsonResponse(url.includes("/2027/") ? es2027 : es2026));
    const list = await upcomingHolidays("ES", "2026-12-24", 14);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://date.nager.at/api/v3/PublicHolidays/2026/ES",
      "https://date.nager.at/api/v3/PublicHolidays/2027/ES",
    ]);
    expect(list.map((x) => `${x.date} ${x.name}`)).toEqual([
      "2026-12-25 Christmas Day",
      "2026-12-26 St. Stephen's Day",
      "2027-01-01 New Year's Day",
      "2027-01-06 Epiphany",
    ]);
  });

  it("merges duplicate rows and flags non-public observances", async () => {
    mockFetch(() =>
      jsonResponse([
        h("2026-04-03", "Good Friday", "Good Friday", false, ["US-CT", "US-NC"], ["Public"]),
        h("2026-04-03", "Good Friday", "Good Friday", false, ["US-TX", "US-CT"], ["Bank"]),
        h("2026-02-12", "Lincoln's Birthday", "Lincoln's Birthday", false, ["US-CA"], ["Observance"]),
      ]),
    );
    const list = await upcomingHolidays("US", "2026-02-01", 90);
    expect(list).toEqual<Holiday[]>([
      { date: "2026-02-12", name: "Lincoln's Birthday", local_name: "Lincoln's Birthday", national: false, regions: ["US-CA"], observance: true },
      { date: "2026-04-03", name: "Good Friday", local_name: "Good Friday", national: false, regions: ["US-CT", "US-NC", "US-TX"] },
    ]);
    expect(holidayLine(list[0])).toBe("Thu 12 Feb: Lincoln's Birthday, regional observance (US-CA)");
    expect(holidayLine(list[1])).toBe("Fri 3 Apr: Good Friday, regional holiday (US-CT, US-NC, US-TX)");
  });

  it("returns [] for bad input, unknown countries and outages", async () => {
    const { calls } = mockFetch(() => jsonResponse({ type: "https://tools.ietf.org/html/rfc9110#section-15.5.5", status: 404 }, 404));
    await expect(upcomingHolidays("XX", "2026-10-20")).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    await expect(upcomingHolidays("Spain", "2026-10-20")).resolves.toEqual([]);
    await expect(upcomingHolidays("ES", "20/10/2026")).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    mockFetch(() => jsonResponse(null, 204));
    await expect(upcomingHolidays("ES", "2026-10-20")).resolves.toEqual([]);
  });

  it("accepts a full ISO timestamp as the start", async () => {
    mockFetch(() => jsonResponse(es2026));
    const list = await upcomingHolidays("ES", "2026-10-31T22:00:00Z", 2);
    expect(list.map((x) => x.date)).toEqual(["2026-11-01"]);
  });
});

describe("holidayLine", () => {
  it("matches the canonical format exactly", () => {
    expect(holidayLine({ date: "2026-11-01", name: "All Saints' Day", local_name: "Todos los Santos", national: true })).toBe(
      "Sun 1 Nov: All Saints' Day (Todos los Santos), national holiday",
    );
    expect(holidayLine({ date: "2026-11-09", name: "Our Lady of Almudena", local_name: "Nuestra Señora de la Almudena", national: false, regions: ["ES-MD"] })).toBe(
      "Mon 9 Nov: Our Lady of Almudena (Nuestra Señora de la Almudena), regional holiday (ES-MD)",
    );
    expect(holidayLine({ date: "2026-12-25", name: "Christmas Day", local_name: "Christmas Day", national: true })).toBe(
      "Fri 25 Dec: Christmas Day, national holiday",
    );
  });
});
