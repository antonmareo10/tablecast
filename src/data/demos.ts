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
};

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
    days: week.days.map(({ date, weekday, condition, tmax, precip_mm }) => ({ date, weekday, condition, tmax, precip_mm })),
    events: byDate,
    holidays: Object.fromEntries(week.holidays.map((h) => [h.date, h.local_name || h.name])),
    verification: v && v.checked > 0 ? { verified: v.verified, checked: v.checked, sources: v.sources } : undefined,
  };
}

export function demoSummaries() {
  return DEMOS.map(({ slug, restaurant, city, goal, recordedAt, events }) => ({ slug, restaurant, city, goal, recordedAt, preview: preview(events) }));
}
