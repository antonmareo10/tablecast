"use client";

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { DemoSummary } from "./TablecastApp";
import { formatMm } from "@/lib/sources/format";
import { useMagnetic, usePillClip } from "./motion";
import { WeatherIcon } from "./weather";
import { IconArrow } from "./icons";

const RAIN_FULL_MM = 20; // a bar is full at 20 mm of rain in a day

const recorded = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * The home page's instant-replay card: the week a real recorded run read (forecast, events nearby, holidays) and
 * how many of its claims passed the code check, with one button to replay it. Everything shown comes from the
 * recording itself and is labelled as recorded.
 */
export default function ReplayWeek({ demos, onPlay, className = "" }: { demos: DemoSummary[]; onPlay: (d: DemoSummary) => void; className?: string }) {
  const runs = demos.filter((d) => d.preview);
  const [active, setActive] = useState(0);
  const tabs = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const play = useMagnetic<HTMLButtonElement>(6);
  const id = useId();
  usePillClip(tabs, active);

  if (!runs.length) return null;
  const run = runs[active] ?? runs[0];
  const week = run.preview!;
  const v = week.verification;
  const hasEvents = Object.keys(week.events).length > 0;
  const hasHoliday = Object.keys(week.holidays).length > 0;

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? runs.length - 1 : step ? (active + step + runs.length) % runs.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setActive(to);
    tabRefs.current[to]?.focus();
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`relative rounded-2xl border border-olive/25 bg-card/90 p-4 shadow-[0_1px_0_rgba(29,27,23,0.04),0_22px_44px_-30px_rgba(47,74,53,0.45)] sm:p-5 ${className}`}
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-[14px] font-semibold text-olive">
        <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-olive text-paper">
          <svg width="8" height="9" viewBox="0 0 8 9" fill="currentColor">
            <path d="M0 0.6v7.8L7.2 4.5z" />
          </svg>
        </span>
        Watch a real recorded run — no wait
      </h2>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-terracotta/25 bg-terracotta/5 px-2 py-px text-[10px] font-semibold uppercase tracking-[0.12em] text-terracotta">
          <span aria-hidden className="pulse-ring relative h-1.5 w-1.5 rounded-full bg-terracotta" />
          Recorded
        </span>
        Instant replays of live runs, labelled as recorded.
      </p>

      {runs.length > 1 && (
        <div ref={tabs} className="relative mt-3.5">
          <div role="tablist" aria-label="Recorded runs" onKeyDown={onKey} className="flex gap-1 rounded-full border border-line bg-paper/70 p-1">
            {runs.map((d, k) => (
              <button
                key={d.slug}
                ref={(el) => {
                  tabRefs.current[k] = el;
                }}
                id={`${id}-tab-${k}`}
                type="button"
                role="tab"
                aria-selected={k === active}
                aria-controls={`${id}-panel`}
                tabIndex={k === active ? 0 : -1}
                data-pill-item=""
                data-active={k === active}
                onClick={() => setActive(k)}
                className="min-h-10 flex-1 truncate rounded-full px-2 text-[13px] text-ink-2 transition-colors hover:text-ink sm:px-3"
              >
                {d.city}
              </button>
            ))}
          </div>
          <div aria-hidden className="pill-layer pointer-events-none absolute inset-0 flex gap-1 rounded-full border border-transparent bg-olive p-1">
            {runs.map((d) => (
              <span key={d.slug} className="grid min-h-10 flex-1 place-items-center truncate px-2 text-[13px] font-medium text-paper sm:px-3">
                {d.city}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        key={run.slug}
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={runs.length > 1 ? `${id}-tab-${active}` : `${id}-title`}
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <p className="rise text-[13px] leading-snug text-ink-2">
          <strong className="font-semibold text-ink">{run.restaurant}</strong>, {run.city} · recorded {recorded(run.recordedAt)}
          {week.writer ? (
            <span className="ml-1.5 inline-flex rounded-full border border-line bg-paper/70 px-2 py-px align-[1px] text-[11px] font-medium text-ink-2">
              {week.writer === "economy" ? "Economy · Nemotron Super" : "Quick · Nemotron Ultra"}
            </span>
          ) : null}
          {run.goal ? <span className="block text-muted">Goal: “{run.goal}”</span> : null}
        </p>
        <button
          ref={play}
          type="button"
          onClick={() => onPlay(run)}
          className="magnetic group order-last inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-olive px-5 text-[14px] font-medium text-paper hover:bg-ink sm:order-none"
        >
          Watch this run
          <span className="sr-only">: {run.restaurant}, {run.city}</span>
          <IconArrow size={15} className="nudge" />
        </button>

        <ol className="grid grid-cols-7 gap-1 sm:col-span-2 sm:gap-1.5" aria-label={`The week ${run.restaurant} faced`}>
          {week.days.map((day, k) => {
            const events = week.events[day.date] ?? 0;
            const holiday = week.holidays[day.date];
            const rain = Math.min(1, day.precip_mm / RAIN_FULL_MM);
            const mm = formatMm(day.precip_mm); // same rounding as the forecast the claims cite
            const delay = { "--d": `${120 + k * 55}ms` } as CSSProperties;
            return (
              <li
                key={day.date}
                style={delay}
                className={`rise relative flex min-w-0 flex-col items-center rounded-xl border px-0.5 py-1.5 text-center ${
                  holiday ? "border-saffron/70 bg-saffron/10" : "border-line bg-paper/50"
                }`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{day.weekday.slice(0, 3)}</span>
                <span className="text-[11px] leading-none tabular-nums text-ink-2">{Number(day.date.slice(8, 10))}</span>
                <WeatherIcon condition={day.condition} size={24} className="mt-1" />
                <span className="mt-0.5 text-[13px] font-semibold tabular-nums">{Math.round(day.tmax)}°</span>
                <span className="sr-only">
                  {day.condition}
                  {mm !== "0.0" ? `, ${mm} mm of rain` : ""}
                  {events ? `, ${events} event${events > 1 ? "s" : ""} nearby` : ""}
                  {holiday ? `, ${holiday}` : ""}
                </span>
                <span aria-hidden className="mt-1 flex h-5 w-1.5 items-end overflow-hidden rounded-full bg-paper-2">
                  <span className="bar-grow block w-full rounded-full bg-olive-2" style={{ height: `${rain * 100}%`, ...delay }} />
                </span>
                <span aria-hidden className={`mt-0.5 text-[10px] tabular-nums ${day.precip_mm >= 1 ? "font-semibold text-olive" : "text-muted"}`}>
                  {mm !== "0.0" ? mm : "–"}
                </span>
                {events > 0 && (
                  <span aria-hidden style={delay} className="pop mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-terracotta">
                    <span className="h-1.5 w-1.5 rounded-full bg-terracotta" />
                    {events}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3 sm:col-span-2">
          {v && (
            <p className="flex items-baseline gap-2">
              <span className="font-display text-4xl leading-none text-olive tabular-nums">
                <span aria-hidden className="css-count" style={{ "--to": v.verified, "--d": "450ms" } as CSSProperties} />
                <span className="sr-only">{v.verified}</span>
              </span>
              <span className="text-[13px] leading-tight text-ink-2">
                <span className="tabular-nums">/ {v.checked}</span> claims verified
                <br />
                against {v.sources} sources
              </span>
            </p>
          )}
          <p aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-1 rounded-full bg-olive-2" /> rain, mm
            </span>
            {hasEvents && (
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-terracotta" /> events within 5 km
              </span>
            )}
            {hasHoliday && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-3 rounded-sm border border-saffron/70 bg-saffron/10" /> public holiday
              </span>
            )}
            <span>Open-Meteo · Ticketmaster · Nager.Date</span>
          </p>
        </div>
      </div>
    </section>
  );
}
