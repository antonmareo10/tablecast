"use client";

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { DemoSummary } from "./TablecastApp";
import type { OtariStats, PlanPreview } from "@/data/demos";
import { formatMm } from "@/lib/sources/format";
import { useMagnetic } from "./motion";
import { WeatherIcon } from "./weather";
import { IconArrow } from "./icons";

const RAIN_FULL_MM = 20; // a gauge is full at 20 mm of rain in a day

const recorded = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Radar scale: drizzle, rain, storm (the same thresholds everywhere on the board). */
export function rainTone(mm: number): string {
  if (mm >= 10) return "var(--rain-3)";
  if (mm >= 5) return "var(--rain-2)";
  if (mm >= 0.2) return "var(--rain-1)";
  return "var(--line)";
}

/** Split-flap letters: each character on its own flap, flipping in one after another. Decorative: the text is read once, whole. */
export function Flap({ text, delay = 0, className = "" }: { text: string; delay?: number; className?: string }) {
  return (
    <span className={`flap ${className}`} aria-hidden>
      {[...text].map((ch, i) => (
        <span key={i} style={{ "--i": i, "--d": `${delay}ms` } as CSSProperties}>
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

/** What a line of the recorded day-by-day plan is about, from words it contains (nothing is added to the line). */
function tagsFor(action: string, plan: PlanPreview): string[] {
  const a = action.toLowerCase();
  const out: string[] = [];
  if (/supplier order|deliveries/.test(a)) out.push("Order");
  if (plan.dishes.some((d) => a.includes(d.dish.toLowerCase().split(" ").slice(0, 2).join(" ")))) out.push("Dish");
  const eventName = plan.event.split(":")[0].trim().toLowerCase();
  if (eventName.length > 3 && a.includes(eventName)) out.push("Event");
  if (/instagram|\bpost\b/.test(a)) out.push("Post");
  return out;
}

const money = (v: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
  } catch {
    return `${v} ${currency}`;
  }
};

/**
 * The home page's signature: the week a real recorded run read, set as a departures board. One row per day: the sky,
 * the rain gauge (radar scale) and what the recorded plan says to do that day, word for word, then its three dishes.
 * One button replays the run. Everything shown comes from the recording itself and is labelled as recorded.
 */
export default function ReplayWeek({ demos, onPlay, className = "" }: { demos: DemoSummary[]; onPlay: (d: DemoSummary) => void; className?: string }) {
  const runs = demos.filter((d) => d.preview);
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const play = useMagnetic<HTMLButtonElement>(6);
  const id = useId();

  if (!runs.length) return null;
  const run = runs[active] ?? runs[0];
  const week = run.preview!;
  const plan = week.plan;
  const v = week.verification;
  const heaviest = week.days.reduce((m, d) => (d.precip_mm > m ? d.precip_mm : m), 0);

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? runs.length - 1 : step ? (active + step + runs.length) % runs.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setActive(to);
    tabRefs.current[to]?.focus();
  };

  return (
    <section aria-labelledby={`${id}-title`} className={`board relative border border-line bg-card ${className}`}>
      {/* Board header: what this is, that it is recorded, and which run. */}
      <div className="flex flex-wrap items-stretch justify-between border-b border-line font-mono text-[11px] uppercase tracking-[0.08em]">
        <h2 id={`${id}-title`} className="flex min-h-11 items-center gap-2.5 px-4 text-ink sm:px-5">
          <span className="inline-flex items-center gap-1.5 bg-terracotta px-1.5 py-0.5 text-paper">
            <span aria-hidden className="pulse-dot h-1.5 w-1.5 rounded-full bg-paper" />
            Rec
          </span>
          A real run, recorded
        </h2>
        {runs.length > 1 && (
          <div role="tablist" aria-label="Recorded runs" onKeyDown={onKey} className="flex">
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
                onClick={() => setActive(k)}
                className={`relative min-h-11 border-l border-line px-4 uppercase transition-colors sm:px-5 ${
                  k === active ? "bg-olive text-paper" : "text-ink-2 hover:bg-paper-2 hover:text-ink"
                }`}
              >
                {d.city}
              </button>
            ))}
          </div>
        )}
      </div>

      <div key={run.slug} id={`${id}-panel`} role="tabpanel" aria-labelledby={runs.length > 1 ? `${id}-tab-${active}` : `${id}-title`}>
        {/* Which restaurant, when, and the plan's own headline. */}
        <div className="grid gap-x-6 gap-y-2 border-b border-line px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <p className="font-display text-[34px] uppercase leading-[0.9] sm:text-[40px]">
              {run.restaurant}
              <span className="text-muted">
                <span className="max-sm:hidden"> · </span>
                <span className="max-sm:block">{run.city}</span>
              </span>
            </p>
            <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
              Recorded {recorded(run.recordedAt)} · {week.writer === "economy" ? "Writer: Nemotron 3 Super" : "Writer: Nemotron 3 Ultra"}
              {week.otari ? " on Otari" : ""}
            </p>
            {plan?.headline && <p className="mt-2 max-w-2xl text-[14px] leading-snug text-ink-2">“{plan.headline}”</p>}
          </div>
          <div className="flex flex-col gap-2 max-lg:order-first max-lg:mb-1 lg:items-end">
            <button
              ref={play}
              type="button"
              onClick={() => onPlay(run)}
              className="magnetic group inline-flex min-h-13 items-center justify-center gap-3 bg-olive px-6 font-mono text-[13px] font-semibold uppercase tracking-[0.06em] text-paper hover:bg-ink"
            >
              <svg aria-hidden width="11" height="12" viewBox="0 0 8 9" fill="currentColor">
                <path d="M0 0.6v7.8L7.2 4.5z" />
              </svg>
              Watch this run
              <span className="sr-only">: {run.restaurant}, {run.city} (recorded, plays at once)</span>
              <IconArrow size={15} className="nudge" />
            </button>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">Plays at once · labelled as recorded</p>
          </div>
        </div>

        {/* The week, one row per day. */}
        <div role="table" aria-label={`The week ${run.restaurant} faced, and the recorded plan for each day`} className="text-[14px]">
          <div role="rowgroup" className="hidden border-b border-line font-mono text-[10px] uppercase tracking-[0.1em] text-muted sm:block">
            <div role="row" className="board-row py-2">
              <span role="columnheader">Day</span>
              <span role="columnheader">Sky</span>
              <span role="columnheader">Rain</span>
              <span role="columnheader">What the plan says</span>
              <span role="columnheader" className="max-sm:sr-only">Moves</span>
            </div>
          </div>
          <div role="rowgroup">
            {week.days.map((day, k) => {
              const mm = formatMm(day.precip_mm); // same rounding as the forecast the claims cite
              const wet = day.precip_mm >= 0.2;
              const storm = day.precip_mm >= 5 && day.precip_mm === heaviest;
              const line = plan?.days.find((p) => p.day.startsWith(`${day.weekday.slice(0, 3)} ${Number(day.date.slice(8, 10))} `)) ?? plan?.days[k];
              const [lead, ...rest] = (line?.action ?? "").split(/;\s*/);
              const tags = line && plan ? tagsFor(line.action, plan) : [];
              const events = week.events[day.date] ?? 0;
              const holiday = week.holidays[day.date];
              const delay = 140 + k * 70;
              return (
                <div
                  role="row"
                  key={day.date}
                  className={`board-row relative border-b border-line py-2.5 last:border-b-0 ${storm ? "bg-[color-mix(in_srgb,var(--rain-3)_7%,transparent)]" : ""}`}
                >
                  {storm && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-rain-3" />}
                  <span role="rowheader" className="flex items-center gap-1.5 self-start pt-0.5">
                    <Flap text={day.weekday.slice(0, 3).toUpperCase()} delay={delay} className="text-[15px]" />
                    <Flap text={day.date.slice(8, 10)} delay={delay + 100} className="text-[15px] text-olive" />
                    <span className="sr-only">
                      {day.weekday} {Number(day.date.slice(8, 10))}
                    </span>
                  </span>
                  <span role="cell" className="flex min-w-0 items-center gap-1.5 self-start">
                    <WeatherIcon condition={day.condition} size={24} />
                    <span className="font-mono text-[14px] tabular-nums text-ink">{Math.round(day.tmax)}°</span>
                  </span>
                  <span role="cell" className="grid gap-1 self-start pt-1">
                    <span className="flex items-center gap-2">
                    <span aria-hidden className="relative h-[6px] w-14 overflow-hidden bg-paper-2 sm:w-16">
                      <span
                        className="gauge absolute inset-y-0 left-0 block"
                        style={
                          {
                            width: `${Math.max(wet ? 6 : 0, Math.min(1, day.precip_mm / RAIN_FULL_MM) * 100)}%`,
                            background: rainTone(day.precip_mm),
                            "--d": `${delay + 160}ms`,
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className={`font-mono text-[12px] tabular-nums ${wet ? "text-ink" : "text-muted"}`}>
                      {mm}
                      <span className="text-muted"> mm</span>
                    </span>
                    </span>
                    <span className={`truncate font-mono text-[10px] uppercase tracking-[0.06em] ${storm ? "text-rain-3" : "text-muted"}`}>{day.condition}</span>
                  </span>
                  <span role="cell" className="board-plan min-w-0">
                    {line ? (
                      <span className="block text-[14px] leading-snug text-ink">
                        {lead}
                        {rest.length > 0 && <span className="text-muted">; {rest.join("; ")}</span>}
                      </span>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </span>
                  <span role="cell" className="board-tags">
                    {(tags.length > 0 || events > 0 || holiday) && (
                      <span className="flex flex-wrap gap-1 font-mono text-[10px] uppercase tracking-[0.08em] sm:flex-col sm:items-start">
                        {tags.map((t) => (
                          <span key={t} className="border border-olive/60 px-1.5 py-px text-olive">
                            {t}
                          </span>
                        ))}
                        {events > 0 && (
                          <span className="border border-terracotta/60 px-1.5 py-px text-terracotta">
                            {events} event{events > 1 ? "s" : ""} within 5 km
                          </span>
                        )}
                        {holiday && <span className="border border-saffron/60 px-1.5 py-px text-saffron">{holiday}</span>}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* The three dishes the run proposed, as written. */}
        {plan && plan.dishes.length > 0 && (
          <div className="grid border-t border-line sm:grid-cols-3">
            {plan.dishes.map((d, i) => (
              <div key={d.dish} className="border-line px-4 py-3 max-sm:border-b sm:border-l sm:px-5 sm:first:border-l-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                  Dish {i + 1} · {money(d.price, plan.currency)}
                </p>
                <p className="mt-1 text-[14px] font-semibold leading-snug text-ink">{d.dish}</p>
                <p className="mt-0.5 font-mono text-[11px] leading-snug text-olive">{d.when}</p>
              </div>
            ))}
          </div>
        )}

        {/* Proof and the one action: replay it. */}
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {v && (
              <p className="flex items-end gap-2.5">
                <span className="font-display text-[56px] leading-[0.8] text-olive tabular-nums">
                  <span aria-hidden className="css-count" style={{ "--to": v.verified, "--d": "500ms" } as CSSProperties} />
                  <span className="sr-only">{v.verified}</span>
                  <span className="text-[28px] text-muted">/{v.checked}</span>
                </span>
                <span className="pb-0.5 font-mono text-[11px] uppercase leading-snug tracking-[0.05em] text-ink-2">
                  cited claims checked
                  <br />
                  in code · {v.sources} sources
                </span>
              </p>
            )}
            {week.onOtari?.billed != null && (
              <p className="flex items-end gap-2.5">
                <span className="font-display text-[56px] leading-[0.8] tabular-nums text-ink">${week.onOtari.billed.toFixed(3)}</span>
                <span className="pb-0.5 font-mono text-[11px] uppercase leading-snug tracking-[0.05em] text-ink-2">
                  billed by Otari
                  <br />
                  for this run
                </span>
              </p>
            )}
          </div>
        </div>
        {week.onOtari && <OnOtari stats={week.onOtari} />}
      </div>
    </section>
  );
}

/** What Otari did in the recorded run: who served each role, and the searches, MCP reads and guardrail checks. */
function OnOtari({ stats }: { stats: OtariStats }) {
  const roles = [
    stats.researcher && ["Research", stats.researcher],
    stats.writer && ["Writing", stats.writer],
    stats.sandbox && ["Sandbox code", stats.sandbox],
  ].filter(Boolean) as [string, string][];
  const counts = [
    `${stats.searches} web search${stats.searches === 1 ? "" : "es"}`,
    `${stats.mcpReads} page${stats.mcpReads === 1 ? "" : "s"} read over MCP`,
    `${stats.screened} source${stats.screened === 1 ? "" : "s"} through the guardrail`,
  ];
  return (
    <div className="border-t border-line bg-paper-2/60 px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-2 sm:px-5">
      <p className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span className="uppercase tracking-[0.08em] text-olive">On Otari</span>
        {roles.map(([role, model]) => (
          <span key={role}>
            <span className="text-muted">{role}:</span> {model}
          </span>
        ))}
      </p>
      <p className="mt-0.5 tabular-nums text-muted">{counts.join(" · ")}</p>
    </div>
  );
}
