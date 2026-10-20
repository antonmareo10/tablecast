// Food & drink competition around the restaurant, from OpenStreetMap.
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
//
// Primary: the Overpass API (complete list + counts). Public Overpass instances are often saturated
// (502 "at capacity" or connections that hang for a minute), so:
//   • the query is a cheap bbox query with a small declared maxsize (better admission on busy servers),
//     filtered to the radius client-side;
//   • it is hedged across mirrors (next mirror after a few seconds or on fast failure; first answer wins);
//   • the whole call is capped at ~12 s;
//   • if Overpass fails, or is silent after 3 s, a fallback runs bounded Nominatim searches (one per kind,
//     ≤ 40 results each, 1 req/s). Whichever source produces data first wins. Nominatim's 40-result cap
//     means its counts can be lower bounds: the summary then says complete=false and blockLine says so.

import { fetchJson, SourceError, warnSource } from "./http";
import { cleanText, compareText, haversineM, isValidLatLon, normalizeKey } from "./format";
import { NOMINATIM_SEARCH, nominatimSlot } from "./nominatim";

export type Venue = {
  /** "node/123" or "way/456" — unique across OSM element types. */
  osm_id: string;
  name: string;
  /** "restaurant" | "cafe" | "bar" | "pub" | "fast food" */
  kind: string;
  cuisine: string[];
  lat: number;
  lon: number;
  distance_m: number;
  website?: string;
  opening_hours?: string;
};

export type VenueSummary = {
  /** Nearest first, at most 40. */
  venues: Venue[];
  /** All named venues found within the radius (not just the 40 returned). A lower bound when !complete. */
  total: number;
  /** `at_least` marks kinds whose count is a lower bound (a Nominatim query for them hit its cap). */
  by_kind: { kind: string; count: number; at_least?: boolean }[];
  /** Top 15 cuisines over all venues. */
  by_cuisine: { cuisine: string; count: number }[];
  radius_m: number;
  source: "overpass" | "nominatim";
  /** False when the list is known to be truncated (Nominatim cap hit, or a fallback query failed / ran out of time). */
  complete: boolean;
};

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const QUERY_TIMEOUT_S = 15;
const QUERY_MAXSIZE_BYTES = 64 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 28_000;
const HEDGE_AFTER_MS = 2_500;
const BUDGET_MS = 12_000;
const FALLBACK_AFTER_MS = 3_000;
const NOMINATIM_LIMIT = 40;
/** Do not start another Nominatim query with less time than this left (slot wait ≤ 1 s + request). */
const NOMINATIM_MIN_WINDOW_MS = 1_200;
const MAX_VENUES = 40;
const MAX_CUISINES = 15;
const AMENITIES = ["restaurant", "cafe", "bar", "pub", "fast_food"];
const NOMINATIM_QUERIES = ["restaurant", "bar", "cafe", "pub", "fast_food"];
const KIND_LABEL: Record<string, string> = { fast_food: "fast food" };
const KIND_PLURAL: Record<string, [string, string]> = {
  restaurant: ["restaurant", "restaurants"],
  cafe: ["cafe", "cafes"],
  bar: ["bar", "bars"],
  pub: ["pub", "pubs"],
  "fast food": ["fast-food place", "fast-food places"],
};
const kindLabel = (amenity: string) => KIND_LABEL[amenity] ?? amenity;

type OsmElement = {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};
type OverpassResponse = { elements?: OsmElement[]; remark?: string };

export type OverpassOptions = {
  endpoints?: string[];
  /** Start the next mirror if the current one has not answered after this long. */
  hedgeMs?: number;
  /** Per-instance timeout. */
  timeoutMs?: number;
  /** Give up on all instances after this long. */
  budgetMs?: number;
  signal?: AbortSignal;
};

export type NearbyVenuesOptions = {
  /** Hard cap on the whole call. Default 12 s. */
  budgetMs?: number;
  /** Start the Nominatim fallback if Overpass is still silent after this long. Default 3 s. */
  fallbackAfterMs?: number;
  /** Set false to disable the Nominatim fallback. */
  nominatim?: boolean;
  overpass?: Omit<OverpassOptions, "budgetMs" | "signal">;
  /**
   * Wait for Overpass (complete) until the budget runs out and use the Nominatim fallback (partial) only if
   * Overpass fails. Default false: whichever answers first wins.
   */
  preferComplete?: boolean;
};

// ---------------------------------------------------------------------------------------------------------
// Overpass

/** Runs an Overpass QL query, hedged across mirrors. Null when every instance failed or the budget ran out. */
export function overpassQuery(query: string, opts: OverpassOptions = {}): Promise<OverpassResponse | null> {
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const hedgeMs = opts.hedgeMs ?? HEDGE_AFTER_MS;
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const deadline = opts.budgetMs != null ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const body = new URLSearchParams({ data: query }).toString();
  const controller = new AbortController();

  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(null);
    const finish = (value: OverpassResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(budgetTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      resolve(value);
    };
    const launch = () => {
      clearTimeout(hedgeTimer);
      if (settled) return;
      const remaining = deadline - Date.now();
      if (next >= endpoints.length || remaining < 200) {
        if (running === 0) finish(null);
        return;
      }
      const url = endpoints[next++];
      running++;
      if (next < endpoints.length) hedgeTimer = setTimeout(launch, hedgeMs);
      fetchJson<OverpassResponse | null>(
        url,
        { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } },
        { timeoutMs: Math.min(timeoutMs, remaining), retries: 0, signal: controller.signal },
      )
        .then((json) => {
          if (!json || !Array.isArray(json.elements)) throw new SourceError("UPSTREAM", `${url} returned no elements array`, { url });
          // A runtime error (timeout / memory) comes back as HTTP 200 with partial data and a remark.
          if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
            throw new SourceError("UPSTREAM", `${url}: ${json.remark.slice(0, 160)}`, { url });
          }
          running--;
          finish(json);
        })
        .catch((err: unknown) => {
          running--;
          if (settled) return;
          warnSource("places/overpass", err);
          launch();
        });
    };
    if (opts.signal?.aborted) return finish(null);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (Number.isFinite(deadline)) budgetTimer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    launch();
  });
}

function boundingBox(lat: number, lon: number, radiusM: number) {
  const dLat = radiusM / 111_195;
  const dLon = radiusM / (111_195 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

/** Overpass QL for named food & drink nodes and ways in the radius's bounding square (filtered to the circle client-side). */
export function buildVenueQuery(lat: number, lon: number, radiusM: number): string {
  const b = boundingBox(lat, lon, radiusM);
  const bbox = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
  const filter = `["amenity"~"^(${AMENITIES.join("|")})$"]["name"]`;
  return `[out:json][timeout:${QUERY_TIMEOUT_S}][maxsize:${QUERY_MAXSIZE_BYTES}];(node${filter}${bbox};way${filter}${bbox};);out center tags qt;`;
}

// ---------------------------------------------------------------------------------------------------------
// Shared summarising

function splitCuisine(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v.split(";")) {
    const c = cleanText(raw.replace(/_/g, " ")).toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function makeVenue(
  osmId: string,
  tags: Record<string, string | undefined>,
  amenity: string,
  lat: unknown,
  lon: unknown,
  origin: { lat: number; lon: number },
): Venue | null {
  const name = cleanText(tags.name);
  if (!name || !AMENITIES.includes(amenity)) return null;
  if (typeof lat !== "number" || typeof lon !== "number" || !isValidLatLon(lat, lon)) return null;
  const website = tags.website ?? tags["contact:website"];
  return {
    osm_id: osmId,
    name,
    kind: kindLabel(amenity),
    cuisine: splitCuisine(tags.cuisine),
    lat,
    lon,
    distance_m: Math.round(haversineM(origin, { lat, lon })),
    ...(website ? { website } : {}),
    ...(tags.opening_hours ? { opening_hours: cleanText(tags.opening_hours) } : {}),
  };
}

/** Most frequent first, ties alphabetical. */
const byCount = (counts: Map<string, number>): [string, number][] =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));

function buildSummary(
  found: Venue[],
  radiusM: number,
  source: VenueSummary["source"],
  complete: boolean,
  cappedKinds: Set<string> = new Set(),
): VenueSummary {
  const sorted = found
    .filter((v) => v.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m || compareText(a.name, b.name) || compareText(a.osm_id, b.osm_id));

  // The same place is sometimes mapped twice (a node and the building way): same name + kind within 50 m.
  const venues: Venue[] = [];
  for (const v of sorted) {
    const key = normalizeKey(v.name);
    if (venues.some((u) => u.osm_id === v.osm_id || (u.kind === v.kind && normalizeKey(u.name) === key && haversineM(u, v) <= 50))) continue;
    venues.push(v);
  }

  const kinds = new Map<string, number>();
  const cuisines = new Map<string, number>();
  for (const v of venues) {
    kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
    for (const c of v.cuisine) cuisines.set(c, (cuisines.get(c) ?? 0) + 1);
  }
  return {
    venues: venues.slice(0, MAX_VENUES),
    total: venues.length,
    by_kind: byCount(kinds).map(([kind, count]) => ({ kind, count, ...(cappedKinds.has(kind) ? { at_least: true } : {}) })),
    by_cuisine: byCount(cuisines).slice(0, MAX_CUISINES).map(([cuisine, count]) => ({ cuisine, count })),
    radius_m: Math.round(radiusM),
    source,
    complete,
  };
}

/** Summarises the elements of an Overpass answer (exported for tests and offline fixtures). */
export function summarizeVenues(elements: OsmElement[], origin: { lat: number; lon: number }, radiusM: number): VenueSummary {
  const found: Venue[] = [];
  for (const el of elements) {
    if (!el.type || el.id == null) continue;
    const v = makeVenue(`${el.type}/${el.id}`, el.tags ?? {}, el.tags?.amenity ?? "", el.lat ?? el.center?.lat, el.lon ?? el.center?.lon, origin);
    if (v) found.push(v);
  }
  return buildSummary(found, radiusM, "overpass", true);
}

// ---------------------------------------------------------------------------------------------------------
// Nominatim fallback

type NominatimPoi = {
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  name?: string;
  extratags?: Record<string, string> | null;
};

/** Resolves `{ ok: false }` instead of waiting past the deadline. */
async function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<{ ok: true; value: T } | { ok: false }> {
  const ms = deadline - Date.now();
  if (ms <= 0) return { ok: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ ok: true as const, value })), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** One bounded Nominatim search per kind inside the radius square. Null if no query got an answer. */
async function nominatimVenues(
  origin: { lat: number; lon: number },
  radiusM: number,
  deadline: number,
  signal: AbortSignal,
): Promise<VenueSummary | null> {
  const b = boundingBox(origin.lat, origin.lon, radiusM);
  const viewbox = [b.west, b.north, b.east, b.south].map((x) => x.toFixed(6)).join(",");
  const byId = new Map<string, Venue>();
  const capped = new Set<string>();
  let complete = true;
  let answered = 0;

  for (const q of NOMINATIM_QUERIES) {
    if (signal.aborted) return null;
    if (deadline - Date.now() < NOMINATIM_MIN_WINDOW_MS) {
      complete = false;
      break;
    }
    const slot = await beforeDeadline(nominatimSlot(), deadline - 400);
    if (signal.aborted) return null;
    if (!slot.ok) {
      complete = false;
      break;
    }
    const url = new URL(NOMINATIM_SEARCH);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("limit", String(NOMINATIM_LIMIT));
    url.searchParams.set("extratags", "1");
    let hits: NominatimPoi[] | null;
    try {
      const timeoutMs = Math.max(200, Math.min(5_000, deadline - Date.now() - 150));
      hits = await fetchJson<NominatimPoi[] | null>(url, {}, { timeoutMs, retries: 0, signal });
    } catch (err) {
      if (signal.aborted) return null;
      warnSource("places/nominatim", err);
      complete = false;
      continue;
    }
    answered++;
    const list = Array.isArray(hits) ? hits : [];
    const kindsSeen = new Set([kindLabel(q)]);
    for (const h of list) {
      if (h.category !== "amenity" || !AMENITIES.includes(h.type ?? "") || !h.osm_type || h.osm_id == null) continue;
      kindsSeen.add(kindLabel(h.type as string));
      const tags = { ...(h.extratags ?? {}), name: h.name };
      const v = makeVenue(`${h.osm_type}/${h.osm_id}`, tags, h.type as string, Number(h.lat), Number(h.lon), origin);
      if (v && !byId.has(v.osm_id)) byId.set(v.osm_id, v);
    }
    // A full page means there may be more of these kinds in the box: their counts become lower bounds.
    if (list.length >= NOMINATIM_LIMIT) {
      complete = false;
      for (const k of kindsSeen) capped.add(k);
    }
  }
  if (!answered) return null;
  return buildSummary([...byId.values()], radiusM, "nominatim", complete, capped);
}

/** First promise to resolve non-null wins; null when all resolve null (rejections count as null). */
function firstNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = promises.length;
    const done = () => {
      if (--pending === 0) resolve(null);
    };
    for (const p of promises) p.then((v) => (v !== null ? resolve(v) : done()), done);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Public API

/**
 * Named restaurants, cafes, bars, pubs and fast-food places within `radiusM` (default 600, clamped 50–1500).
 * Takes at most ~12 s. Overpass first (complete); Nominatim fallback (possibly partial, see `complete`).
 * Null only when both sources are unreachable; an empty summary when nothing is mapped nearby.
 */
export async function nearbyVenues(lat: number, lon: number, radiusM = 600, opts: NearbyVenuesOptions = {}): Promise<VenueSummary | null> {
  if (!isValidLatLon(lat, lon)) return null;
  const radius = Math.max(50, Math.min(1_500, Number.isFinite(radiusM) ? radiusM : 600));
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const origin = { lat, lon };
  const controller = new AbortController();
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const overpass = overpassQuery(buildVenueQuery(lat, lon, radius), { ...opts.overpass, budgetMs, signal: controller.signal }).then((res) =>
    res ? summarizeVenues(res.elements ?? [], origin, radius) : null,
  );
  const sources: Promise<VenueSummary | null>[] = [overpass];
  if (opts.nominatim !== false) {
    // Start the fallback when Overpass fails, or is still silent after fallbackAfterMs — whichever is first.
    const trigger = new Promise<boolean>((resolve) => {
      fallbackTimer = setTimeout(() => resolve(true), opts.fallbackAfterMs ?? FALLBACK_AFTER_MS);
      void overpass.then((summary) => resolve(summary === null));
    });
    sources.push(trigger.then((go) => (go && !controller.signal.aborted ? nominatimVenues(origin, radius, deadline, controller.signal) : null)));
  }
  try {
    if (opts.preferComplete) {
      const complete = await overpass;
      if (complete) return complete;
      return (await sources[1]) ?? null;
    }
    return await firstNonNull(sources);
  } finally {
    clearTimeout(fallbackTimer);
    controller.abort();
  }
}

/** Canonical line, e.g. "Trattoria Sora Lella — restaurant, italian, 240 m away". */
export function venueLine(v: Venue): string {
  return [`${v.name} — ${v.kind}`, ...v.cuisine.slice(0, 3), `${v.distance_m} m away`].join(", ");
}

function kindCount(kind: string, count: number, atLeast: boolean): string {
  const [one, many] = KIND_PLURAL[kind] ?? [kind, `${kind}s`];
  return atLeast ? `${count}+ ${many}` : `${count} ${count === 1 ? one : many}`;
}

/**
 * Canonical line for the whole block, e.g.
 * "Within 600 m: 87 food & drink venues — 41 restaurants, 22 bars, 15 cafes, 6 pubs, 3 fast-food places; top cuisines: spanish 12, italian 7, japanese 5"
 * or, from a capped Nominatim fallback,
 * "Within 600 m: at least 109 food & drink venues (OpenStreetMap via Nominatim; partial list) — 40+ restaurants, 40+ bars, 29 cafes; top cuisines: …".
 */
export function blockLine(
  summary: Pick<VenueSummary, "total" | "by_kind" | "by_cuisine"> & Partial<Pick<VenueSummary, "radius_m" | "source" | "complete">>,
): string {
  const where = summary.radius_m != null ? `Within ${summary.radius_m} m` : "Nearby";
  const partial = summary.complete === false;
  const notes = [summary.source === "nominatim" ? "OpenStreetMap via Nominatim" : "", partial ? "partial list" : ""].filter(Boolean);
  const note = notes.length ? ` (${notes.join("; ")})` : "";
  if (!summary.total) {
    return partial ? `${where}: no named food & drink venues found${note}` : `${where}: no named food & drink venues mapped in OpenStreetMap${note}`;
  }
  // The provenance note goes last, so the counts read as one quotable run of words.
  let line = `${where}: ${partial ? "at least " : ""}${summary.total} food & drink ${summary.total === 1 && !partial ? "venue" : "venues"}`;
  if (summary.by_kind.length) line += ` — ${summary.by_kind.map((k) => kindCount(k.kind, k.count, !!k.at_least)).join(", ")}`;
  const top = summary.by_cuisine.slice(0, 5);
  if (top.length) line += `; top cuisines: ${top.map((c) => `${c.cuisine} ${c.count}`).join(", ")}`;
  return line + note;
}
