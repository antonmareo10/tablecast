"use client";

import { useState } from "react";
import { dayLabel, formatMm } from "@/lib/sources/format";
import type { Proposal } from "@/lib/replan";
import { movePost } from "@/lib/week";
import { IconArrow, IconCheck } from "../icons";
import { WeatherIcon } from "../weather";
import { BTN_PRIMARY, BTN_SECOND, CARD, EmptyState, ErrorNotice, RecordedTag, ScreenHead, Skeleton } from "./parts";
import { api, type ReplanResponse } from "./api";
import type { WeekStore } from "./store";

type Scenario = "live" | "simulated";

export default function Replan({ w }: { w: WeekStore }) {
  const [busy, setBusy] = useState<Scenario | "apply" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [res, setRes] = useState<ReplanResponse | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const sched = w.scheduled;
  const plan = w.plan;
  const replay = plan?.source.kind === "replay";

  function body(scenario: Scenario, approve?: { postId: string; dueAt: string }[]) {
    return { posts: sched!.posts, previous: plan!.snapshot, location: plan!.location, scenario, channelIds: sched!.channelIds, ...(approve ? { approve } : {}) };
  }

  async function check(scenario: Scenario) {
    setBusy(scenario);
    setError(null);
    try {
      const r = await api<ReplanResponse>("/api/buffer/replan", body(scenario));
      setRes(r);
      setPicked(r.proposals.filter((p) => p.action === "move").map((p) => p.postId));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function apply(list: Proposal[]) {
    if (!res) return;
    setBusy("apply");
    setError(null);
    try {
      const r = await api<ReplanResponse>("/api/buffer/replan", body(res.scenario, list.map((p) => ({ postId: p.postId, dueAt: p.to!.utc }))));
      setRes((cur) => (cur ? { ...r, proposals: cur.proposals } : r)); // keep the proposals on screen next to what happened to them
      // Posts that really moved in Buffer are remembered at their new time, so the next check still recognises them.
      const movedIds = new Set((r.outcomes ?? []).filter((o) => o.status === "moved").map((o) => o.postId));
      const done = new Map<string, Proposal>();
      for (const p of list) {
        const all = res.proposals.filter((q) => q.specId === p.specId);
        if (all.length > 0 && all.every((q) => movedIds.has(q.postId)) && p.to) done.set(p.specId, p);
      }
      if (done.size > 0) w.setScheduled({ ...sched!, posts: sched!.posts.map((sp) => { const d = done.get(sp.id); return d?.to ? (movePost(sp, d.to.date, d.to.time) ?? sp) : sp; }) });
      setPicked([]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const titleOf = (specId: string) => sched?.posts.find((p) => p.id === specId)?.title ?? specId;
  const moves = res?.proposals.filter((p) => p.action === "move") ?? [];
  const outcome = (id: string) => res?.outcomes?.find((o) => o.postId === id);

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead kicker="6 · Re-plan" title="Let the queue follow the weather">
        Compare today&rsquo;s forecast with the one the posts were written for. If a rainy-day post no longer has rain, Tablecast proposes moving it to a day that does. Nothing changes in Buffer until you approve it.
      </ScreenHead>
      {replay && <div><RecordedTag /></div>}

      {!w.connected ? (
        <EmptyState title="Connect Buffer first" action={<button type="button" onClick={() => w.setStep("connect")} className={BTN_PRIMARY}>Connect Buffer</button>}>Re-planning edits posts that are already in your Buffer queue.</EmptyState>
      ) : !sched || !plan || !plan.location ? (
        <EmptyState title="Nothing to re-plan yet" action={<button type="button" onClick={() => w.setStep(plan ? "schedule" : "week")} className={BTN_PRIMARY}>{plan ? "Send the week to Buffer" : "Pick a week"}</button>}>
          Create this week&rsquo;s posts in Buffer first. Then come back here when the forecast moves.
        </EmptyState>
      ) : (
        <>
          <div className={`${CARD} flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6`}>
            <div className="max-w-xl">
              <p className="font-display text-xl">{sched.posts.length} posts in Buffer for {plan.source.restaurant}</p>
              <p className="mt-1 text-[14px] text-ink-2">
                {replay ? "This is a recorded plan: its original forecast is from the recording, moved forward to this week. " : ""}
                Today&rsquo;s forecast comes from Open-Meteo. Event listings are not re-read.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void check("live")} disabled={busy !== null} className={BTN_PRIMARY}>{busy === "live" ? "Checking" : "Check today's forecast"}</button>
              {replay && <button type="button" onClick={() => void check("simulated")} disabled={busy !== null} className={BTN_SECOND}>{busy === "simulated" ? "Simulating" : "Simulate a forecast change"}</button>}
            </div>
          </div>

          {error != null && <ErrorNotice error={error} onRetry={() => void check(res?.scenario ?? "live")} />}
          {busy && busy !== "apply" && <div className="space-y-3" aria-busy="true" aria-label="Comparing forecasts"><Skeleton className="h-24" /><Skeleton className="h-32" /></div>}

          {res && !busy && (
            <div className="flex flex-col gap-6">
              {res.scenario === "simulated" && (
                <div role="note" className="rounded-2xl border border-saffron/60 bg-saffron/15 px-4 py-3 text-[14px] text-ink">
                  <strong className="font-semibold">Simulated forecast.</strong> One rainy day was dried out and one dry day made rainy, to show how the queue reacts. It is not a real forecast, and the posts it moves are the real drafts in your Buffer.
                </div>
              )}

              <section aria-labelledby="diff-h" className={`${CARD} p-4 sm:p-5`}>
                <h3 id="diff-h" className="font-display text-xl">Forecast: then and now</h3>
                <ul className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
                  {res.diff.map((d) => (
                    <li key={d.date} className={`rounded-xl border p-2.5 ${d.changed ? "border-terracotta/50 bg-terracotta/5" : "border-line bg-paper/60"}`}>
                      <p className="text-[12.5px] font-semibold">{dayLabel(d.date)}</p>
                      <div className="mt-1.5 flex items-center gap-2 text-[12px]">
                        {d.before && <WeatherIcon condition={d.before.condition} size={18} />}<span className="tabular-nums text-muted">{d.before ? formatMm(d.before.precip_mm) : "?"}</span>
                        <IconArrow size={11} className="text-muted" />
                        {d.after ? <><WeatherIcon condition={d.after.condition} size={18} /><span className="tabular-nums font-medium">{formatMm(d.after.precip_mm)}</span></> : <span className="text-muted">no forecast yet</span>}
                      </div>
                      {d.changed && <p className="mt-1 text-[11.5px] font-medium text-terracotta">Rain changed</p>}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12.5px] text-muted">{res.queued} post{res.queued === 1 ? "" : "s"} read from Buffer. {res.eventsRechecked ? "" : "Event listings were not re-read."}</p>
              </section>

              {res.proposals.length === 0 ? (
                <EmptyState title="Nothing to change">The forecast still fits the posts in Buffer, so the queue stays as it is.</EmptyState>
              ) : (
                <section aria-labelledby="prop-h" className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 id="prop-h" className="font-display text-2xl">{res.proposals.length} proposal{res.proposals.length === 1 ? "" : "s"}</h3>
                    {moves.some((m) => !outcome(m.postId)) && (
                      <button type="button" disabled={busy !== null || picked.length === 0} onClick={() => void apply(moves.filter((m) => picked.includes(m.postId) && !outcome(m.postId)))} className={BTN_PRIMARY}>
                        {busy === "apply" ? "Moving" : `Approve ${picked.length} move${picked.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                  </div>
                  <ul className="flex flex-col gap-3">
                    {res.proposals.map((p) => {
                      const o = outcome(p.postId);
                      return (
                        <li key={p.postId} className={`${CARD} p-4 sm:p-5`}>
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{p.action === "move" ? "Move" : "Needs your decision"}</p>
                              <h4 className="font-display text-xl leading-tight">{titleOf(p.specId)}</h4>
                            </div>
                            {p.action === "move" && p.to && (
                              <p className="inline-flex items-center gap-2 rounded-full bg-paper px-3 py-1 text-[13px] tabular-nums"><span className="text-muted line-through">{dayLabel(p.from.date)}, {p.from.time}</span><IconArrow size={12} /><span className="font-medium">{dayLabel(p.to.date)}, {p.to.time}</span></p>
                            )}
                          </div>
                          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{p.reason}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            {p.action === "move" && !o && (
                              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[14px] sm:min-h-9">
                                <input type="checkbox" className="h-4 w-4 accent-[var(--olive)]" checked={picked.includes(p.postId)} onChange={() => setPicked((cur) => (cur.includes(p.postId) ? cur.filter((x) => x !== p.postId) : [...cur, p.postId]))} />
                                Include in the approval
                              </label>
                            )}
                            {p.action === "review" && <a href="https://publish.buffer.com" target="_blank" rel="noreferrer" className="text-[14px] font-medium text-olive underline underline-offset-2">Open Buffer to decide</a>}
                            {o && (
                              <span className={`inline-flex items-center gap-1.5 text-[14px] font-medium ${o.status === "moved" ? "text-olive" : "text-terracotta"}`}>
                                {o.status === "moved" && <IconCheck size={14} />}{o.status === "moved" ? "Moved in Buffer" : `Not moved: ${o.reason ?? "Buffer refused the edit."}`}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {(res.stale?.length ?? 0) > 0 && <p role="alert" className="text-[13px] text-terracotta">The forecast changed while you were deciding, so {res.stale!.length} proposal{res.stale!.length === 1 ? " was" : "s were"} not applied. Check again.</p>}
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
