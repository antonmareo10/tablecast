// "The queue follows the weather": compare the forecast and the listed events with what the posts were written
// for, and propose editPost moves. Nothing is changed until the owner approves each proposal.
//
// Rules (all on exact figures from the two forecasts, no model call):
//  - A post written for a rainy day whose rain has gone (under RAIN_MM now) moves to the nearest day that is
//    rainy now and has no rain post yet, at the same local time. If there is no such day it is flagged for review.
//  - A post written about a listed event whose listing has disappeared is flagged for review.

import type { BufferClient, BufferPost, EditPostInput, MutationResult } from "./buffer/client";
import { utcToZoned, zonedToUtc, type PostSpec } from "./post-writer";
import { dayLabel } from "./sources/format";
import type { DayForecast, NearbyEvent } from "./types";

export const RAIN_MM = 1;

export type Snapshot = { days: DayForecast[]; events: NearbyEvent[] };

export type QueuedPost = Pick<BufferPost, "id" | "channelId" | "status" | "dueAt" | "text">;

export type Proposal = {
  postId: string;
  specId: string;
  action: "move" | "review";
  reason: string;
  from: { date: string; time: string };
  to?: { date: string; time: string; utc: string };
  /** The editPost call that applying this proposal sends. Absent for "review". */
  edit?: EditPostInput;
};

const rainy = (d: DayForecast | undefined) => !!d && d.precip_mm >= RAIN_MM;
const mm = (d: DayForecast | undefined) => (d ? `${d.precip_mm} mm` : "no forecast");

/** The queue post a written spec became: same channel, same instant and the text it was sent with. */
export function matchQueue(spec: PostSpec, queue: QueuedPost[], textOf: (s: PostSpec, channelId: string) => string): QueuedPost[] {
  return queue.filter((q) => q.dueAt && Date.parse(q.dueAt) === Date.parse(spec.post_at.utc) && q.text === textOf(spec, q.channelId));
}

export function proposeMoves(o: {
  specs: PostSpec[];
  previous: Snapshot;
  next: Snapshot;
  queue: QueuedPost[];
  textOf: (s: PostSpec, channelId: string) => string;
  now: Date;
}): Proposal[] {
  const prev = new Map(o.previous.days.map((d) => [d.date, d]));
  const next = new Map(o.next.days.map((d) => [d.date, d]));
  const today = utcToZoned(o.now, o.specs[0]?.post_at.timezone ?? "UTC").date;
  const rainPostDates = new Set(o.specs.filter((s) => s.image.tone === "rain").map((s) => s.post_at.date));
  const out: Proposal[] = [];
  const claimed = new Set<string>(); // a new rainy day takes one moved post, not all of them

  for (const spec of o.specs) {
    const queued = matchQueue(spec, o.queue, o.textOf);
    if (queued.length === 0) continue;
    const date = spec.post_at.date;
    const from = { date, time: spec.post_at.time };

    if (spec.image.tone === "rain" && rainy(prev.get(date)) && !rainy(next.get(date))) {
      const target = o.next.days.find((d) => d.date >= today && d.date > date && rainy(d) && !rainPostDates.has(d.date) && !claimed.has(d.date))
        ?? o.next.days.find((d) => d.date >= today && rainy(d) && !rainPostDates.has(d.date) && !claimed.has(d.date));
      if (target) {
        claimed.add(target.date);
        const utc = zonedToUtc(target.date, spec.post_at.time, spec.post_at.timezone);
        for (const q of queued) {
          out.push({
            postId: q.id, specId: spec.id, action: "move", from,
            to: { date: target.date, time: spec.post_at.time, utc: utc.toISOString() },
            reason: `The forecast for ${dayLabel(date)} changed from ${mm(prev.get(date))} to ${mm(next.get(date))}. ${dayLabel(target.date)} is now ${target.condition}, ${mm(target)}. Move the post there, same time.`,
            edit: { id: q.id, mode: "customScheduled", dueAt: utc.toISOString(), ...(q.status === "draft" ? { saveToDraft: true } : {}) },
          });
        }
      } else {
        for (const q of queued) {
          out.push({ postId: q.id, specId: spec.id, action: "review", from, reason: `The forecast for ${dayLabel(date)} changed from ${mm(prev.get(date))} to ${mm(next.get(date))} and no other day this week is rainy. Keep, rewrite or delete this post.` });
        }
      }
      continue;
    }

    if (spec.kind === "moment" && spec.image.tone === "event") {
      const had = o.previous.events.some((e) => e.date === date && spec.text.includes(e.name));
      const still = o.next.events.some((e) => e.date === date && spec.text.includes(e.name));
      if (had && !still) {
        for (const q of queued) out.push({ postId: q.id, specId: spec.id, action: "review", from, reason: `The event this post is about is no longer listed for ${dayLabel(date)}. Check it before it goes out.` });
      }
    }
  }
  return out;
}

export type ApplyOutcome = { postId: string; status: "moved" | "failed" | "skipped"; reason?: string };

/** Sends the approved moves, one editPost each. Review proposals are never applied here. */
export async function applyMoves(client: BufferClient, approved: Proposal[]): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  for (const p of approved) {
    if (p.action !== "move" || !p.edit) {
      out.push({ postId: p.postId, status: "skipped", reason: "Needs your decision in Buffer; nothing was changed." });
      continue;
    }
    const r: MutationResult<BufferPost> = await client.editPost(p.edit);
    out.push(r.ok ? { postId: p.postId, status: "moved" } : { postId: p.postId, status: "failed", reason: r.error.message });
  }
  return out;
}
