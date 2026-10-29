"use client";

import { useMemo, useState } from "react";
import type { BufferPost } from "@/lib/buffer/client";
import { TAG_DOT } from "@/lib/week";
import { utcToZoned } from "@/lib/post-writer";
import { dayLabel } from "@/lib/sources/format";
import { Avatar, BTN_PRIMARY, BTN_SECOND, BTN_SMALL, CARD, channelName, EmptyState, ErrorNotice, ScreenHead, ServiceChip, Skeleton } from "./parts";
import type { WeekStore } from "./store";
import { useQueue } from "./useQueue";

const FILTERS = [["all", "All"], ["draft", "Drafts"], ["scheduled", "Scheduled"], ["attention", "Needs attention"]] as const;
const STATUS_LABEL: Record<string, string> = { draft: "Draft", scheduled: "Scheduled", needs_approval: "Needs approval", error: "Error", sending: "Sending", sent: "Sent" };

export default function Queue({ w }: { w: WeekStore }) {
  const { state, reload } = useQueue(w.connected, false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");

  const view = useMemo(() => {
    if (state.status !== "ready") return [];
    const zone = new Map(state.data.channels.map((c) => [c.id, c.timezone]));
    const rows = state.data.posts
      .filter((p) => filter === "all" || (filter === "attention" ? p.status === "error" || p.status === "needs_approval" : p.status === filter))
      .map((p) => ({ p, at: p.dueAt ? utcToZoned(new Date(p.dueAt), zone.get(p.channelId) ?? "UTC") : null }));
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(r.at?.date ?? "none", [...(groups.get(r.at?.date ?? "none") ?? []), r]);
    return [...groups.entries()].sort(([a], [b]) => (a === "none" ? 1 : b === "none" ? -1 : a.localeCompare(b)));
  }, [state, filter]);

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead
        kicker="5 · Queue"
        title="What Buffer holds now"
        aside={w.connected ? <button type="button" onClick={() => void reload()} disabled={state.status === "loading"} className={BTN_SECOND}>{state.status === "loading" ? "Refreshing" : "Refresh"}</button> : undefined}
      >
        Read straight from your Buffer account: drafts and scheduled posts, each with the tag Tablecast gave it (one per reason: rain, sun, event, dish).
      </ScreenHead>

      {!w.connected ? (
        <EmptyState title="Connect Buffer to see your queue" action={<button type="button" onClick={() => w.setStep("connect")} className={BTN_PRIMARY}>Connect Buffer</button>}>
          The queue is only ever read with your permission, and only the first 100 posts.
        </EmptyState>
      ) : state.status === "loading" || state.status === "idle" ? (
        <div className="space-y-3" aria-busy="true" aria-label="Reading your Buffer queue"><Skeleton className="h-8 w-64" />{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : state.status === "error" ? (
        <ErrorNotice error={state.error} onRetry={() => void reload()} />
      ) : (
        <>
          <div role="group" aria-label="Filter" className="flex flex-wrap gap-2">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`min-h-11 rounded-full border px-3.5 text-[13px] transition sm:min-h-9 ${filter === k ? "border-olive bg-olive text-paper" : "border-line bg-card text-ink-2 hover:border-ink-2/40"}`}>{label}</button>
            ))}
            <span className="ml-auto self-center text-[12.5px] text-muted">{state.data.posts.length} in Buffer{state.data.hasNextPage ? ", first 100 shown" : ""}</span>
          </div>

          {view.length === 0 ? (
            <EmptyState title={state.data.posts.length === 0 ? "Your queue is empty" : "Nothing matches this filter"} action={state.data.posts.length === 0 ? <button type="button" onClick={() => w.setStep(w.plan ? "schedule" : "week")} className={BTN_PRIMARY}>{w.plan ? "Send the week to Buffer" : "Pick a week"}</button> : <button type="button" onClick={() => setFilter("all")} className={BTN_SMALL}>Show all</button>}>
              {state.data.posts.length === 0 ? "No drafts or scheduled posts yet. Create the week as drafts and they will appear here." : "Try another filter."}
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-6">
              {view.map(([date, rows]) => (
                <section key={date} aria-label={date === "none" ? "No time set" : dayLabel(date)}>
                  <h3 className="font-display mb-2 text-xl">{date === "none" ? "No time set" : dayLabel(date)}</h3>
                  <ul className="grid gap-3 lg:grid-cols-2">
                    {rows.map(({ p, at }) => <QueueRow key={p.id} post={p} time={at?.time} channel={state.data.channels.find((c) => c.id === p.channelId)} />)}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QueueRow({ post, time, channel }: { post: BufferPost; time?: string; channel?: { avatar: string; name: string; displayName: string | null; service: BufferPost["channelService"] } }) {
  const bad = post.status === "error" || post.status === "needs_approval";
  return (
    <li className={`${CARD} flex gap-3 p-3.5 sm:p-4`}>
      <div className="w-14 shrink-0 text-center">
        <p className="rounded-md bg-ink px-1.5 py-0.5 text-[13px] font-semibold tabular-nums text-paper">{time ?? "--:--"}</p>
        {channel && <div className="mt-2 flex justify-center"><Avatar channel={channel} size={30} /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${bad ? "border-terracotta/40 bg-terracotta/10 text-terracotta" : post.status === "scheduled" ? "border-olive/30 bg-olive/10 text-olive" : "border-line bg-paper text-ink-2"}`}>{STATUS_LABEL[post.status] ?? post.status}</span>
          {channel && <><ServiceChip channel={channel} /><span className="truncate text-[12px] text-muted">{channelName(channel)}</span></>}
        </div>
        <p className="mt-1.5 line-clamp-3 text-[14px] leading-relaxed text-ink">{post.text || <span className="text-muted">No text</span>}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {post.tags.length === 0 && <span className="text-[12px] text-muted">No tag</span>}
          {post.tags.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2 py-0.5 text-[12px] text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: TAG_DOT[t.name] ?? t.color }} aria-hidden />{t.name}</span>
          ))}
          {post.assets.length > 0 && <span className="text-[12px] text-muted">{post.assets.length} image{post.assets.length === 1 ? "" : "s"}</span>}
        </div>
      </div>
    </li>
  );
}
