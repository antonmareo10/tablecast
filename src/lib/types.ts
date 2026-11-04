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

export type Provider = "Tavily" | "Otari web search" | "Tablecast reader" | "Open-Meteo" | "OpenStreetMap" | "Ticketmaster" | "Nager.Date" | "Nemotron VL" | "Vision model";

export type Source = {
  id: string; // "S1", "S2"… — what the model cites
  kind: SourceKind;
  provider: Provider;
  title: string;
  url?: string;
  published?: string;
  text: string; // the text quotes are checked against, exactly as fetched
};

// The writer cites sentence ids (span "S9.4"); the server fills in `source` and the exact `quote`, plus
// `context`: the neighbouring lines that hold a number or word of the claim (menus often put a dish and its
// price on separate lines), shown next to the quote.
export type Cite = { source: string; quote: string; span?: string; ok?: boolean; context?: string[] };

export type Evidence = {
  text: string; // one owner-friendly sentence
  cites: Cite[]; // source id + verbatim quote(s) backing it
  verified?: boolean; // set by the server: every quote found in its source, every number backed
  issue?: string; // why it did not verify
  across?: string; // verified across languages (e.g. "es"): numbers and names checked, words can't be
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
  verification?: {
    checked: number;
    verified: number;
    sources: number;
    providers: string[];
    // How the verifier got there: claims that matched as written, quotes code re-pointed to the source that
    // really contains them, and claims the repair pass fixed or dropped.
    written?: number;
    first_pass?: number;
    reattributed?: number;
    fixed?: number;
    dropped?: number;
    // Money amounts in the plan's free text (headline, plays, event, post…): each must equal a dish price, a
    // price on the current menu or a number in a checked claim, and an amount next to a competitor's name must come
    // from that competitor (`venue`, v7.1). `unbacked` lists what still doesn't after repair.
    amounts?: { checked: number; fixed: number; unbacked: { where: string; amount: string; venue?: string }[] };
    // Explicit dates in the plan's scheduling fields (day-by-day plan, moments, dishes, the event, when to post),
    // checked against the restaurant's local date: re-dated by the repair, day-plan lines dropped, the rest listed.
    dates?: { today: string; checked: number; fixed: number; dropped: number; past: { where: string; text: string }[] };
  };
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

// One model call (or one gateway tool call) made by the agent through Otari, as measured on the server: the usage
// fields and inline cost Otari returns, the headers that say who served it, and wall-clock timing.
export type EngineCall = {
  phase: "baseline" | "vision" | "gather" | "synthesize" | "verify" | "repair" | "search" | "mcp" | "screen" | "code";
  model: string; // the name the app asked Otari for: a routing policy ("tablecast-write") or a catalog id
  label: string; // the model that answered, readable: "Nemotron 3 Ultra", "GLM 5.2"…
  ms: number;
  started_at?: number; // epoch ms when the call started (server clock)
  ttft_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  tool_calls?: number;
  tools_ms?: number;
  cost_usd?: number; // Otari's own figure (usage.cost_usd), summed over the requests this entry stands for
  est_cost_usd?: number; // recorded runs from the Nebius version: tokens × the published price
  usage_estimated?: boolean; // the call was cut before the provider reported usage
  note?: string;
  count?: number; // HTTP requests this entry stands for (parallel repairs are measured together)
  // How Otari served it (Otari-Provider, Otari-Model, Otari-Attempt-Count, Otari-Fallback, Otari-Request-ID).
  served?: { provider?: string; model?: string; attempts?: number; fallback?: boolean; fallbacks?: number; request_id?: string };
  // Verdicts of the guardrails Otari ran on the request's input (Otari-Guardrails).
  guardrails?: { profile: string; mode?: string; valid: boolean | null; score?: number | null; status?: string; reason?: string }[];
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
  // Where the run goes on Otari: its session id (Otari-Conversation-Id), the API and the model name of each step.
  | { type: "otari"; run_id: string; api: string; routing: Record<string, string>; missing?: string[]; end_user?: string }
  | { type: "error"; message: string }
  | { type: "done"; elapsed_ms: number };

export type AgentRequest = {
  restaurant: string;
  city: string;
  website?: string; // optional: the owner's site, skips the search for it
  goal?: string;
  language?: "English" | "Español";
  menu_photo?: string; // optional data: URL (jpeg/png/webp), read by the vision model
  mode?: "quick" | "economy"; // quick: tablecast-write (Nemotron 3 Ultra) writes; economy: tablecast-economy (Nemotron 3 Super)
};
