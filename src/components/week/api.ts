// The browser side of the /api/buffer routes: one fetch helper that turns every failure into something the screens
// can show (reconnect, rate limit with its wait, server not configured, bad input, network down).

import type { Channel, DailyLimit, BufferPost, Organization, RateWindow } from "@/lib/buffer/client";
import type { DayDiff, Proposal, ApplyOutcome } from "@/lib/replan";
import type { ScheduleResult } from "@/lib/schedule";
import type { PostSpec } from "@/lib/post-writer";
import type { DayForecast, NearbyEvent } from "@/lib/types";

export type ApiErrorKind = "reconnect" | "rate_limit" | "not_configured" | "network" | "bad_input" | "server" | "forecast";

export class ApiError extends Error {
  constructor(message: string, readonly kind: ApiErrorKind, readonly status: number, readonly retryAfter?: number, readonly problems?: string[]) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? { signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the server. Check your connection and try again.", "network", 0);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; retryAfter?: number | null; problems?: string[]; issues?: string[] }) | null;
  if (res.ok && json) return json;
  const msg = json?.message ?? "";
  const problems = json?.problems ?? json?.issues;
  if (res.status === 401) throw new ApiError(msg || "Buffer needs you to connect again.", "reconnect", 401);
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || json?.retryAfter || undefined;
    throw new ApiError(msg || "Buffer's rate limit is used up for now.", "rate_limit", 429, wait ?? undefined);
  }
  if (res.status === 503 && json?.error === "not_configured") throw new ApiError("This deployment is not connected to a Buffer app client yet.", "not_configured", 503);
  if (json?.error === "forecast_unavailable") throw new ApiError(msg, "forecast", res.status);
  if (res.status >= 400 && res.status < 500) throw new ApiError(msg || "That request was not accepted.", "bad_input", res.status, undefined, problems);
  throw new ApiError(msg || "Something went wrong on the server. Nothing was changed.", "server", res.status);
}

export type Snapshot = { days: DayForecast[]; events: NearbyEvent[] };
export type Source =
  | { kind: "replay"; slug: string; restaurant: string; recordedAt: string; timezone: string }
  | { kind: "live"; restaurant: string; timezone: string };

export type WriteResult = {
  source: Source;
  posts: PostSpec[];
  skipped: { id: string; title: string; reason: string }[];
  shiftDays: number;
  today: string;
  problems: string[];
  snapshot: Snapshot;
  location: { lat: number; lon: number; timezone: string } | null;
  images: Record<string, string>;
};

export type SessionInfo =
  | { connected: false; reason?: string }
  | { connected: true; organizations: Organization[]; channels: Channel[]; rate: RateWindow[] };

export type QueueInfo = { posts: BufferPost[]; hasNextPage: boolean; limits: DailyLimit[]; channels: Channel[]; rate: RateWindow[] };
export type ScheduleResponse = ScheduleResult & { skippedByWriter: { id: string; title: string; reason: string }[]; draft: boolean; rate: RateWindow[] };
export type ReplanResponse = {
  scenario: "live" | "simulated";
  proposals: Proposal[];
  diff: DayDiff[];
  nextDays: DayForecast[];
  eventsRechecked: boolean;
  queued: number;
  outcomes?: ApplyOutcome[];
  stale?: string[];
  rate: RateWindow[];
};
