// Open-data source clients for the weekly playbook. Each returns typed data plus a deterministic
// canonical text line per item; playbook quotes are checked verbatim against those lines.
//
// Attribution the UI must show when these sources are used:
//   "Map data © OpenStreetMap contributors (ODbL)" — link https://www.openstreetmap.org/copyright
//   "Weather data by Open-Meteo.com (CC BY 4.0)"   — link https://open-meteo.com/

export { fetchJson, SourceError, USER_AGENT, DEFAULT_TIMEOUT_MS, type SourceErrorCode, type FetchJsonOptions } from "./http";
export { geocodeCity, geocodePlace, placeLine, type GeoPoint, type PlacePoint } from "./geo";
export { weekForecast, forecastLine, weatherCondition, type DayForecast } from "./weather";
export { nearbyVenues, venueLine, blockLine, type Venue, type VenueSummary, type NearbyVenuesOptions } from "./places";
export { upcomingHolidays, holidayLine, type Holiday } from "./holidays";
export { eventsNear, eventLine, type NearbyEvent } from "./events";
export * as tavily from "./tavily";

export const SOURCE_ATTRIBUTIONS = {
  osm: { text: "Map data © OpenStreetMap contributors (ODbL)", url: "https://www.openstreetmap.org/copyright" },
  openMeteo: { text: "Weather data by Open-Meteo.com (CC BY 4.0)", url: "https://open-meteo.com/" },
  nagerDate: { text: "Public holidays: Nager.Date", url: "https://date.nager.at" },
  ticketmaster: { text: "Events: Ticketmaster Discovery API", url: "https://developer.ticketmaster.com" },
  tavily: { text: "Web search: Tavily", url: "https://tavily.com" },
} as const;
