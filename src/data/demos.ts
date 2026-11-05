// Recorded REAL agent runs (open-weight models through Otari, or the earlier Nebius version, + live sources), replayed
// instantly so judges don't wait.
// Files are produced by `node scripts/record-demo.mjs` against the live agent; never hand-written.
import type { AgentEvent, AgentRequest } from "@/lib/types";

export type RecordedEvent = AgentEvent & { t: number }; // ms since the run started
export type Demo = AgentRequest & { slug: string; recordedAt: string; events: RecordedEvent[] };

/** What the home page previews of a recorded run: its week as the agent read it, and its verified claims. */
export type DemoPreview = {
  days: { date: string; weekday: string; condition: string; tmax: number; precip_mm: number }[];
  events: Record<string, number>; // events within 5 km per date
  holidays: Record<string, string>; // holiday name per date
  verification?: { verified: number; checked: number; sources: number };
  writer?: "quick" | "economy"; // which writer the recorded run used (Nemotron Ultra or Super), from its engine log
  otari?: boolean; // recorded on the Otari version (its engine log carries Otari's served models and costs)
  onOtari?: OtariStats; // what Otari did in the run, read from its own events
};

/** What a recorded run did on Otari: who served each role, and the searches, MCP reads, guardrail checks and bill. */
export type OtariStats = {
  researcher?: string;
  writer?: string;
  sandbox?: string; // the model that wrote the program Otari's sandbox ran
  searches: number; // otari_web_search calls
  mcpReads: number; // pages read by the Tablecast MCP server inside Otari's tool loop
  screened: number; // web sources the guardrail checked
  billed?: number; // what Otari billed the restaurant's end user for the run, in USD
};

export function otariStats(events: RecordedEvent[]): OtariStats | undefined {
  if (!events.some((e) => e.type === "otari")) return undefined;
  const engine = events.flatMap((e) => (e.type === "engine" ? [e.call] : []));
  const label = (phase: string) => engine.find((c) => c.phase === phase)?.label;
  const mcpSteps = new Set(events.flatMap((e) => (e.type === "tool_start" && e.tool === "read_pages" && /Tablecast MCP/.test(e.label) ? [e.id] : [])));
  const mcpReads = events.reduce((n, e) => (e.type === "tool_end" && mcpSteps.has(e.id) && !e.error ? n + (e.sources?.length ?? 0) : n), 0);
  const end = events.find((e): e is Extract<RecordedEvent, { type: "budget" }> => e.type === "budget" && e.stage === "end");
  const guard = events.find((e): e is Extract<RecordedEvent, { type: "guardrails" }> => e.type === "guardrails");
  return {
    researcher: label("gather"),
    writer: label("synthesize"),
    sandbox: events.some((e) => e.type === "quartermaster") ? label("code") : undefined,
    searches: engine.filter((c) => c.phase === "search").length,
    mcpReads,
    screened: guard?.screening.available ? guard.screening.screened : 0,
    ...(end?.before != null ? { billed: end.spend - end.before } : {}),
  };
}

// Populated by the recorder (see scripts/record-demo.mjs).
import recorded from "./demos.json";

export const DEMOS: Demo[] = recorded as Demo[];

function preview(events: RecordedEvent[]): DemoPreview | undefined {
  const week = events.find((e): e is Extract<RecordedEvent, { type: "week" }> => e.type === "week");
  if (!week || week.days.length === 0) return undefined;
  const v = events.find((e): e is Extract<RecordedEvent, { type: "playbook" }> => e.type === "playbook")?.playbook.verification;
  const byDate: Record<string, number> = {};
  for (const ev of week.events) byDate[ev.date] = (byDate[ev.date] ?? 0) + 1;
  const written = events.find((e): e is Extract<RecordedEvent, { type: "engine" }> => e.type === "engine" && e.call.phase === "synthesize");
  return {
    writer: written ? (/super|economy/i.test(written.call.model) || /super/i.test(written.call.label) ? "economy" : "quick") : undefined,
    otari: events.some((e) => e.type === "otari"),
    onOtari: otariStats(events),
    days: week.days.map(({ date, weekday, condition, tmax, precip_mm }) => ({ date, weekday, condition, tmax, precip_mm })),
    events: byDate,
    holidays: Object.fromEntries(week.holidays.map((h) => [h.date, h.local_name || h.name])),
    verification: v && v.checked > 0 ? { verified: v.verified, checked: v.checked, sources: v.sources } : undefined,
  };
}

/** The recorded runs for the home page, newest first. */
export function demoSummaries() {
  return [...DEMOS].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(({ slug, restaurant, city, goal, recordedAt, events }) => ({ slug, restaurant, city, goal, recordedAt, preview: preview(events) }));
}
