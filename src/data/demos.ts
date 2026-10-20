// Recorded REAL agent runs (NVIDIA Nemotron + live sources), replayed instantly so judges don't wait.
// Files are produced by `node scripts/record-demo.mjs` against the live agent; never hand-written.
import type { AgentEvent, AgentRequest } from "@/lib/types";

export type RecordedEvent = AgentEvent & { t: number }; // ms since the run started
export type Demo = AgentRequest & { slug: string; recordedAt: string; events: RecordedEvent[] };

// Populated by the recorder (see scripts/record-demo.mjs).
import recorded from "./demos.json";

export const DEMOS: Demo[] = recorded as Demo[];

export function demoSummaries() {
  return DEMOS.map(({ slug, restaurant, city, goal, recordedAt }) => ({ slug, restaurant, city, goal, recordedAt }));
}
