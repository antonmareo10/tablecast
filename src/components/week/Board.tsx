"use client";

import { useMemo, useState, type DragEvent } from "react";
import { LayoutGroup, m } from "motion/react";
import type { PostSpec } from "@/lib/post-writer";
import { boardDays, TAG_DOT, tagLabel, type BoardDay } from "@/lib/week";
import { IconArrow } from "../icons";
import { SPRING } from "../motion";
import { useToast } from "../toast";
import { WeatherIcon } from "../weather";
import type { DemoSummary } from "../TablecastApp";
import { BTN_PRIMARY, BTN_SECOND, BTN_SMALL, CARD, EmptyState, ErrorNotice, FIELD, longDate, RecordedTag, ScreenHead, Skeleton } from "./parts";
import { LIVE_KEY, type WeekStore } from "./store";

const RAIN_FULL_MM = 20;

export default function Board({ w, demos }: { w: WeekStore; demos: DemoSummary[] }) {
  if (w.planState.loading) return <BoardSkeleton />;
  if (!w.plan) return <Picker w={w} demos={demos} />;
  return <Week w={w} />;
}

// ---- Choose a week -----------------------------------------------------------------------------------------------

function Picker({ w, demos }: { w: WeekStore; demos: DemoSummary[] }) {
  const [hasLive] = useState(() => {
    try { return Boolean(sessionStorage.getItem(LIVE_KEY)); } catch { return false; }
  });
  const runs = demos.filter((d) => d.preview);
  function useLive() {
    try {
      const raw = sessionStorage.getItem(LIVE_KEY);
      if (raw) void w.loadPlan({ live: JSON.parse(raw) });
    } catch { /* unreadable hand-off: the picker stays */ }
  }
  return (
    <div className="flex flex-col gap-6">
      <ScreenHead kicker="2 · The week" title="Pick a week to plan">
        Each week below is a real agent run, recorded and replayed, so you can try the whole flow without waiting for the agent. The posts are written from its verified plan with no model call.
      </ScreenHead>
      {w.planState.error != null && <ErrorNotice error={w.planState.error} />}
      {hasLive && (
        <div className="flex flex-col gap-3 rounded-2xl border border-olive/30 bg-olive/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div><p className="font-display text-xl">Your live run is ready</p><p className="text-[14px] text-ink-2">The plan you just generated, written into posts with the same verified sources.</p></div>
          <button type="button" onClick={useLive} className={BTN_PRIMARY}>Plan my live week <IconArrow size={14} /></button>
        </div>
      )}
      <ul className="grid gap-4 sm:grid-cols-2">
        {runs.map((d, i) => (
          <m.li key={d.slug} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0, transition: { ...SPRING, delay: i * 0.06 } }}>
            <button type="button" onClick={() => void w.loadPlan({ plan: d.slug })} className={`lift ${CARD} group flex w-full flex-col gap-3 p-5 text-left`}>
              <span className="flex items-start justify-between gap-3">
                <span><span className="font-display block text-2xl leading-tight">{d.restaurant}</span><span className="text-[13px] text-muted">{d.city}</span></span>
                <RecordedTag />
              </span>
              <span className="flex gap-1" aria-hidden>
                {d.preview!.days.slice(0, 7).map((day) => (
                  <span key={day.date} className="flex flex-1 flex-col items-center gap-1 rounded-lg bg-paper py-1.5">
                    <WeatherIcon condition={day.condition} size={18} />
                    <span className="h-1 w-3/4 rounded-full bg-line"><span className="block h-full rounded-full bg-olive-2" style={{ width: `${Math.min(100, (day.precip_mm / RAIN_FULL_MM) * 100)}%` }} /></span>
                  </span>
                ))}
              </span>
              <span className="flex items-center justify-between text-[13px] text-ink-2">
                <span>Recorded {longDate(d.recordedAt)}</span>
                <span className="inline-flex items-center gap-1 font-medium text-olive">Write the posts <IconArrow size={13} className="nudge" /></span>
              </span>
            </button>
          </m.li>
        ))}
      </ul>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Writing the posts">
      <Skeleton className="h-24 max-w-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-72" />)}</div>
    </div>
  );
}

// ---- The board ---------------------------------------------------------------------------------------------------

function Week({ w }: { w: WeekStore }) {
  const plan = w.plan!;
  const toast = useToast();
  const days = useMemo(() => boardDays(w.active, plan.snapshot.days, plan.snapshot.events), [w.active, plan]);
  const [openMove, setOpenMove] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const replay = plan.source.kind === "replay";

  function dropOn(e: DragEvent, day: BoardDay) {
    e.preventDefault();
    setOverDay(null);
    const id = e.dataTransfer.getData("text/plain");
    const post = w.posts.find((p) => p.id === id);
    if (!post || post.post_at.date === day.date) return;
    const err = w.movePost(id, day.date, post.post_at.time);
    toast(err ?? `Moved to ${day.label}, same time`);
  }

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead
        kicker="2 · The week"
        title={`${plan.source.restaurant}: ${w.active.length} post${w.active.length === 1 ? "" : "s"} for the week`}
        aside={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => w.reset()} className={BTN_SECOND}>Change week</button>
            <button type="button" onClick={() => w.setStep("review")} className={BTN_PRIMARY}>Review the posts <IconArrow size={14} /></button>
          </div>
        }
      >
        Each post sits on the day it is for, at the time it should go out in {plan.source.timezone.replace("_", " ")}, with the reason it exists. Drag a card to another day, or use Move.
      </ScreenHead>

      {replay && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-saffron/50 bg-saffron/10 px-4 py-3 text-[14px] text-ink-2">
          <RecordedTag />
          <span>
            Recorded {plan.source.kind === "replay" ? longDate(plan.source.recordedAt) : ""}. The forecast, events and sources are from that run
            {plan.shiftDays > 0 ? `; the dates were moved forward ${plan.shiftDays} days so the posts lie ahead of today, weekdays unchanged` : ""}.
          </span>
        </div>
      )}
      {plan.problems.length > 0 && <ErrorNotice error={new Error("Some post times did not pass the date check.")}><ul className="mt-2 list-disc pl-5 text-[13px]">{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul></ErrorNotice>}
      {plan.skipped.length > 0 && (
        <details className="rounded-2xl border border-line bg-card/70 px-4 py-3 text-[14px] text-ink-2">
          <summary className="cursor-pointer font-medium text-ink">{plan.skipped.length} post{plan.skipped.length === 1 ? "" : "s"} left out</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{plan.skipped.map((s) => <li key={s.id}>{s.title}: {s.reason}</li>)}</ul>
        </details>
      )}

      {w.active.length === 0 ? (
        <EmptyState title="Every post was removed" action={<button type="button" onClick={() => w.setStep("review")} className={BTN_SECOND}>Restore posts in Review</button>}>
          Nothing would be sent. Bring posts back in Review, or change the week.
        </EmptyState>
      ) : (
        <LayoutGroup>
          <ol className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,11.5rem),1fr))]" aria-label="Days of the week">
            {days.map((d, i) => (
              <li
                key={d.date}
                onDragOver={(e) => { e.preventDefault(); if (overDay !== d.date) setOverDay(d.date); }}
                onDragLeave={() => setOverDay((cur) => (cur === d.date ? null : cur))}
                onDrop={(e) => dropOn(e, d)}
                className={`rise flex min-w-0 flex-col gap-2 rounded-2xl border p-2.5 transition-colors ${overDay === d.date ? "border-olive bg-olive/10" : "border-line bg-paper-2/40"}`}
                style={{ "--d": `${i * 50}ms` } as React.CSSProperties}
              >
                <DayHead d={d} />
                <ul className="flex min-h-14 flex-col gap-2">
                  {d.posts.map((p) => (
                    <PostCard key={p.id} post={p} image={w.images[p.id]} open={openMove === p.id} onOpenMove={(o) => setOpenMove(o ? p.id : null)} w={w} days={days} />
                  ))}
                  {d.posts.length === 0 && <li className="grid flex-1 place-items-center rounded-xl border border-dashed border-line/80 px-2 py-4 text-center text-[12px] text-muted">No post</li>}
                </ul>
              </li>
            ))}
          </ol>
        </LayoutGroup>
      )}
    </div>
  );
}

function DayHead({ d }: { d: BoardDay }) {
  const f = d.forecast;
  const rain = f ? Math.min(100, (f.precip_mm / RAIN_FULL_MM) * 100) : 0;
  return (
    <div className="rounded-xl bg-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-[17px] leading-none">{d.label}</h3>
        {f && <WeatherIcon condition={f.condition} size={22} />}
      </div>
      {f ? (
        <>
          <p className="mt-1.5 text-[12px] capitalize text-ink-2">{f.condition}, {Math.round(f.tmax)}° / {Math.round(f.tmin)}°</p>
          <div className="mt-1.5 flex items-center gap-2" title={`${f.precip_mm} mm of rain`}>
            <span className="h-1.5 flex-1 rounded-full bg-line" aria-hidden><span className="block h-full rounded-full bg-olive-2" style={{ width: `${rain}%` }} /></span>
            <span className="text-[11px] tabular-nums text-muted">{f.precip_mm} mm</span>
          </div>
        </>
      ) : <p className="mt-1.5 text-[12px] text-muted">No forecast for this day</p>}
      {d.events.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-line pt-1.5">
          {d.events.slice(0, 2).map((e) => (
            <li key={e.id} className="truncate text-[11.5px] text-plum" title={`${e.name}${e.time ? `, ${e.time}` : ""}`}>{e.time ? `${e.time} ` : ""}{e.name}</li>
          ))}
          {d.events.length > 2 && <li className="text-[11px] text-muted">+{d.events.length - 2} more nearby</li>}
        </ul>
      )}
    </div>
  );
}

function PostCard({ post, image, open, onOpenMove, w, days }: { post: PostSpec; image?: string; open: boolean; onOpenMove: (o: boolean) => void; w: WeekStore; days: BoardDay[] }) {
  const [why, setWhy] = useState(false);
  const dot = TAG_DOT[post.tag] ?? "#6F6759";
  return (
    <li
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", post.id); e.dataTransfer.effectAllowed = "move"; }}
      className="min-w-0 cursor-grab active:cursor-grabbing"
    >
    <m.div
      layoutId={`post-${post.id}`}
      transition={SPRING}
      className="rounded-xl border border-line bg-card p-3 shadow-[0_1px_0_rgba(29,27,23,0.03)]"
    >
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- generated PNG from our own route
        <img src={image} alt="" width={540} height={540} loading="lazy" className="mb-2 aspect-square w-full rounded-lg border border-line bg-paper object-cover" draggable={false} />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-md bg-ink px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-paper">{post.post_at.time}</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden />{tagLabel(post.tag)}</span>
      </div>
      <h4 className="mt-2 text-[13.5px] font-semibold leading-snug">{post.title}</h4>
      <p className="mt-1 line-clamp-4 text-[12.5px] leading-relaxed text-ink-2">{post.text}</p>

      {post.why_now.text && (
        <button type="button" aria-expanded={why} onClick={() => setWhy((v) => !v)} className="hit mt-2 flex min-h-8 w-full items-center gap-1.5 rounded-lg bg-olive/10 px-2 text-left text-[12px] font-medium text-olive transition hover:bg-olive/15">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${post.why_now.verified ? "bg-olive" : "bg-saffron"}`} aria-hidden />
          <span className="truncate">Why now</span>
          <span className="ml-auto text-[11px] text-olive/80">{post.why_now.verified ? "verified" : "unchecked"}</span>
        </button>
      )}
      {why && (
        <div className="rise mt-2 rounded-lg border border-line bg-paper px-2.5 py-2 text-[12px] leading-relaxed text-ink-2">
          <p>{post.why_now.text}</p>
          {post.why_now.cites.map((c) => (
            <blockquote key={c.source + c.quote} className="mt-1.5 border-l-2 border-saffron pl-2 italic">“{c.quote}”
              <span className="mt-0.5 block text-[11px] not-italic text-muted">{c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">{c.title ?? c.source}</a> : (c.title ?? c.source)}</span>
            </blockquote>
          ))}
        </div>
      )}
      {post.issues.length > 0 && <p className="mt-2 rounded-lg bg-saffron/15 px-2 py-1 text-[11.5px] leading-snug text-ink-2">Check before sending: {post.issues[0]}</p>}

      <button type="button" aria-expanded={open} onClick={() => onOpenMove(!open)} className={`${BTN_SMALL} mt-2 w-full`}>Move</button>
      {open && <MovePanel post={post} days={days} w={w} close={() => onOpenMove(false)} />}
    </m.div>
    </li>
  );
}

function MovePanel({ post, days, w, close }: { post: PostSpec; days: BoardDay[]; w: WeekStore; close: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(post.post_at.date);
  const [time, setTime] = useState(post.post_at.time);
  const [err, setErr] = useState<string | null>(null);
  const id = `mv-${post.id}`;
  function apply() {
    const e = w.movePost(post.id, date, time);
    setErr(e);
    if (!e) { toast(`Moved to ${days.find((d) => d.date === date)?.label ?? date}, ${time}`); close(); }
  }
  return (
    <form className="rise mt-2 space-y-2 rounded-lg border border-line bg-paper p-2.5" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <label htmlFor={`${id}-d`} className="block text-[11px] font-semibold uppercase tracking-wide text-muted">Day</label>
      <select id={`${id}-d`} value={date} onChange={(e) => setDate(e.target.value)} className={`${FIELD} !py-2 !text-[14px]`}>
        {days.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
      </select>
      <label htmlFor={`${id}-t`} className="block text-[11px] font-semibold uppercase tracking-wide text-muted">Time ({post.post_at.timezone.split("/").pop()?.replace("_", " ")})</label>
      <input id={`${id}-t`} type="time" value={time} onChange={(e) => setTime(e.target.value)} required className={`${FIELD} !py-2 !text-[14px]`} />
      {err && <p role="alert" className="text-[12px] text-terracotta">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" className={`${BTN_SMALL} flex-1 !bg-ink !text-paper hover:!bg-olive`}>Apply</button>
        <button type="button" onClick={close} className={`${BTN_SMALL} flex-1`}>Cancel</button>
      </div>
    </form>
  );
}
