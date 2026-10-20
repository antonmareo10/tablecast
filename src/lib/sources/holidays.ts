// Public holidays from Nager.Date (free, keyless, https://date.nager.at).

import { fetchJson, warnSource } from "./http";
import { addDaysIso, cleanText, compareText, dayLabel, parseIsoDate, toIsoDate } from "./format";

export type Holiday = {
  date: string;
  name: string;
  local_name: string;
  national: boolean;
  /** ISO 3166-2 subdivisions (e.g. "ES-MD") when the holiday is regional. */
  regions?: string[];
  /** True when no listed type is "Public" (bank / school / optional / observance days): not a general day off. */
  observance?: boolean;
};

type NagerHoliday = {
  date?: string;
  localName?: string;
  name?: string;
  global?: boolean;
  counties?: string[] | null;
  types?: string[] | null;
};

const NAGER = "https://date.nager.at/api/v3/PublicHolidays";

async function holidaysForYear(year: number, cc: string): Promise<NagerHoliday[]> {
  try {
    const data = await fetchJson<NagerHoliday[] | null>(`${NAGER}/${year}/${cc}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    warnSource("holidays", err); // 404 = country not covered by Nager.Date
    return [];
  }
}

/**
 * Holidays in [fromIso, fromIso + days) for an ISO 3166-1 alpha-2 country, national and regional,
 * sorted by date. Windows crossing New Year fetch both years. [] when unknown country or unavailable.
 */
export async function upcomingHolidays(countryCode: string, fromIso: string, days = 14): Promise<Holiday[]> {
  const cc = cleanText(countryCode).toUpperCase();
  const start = parseIsoDate(fromIso);
  if (!/^[A-Z]{2}$/.test(cc) || !start) return [];
  const span = Math.max(1, Math.min(366, Math.round(days)));
  const from = toIsoDate(start);
  const endExclusive = addDaysIso(from, span) as string;
  const lastDay = addDaysIso(from, span - 1) as string;
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(lastDay.slice(0, 4)); y++) years.push(y);

  const raw = (await Promise.all(years.map((y) => holidaysForYear(y, cc)))).flat();
  const merged = new Map<string, Holiday>();
  for (const h of raw) {
    const date = h.date?.slice(0, 10);
    const name = cleanText(h.name);
    if (!date || !name || !parseIsoDate(date) || date < from || date >= endExclusive) continue;
    const national = h.global === true;
    const regions = national ? [] : (h.counties ?? []).filter((c): c is string => typeof c === "string");
    const observance = !(h.types ?? ["Public"]).includes("Public");
    const key = `${date}|${name}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, {
        date,
        name,
        local_name: cleanText(h.localName) || name,
        national,
        ...(regions.length ? { regions } : {}),
        ...(observance ? { observance: true } : {}),
      });
      continue;
    }
    // Nager lists some days twice (e.g. once per group of regions): merge them.
    prev.national = prev.national || national;
    if (prev.national) delete prev.regions;
    else if (regions.length) prev.regions = [...new Set([...(prev.regions ?? []), ...regions])];
    if (!observance) delete prev.observance;
  }
  for (const h of merged.values()) if (h.regions) h.regions.sort(compareText);
  return [...merged.values()].sort(
    (a, b) => compareText(a.date, b.date) || Number(b.national) - Number(a.national) || compareText(a.name, b.name),
  );
}

/**
 * Canonical line, e.g. "Sun 1 Nov: All Saints' Day (Todos los Santos), national holiday" or
 * "Mon 9 Nov: Our Lady of Almudena (Nuestra Señora de la Almudena), regional holiday (ES-MD)".
 */
export function holidayLine(h: Holiday): string {
  const local = h.local_name && h.local_name !== h.name ? ` (${h.local_name})` : "";
  const what = h.observance ? "observance" : "holiday";
  const scope = h.national
    ? `national ${what}`
    : `regional ${what}${h.regions?.length ? ` (${h.regions.join(", ")})` : ""}`;
  return `${dayLabel(h.date)}: ${h.name}${local}, ${scope}`;
}
