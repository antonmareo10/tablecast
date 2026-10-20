// Geocoding: cities via Open-Meteo (gives country code + IANA timezone), the restaurant itself via
// OpenStreetMap Nominatim (with Photon as fallback). Data © OpenStreetMap contributors, ODbL 1.0.
// Nominatim's usage policy allows at most 1 request/second per application: enforced process-wide in ./nominatim.

import { fetchJson, SourceError, warnSource } from "./http";
import { cleanText, isValidLatLon, normalizeKey } from "./format";
import { NOMINATIM_SEARCH, nominatimSlot } from "./nominatim";

export { _resetNominatimThrottle } from "./nominatim";

export type GeoPoint = {
  lat: number;
  lon: number;
  label: string;
  country_code?: string;
  timezone?: string;
  source: "open-meteo" | "nominatim" | "photon";
};

export type PlacePoint = GeoPoint & {
  /** The venue's OSM name (label is "name, city"). */
  name?: string;
  address?: string;
  osm_type?: string;
  osm_id?: string;
  website?: string;
  cuisine?: string[];
  phone?: string;
  opening_hours?: string;
};

const OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const PHOTON_SEARCH = "https://photon.komoot.io/api/";

// ---------------------------------------------------------------------------------------------------------
// City → point (Open-Meteo geocoding)

type OpenMeteoPlace = {
  name?: string;
  latitude?: number;
  longitude?: number;
  country_code?: string;
  country?: string;
  admin1?: string;
  timezone?: string;
};

/**
 * Resolves a city name. Accepts "Madrid", "Madrid, ES" or "Valencia, Venezuela": Open-Meteo matches place
 * names only, so text after the first comma is used as a country (ISO code or name) / region hint.
 */
export async function geocodeCity(city: string): Promise<GeoPoint | null> {
  const parts = cleanText(city).split(",").map((s) => s.trim()).filter(Boolean);
  const name = parts[0];
  if (!name) return null;
  const hint = parts.slice(1).join(" ");
  const isoHint = /^[A-Za-z]{2}$/.test(hint) ? hint.toUpperCase() : undefined;

  const url = new URL(OPEN_METEO_GEOCODE);
  url.searchParams.set("name", name);
  url.searchParams.set("count", hint && !isoHint ? "10" : "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  if (isoHint) url.searchParams.set("countryCode", isoHint);

  let data: { results?: OpenMeteoPlace[] } | null;
  try {
    data = await fetchJson<{ results?: OpenMeteoPlace[] }>(url);
  } catch (err) {
    warnSource("geo", err);
    return null;
  }
  const results = (data?.results ?? []).filter(
    (r) => typeof r.latitude === "number" && typeof r.longitude === "number" && isValidLatLon(r.latitude, r.longitude),
  );
  if (!results.length) return null;
  const h = normalizeKey(hint);
  const pick =
    (h && !isoHint
      ? results.find((r) => [r.country, r.admin1, r.country_code].some((x) => x && normalizeKey(x) === h))
      : undefined) ?? results[0];

  const label = [pick.name, pick.admin1 && pick.admin1 !== pick.name ? pick.admin1 : undefined, pick.country]
    .map((x) => cleanText(x))
    .filter(Boolean)
    .join(", ");
  return {
    lat: pick.latitude as number,
    lon: pick.longitude as number,
    label: label || name,
    ...(pick.country_code ? { country_code: pick.country_code.toUpperCase() } : {}),
    ...(pick.timezone ? { timezone: pick.timezone } : {}),
    source: "open-meteo",
  };
}

// ---------------------------------------------------------------------------------------------------------
// Restaurant → point (Nominatim, Photon fallback)

const FOOD_AMENITIES = new Set(["restaurant", "bar", "cafe", "pub", "fast_food"]);
// Generic words that say nothing about which venue is meant.
const NAME_STOPWORDS = new Set([
  "el", "la", "los", "las", "lo", "de", "del", "da", "do", "di", "du", "der", "die", "das", "le", "les", "il",
  "the", "a", "an", "and", "y", "e", "et", "restaurant", "restaurante", "ristorante", "restaurace", "bar",
  "cafe", "caffe", "taberna", "trattoria", "pizzeria", "bistro", "brasserie", "pub",
]);

function nameTokens(s: string): string[] {
  const all = normalizeKey(s).split(" ").filter((t) => t.length > 1);
  const meaningful = all.filter((t) => !NAME_STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** True when the candidate's name plausibly is the venue the user typed (accents, articles and one typo forgiven). */
export function nameMatches(query: string, candidate: string): boolean {
  const q = normalizeKey(query);
  const c = normalizeKey(candidate);
  if (!q || !c) return false;
  if (` ${c} `.includes(` ${q} `) || (c.length >= 4 && ` ${q} `.includes(` ${c} `))) return true;
  const qt = nameTokens(query);
  const ct = nameTokens(candidate);
  if (!qt.length || !ct.length) return false;
  const hits = qt.filter((t) => ct.some((x) => x === t || (t.length >= 4 && withinOneEdit(t, x)))).length;
  return hits / qt.length >= 0.6;
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v.split(";")) {
    const c = cleanText(raw.replace(/_/g, " ")).toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

type Candidate = { place: PlacePoint; name: string; food: boolean; cityMatch: boolean };

function pickCandidate(query: string, candidates: Candidate[], requireCityOrFood: boolean): PlacePoint | null {
  const exact = normalizeKey(query);
  let best: { c: Candidate; score: number } | undefined;
  for (const c of candidates) {
    if (!nameMatches(query, c.name)) continue;
    if (requireCityOrFood && !c.cityMatch && !c.food) continue;
    const score = (c.food ? 4 : 0) + (c.cityMatch ? 2 : 0) + (normalizeKey(c.name) === exact ? 1 : 0);
    if (!best || score > best.score) best = { c, score };
  }
  return best?.c.place ?? null;
}

type NominatimHit = {
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
};

function nominatimCity(a: Record<string, string> | undefined): string | undefined {
  return a?.city ?? a?.town ?? a?.village ?? a?.municipality ?? a?.county;
}

function formatAddress(a: Record<string, string> | undefined, fallback?: string): string | undefined {
  if (a) {
    const street = cleanText([a.road ?? a.pedestrian ?? a.square ?? a.footway, a.house_number].filter(Boolean).join(" "));
    const town = cleanText([a.postcode, nominatimCity(a)].filter(Boolean).join(" "));
    const line = [street, town].filter(Boolean).join(", ");
    if (line) return line;
  }
  return fallback ? cleanText(fallback) : undefined;
}

function fromNominatim(hit: NominatimHit, cityKey: string): Candidate | null {
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  const name = cleanText(hit.name);
  if (!name || !isValidLatLon(lat, lon)) return null;
  const tags = hit.extratags ?? {};
  const city = nominatimCity(hit.address);
  const cuisine = splitList(tags.cuisine);
  const website = tags.website ?? tags["contact:website"];
  const phone = tags.phone ?? tags["contact:phone"];
  const address = formatAddress(hit.address, hit.display_name);
  const place: PlacePoint = {
    lat,
    lon,
    label: [name, cleanText(city)].filter(Boolean).join(", "),
    name,
    ...(hit.address?.country_code ? { country_code: hit.address.country_code.toUpperCase() } : {}),
    source: "nominatim",
    ...(address ? { address } : {}),
    ...(hit.osm_type ? { osm_type: hit.osm_type } : {}),
    ...(hit.osm_id != null ? { osm_id: String(hit.osm_id) } : {}),
    ...(website ? { website } : {}),
    ...(cuisine.length ? { cuisine } : {}),
    ...(phone ? { phone } : {}),
    ...(tags.opening_hours ? { opening_hours: tags.opening_hours } : {}),
  };
  const haystack = normalizeKey([hit.display_name, ...Object.values(hit.address ?? {})].filter(Boolean).join(" "));
  return {
    place,
    name,
    food: hit.category === "amenity" && FOOD_AMENITIES.has(hit.type ?? ""),
    cityMatch: !!cityKey && ` ${haystack} `.includes(` ${cityKey} `),
  };
}

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | number | undefined>;
};

const PHOTON_OSM_TYPES: Record<string, string> = { N: "node", W: "way", R: "relation" };

function fromPhoton(f: PhotonFeature, cityKey: string): Candidate | null {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [NaN, NaN];
  const name = cleanText(p.name as string | undefined);
  if (!name || !isValidLatLon(lat, lon)) return null;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const city = str("city") ?? str("town") ?? str("village") ?? str("county");
  const street = cleanText([str("street"), str("housenumber")].filter(Boolean).join(" "));
  const town = cleanText([str("postcode"), city].filter(Boolean).join(" "));
  const address = [street, town].filter(Boolean).join(", ");
  const osmType = PHOTON_OSM_TYPES[str("osm_type") ?? ""];
  const place: PlacePoint = {
    lat,
    lon,
    label: [name, cleanText(city)].filter(Boolean).join(", "),
    name,
    ...(str("countrycode") ? { country_code: (str("countrycode") as string).toUpperCase() } : {}),
    source: "photon",
    ...(address ? { address } : {}),
    ...(osmType ? { osm_type: osmType } : {}),
    ...(p.osm_id != null ? { osm_id: String(p.osm_id) } : {}),
  };
  const haystack = normalizeKey(
    ["city", "town", "village", "locality", "district", "county", "state"].map(str).filter(Boolean).join(" "),
  );
  return {
    place,
    name,
    food: str("osm_key") === "amenity" && FOOD_AMENITIES.has(str("osm_value") ?? ""),
    cityMatch: !!cityKey && ` ${haystack} `.includes(` ${cityKey} `),
  };
}

/**
 * Finds a specific venue ("Casa Lucio", "Madrid"). Nominatim first (rich tags: website, cuisine, hours);
 * Photon when Nominatim fails or has nothing plausible. Null when no result's name matches the query.
 */
export async function geocodePlace(name: string, city: string): Promise<PlacePoint | null> {
  const venue = cleanText(name);
  const town = cleanText(city);
  if (!venue) return null;
  const q = town ? `${venue}, ${town}` : venue;
  const cityKey = normalizeKey(town.split(",")[0] ?? "");

  try {
    const url = new URL(NOMINATIM_SEARCH);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("extratags", "1");
    const hits = await fetchJson<NominatimHit[] | null>(url, {}, { beforeAttempt: nominatimSlot, backoffMs: 1_000 });
    const candidates = (Array.isArray(hits) ? hits : []).map((h) => fromNominatim(h, cityKey)).filter((c): c is Candidate => !!c);
    const picked = pickCandidate(venue, candidates, false);
    if (picked) return picked;
  } catch (err) {
    if (err instanceof SourceError && err.code === "CONFIG") throw err;
    warnSource("geo/nominatim", err);
  }

  try {
    const url = new URL(PHOTON_SEARCH);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "5");
    const fc = await fetchJson<{ features?: PhotonFeature[] } | null>(url);
    const candidates = (fc?.features ?? []).map((f) => fromPhoton(f, cityKey)).filter((c): c is Candidate => !!c);
    return pickCandidate(venue, candidates, true);
  } catch (err) {
    warnSource("geo/photon", err);
    return null;
  }
}

/** Canonical one-liner for the restaurant itself, e.g. "Casa Lucio — Calle de la Cava Baja 35, 28005 Madrid; cuisine: spanish; opening hours: Mo-Su 13:00-16:00". */
export function placeLine(p: PlacePoint): string {
  const name = p.name ?? p.label;
  const parts = [`${name} — ${p.address ?? p.label}`];
  if (p.cuisine?.length) parts.push(`cuisine: ${p.cuisine.join(", ")}`);
  if (p.opening_hours) parts.push(`opening hours: ${cleanText(p.opening_hours)}`);
  if (p.website) parts.push(`website: ${p.website}`);
  return parts.join("; ");
}
