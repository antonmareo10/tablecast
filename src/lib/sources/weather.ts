// 7-day forecast from Open-Meteo (free, keyless). Weather data by Open-Meteo.com, CC BY 4.0.

import { fetchJson, warnSource } from "./http";
import { dayLabel, isValidLatLon, roundInt, weekdayOf } from "./format";

export type DayForecast = {
  date: string;
  weekday: string;
  tmax: number;
  tmin: number;
  precip_mm: number;
  precip_prob: number | null;
  weather_code: number;
  condition: string;
};

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const DAILY_VARS = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max";

// WMO 4677 codes as used by Open-Meteo (https://open-meteo.com/en/docs, "WMO Weather interpretation codes").
const WMO_CONDITIONS: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "heavy showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with hail",
};

export function weatherCondition(code: number): string {
  return WMO_CONDITIONS[code] ?? `weather code ${code}`;
}

type DailyBlock = {
  time?: string[];
  weather_code?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  precipitation_sum?: (number | null)[];
  precipitation_probability_max?: (number | null)[];
};

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Daily forecast for the next `days` (default 7, max 16) in the location's own timezone. [] when unavailable. */
export async function weekForecast(lat: number, lon: number, opts: { days?: number; timezone?: string } = {}): Promise<DayForecast[]> {
  if (!isValidLatLon(lat, lon)) return [];
  const days = Math.max(1, Math.min(16, Math.round(opts.days ?? 7)));
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set("daily", DAILY_VARS);
  url.searchParams.set("timezone", opts.timezone || "auto");
  url.searchParams.set("forecast_days", String(days));

  let data: { daily?: DailyBlock } | null;
  try {
    data = await fetchJson<{ daily?: DailyBlock }>(url);
  } catch (err) {
    warnSource("weather", err);
    return [];
  }
  const d = data?.daily;
  if (!d?.time?.length) return [];
  const out: DayForecast[] = [];
  d.time.forEach((date, i) => {
    const code = d.weather_code?.[i];
    const tmax = d.temperature_2m_max?.[i];
    const tmin = d.temperature_2m_min?.[i];
    const precip = d.precipitation_sum?.[i];
    const prob = d.precipitation_probability_max?.[i];
    // Open-Meteo pads the far end of the range with nulls; a day without its core numbers is not a forecast.
    if (!num(code) || !num(tmax) || !num(tmin) || !num(precip) || !weekdayOf(date)) return;
    out.push({
      date,
      weekday: weekdayOf(date),
      tmax,
      tmin,
      precip_mm: precip,
      precip_prob: num(prob) ? prob : null,
      weather_code: code,
      condition: weatherCondition(code),
    });
  });
  return out;
}

/** Canonical line, e.g. "Thu 23 Oct: rain, max 14°C / min 9°C, 6.2 mm, 80% chance of rain". */
export function forecastLine(d: DayForecast): string {
  const parts = [
    `${dayLabel(d.date)}: ${d.condition}`,
    `max ${roundInt(d.tmax)}°C / min ${roundInt(d.tmin)}°C`,
    `${(Math.round(Math.max(0, d.precip_mm) * 10) / 10).toFixed(1)} mm`,
  ];
  if (d.precip_prob !== null) parts.push(`${roundInt(d.precip_prob)}% chance of rain`);
  return parts.join(", ");
}
