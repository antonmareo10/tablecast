// Recorded plans as writer input. The recorded runs hold the week as the agent read it (forecast, listed events,
// sources) and the verified plan, so the writer can run on them with no model call and no cost.

import { DEMOS } from "@/data/demos";
import { writePosts, type WriterResult } from "./post-writer";
import type { Playbook, Source } from "./types";

// The recorded places carry no IANA zone (the live agent sets one from Open-Meteo); these four are known.
const ZONES: Record<string, string> = {
  "gjelina-los-angeles": "America/Los_Angeles",
  "katz-s-delicatessen-new-york": "America/New_York",
  "casa-lucio-madrid": "Europe/Madrid",
  "dishoom-covent-garden-london": "Europe/London",
};

export function replayPosts(slug: string, now = new Date()): (WriterResult & { restaurant: string; recordedAt: string; timezone: string }) | null {
  const demo = DEMOS.find((d) => d.slug === slug);
  if (!demo) return null;
  const week = demo.events.find((e) => e.type === "week");
  const play = demo.events.find((e) => e.type === "playbook");
  const src = demo.events.find((e) => e.type === "sources");
  const place = demo.events.find((e) => e.type === "place");
  if (!week || week.type !== "week" || !play || play.type !== "playbook") return null;
  const timezone = (place?.type === "place" && place.place.timezone) || ZONES[slug];
  if (!timezone) return null;
  const sources: Source[] = src?.type === "sources" ? src.sources : [];
  const r = writePosts({ playbook: play.playbook as Playbook, days: week.days, events: week.events, sources, timezone, now, rebase: true });
  return { ...r, restaurant: demo.restaurant, recordedAt: demo.recordedAt, timezone };
}
