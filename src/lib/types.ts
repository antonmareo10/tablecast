// Shared types between the agent (server) and the UI (client).

import type { NearbyEvent } from "./sources/events";
import type { Holiday } from "./sources/holidays";
import type { Venue } from "./sources/places";
import type { DayForecast } from "./sources/weather";

export type { NearbyEvent, Holiday, Venue, DayForecast };

// ---- Evidence --------------------------------------------------------------------------

export type SourceKind =
  | "site" // the restaurant's own website
  | "menu" // a menu (web page or the owner's photo)
  | "review" // guides, reviews, press about the restaurant
  | "news" // local news / what's on this week
  | "rival" // a nearby competitor's page
  | "web" // any other web page
  | "weather"
  | "holiday"
  | "event"
  | "block"; // the venues around the restaurant (OpenStreetMap)

export type Provider = "Tavily" | "Open-Meteo" | "OpenStreetMap" | "Ticketmaster" | "Nager.Date" | "Nemotron VL";

export type Source = {
  id: string; // "S1", "S2"… — what the model cites
  kind: SourceKind;
  provider: Provider;
  title: string;
  url?: string;
  published?: string;
  text: string; // the text quotes are checked against, exactly as fetched
};

export type Cite = { source: string; quote: string; ok?: boolean };

export type Evidence = {
  text: string; // one owner-friendly sentence
  cites: Cite[]; // source id + verbatim quote(s) backing it
  verified?: boolean; // set by the server: every quote found in its source, every number backed
  issue?: string; // why it did not verify
};

// ---- Playbook --------------------------------------------------------------------------

export type Ingredient = {
  item: string;
  qty: number;
  unit: string;
  supplier_category: string;
};

export type MenuMove = {
  dish: string;
  description: string;
  price: number;
  when: string; // which days this week it runs
  why: string;
  evidence: Evidence[];
  ingredients: Ingredient[];
};

export type Moment = {
  when: string; // "Thu 23 Oct, evening"
  title: string; // "Rain all day"
  play: string; // what to do about it
  evidence: Evidence[];
};

export type Playbook = {
  restaurant: {
    name: string;
    city: string;
    concept: string;
    website: string | null;
  };
  currency: string; // ISO 4217
  headline: string;
  snapshot: {
    summary: string;
    loved_for: Evidence[];
    watch_outs: Evidence[];
  };
  moments: Moment[];
  menu_moves: MenuMove[];
  rivals: { summary: string; evidence: Evidence[] };
  experience: { event_idea: string; event_why: string; evidence: Evidence[] };
  marketing: { instagram_post: string; post_when: string; audience: string };
  shopping_list: (Ingredient & { est_cost: number })[];
  week_plan: { day: string; action: string; owner: string }[];
  caveats: string[];
  // Set by the server after checking every claim against the sources fetched in this run.
  verification?: { checked: number; verified: number; sources: number; providers: string[] };
};

// ---- Context the server gathers deterministically (rendered without the model) ---------

export type Place = {
  name: string;
  city: string;
  lat: number;
  lon: number;
  address?: string;
  website?: string;
  cuisine?: string[];
  country_code?: string;
  timezone?: string;
  match: "exact" | "city"; // "city" = we could not pin the restaurant, so we work at city level
};

export type MenuItem = { name: string; price?: number | null; section?: string | null };

// ---- Engine telemetry ------------------------------------------------------------------

// One model call made by the agent, as measured on the server (Nebius Token Factory usage
// fields + wall-clock timing). Nothing here is estimated except `est_cost_usd`, which
// multiplies the measured tokens by the published per-token price.
export type EngineCall = {
  phase: "baseline" | "vision" | "gather" | "synthesize" | "verify" | "repair";
  model: string; // exact Token Factory model id
  label: string; // "Nemotron Lightning", "Nemotron Ultra"…
  ms: number;
  ttft_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  tool_calls?: number;
  tools_ms?: number;
  est_cost_usd?: number;
  usage_estimated?: boolean; // the call was cut before Token Factory reported usage
  note?: string;
};

// ---- Stream events ---------------------------------------------------------------------

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "note"; text: string }
  | { type: "tool_start"; id: string; tool: string; label: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; tool: string; summary: string; error?: boolean; sources?: string[] }
  | { type: "place"; place: Place }
  | { type: "week"; days: DayForecast[]; holidays: Holiday[]; events: NearbyEvent[] }
  | { type: "block"; radius_m: number; total: number; venues: Venue[]; by_cuisine: { cuisine: string; count: number }[] }
  | { type: "menu"; items: MenuItem[]; from: "web" | "photo"; url?: string }
  | { type: "sources"; sources: Source[] }
  | { type: "baseline"; text: string }
  | { type: "playbook"; playbook: Playbook }
  | { type: "playbook_draft"; draft: Record<string, unknown> }
  | { type: "engine"; call: EngineCall }
  | { type: "tavily"; credits: number }
  | { type: "error"; message: string }
  | { type: "done"; elapsed_ms: number };

export type AgentRequest = {
  restaurant: string;
  city: string;
  website?: string; // optional: the owner's site, skips the search for it
  goal?: string;
  language?: "English" | "Español";
  menu_photo?: string; // optional data: URL (jpeg/png/webp), read by Nemotron VL
};
