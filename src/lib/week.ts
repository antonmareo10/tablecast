// Pure helpers behind the screens (no React, no network): moving and editing posts, the board's day grid, the
// daily-limit counter and the character budget per network. Everything that changes a post goes through here so
// the exact UTC instant, the weekday in the title and the image stay consistent with the local date and time.

import { dayName, LIMITS, utcToZoned, zonedToUtc, type NetworkKey, type PostSpec } from "./post-writer";
import type { BufferPost, Channel, DailyLimit, Service } from "./buffer/client";
import type { DayForecast, NearbyEvent } from "./types";

/** The text variant a channel's service gets (same mapping the scheduler uses). */
export const NETWORK_OF: Partial<Record<Service, NetworkKey>> = {
  instagram: "instagram", facebook: "facebook", linkedin: "linkedin", googlebusiness: "google",
  bluesky: "bluesky", threads: "threads", mastodon: "mastodon", twitter: "twitter",
};
export const networkOf = (service: Service): NetworkKey => NETWORK_OF[service] ?? "default";
export const charLimit = (service: Service): number => LIMITS[networkOf(service)];

export const SERVICE_LABEL: Partial<Record<Service, string>> = {
  instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", googlebusiness: "Google Business", bluesky: "Bluesky",
  threads: "Threads", mastodon: "Mastodon", twitter: "X", pinterest: "Pinterest", tiktok: "TikTok", youtube: "YouTube",
  startPage: "Start Page", substack: "Substack", whatsapp: "WhatsApp",
};
export const serviceLabel = (s: Service) => SERVICE_LABEL[s] ?? s;

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Moves a post to another local date and time. Returns null for a malformed date or time. */
export function movePost(spec: PostSpec, date: string, time: string): PostSpec | null {
  if (!isIso(date) || !isTime(time)) return null;
  const tz = spec.post_at.timezone;
  const utc = zonedToUtc(date, time, tz);
  if (Number.isNaN(utc.getTime())) return null;
  // A time that does not exist (spring-forward gap) lands later; report what really goes out.
  const real = utcToZoned(utc, tz);
  const label = dayName(real.date);
  const lead = spec.title.includes(" · ") ? spec.title.slice(0, spec.title.lastIndexOf(" · ")) : spec.title;
  return {
    ...spec,
    title: `${lead} · ${label}`,
    image: { ...spec.image, kicker: label },
    post_at: { ...spec.post_at, date: real.date, time: real.time, utc: utc.toISOString(), basis: "moved by you" },
  };
}

/** Writes a new text for one network (the canonical `text` follows the default variant). */
export function setVariantText(spec: PostSpec, network: NetworkKey, text: string): PostSpec {
  return { ...spec, text: network === "default" ? text : spec.text, variants: { ...spec.variants, [network]: text } };
}

/** How many characters over the network's limit (0 when it fits). */
export const overBy = (text: string, limit: number) => Math.max(0, [...text].length - limit);

export type BoardDay = {
  date: string;
  label: string;
  forecast?: DayForecast;
  events: NearbyEvent[];
  posts: PostSpec[];
};

/** Seven (or more) day columns covering the forecast and every post, posts sorted by time. */
export function boardDays(posts: PostSpec[], forecast: DayForecast[], events: NearbyEvent[]): BoardDay[] {
  const dates = new Set<string>([...forecast.map((d) => d.date), ...posts.map((p) => p.post_at.date)]);
  const sorted = [...dates].sort();
  return sorted.map((date) => ({
    date,
    label: dayName(date),
    forecast: forecast.find((d) => d.date === date),
    events: events.filter((e) => e.date === date),
    posts: posts.filter((p) => p.post_at.date === date).sort((a, b) => a.post_at.time.localeCompare(b.post_at.time)),
  }));
}

/** Local dates (in the channel's zone) of the queue posts per channel, for the daily-limit counter. */
export type DayCount = { channelId: string; date: string; inBuffer: number; fromPlan: number };

/**
 * Scheduled posts per channel and local day: those already in Buffer (drafts do not count against Buffer's
 * limit) plus, when scheduling for real, the ones this plan would add.
 */
export function dailyCounts(o: {
  queue: Pick<BufferPost, "channelId" | "dueAt" | "status">[];
  plan: PostSpec[];
  targets: Record<string, string[]>;
  channels: Pick<Channel, "id" | "timezone">[];
  real: boolean;
}): DayCount[] {
  const zone = new Map(o.channels.map((c) => [c.id, c.timezone]));
  const map = new Map<string, DayCount>();
  const bump = (channelId: string, date: string, key: "inBuffer" | "fromPlan") => {
    const k = `${channelId}|${date}`;
    const row = map.get(k) ?? { channelId, date, inBuffer: 0, fromPlan: 0 };
    row[key]++;
    map.set(k, row);
  };
  for (const q of o.queue) {
    if (q.status !== "scheduled" || !q.dueAt || !zone.has(q.channelId)) continue;
    bump(q.channelId, utcToZoned(new Date(q.dueAt), zone.get(q.channelId)!).date, "inBuffer");
  }
  if (o.real) {
    for (const p of o.plan) {
      for (const id of o.targets[p.id] ?? []) {
        if (zone.has(id)) bump(id, utcToZoned(new Date(p.post_at.utc), zone.get(id)!).date, "fromPlan");
      }
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.channelId.localeCompare(b.channelId));
}

/** Rows that would pass the channel's daily limit. `limits` comes from Buffer's dailyPostingLimits. */
export function overLimit(counts: DayCount[], limits: Pick<DailyLimit, "channelId" | "limit">[]): (DayCount & { limit: number })[] {
  const cap = new Map(limits.filter((l) => l.limit != null).map((l) => [l.channelId, l.limit as number]));
  return counts.filter((c) => cap.has(c.channelId) && c.inBuffer + c.fromPlan > cap.get(c.channelId)!).map((c) => ({ ...c, limit: cap.get(c.channelId)! }));
}

/** Default targets: every post goes to every selected channel. */
export function defaultTargets(posts: PostSpec[], channelIds: string[]): Record<string, string[]> {
  return Object.fromEntries(posts.map((p) => [p.id, [...channelIds]]));
}

/** Number of createPost writes a schedule run costs (plus the tag and queue reads it makes once). */
export function estimateCalls(posts: PostSpec[], targets: Record<string, string[]>, real: boolean): number {
  const writes = posts.reduce((n, p) => n + (targets[p.id]?.length ?? 0), 0);
  const tagReads = 1 + new Set(posts.map((p) => p.tag)).size; // list + worst case one createTag each
  return writes + tagReads + 1 /* queue read */ + (real ? writes : 0) /* dailyPostingLimits per post */;
}
