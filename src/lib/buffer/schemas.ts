// What the routes accept from the browser. Posts come back from the screens after the owner edited them, so they are
// validated field by field (shape, lengths, a real IANA zone, tags we know) and then checked again by code
// (checkPostTimes, the per-network character limit) before anything reaches Buffer.

import { z } from "zod";
import { TAG_COLORS } from "../schedule";
import type { DayForecast, NearbyEvent, Playbook, Source } from "../types";
import type { PostSpec } from "../post-writer";

const NETWORKS = ["instagram", "facebook", "linkedin", "google", "bluesky", "threads", "mastodon", "twitter", "default"] as const;
const text = (max: number) => z.string().max(max);

const zone = z.string().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown time zone");

export const PostSpecSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["moment", "event", "dish"]),
  title: text(200),
  tag: z.string().refine((t) => t in TAG_COLORS, "unknown tag"),
  post_at: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: zone,
    utc: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "bad instant"),
    basis: text(200),
  }),
  text: text(2200),
  variants: z.object(Object.fromEntries(NETWORKS.map((n) => [n, text(2200)])) as Record<(typeof NETWORKS)[number], z.ZodString>),
  image: z.object({
    restaurant: text(120),
    kicker: text(60),
    headline: text(160),
    detail: text(400),
    tone: z.enum(["rain", "sun", "event", "dish"]),
  }),
  why_now: z.object({
    text: text(800),
    verified: z.boolean(),
    cites: z.array(z.object({ source: text(20), title: text(300).optional(), url: text(600).optional(), quote: text(800) })).max(4),
  }),
  issues: z.array(text(300)).max(8),
});

export const PostsSchema = z.array(PostSpecSchema).min(1).max(30);

const day = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekday: text(8),
  tmax: z.number(),
  tmin: z.number(),
  precip_mm: z.number(),
  precip_prob: z.number().nullable(),
  weather_code: z.number(),
  condition: text(60),
});
const event = z.object({
  id: text(80), name: text(200), venue: text(200), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: text(8).optional(), distance_km: z.number().optional(), url: text(600).optional(), segment: text(60).optional(), genre: text(60).optional(),
});

export const SnapshotSchema = z.object({ days: z.array(day).max(20), events: z.array(event).max(60) });
export const LocationSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), timezone: zone });

/**
 * The plan of a live run, trimmed by the browser to what the writer reads. The playbook is the server-verified
 * object the agent streamed; here only its structure is checked, because the writer reads fields, not prose.
 */
export const LivePlanSchema = z.object({
  playbook: z.looseObject({
    restaurant: z.looseObject({ name: text(160), city: text(120) }),
    currency: text(8),
    moments: z.array(z.looseObject({ title: text(1000), when: text(1000), play: text(4000), evidence: z.array(z.looseObject({})).max(12) })).max(8),
    menu_moves: z.array(z.looseObject({ dish: text(1000), price: z.number(), when: text(1000), description: text(3000).optional(), evidence: z.array(z.looseObject({})).max(12) })).max(12),
    experience: z.looseObject({ event_idea: text(4000), event_why: text(4000), evidence: z.array(z.looseObject({})).max(12) }),
    marketing: z.looseObject({ post_when: text(1000) }),
  }),
  days: z.array(day).min(1).max(16),
  events: z.array(event).max(60),
  sources: z.array(z.object({ id: text(20), title: text(300), url: text(600).optional() })).max(80),
  timezone: zone,
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
});
export type LivePlan = z.infer<typeof LivePlanSchema>;

export const asPosts = (v: z.infer<typeof PostsSchema>) => v as unknown as PostSpec[];
export const asPlaybook = (v: LivePlan["playbook"]) => v as unknown as Playbook;
export const asSources = (v: LivePlan["sources"]): Source[] => v.map((s) => ({ ...s, kind: "web", provider: "tavily", text: "" }) as unknown as Source);
export const asDays = (v: LivePlan["days"]) => v as DayForecast[];
export const asEvents = (v: LivePlan["events"]) => v as NearbyEvent[];
