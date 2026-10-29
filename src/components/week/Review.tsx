"use client";

import { useMemo, useState } from "react";
import type { Channel } from "@/lib/buffer/client";
import type { NetworkKey, PostSpec } from "@/lib/post-writer";
import { charLimit, dailyCounts, networkOf, overBy, overLimit, serviceLabel, TAG_DOT, tagLabel, textOn } from "@/lib/week";
import { dayLabel } from "@/lib/sources/format";
import { IconArrow } from "../icons";
import { Avatar, BTN_PRIMARY, BTN_SECOND, BTN_SMALL, CARD, channelName, EmptyState, ErrorNotice, FIELD, RecordedTag, ScreenHead, Skeleton } from "./parts";
import type { WeekStore } from "./store";
import { useQueue } from "./useQueue";

export default function Review({ w }: { w: WeekStore }) {
  const plan = w.plan;
  const selectedChannels = w.channels.filter((c) => w.selected.includes(c.id));
  const { state: queue, reload } = useQueue(w.connected, true);

  if (!plan) {
    return (
      <div className="flex flex-col gap-6">
        <ScreenHead kicker="3 · Review" title="Review and edit the posts" />
        <EmptyState title="No week chosen yet" action={<button type="button" onClick={() => w.setStep("week")} className={BTN_PRIMARY}>Pick a week</button>}>
          Choose a recorded week or send your live run here, then edit each post before it goes anywhere.
        </EmptyState>
      </div>
    );
  }

  const real = false; // the daily-limit view for drafts; Schedule shows it again when scheduling for real

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead
        kicker="3 · Review"
        title="Edit, remove, choose channels"
        aside={<button type="button" onClick={() => w.setStep("schedule")} className={BTN_PRIMARY} disabled={w.active.length === 0}>Continue to Schedule <IconArrow size={14} /></button>}
      >
        Every text is yours to change. Each network gets its own version, with its own length limit. Removed posts stay out of Buffer; you can bring them back.
      </ScreenHead>

      {plan.source.kind === "replay" && <div><RecordedTag /></div>}

      {!w.connected && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-card px-4 py-3.5 text-[14px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <span>Connect Buffer to choose real channels and see their daily limits. Until then you are editing the default text.</span>
          <button type="button" onClick={() => w.setStep("connect")} className={BTN_SECOND}>Connect Buffer</button>
        </div>
      )}
      {w.connected && w.selected.length === 0 && (
        <div role="status" className="rounded-2xl border border-saffron/50 bg-saffron/10 px-4 py-3 text-[14px] text-ink-2">
          No channel is selected. <button type="button" onClick={() => w.setStep("connect")} className="font-medium text-olive underline underline-offset-2">Choose channels</button> to see per-network text and send the posts.
        </div>
      )}

      {w.connected && w.selected.length > 0 && <Limits w={w} channels={selectedChannels} queue={queue} reload={reload} real={real} />}

      <ul className="flex flex-col gap-4">
        {w.posts.map((p, i) => (
          <li key={p.id} className="rise" style={{ "--d": `${Math.min(i, 8) * 40}ms` } as React.CSSProperties}>
            <PostEditor post={p} w={w} channels={selectedChannels} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Daily limits ------------------------------------------------------------------------------------------------

function Limits({ w, channels, queue, reload, real }: { w: WeekStore; channels: Channel[]; queue: ReturnType<typeof useQueue>["state"]; reload: () => void; real: boolean }) {
  const rows = useMemo(() => {
    if (queue.status !== "ready") return [];
    return dailyCounts({ queue: queue.data.posts, plan: w.active, targets: w.targets, channels, real });
  }, [queue, w.active, w.targets, channels, real]);

  return (
    <section aria-labelledby="limits-h" className={`${CARD} p-4 sm:p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="limits-h" className="font-display text-xl">Daily posting limits</h3>
          <p className="mt-0.5 text-[13px] text-muted">From Buffer. Drafts do not count; only posts scheduled for real do.</p>
        </div>
        <button type="button" onClick={reload} className={BTN_SMALL} disabled={queue.status === "loading"}>Refresh</button>
      </div>
      {queue.status === "loading" && <Skeleton className="mt-3 h-16" />}
      {queue.status === "error" && <div className="mt-3"><ErrorNotice error={queue.error} onRetry={reload} /></div>}
      {queue.status === "ready" && (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {channels.map((c) => {
            const lim = queue.data.limits.find((l) => l.channelId === c.id);
            const mine = rows.filter((r) => r.channelId === c.id);
            const over = overLimit(mine, lim ? [lim] : []);
            return (
              <li key={c.id} className="rounded-xl border border-line bg-paper/60 p-3">
                <div className="flex items-center gap-2.5"><Avatar channel={c} size={28} /><span className="min-w-0 truncate text-[14px] font-medium">{channelName(c)}</span></div>
                <p className="mt-2 text-[13px] text-ink-2">
                  {lim?.limit != null ? <>Limit <strong className="tabular-nums">{lim.limit}</strong> per day.{" "}</> : "No daily limit reported. "}
                  {lim?.isAtLimit ? <span className="text-terracotta">Today is already full.</span> : null}
                </p>
                {mine.length === 0 ? (
                  <p className="mt-1 text-[12.5px] text-muted">{real ? "Nothing scheduled around this plan." : "No scheduled posts in Buffer on the plan's days."}</p>
                ) : (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {mine.map((r) => {
                      const total = r.inBuffer + r.fromPlan;
                      const bad = over.some((o) => o.date === r.date);
                      return <li key={r.date} className={`rounded-full border px-2 py-0.5 text-[12px] tabular-nums ${bad ? "border-terracotta/40 bg-terracotta/10 text-terracotta" : "border-line bg-card text-ink-2"}`}>{dayLabel(r.date)}: {total}{lim?.limit != null ? ` / ${lim.limit}` : ""}</li>;
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- One post ---------------------------------------------------------------------------------------------------

function PostEditor({ post, w, channels }: { post: PostSpec; w: WeekStore; channels: Channel[] }) {
  const removed = w.removed.includes(post.id);
  const networks = useMemo(() => {
    const seen = new Map<NetworkKey, Channel[]>();
    for (const c of channels) {
      const k = networkOf(c.service);
      seen.set(k, [...(seen.get(k) ?? []), c]);
    }
    return seen.size ? [...seen.entries()] : ([["default", []]] as [NetworkKey, Channel[]][]);
  }, [channels]);
  const [tab, setTab] = useState<NetworkKey>(networks[0][0]);
  const current = networks.find(([k]) => k === tab) ? tab : networks[0][0];
  const [first] = networks.find(([k]) => k === current)![1];
  const limit = first ? charLimit(first.service) : 1000;
  const value = first ? textOn(post, first.service) : post.variants.default;
  const over = overBy(value, limit);
  const edited = JSON.stringify(post) !== JSON.stringify(w.plan?.posts.find((p) => p.id === post.id));
  const targets = w.targetsFor(post.id);
  const image = w.images[post.id];
  const dot = TAG_DOT[post.tag] ?? "#6F6759";
  const idBase = `post-${post.id}`;

  return (
    <article className={`${CARD} overflow-hidden transition-opacity ${removed ? "opacity-60" : ""}`} aria-label={post.title}>
      <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[148px_1fr]">
        <div className="flex gap-3 md:flex-col">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- generated PNG from our own route
            <img src={image} alt={`Picture for ${post.title}`} width={296} height={296} loading="lazy" className="aspect-square w-24 rounded-xl border border-line object-cover md:w-full" />
          ) : <div className="aspect-square w-24 rounded-xl border border-dashed border-line bg-paper md:w-full" aria-hidden />}
          <div className="min-w-0 md:mt-1">
            <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden />{tagLabel(post.tag)}</p>
            <p className="mt-1 text-[13px] font-medium tabular-nums">{dayLabel(post.post_at.date)}, {post.post_at.time}</p>
            <p className="text-[12px] leading-snug text-muted">{post.post_at.basis}</p>
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="font-display text-xl leading-tight">{post.title}</h3>
            <div className="flex gap-2">
              {edited && !removed && <button type="button" onClick={() => w.resetPost(post.id)} className={BTN_SMALL}>Undo my edits</button>}
              <button type="button" onClick={() => w.toggleRemoved(post.id)} className={BTN_SMALL} aria-pressed={removed}>{removed ? "Bring back" : "Remove"}</button>
            </div>
          </div>

          {removed ? (
            <p className="mt-3 text-[14px] text-muted">Removed. It will not be sent to Buffer.</p>
          ) : (
            <>
              {post.issues.length > 0 && (
                <ul className="mt-2 space-y-1">{post.issues.map((i) => <li key={i} className="rounded-lg bg-saffron/15 px-2.5 py-1.5 text-[13px] leading-snug text-ink-2">Check this: {i}</li>)}</ul>
              )}
              {networks.length > 1 && (
                <div role="tablist" aria-label="Network" className="mt-3 flex flex-wrap gap-1.5">
                  {networks.map(([k, cs]) => (
                    <button key={k} type="button" role="tab" aria-selected={k === current} onClick={() => setTab(k)} className={`min-h-11 rounded-full border px-3 text-[13px] transition sm:min-h-8 ${k === current ? "border-olive bg-olive text-paper" : "border-line bg-paper text-ink-2 hover:border-ink-2/40"}`}>
                      {cs[0] ? serviceLabel(cs[0].service) : "Default"}{cs.length > 1 ? ` +${cs.length - 1}` : ""}
                    </button>
                  ))}
                </div>
              )}
              <label htmlFor={`${idBase}-text`} className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-muted">
                Text{first ? ` for ${serviceLabel(first.service)}` : ""}
              </label>
              <textarea
                id={`${idBase}-text`}
                value={value}
                onChange={(e) => w.editText(post.id, current, e.target.value)}
                rows={4}
                aria-invalid={over > 0}
                aria-describedby={`${idBase}-count`}
                className={`${FIELD} mt-1 resize-y leading-relaxed ${over > 0 ? "!border-terracotta" : ""}`}
              />
              <p id={`${idBase}-count`} className={`mt-1 text-[12.5px] tabular-nums ${over > 0 ? "font-medium text-terracotta" : "text-muted"}`} aria-live="polite">
                {[...value].length} / {limit}{over > 0 ? `, ${over} too long. Shorten it before sending.` : ""}
              </p>

              <fieldset className="mt-3">
                <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted">Goes to</legend>
                {channels.length === 0 ? (
                  <p className="mt-1 text-[13px] text-muted">Select channels in Connect.</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {channels.map((c) => {
                      const on = targets.includes(c.id);
                      return (
                        <label key={c.id} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-olive/40 sm:min-h-9 ${on ? "border-olive bg-olive/10 text-olive" : "border-line bg-paper text-ink-2 hover:border-ink-2/40"}`}>
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => w.toggleTarget(post.id, c.id)} />
                          <Avatar channel={c} size={20} /><span className="max-w-[10rem] truncate">{channelName(c)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>

              {post.why_now.text && (
                <p className="mt-3 text-[12.5px] leading-relaxed text-muted"><span className="font-medium text-ink-2">Why now:</span> {post.why_now.text}{post.why_now.cites[0]?.title ? ` (${post.why_now.cites[0].title})` : ""}</p>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
