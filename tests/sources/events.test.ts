import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventLine, eventsNear, type NearbyEvent } from "../../src/lib/sources/events";
import { SourceError } from "../../src/lib/sources/http";
import { jsonResponse, mockFetch, params, silenceWarnings } from "./helpers";

let warn: ReturnType<typeof silenceWarnings>;
beforeEach(() => {
  warn = silenceWarnings();
  vi.stubEnv("TICKETMASTER_API_KEY", "tm-secret-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ev = (id: string, name: string, localDate: string, localTime: string | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  url: `https://www.ticketmaster.es/event/${id}`,
  distance: 2.08,
  dates: { start: { localDate, ...(localTime ? { localTime } : { noSpecificTime: true }) }, status: { code: "onsale" } },
  classifications: [{ primary: true, segment: { name: "Music" }, genre: { name: "Rock" } }],
  _embedded: { venues: [{ name: "Estadio Metropolitano" }] },
  ...extra,
});

describe("eventsNear", () => {
  it("returns null (and makes no call) without an API key", async () => {
    vi.stubEnv("TICKETMASTER_API_KEY", "");
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(eventsNear(40.4, -3.7)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("builds the Discovery API request for the next 7 days within 5 km", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T08:30:15.123Z"));
    const { calls } = mockFetch(() => jsonResponse({ page: { totalElements: 0 } }));
    await expect(eventsNear(40.41689, -3.70348)).resolves.toEqual([]);
    expect(calls[0].url.startsWith("https://app.ticketmaster.com/discovery/v2/events.json?")).toBe(true);
    expect(params(calls[0].url)).toEqual({
      apikey: "tm-secret-key",
      latlong: "40.41689,-3.70348",
      radius: "5",
      unit: "km",
      startDateTime: "2026-10-20T08:30:15Z",
      endDateTime: "2026-10-27T08:30:15Z",
      sort: "date,asc",
      size: "100",
      locale: "*",
    });
  });

  it("maps, filters, de-duplicates and sorts events", async () => {
    mockFetch(() =>
      jsonResponse({
        _embedded: {
          events: [
            ev("b", "Coldplay", "2025-10-24", "21:00:00"),
            ev("a", "Rosalía", "2025-10-23", undefined, {
              distance: 0.44,
              classifications: [{ primary: true, segment: { name: "Music" }, genre: { name: "Undefined" } }],
              _embedded: { venues: [{ name: "WiZink Center" }] },
            }),
            ev("b2", "COLDPLAY", "2025-10-24", "21:00:00"), // same name + date
            ev("p", "Parking Pass - Coldplay", "2025-10-24", "18:00:00"),
            ev("x", "Cancelled Show", "2025-10-25", "20:00:00", { dates: { start: { localDate: "2025-10-25", localTime: "20:00:00" }, status: { code: "cancelled" } } }),
            ev("c", "Real Madrid vs Barcelona", "2025-10-24", "16:15:00", {
              distance: 4.96,
              classifications: [{ primary: true, segment: { name: "Sports" }, genre: { name: "Soccer" } }],
              _embedded: { venues: [{ name: "Estadio Santiago Bernabéu" }] },
            }),
          ],
        },
      }),
    );
    const list = await eventsNear(40.4, -3.7);
    expect(list).toEqual<NearbyEvent[]>([
      { id: "a", name: "Rosalía", venue: "WiZink Center", date: "2025-10-23", distance_km: 0.4, url: "https://www.ticketmaster.es/event/a", segment: "Music" },
      {
        id: "c",
        name: "Real Madrid vs Barcelona",
        venue: "Estadio Santiago Bernabéu",
        date: "2025-10-24",
        time: "16:15",
        distance_km: 5,
        url: "https://www.ticketmaster.es/event/c",
        segment: "Sports",
        genre: "Soccer",
      },
      {
        id: "b",
        name: "Coldplay",
        venue: "Estadio Metropolitano",
        date: "2025-10-24",
        time: "21:00",
        distance_km: 2.1,
        url: "https://www.ticketmaster.es/event/b",
        segment: "Music",
        genre: "Rock",
      },
    ]);
    expect(list!.map(eventLine)).toEqual([
      "Thu 23 Oct — Rosalía at WiZink Center, 0.4 km away (Music)",
      "Fri 24 Oct 16:15 — Real Madrid vs Barcelona at Estadio Santiago Bernabéu, 5.0 km away (Sports · Soccer)",
      "Fri 24 Oct 21:00 — Coldplay at Estadio Metropolitano, 2.1 km away (Music · Rock)",
    ]);
  });

  it("keeps only the week's dates when given the local date (the listing can return season passes)", async () => {
    mockFetch(() =>
      jsonResponse({
        _embedded: {
          events: [
            ev("s", "Abono viernes Orquesta Sinfónica Nacional", "2026-09-25", "20:00:00"),
            ev("m", "Row C Start", "2026-05-25", "19:30:00"),
            ev("w", "Jesse & Joy", "2026-10-21", "20:30:00"),
            ev("l", "Last night of the week", "2026-10-27", "21:00:00"),
            ev("n", "Next week", "2026-10-28", "21:00:00"),
          ],
        },
      }),
    );
    const list = await eventsNear(19.42, -99.17, { from: "2026-10-21", days: 7 });
    expect(list!.map((e) => e.id)).toEqual(["w", "l"]);
  });

  it("caps the list at 25 (or the requested size)", async () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(`e${i}`, `Show ${i}`, "2025-10-24", `${String(10 + (i % 12)).padStart(2, "0")}:00:00`));
    mockFetch(() => jsonResponse({ _embedded: { events } }));
    await expect(eventsNear(40.4, -3.7)).resolves.toHaveLength(25);
    await expect(eventsNear(40.4, -3.7, { size: 3 })).resolves.toHaveLength(3);
  });

  it("returns [] when nothing is on and null when the listing fails", async () => {
    mockFetch(() => jsonResponse({ page: { totalElements: 0 } }));
    await expect(eventsNear(40.4, -3.7)).resolves.toEqual([]);
    mockFetch(() => jsonResponse({ fault: "oops" }, 500));
    await expect(eventsNear(40.4, -3.7)).resolves.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tm-secret-key");
  });

  it("throws CONFIG when the key is rejected", async () => {
    mockFetch(() => jsonResponse({ fault: { faultstring: "Invalid ApiKey" } }, 401));
    const err = await eventsNear(40.4, -3.7).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.code).toBe("CONFIG");
    expect(err.message).not.toContain("tm-secret-key");
  });
});

describe("eventLine", () => {
  it("matches the canonical format exactly", () => {
    expect(
      eventLine({ id: "1", name: "Coldplay", venue: "Estadio Metropolitano", date: "2025-10-24", time: "21:00", distance_km: 2.1, segment: "Music", genre: "Rock" }),
    ).toBe("Fri 24 Oct 21:00 — Coldplay at Estadio Metropolitano, 2.1 km away (Music · Rock)");
    expect(eventLine({ id: "2", name: "Mystery gig", venue: "", date: "2025-10-24" })).toBe("Fri 24 Oct — Mystery gig");
  });
});
