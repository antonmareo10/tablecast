// Locale-free date and text helpers shared by the canonical-line builders. Everything works on plain
// "YYYY-MM-DD" calendar dates via UTC arithmetic, so output never depends on the server's timezone or ICU.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parses the calendar-date prefix of an ISO string ("2026-10-23" or "2026-10-23T21:00:00Z"). */
export function parseIsoDate(iso: string): Date | null {
  const m = ISO_DATE.exec(iso ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Rejects 2026-02-31 and friends instead of silently rolling over.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string | null {
  const d = parseIsoDate(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Three-letter English weekday for an ISO date, e.g. "Thu". */
export function weekdayOf(iso: string): string {
  const d = parseIsoDate(iso);
  return d ? WEEKDAYS[d.getUTCDay()] : "";
}

/** "Thu 23 Oct" for "2026-10-23"; the raw input if it is not a valid date. */
export function dayLabel(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d) return iso;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Collapses whitespace so names from crowd-sourced data render on one clean line. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Lowercase, accent-free, punctuation-free form used for matching and de-duplication. */
export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Code-unit string comparison: stable across machines, unlike localeCompare (ICU / locale dependent). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Integer rounding without "-0". */
export function roundInt(n: number): number {
  const r = Math.round(n);
  return r === 0 ? 0 : r;
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
