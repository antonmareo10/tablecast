import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forecastLine, weatherCondition, weekForecast, type DayForecast } from "../../src/lib/sources/weather";
import { dayLabel } from "../../src/lib/sources/format";
import { jsonResponse, mockFetch, params, silenceWarnings } from "./helpers";

beforeEach(() => {
  silenceWarnings();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const daily = {
  time: ["2025-10-23", "2025-10-24", "2025-10-25"],
  weather_code: [63, 2, null],
  temperature_2m_max: [14.4, 19.6, null],
  temperature_2m_min: [8.6, 10.2, null],
  precipitation_sum: [6.24, 0, null],
  precipitation_probability_max: [80, null, null],
};

describe("weekForecast", () => {
  it("builds the Open-Meteo request", async () => {
    const { calls } = mockFetch(() => jsonResponse({ daily }));
    await weekForecast(40.4168, -3.7038);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(params(calls[0].url)).toEqual({
      latitude: "40.4168",
      longitude: "-3.7038",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "7",
    });
  });

  it("passes days and timezone through (clamped to 16)", async () => {
    const { calls } = mockFetch(() => jsonResponse({ daily }));
    await weekForecast(1, 2, { days: 30, timezone: "Europe/Rome" });
    expect(params(calls[0].url)).toMatchObject({ forecast_days: "16", timezone: "Europe/Rome" });
  });

  it("parses days, maps WMO codes, and skips days padded with nulls", async () => {
    mockFetch(() => jsonResponse({ daily }));
    const days = await weekForecast(40.4, -3.7);
    expect(days).toEqual<DayForecast[]>([
      { date: "2025-10-23", weekday: "Thu", tmax: 14.4, tmin: 8.6, precip_mm: 6.24, precip_prob: 80, weather_code: 63, condition: "rain" },
      { date: "2025-10-24", weekday: "Fri", tmax: 19.6, tmin: 10.2, precip_mm: 0, precip_prob: null, weather_code: 2, condition: "partly cloudy" },
    ]);
  });

  it("returns [] when the API fails or has no daily block", async () => {
    mockFetch(() => jsonResponse("down", 500));
    await expect(weekForecast(40.4, -3.7)).resolves.toEqual([]);
    mockFetch(() => jsonResponse({}));
    await expect(weekForecast(40.4, -3.7)).resolves.toEqual([]);
  });

  it("returns [] for invalid coordinates without calling the API", async () => {
    const { calls } = mockFetch(() => jsonResponse({ daily }));
    await expect(weekForecast(NaN, 0)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("forecastLine", () => {
  const base: DayForecast = { date: "2025-10-23", weekday: "Thu", tmax: 14.4, tmin: 8.6, precip_mm: 6.24, precip_prob: 80, weather_code: 63, condition: "rain" };

  it("matches the canonical format exactly", () => {
    expect(forecastLine(base)).toBe("Thu 23 Oct: rain, max 14°C / min 9°C, 6.2 mm, 80% chance of rain");
  });

  it("omits the chance when unknown and never prints -0", () => {
    expect(forecastLine({ ...base, date: "2026-01-05", tmax: 2.2, tmin: -0.4, precip_mm: 0, precip_prob: null, condition: "clear" })).toBe(
      "Mon 5 Jan: clear, max 2°C / min 0°C, 0.0 mm",
    );
  });

  it("handles sub-zero temperatures", () => {
    expect(forecastLine({ ...base, date: "2026-02-01", tmax: -1.6, tmin: -7.5, precip_mm: 12.05, precip_prob: 95, condition: "heavy snow" })).toBe(
      "Sun 1 Feb: heavy snow, max -2°C / min -7°C, 12.1 mm, 95% chance of rain",
    );
  });
});

describe("weatherCondition / dayLabel", () => {
  it("maps WMO codes to short English conditions", () => {
    expect([0, 2, 3, 45, 53, 61, 63, 65, 73, 81, 95, 99].map(weatherCondition)).toEqual([
      "clear", "partly cloudy", "overcast", "fog", "drizzle", "light rain", "rain", "heavy rain", "snow", "showers", "thunderstorm", "thunderstorm with hail",
    ]);
    expect(weatherCondition(42)).toBe("weather code 42");
  });

  it("formats dates without locale or timezone dependence", () => {
    expect(dayLabel("2026-10-20")).toBe("Tue 20 Oct");
    expect(dayLabel("2026-11-01")).toBe("Sun 1 Nov");
    expect(dayLabel("2028-02-29")).toBe("Tue 29 Feb");
    expect(dayLabel("2026-02-30")).toBe("2026-02-30");
  });
});
