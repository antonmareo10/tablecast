// Ticketed events near the restaurant this week (Ticketmaster Discovery API v2). Needs TICKETMASTER_API_KEY;
// without it the source is simply off (null). Quota on the free tier: 5 requests/s, 5,000/day.

import { fetchJson, SourceError, warnSource } from "./http";
import { addDaysIso, cleanText, compareText, dayLabel, isValidLatLon, normalizeKey, parseIsoDate } from "./format";

export type NearbyEvent = {
  id: string;
  name: string;
  venue: string;
  /** Local date at the venue, YYYY-MM-DD. */
  date: string;
  /** Local start time at the venue, HH:MM (absent when TBA). */
  time?: string;
  distance_km?: number;
  url?: string;
  segment?: string;
  genre?: string;
};

const TM_EVENTS = "https://app.ticketmaster.com/discovery/v2/events.json";
const MAX_EVENTS = 25;
// Listings that are not events people travel to: parking passes, hospitality upsells, test events.
const NOT_AN_EVENT =
  /\b(parking|car park|parqueo|aparcamiento|suites?|premium seating|season tickets?|membership|hospitality package|vip package|gift ?card|upsell)\b|^test\b|\btest event\b/i;

type TmEvent = {
  id?: string;
  name?: string;
  url?: string;
  distance?: number;
  dates?: {
    start?: { localDate?: string; localTime?: string; timeTBA?: boolean; noSpecificTime?: boolean; dateTBA?: boolean; dateTBD?: boolean };
    status?: { code?: string };
  };
  classifications?: Array<{ primary?: boolean; segment?: { name?: string }; genre?: { name?: string } }>;
  _embedded?: { venues?: Array<{ name?: string }> };
};

const tmIso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
const meaningful = (s: string | undefined) => {
  const c = cleanText(s);
  return c && !/^(undefined|other)$/i.test(c) ? c : undefined;
};

/**
 * Events within `radiusKm` (default 5) over the next `days` (default 7), date order, one entry per
 * name + date, at most `size` (default and max 25). With `from` (the place's local date, YYYY-MM-DD), events
 * dated outside [from, from + days) are dropped: the listing can return season passes and stray items
 * ("Sat 25 May", "Fri 25 Sep" in the held-out eval). Null when no API key is configured or the listing
 * is unavailable; [] when nothing is on. Throws SourceError CONFIG if the key is rejected.
 */
export async function eventsNear(
  lat: number,
  lon: number,
  opts: { days?: number; radiusKm?: number; size?: number; from?: string } = {},
): Promise<NearbyEvent[] | null> {
  const key = process.env.TICKETMASTER_API_KEY?.trim();
  if (!key) return null;
  if (!isValidLatLon(lat, lon)) return [];
  const days = Math.max(1, Math.min(60, opts.days ?? 7));
  const radiusKm = Math.max(1, Math.min(100, Math.round(opts.radiusKm ?? 5)));
  const size = Math.max(1, Math.min(MAX_EVENTS, Math.round(opts.size ?? MAX_EVENTS)));
  const now = new Date();
  const end = new Date(now.getTime() + days * 86_400_000);
  const window = opts.from && parseIsoDate(opts.from) ? { from: opts.from, to: addDaysIso(opts.from, days) as string } : null;

  const url = new URL(TM_EVENTS);
  url.searchParams.set("apikey", key);
  url.searchParams.set("latlong", `${lat.toFixed(5)},${lon.toFixed(5)}`);
  url.searchParams.set("radius", String(radiusKm));
  url.searchParams.set("unit", "km");
  url.searchParams.set("startDateTime", tmIso(now));
  url.searchParams.set("endDateTime", tmIso(end));
  url.searchParams.set("sort", "date,asc");
  url.searchParams.set("size", "100"); // headroom for de-duplication and filtering
  url.searchParams.set("locale", "*"); // default "en" hides many non-English-market events

  let data: { _embedded?: { events?: TmEvent[] } } | null;
  try {
    data = await fetchJson<{ _embedded?: { events?: TmEvent[] } }>(url);
  } catch (err) {
    if (err instanceof SourceError && (err.status === 401 || err.status === 403)) {
      throw new SourceError("CONFIG", "TICKETMASTER_API_KEY was rejected by Ticketmaster", { status: err.status, cause: err });
    }
    warnSource("events", err);
    return null;
  }

  const seen = new Set<string>();
  const events: NearbyEvent[] = [];
  for (const e of data?._embedded?.events ?? []) {
    const name = cleanText(e.name);
    const date = e.dates?.start?.localDate ?? "";
    const status = e.dates?.status?.code ?? "";
    if (!e.id || !name || !parseIsoDate(date) || NOT_AN_EVENT.test(name)) continue;
    if (window && (date < window.from || date >= window.to)) continue;
    if (/^(cancelled|canceled|postponed)$/i.test(status) || e.dates?.start?.dateTBA || e.dates?.start?.dateTBD) continue;
    const k = `${normalizeKey(name)}|${date}`;
    if (seen.has(k)) continue;
    seen.add(k);

    const start = e.dates?.start;
    const time = !start?.timeTBA && !start?.noSpecificTime && /^\d{2}:\d{2}/.test(start?.localTime ?? "") ? start!.localTime!.slice(0, 5) : undefined;
    const cls = e.classifications?.find((c) => c.primary) ?? e.classifications?.[0];
    const segment = meaningful(cls?.segment?.name);
    const genre = meaningful(cls?.genre?.name);
    events.push({
      id: e.id,
      name,
      venue: cleanText(e._embedded?.venues?.[0]?.name),
      date,
      ...(time ? { time } : {}),
      ...(typeof e.distance === "number" && Number.isFinite(e.distance) ? { distance_km: Math.round(e.distance * 10) / 10 } : {}),
      ...(e.url ? { url: e.url } : {}),
      ...(segment ? { segment } : {}),
      ...(genre && genre !== segment ? { genre } : {}),
    });
  }
  return events
    .sort(
      (a, b) =>
        compareText(a.date, b.date) ||
        compareText(a.time ?? "99:99", b.time ?? "99:99") ||
        (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity) ||
        compareText(a.name, b.name),
    )
    .slice(0, size);
}

/** Canonical line, e.g. "Fri 24 Oct 21:00 — Coldplay at Estadio Metropolitano, 2.1 km away (Music · Rock)". */
export function eventLine(e: NearbyEvent): string {
  let line = `${dayLabel(e.date)}${e.time ? ` ${e.time}` : ""} — ${e.name}`;
  if (e.venue) line += ` at ${e.venue}`;
  if (e.distance_km != null) line += `, ${e.distance_km.toFixed(1)} km away`;
  const tags = [e.segment, e.genre].filter(Boolean);
  if (tags.length) line += ` (${tags.join(" · ")})`;
  return line;
}
