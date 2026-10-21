"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { DayForecast, EngineCall, Evidence, Holiday, MenuItem, NearbyEvent, Place, Playbook, Source, Venue } from "@/lib/types";
import { PRICES_RETRIEVED, PRICES_SOURCE } from "@/lib/nebius-pricing";
import { formatMm } from "@/lib/sources/format";
import { cleanMenu } from "@/lib/menu";
import { IconAlert, IconBasket, IconCheck, IconDownload, IconMap, IconMegaphone, IconMusic, IconPlate, IconSpark, IconTrend, IconUsers } from "./icons";
import { CopyButton, CountUp, EvidenceLine, Pill, Section, SourcesProvider } from "./ui";
import ShareAssets from "./ShareAssets";

const BlockMap = dynamic(() => import("./BlockMap"), {
  ssr: false,
  loading: () => <div className="h-[360px] animate-pulse rounded-xl bg-paper-2" />,
});

export type LiveState = {
  place?: Place;
  week?: { days: DayForecast[]; holidays: Holiday[]; events: NearbyEvent[] };
  block?: { radius_m: number; total: number; venues: Venue[]; by_cuisine: { cuisine: string; count: number }[] };
  menu?: { items: MenuItem[]; from: "web" | "photo"; url?: string };
  sources: Source[];
  baseline?: string;
  playbook?: Playbook;
  draft?: Record<string, unknown>;
  engine: EngineCall[];
  tavilyCredits?: number;
  writer?: string; // the Nemotron writing the plan, as the agent announced it
};

function money(v: number, currency: string): string {
  try {
    return v.toLocaleString("en-GB", { style: "currency", currency: currency || "EUR", maximumFractionDigits: 2 });
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

export default function PlaybookView({ live, running, language }: { live: LiveState; running: boolean; language?: "English" | "Español" }) {
  const p = live.playbook;
  const sourceMap = useMemo(() => new Map(live.sources.map((s) => [s.id, s] as const)), [live.sources]);
  const name = p?.restaurant.name ?? live.place?.name;

  return (
    <SourcesProvider value={sourceMap}>
      <div className="space-y-5">
        {(live.place || p) && <Hero live={live} running={running} />}

        {p && !running && (
          // One row at every width: short labels on a phone, and it scrolls sideways rather than wrapping.
          <nav
            aria-label="Playbook sections"
            className="no-print sticky top-2 z-[1100] flex gap-0.5 overflow-x-auto whitespace-nowrap rounded-full border border-line bg-card/90 p-1.5 backdrop-blur [scrollbar-width:none] sm:gap-2"
          >
            {[
              ["act-week", "1 · ", "Your week", ""],
              ["act-moves", "2 · ", "The moves", ""],
              ["act-launch", "3 · ", "Launch", ""],
              ["act-proof", "", "Proof", " & engine"],
            ].map(([id, n, label, more]) => (
              <a
                key={id}
                href={`#${id}`}
                className="shrink-0 rounded-full px-2.5 py-1 text-[13px] text-ink-2 transition hover:bg-paper hover:text-ink sm:px-3"
              >
                <span className="hidden sm:inline">{n}</span>
                {label}
                <span className="hidden sm:inline">{more}</span>
              </a>
            ))}
          </nav>
        )}

        {live.week && (live.week.days.length > 0 || live.week.events.length > 0) && (
          <>
            <ActHeader
              id="act-week"
              n={1}
              title="Your week"
              subtitle="What changes demand around you over the next 7 days — forecast, holidays, events and local news."
            />
            <WeekStrip days={live.week.days} holidays={live.week.holidays} events={live.week.events} />
          </>
        )}

        {p && p.moments.length > 0 && <Moments playbook={p} />}

        {live.block && live.place && (
          <Section icon={<IconMap size={16} />} kicker="Your block" title={`${live.block.total} food & drink venues within ${live.block.radius_m} m`}>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <BlockMap
                center={[live.place.lat, live.place.lon]}
                name={name ?? "You"}
                radiusM={live.block.radius_m}
                venues={live.block.venues}
                cuisine={live.place.cuisine}
              />
              <div className="min-w-0">
                <CuisineBars data={live.block.by_cuisine} highlight={live.place.cuisine} />
                {p?.rivals && (
                  <div className="mt-4">
                    <p className="text-sm leading-relaxed text-ink-2">{p.rivals.summary}</p>
                    {p.rivals.evidence.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {p.rivals.evidence.map((e, i) => (
                          <EvidenceLine key={i} evidence={e} />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Section>
        )}

        {p && (p.snapshot.loved_for.length > 0 || p.snapshot.watch_outs.length > 0 || p.snapshot.summary) && <Snapshot playbook={p} />}

        {live.menu && live.menu.items.length > 0 && <MenuNow menu={live.menu} currency={p?.currency} />}

        {running && live.draft && !p && <DraftPreview draft={live.draft} writer={live.writer} />}

        {p && (
          <>
            <ActHeader
              id="act-moves"
              n={2}
              title="The moves"
              subtitle="Three dishes to test this week, tied to the days they suit and to what your guests already love."
            />
            <MenuMoves playbook={p} />

            <div className="grid gap-5 lg:grid-cols-2">
              <Section icon={<IconMusic size={16} />} kicker="This week's event" title={p.experience.event_idea}>
                <p className="text-sm leading-relaxed text-ink-2">{p.experience.event_why}</p>
                {p.experience.evidence.length > 0 && (
                  <ul className="mt-3 space-y-2 border-t border-line pt-3">
                    {p.experience.evidence.map((e, i) => (
                      <EvidenceLine key={i} evidence={e} />
                    ))}
                  </ul>
                )}
              </Section>
              <Section
                icon={<IconMegaphone size={16} />}
                kicker="Local marketing"
                title="Ready-to-post"
                aside={<CopyButton text={p.marketing.instagram_post} label="Copy post" />}
              >
                <p className="whitespace-pre-line rounded-xl border border-line bg-paper/50 p-4 text-sm leading-relaxed">{p.marketing.instagram_post}</p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="font-semibold">When</dt>
                  <dd className="text-ink-2">{p.marketing.post_when}</dd>
                  <dt className="font-semibold">For</dt>
                  <dd className="text-ink-2">{p.marketing.audience}</dd>
                </dl>
              </Section>
            </div>

            <ActHeader id="act-launch" n={3} title="Launch" subtitle="Print-ready specials, the supplier order and the plan for the next 7 days." />
            <ShareAssets playbook={p} language={language} />
            <ShoppingList playbook={p} />
            {p.week_plan.length > 0 && <WeekPlan playbook={p} />}

            {p.caveats.length > 0 && (
              <section className="rounded-2xl border border-dashed border-line px-5 py-4 text-[13px] leading-relaxed text-muted">
                <p className="font-semibold text-ink-2">What the data can’t tell us</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {p.caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </section>
            )}

            <ActHeader
              id="act-proof"
              n={4}
              title="Proof & engine"
              subtitle="Every source this plan stands on, how each claim was checked, and what it cost to produce."
            />
            {live.baseline && <Compare baseline={live.baseline} playbook={p} engine={live.engine} />}
            <SourcesLedger sources={live.sources} playbook={p} />
          </>
        )}

        {live.engine.length > 0 && <EngineRoom calls={live.engine} tavilyCredits={live.tavilyCredits} running={running} />}
      </div>
    </SourcesProvider>
  );
}

// ---- Hero -----------------------------------------------------------------------------------

function Hero({ live, running }: { live: LiveState; running: boolean }) {
  const p = live.playbook;
  const v = p?.verification;
  return (
    <section className="rise overflow-hidden rounded-2xl border border-line bg-olive text-paper">
      <div className="grain px-6 py-6 sm:px-8 sm:py-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-paper/70">This week’s playbook</p>
          {p && !running && (
            <button
              type="button"
              onClick={() => window.print()}
              className="no-print inline-flex items-center gap-1.5 rounded-full border border-paper/30 px-3 py-1 text-xs text-paper/90 transition hover:bg-paper/10"
            >
              <IconDownload size={13} /> Save as PDF
            </button>
          )}
        </div>
        <h2 className="font-display mt-1 text-3xl leading-tight sm:text-4xl">{p?.restaurant.name ?? live.place?.name}</h2>
        <p className="mt-1 text-sm text-paper/80">{p ? `${p.restaurant.concept} · ${p.restaurant.city}` : (live.place?.address ?? live.place?.city)}</p>
        {live.place?.match === "city" && (
          <p className="mt-2 inline-block rounded-full bg-saffron/90 px-2 py-0.5 text-xs text-ink">
            Not found on OpenStreetMap — the block and forecast are for the city centre
          </p>
        )}
        {p?.restaurant.website && (
          <a href={p.restaurant.website} target="_blank" rel="noopener noreferrer" className="mt-2 block text-xs text-paper/75 underline underline-offset-2">
            {p.restaurant.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
        )}
        {p?.headline && <p className="font-display mt-5 max-w-3xl text-xl leading-snug text-paper sm:text-2xl">“{p.headline}”</p>}
        {v && v.checked > 0 ? (
          <div className="mt-5 inline-flex flex-wrap items-center gap-3 rounded-2xl border border-paper/25 bg-paper/10 px-4 py-2.5">
            <div className="flex items-baseline gap-1">
              <span className="font-display text-4xl leading-none">
                <CountUp value={v.verified} />
              </span>
              <span className="text-sm text-paper/70">/ {v.checked}</span>
            </div>
            <div className="leading-tight">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-paper/90">Claims checked against their sources</p>
              <p className="text-[11px] text-paper/70">
                against {v.sources} sources fetched live{v.providers.length ? ` · ${v.providers.join(", ")}` : ""}
              </p>
            </div>
          </div>
        ) : running ? (
          <p className="mt-5 text-sm text-paper/70">Reading the week around this restaurant…</p>
        ) : null}
      </div>
    </section>
  );
}

function ActHeader({ id, n, title, subtitle }: { id: string; n: number; title: string; subtitle: string }) {
  return (
    <header id={id} className="scroll-mt-20 pt-4">
      <p className="font-display text-sm text-terracotta">{n <= 3 ? `Act ${n}` : "Appendix"}</p>
      <h2 className="font-display text-3xl leading-tight sm:text-4xl">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">{subtitle}</p>
    </header>
  );
}

// ---- Act 1: the week ---------------------------------------------------------------------------

const WEATHER_GLYPH: [RegExp, string][] = [
  [/thunder/, "⛈️"],
  [/snow/, "❄️"],
  [/heavy rain|showers/, "🌧️"],
  [/rain|drizzle/, "🌦️"],
  [/fog/, "🌫️"],
  [/overcast|cloudy/, "⛅"],
  [/clear|sun/, "☀️"],
];
function glyph(condition: string): string {
  const c = condition.toLowerCase();
  return WEATHER_GLYPH.find(([re]) => re.test(c))?.[1] ?? "🌤️";
}

function WeekStrip({ days, holidays, events }: { days: DayForecast[]; holidays: Holiday[]; events: NearbyEvent[] }) {
  const byDate = (d: string) => events.filter((e) => e.date === d);
  return (
    <section aria-label="The next 7 days" className="rise rounded-2xl border border-line bg-card p-4 sm:p-5">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((d, i) => {
          const hol = holidays.find((h) => h.date === d.date);
          const ev = byDate(d.date);
          const wet = d.precip_mm >= 1 || (d.precip_prob ?? 0) >= 60;
          const mm = formatMm(d.precip_mm); // same rounding as the forecast source the claims cite
          return (
            <li
              key={d.date}
              style={{ animationDelay: `${i * 70}ms` }}
              className={`rise flex min-h-[148px] flex-col rounded-xl border p-3 ${hol ? "border-saffron/60 bg-saffron/10" : "border-line bg-paper/40"}`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{d.weekday}</p>
              <p className="text-[12px] text-ink-2">
                {d.date.slice(8, 10)}/{d.date.slice(5, 7)}
              </p>
              <p className="mt-1 text-2xl leading-none" aria-hidden>
                {glyph(d.condition)}
              </p>
              <p className="mt-1 text-sm font-semibold tabular-nums">
                {Math.round(d.tmax)}° <span className="font-normal text-muted">/ {Math.round(d.tmin)}°</span>
              </p>
              <p className={`text-[11px] tabular-nums ${wet ? "font-semibold text-olive" : "text-muted"}`}>
                {d.condition}
                {mm !== "0.0" ? ` · ${mm} mm` : ""}
              </p>
              {hol && <p className="mt-1 text-[11px] font-semibold leading-tight text-ink">{hol.local_name || hol.name}</p>}
              {ev.length > 0 && (
                <p className="mt-auto pt-1 text-[11px] leading-tight text-terracotta" title={ev.map((e) => `${e.name} — ${e.venue}`).join("\n")}>
                  {ev.length} event{ev.length > 1 ? "s" : ""} nearby
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {events.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer select-none text-ink-2">Events within 5 km this week ({events.length})</summary>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {events.slice(0, 12).map((e) => (
              <li key={e.id} className="rounded-lg border border-line bg-paper/50 px-3 py-2">
                <span className="font-medium">{e.name}</span>
                <span className="text-muted">
                  {" "}
                  · {e.date.slice(8, 10)}/{e.date.slice(5, 7)}
                  {e.time ? ` ${e.time}` : ""} · {e.venue}
                  {e.distance_km != null ? ` · ${e.distance_km} km` : ""}
                </span>
                {e.url && (
                  <a href={e.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-olive underline underline-offset-2">
                    tickets
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-3 text-[11px] text-muted">Forecast: Open-Meteo (CC BY 4.0) · Holidays: Nager.Date · Events: Ticketmaster</p>
    </section>
  );
}

function Moments({ playbook: p }: { playbook: Playbook }) {
  return (
    <Section icon={<IconTrend size={16} />} kicker="Demand moments" title="What changes your week">
      <ol className="grid gap-3 md:grid-cols-2">
        {p.moments.map((m, i) => (
          <li key={i} style={{ animationDelay: `${i * 90}ms` }} className="rise rounded-xl border border-line bg-paper/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-terracotta">{m.when}</p>
            <p className="font-display mt-0.5 text-lg leading-tight">{m.title}</p>
            <p className="mt-1.5 text-sm leading-snug">
              <span className="font-semibold">Play: </span>
              {m.play}
            </p>
            <ul className="mt-3 space-y-2 border-t border-line pt-3">
              {m.evidence.map((e, j) => (
                <EvidenceLine key={j} evidence={e} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function CuisineBars({ data, highlight }: { data: { cuisine: string; count: number }[]; highlight?: string[] }) {
  const top = data.slice(0, 8);
  const max = Math.max(1, ...top.map((d) => d.count));
  if (!top.length) return <p className="text-sm text-muted">OpenStreetMap lists no cuisines for the venues around you.</p>;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Cuisines on your block</p>
      <ul className="space-y-1.5">
        {top.map((d) => {
          const you = highlight?.includes(d.cuisine);
          return (
            <li key={d.cuisine} className="grid grid-cols-[96px_1fr_28px] items-center gap-2 text-[12px]">
              <span className={`truncate capitalize ${you ? "font-semibold text-terracotta" : "text-ink-2"}`}>{d.cuisine}</span>
              <span className="h-2 overflow-hidden rounded-full bg-paper-2">
                <span className={`grow-x block h-full rounded-full ${you ? "bg-terracotta" : "bg-olive-2"}`} style={{ width: `${(d.count / max) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums text-muted">{d.count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Snapshot({ playbook: p }: { playbook: Playbook }) {
  return (
    <Section icon={<IconUsers size={16} />} kicker="How you come across online" title="What guests and critics say">
      {p.snapshot.summary && <p className="mb-4 max-w-3xl text-[15px] leading-relaxed text-ink-2">{p.snapshot.summary}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-olive">Loved for</p>
          {p.snapshot.loved_for.length ? (
            <ul className="space-y-2">
              {p.snapshot.loved_for.map((e, i) => (
                <EvidenceLine key={i} evidence={e} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No review or press source was found this run.</p>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-terracotta">Watch out for</p>
          {p.snapshot.watch_outs.length ? (
            <ul className="space-y-2">
              {p.snapshot.watch_outs.map((e, i) => (
                <EvidenceLine key={i} evidence={e} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No complaints found in the sources read this run.</p>
          )}
        </div>
      </div>
    </Section>
  );
}

function MenuNow({ menu, currency }: { menu: NonNullable<LiveState["menu"]>; currency?: string }) {
  // Split "Four Onion $24 Goat Cheese, …" into name / price / description; drop ingredient lists and repeats.
  const items = useMemo(() => cleanMenu(menu.items), [menu.items]);
  if (!items.length) return null;
  return (
    <section className="rise rounded-2xl border border-line bg-card px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
        On your menu now ·{" "}
        {menu.from === "photo" ? (
          "read from your photo by Nemotron Super VL"
        ) : menu.url ? (
          <a href={menu.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            from your website
          </a>
        ) : (
          "from the web"
        )}
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {items.slice(0, 30).map((m, i) => (
          <li key={`${m.name}-${i}`} title={m.description ?? undefined}>
            <Pill>
              {m.name}
              {m.price != null && currency ? <span className="ml-1 tabular-nums text-muted">{money(m.price, currency)}</span> : null}
            </Pill>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Act 2: the moves ----------------------------------------------------------------------------

function MenuMoves({ playbook: p }: { playbook: Playbook }) {
  return (
    <Section icon={<IconPlate size={16} />} kicker="Menu moves" title="Three dishes to test this week">
      <div className="grid gap-4 lg:grid-cols-3">
        {p.menu_moves.map((m) => {
          const ok = m.evidence.filter((e) => e.verified).length;
          return (
            <article key={m.dish} className="flex flex-col rounded-xl border border-line bg-paper/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="font-display text-lg leading-tight">{m.dish}</h4>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-olive">{money(m.price, p.currency)}</span>
              </div>
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-terracotta">{m.when}</p>
              <p className="mt-1.5 text-sm leading-snug text-ink-2">{m.description}</p>
              <p className="mt-3 text-[13px] leading-snug">
                <span className="font-semibold">Our read: </span>
                {m.why}
              </p>
              <ul className="mt-3 space-y-2 border-t border-line pt-3" aria-label="Evidence">
                <li className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Evidence · {ok}/{m.evidence.length} verified
                </li>
                {m.evidence.map((ev, i) => (
                  <EvidenceLine key={`${m.dish}-${i}`} evidence={ev} />
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </Section>
  );
}

function DraftPreview({ draft, writer }: { draft: Record<string, unknown>; writer?: string }) {
  const headline = typeof draft.headline === "string" ? draft.headline : "";
  const moves = Array.isArray(draft.menu_moves) ? (draft.menu_moves as Array<Record<string, unknown>>) : [];
  const moments = Array.isArray(draft.moments) ? (draft.moments as Array<Record<string, unknown>>) : [];
  const steps = [
    { label: "Headline", done: headline.length > 0 },
    { label: "Demand moments", done: moments.length > 0 },
    { label: "Menu moves", done: moves.length >= 3 },
    { label: "Rivals", done: draft.rivals != null },
    { label: "Event", done: draft.experience != null },
    { label: "Marketing", done: draft.marketing != null },
    { label: "Shopping list", done: Array.isArray(draft.shopping_list) },
    { label: "7-day plan", done: Array.isArray(draft.week_plan) },
  ];
  return (
    <section aria-live="polite" className="rise rounded-2xl border border-dashed border-olive/40 bg-card p-5 sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-olive">Drafting live · {writer ?? "Nemotron"}</p>
      {headline ? (
        <p className="font-display mt-2 text-xl leading-snug sm:text-2xl">{headline}</p>
      ) : (
        <p className="mt-2 text-sm text-muted">Writing your week…</p>
      )}
      {moves.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {moves.map((m, i) =>
            typeof m.dish === "string" && m.dish ? (
              <li key={i} className="rounded-full border border-line bg-paper px-3 py-1 text-sm">
                {m.dish}
              </li>
            ) : null,
          )}
        </ul>
      )}
      <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {steps.map((st) => (
          <li key={st.label} className={st.done ? "text-olive" : "text-muted"}>
            {st.done ? "✓" : "○"} {st.label}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- Act 3: launch -------------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 };

// The plan runs over the next 7 days; map "Thu…" / "Jueves…" to the next such date (today included).
function dateForDay(label: string, from = new Date()): Date | null {
  const key = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .slice(0, 3);
  const dow = WEEKDAYS[key];
  if (dow == null) return null;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
  return d;
}

function icsDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function WeekPlan({ playbook: p }: { playbook: Playbook }) {
  const download = () => {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tastecraft//Week plan//EN"];
    const stamp = icsDate(new Date());
    p.week_plan.forEach((it, i) => {
      const day = dateForDay(it.day);
      if (!day) return;
      const end = new Date(day);
      end.setDate(day.getDate() + 1);
      lines.push(
        "BEGIN:VEVENT",
        `UID:tastecraft-${i}-${icsDate(day)}@tastecraft`,
        `DTSTAMP:${stamp}T000000Z`,
        `DTSTART;VALUE=DATE:${icsDate(day)}`,
        `DTEND;VALUE=DATE:${icsDate(end)}`,
        `SUMMARY:${icsEscape(`${p.restaurant.name}: ${it.action}`)}`,
        `DESCRIPTION:${icsEscape(`Owner: ${it.owner}. From your Tastecraft weekly playbook.`)}`,
        "END:VEVENT",
      );
    });
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tastecraft-week.ics";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section
      icon={<IconSpark size={16} />}
      kicker="Next 7 days"
      title="Your week, day by day"
      aside={
        <button
          type="button"
          onClick={download}
          className="no-print inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-ink-2/40 hover:text-ink"
        >
          <IconDownload size={14} /> Add to calendar
        </button>
      }
    >
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {p.week_plan.map((it, i) => (
          <li key={`${it.day}-${i}`} className="rounded-xl border border-line bg-paper/50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-terracotta">{it.day}</p>
            <p className="mt-1 text-sm leading-snug">{it.action}</p>
            <p className="mt-1 text-[12px] text-muted">{it.owner}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ShoppingList({ playbook: p }: { playbook: Playbook }) {
  if (!p.shopping_list.length) return null;
  const total = p.shopping_list.reduce((s, i) => s + (i.est_cost || 0), 0);
  const csv = [
    `item,qty,unit,supplier_category,est_cost_${p.currency.toLowerCase()}`,
    ...p.shopping_list.map((i) => [i.item, i.qty, i.unit, i.supplier_category, i.est_cost].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")),
  ].join("\n");
  const bySupplier = p.shopping_list.reduce<Record<string, typeof p.shopping_list>>((acc, i) => {
    (acc[i.supplier_category] ??= []).push(i);
    return acc;
  }, {});
  const orderEmail = Object.entries(bySupplier)
    .map(([cat, items]) => `— ${cat} —\n` + items.map((i) => `· ${i.item}: ${i.qty} ${i.unit}`).join("\n"))
    .join("\n\n");
  const emailText = `Hello,\n\nFor ${p.restaurant.name}, we would like to order for this week's specials:\n\n${orderEmail}\n\nPlease confirm availability and price.\n\nThank you!`;
  return (
    <Section
      icon={<IconBasket size={16} />}
      kicker="Supplier shopping list"
      title="What to buy for a one-week test"
      aside={
        <div className="flex flex-wrap justify-end gap-2">
          <CopyButton text={emailText} label="Copy order email" />
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
            download="tastecraft-shopping-list.csv"
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-ink-2/40 hover:text-ink"
          >
            <IconDownload size={14} /> CSV
          </a>
        </div>
      }
    >
      {/* Phone: one stacked row per item, cost always visible. */}
      <ul className="border-t border-line text-sm sm:hidden" aria-label="Shopping list">
        {p.shopping_list.map((i, idx) => (
          <li key={`${i.item}-${idx}`} className="flex items-start justify-between gap-3 border-b border-line/60 py-2">
            <div className="min-w-0">
              <p className="leading-snug">{i.item}</p>
              <p className="text-[12px] text-muted">
                <span className="tabular-nums">
                  {i.qty} {i.unit}
                </span>{" "}
                · {i.supplier_category}
              </p>
            </div>
            <span className="shrink-0 tabular-nums">{money(i.est_cost, p.currency)}</span>
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 pt-3">
          <span className="text-xs uppercase tracking-[0.12em] text-muted">Estimated total</span>
          <span className="font-semibold tabular-nums">{money(total, p.currency)}</span>
        </li>
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-muted">
              <th className="py-2 pr-3 font-semibold">Item</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 font-semibold">Supplier</th>
              <th className="py-2 text-right font-semibold">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {p.shopping_list.map((i, idx) => (
              <tr key={`${i.item}-${idx}`} className="border-b border-line/60">
                <td className="py-2 pr-3">{i.item}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {i.qty} {i.unit}
                </td>
                <td className="py-2 pr-3 text-ink-2">{i.supplier_category}</td>
                <td className="py-2 text-right tabular-nums">{money(i.est_cost, p.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-3 text-right text-xs uppercase tracking-[0.12em] text-muted">
                Estimated total
              </td>
              <td className="pt-3 text-right font-semibold tabular-nums">{money(total, p.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  );
}

// ---- Proof & engine --------------------------------------------------------------------------------

function allEvidence(p: Playbook): Evidence[] {
  return [
    ...p.snapshot.loved_for,
    ...p.snapshot.watch_outs,
    ...p.moments.flatMap((m) => m.evidence),
    ...p.menu_moves.flatMap((m) => m.evidence),
    ...p.rivals.evidence,
    ...p.experience.evidence,
  ];
}

function Compare({ baseline, playbook: p, engine }: { baseline: string; playbook: Playbook; engine: EngineCall[] }) {
  const v = p.verification;
  // Name the models from the run itself (older recordings used Lightning for the baseline).
  const without = engine.find((c) => c.phase === "baseline")?.label ?? "Nemotron";
  const writer = engine.findLast((c) => c.phase === "synthesize")?.label ?? "Nemotron";
  const same = without === writer;
  return (
    <Section
      icon={<IconSpark size={16} />}
      kicker="Why live data matters"
      title={same ? `Same ${writer}, with and without the week` : "Nemotron with and without the week"}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-paper/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{without}, no tools, no data</p>
          <p className="mt-1 text-[11px] text-muted">0 sources · nothing to verify</p>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-2">{baseline}</p>
        </div>
        <div className="rounded-xl border border-olive/30 bg-olive/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-olive">{writer} in Tastecraft, grounded in this week</p>
          {v && (
            <p className="mt-1 text-[11px] font-semibold text-olive">
              {v.sources} live sources · {v.verified}/{v.checked} claims verified in code
            </p>
          )}
          <ul className="mt-2 space-y-2 text-sm leading-relaxed">
            {p.menu_moves.map((m) => (
              <li key={m.dish}>
                <span className="font-semibold">{m.dish}</span> <span className="text-muted">({m.when})</span> —{" "}
                {m.evidence.find((e) => e.verified)?.text ?? m.why}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

const KIND_LABEL: Record<Source["kind"], string> = {
  site: "Website",
  menu: "Menu",
  review: "Reviews & press",
  news: "Local news",
  rival: "Rival",
  web: "Web",
  weather: "Forecast",
  holiday: "Holidays",
  event: "Event",
  block: "Map",
};

function SourcesLedger({ sources, playbook: p }: { sources: Source[]; playbook: Playbook }) {
  const ev = allEvidence(p);
  const uses = new Map<string, number>();
  for (const e of ev) for (const c of e.cites) if (c.ok) uses.set(c.source, (uses.get(c.source) ?? 0) + 1);
  const failed = ev.filter((e) => !e.verified);
  const sorted = [...sources].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
  const cited = sorted.filter((s) => uses.get(s.id));
  const readOnly = sorted.filter((s) => !uses.get(s.id));
  const row = (s: Source) => (
    <li key={s.id} className="flex items-start gap-3 px-3 py-2 text-[13px] sm:px-4">
      <span className="w-8 shrink-0 tabular-nums text-muted">{s.id}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {s.title}
            </a>
          ) : (
            s.title
          )}
        </p>
        <p className="text-[11px] text-muted">
          {s.provider} · {KIND_LABEL[s.kind]}
          {s.published ? ` · ${s.published.slice(0, 10)}` : ""}
        </p>
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums ${uses.get(s.id) ? "bg-olive/10 text-olive" : "text-muted"}`}>
        {uses.get(s.id) ? `cited ${uses.get(s.id)}×` : "read"}
      </span>
    </li>
  );
  return (
    <Section icon={<IconCheck size={16} />} kicker="Evidence ledger" title={`${sources.length} sources, ${ev.length} claims checked in code`}>
      <p className="mb-3 max-w-3xl text-[13px] leading-relaxed text-ink-2">
        Every source fetched in this run is cut into numbered sentences, and every claim cites the sentences it stands on — the chip shows the exact
        text. Code checks that each cited sentence exists, that every number in the claim appears in it, and that it says what the claim says: every
        specific word of the claim must be there, give or take one in five. Prices elsewhere in the plan must match a dish or a checked claim. No
        model is asked whether a claim is true.
      </p>
      {p.verification?.first_pass != null && (
        <ol className="mb-4 grid gap-2 sm:grid-cols-4" aria-label="How the verifier got there">
          {[
            [
              "Passed first time",
              `${p.verification.first_pass} / ${p.verification.written ?? p.verification.checked}`,
              "claims the writer got right on its own",
            ],
            [
              "Caught by code",
              String((p.verification.written ?? p.verification.checked) - p.verification.first_pass),
              "a number or detail the cited sentences don't contain",
            ],
            ["Fixed or dropped", `${p.verification.fixed ?? 0} / ${p.verification.dropped ?? 0}`, "one Nemotron repair pass, re-checked by code"],
            ["Verified now", `${p.verification.verified} / ${p.verification.checked}`, "what you see in this plan"],
          ].map(([t, v, d], i) => (
            <li key={t} style={{ animationDelay: `${i * 120}ms` }} className="rise rounded-xl border border-line bg-paper/50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{t}</p>
              <p className="font-display mt-0.5 text-2xl tabular-nums">{v}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">{d}</p>
            </li>
          ))}
        </ol>
      )}
      {p.verification?.amounts && p.verification.amounts.checked > 0 && (
        <p
          className={`mb-3 flex flex-wrap items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] ${
            p.verification.amounts.unbacked.length ? "border-terracotta/30 bg-terracotta/5 text-terracotta" : "border-line bg-paper/50 text-ink-2"
          }`}
        >
          {p.verification.amounts.unbacked.length ? <IconAlert size={13} /> : <IconCheck size={13} className="text-olive" />}
          <span>
            <span className="font-semibold">Prices in the plan’s text:</span> {p.verification.amounts.checked} checked
            {p.verification.amounts.fixed ? `, ${p.verification.amounts.fixed} corrected by the repair pass` : ""}
            {p.verification.amounts.unbacked.length
              ? ` — not backed: ${p.verification.amounts.unbacked.map((u) => `${u.amount} (${u.where})`).join(", ")}`
              : " — each matches a dish price, the menu or a checked claim."}
          </span>
        </p>
      )}
      {failed.length > 0 && (
        <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-terracotta/30 bg-terracotta/5 px-3 py-1 text-[12px] text-terracotta">
          <IconAlert size={13} /> {failed.length} claim{failed.length > 1 ? "s" : ""} could not be verified and {failed.length > 1 ? "are" : "is"} marked in
          place
        </p>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper/40">{cited.map(row)}</ul>
      {readOnly.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-[13px] text-ink-2">Also read, not cited ({readOnly.length})</summary>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper/40">{readOnly.map(row)}</ul>
        </details>
      )}
    </Section>
  );
}

const PHASE_LABEL: Record<EngineCall["phase"], string> = {
  baseline: "Generic baseline",
  vision: "Read menu photo",
  gather: "Web research turn",
  synthesize: "Write the plan",
  verify: "Repair failed checks",
  repair: "Repair schema",
};

function usd(v: number): string {
  if (v === 0) return "$0";
  return v < 0.0001 ? "<$0.0001" : `$${v.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

// Parallel repairs are measured as one entry; older recordings only say how many in the note.
function callCount(c: EngineCall): number {
  return c.count ?? Number(/(\d+) parallel calls/.exec(c.note ?? "")?.[1] ?? 1);
}

function EngineRoom({ calls, tavilyCredits, running }: { calls: EngineCall[]; tavilyCredits?: number; running: boolean }) {
  const byModel = new Map<string, { label: string; calls: number; inTok: number; outTok: number; reason: number; ms: number; usd: number }>();
  for (const c of calls) {
    const m = byModel.get(c.model) ?? { label: c.label, calls: 0, inTok: 0, outTok: 0, reason: 0, ms: 0, usd: 0 };
    m.calls += callCount(c);
    m.inTok += c.prompt_tokens ?? 0;
    m.outTok += c.completion_tokens ?? 0;
    m.reason += c.reasoning_tokens ?? 0;
    m.ms += c.ms;
    m.usd += c.est_cost_usd ?? 0;
    byModel.set(c.model, m);
  }
  const totalUsd = [...byModel.values()].reduce((s, m) => s + m.usd, 0);
  const totalTok = [...byModel.values()].reduce((s, m) => s + m.inTok + m.outTok, 0);
  const synth = calls.findLast((c) => c.phase === "synthesize");
  return (
    <Section
      icon={<IconSpark size={16} />}
      kicker="Engine room · NVIDIA Nemotron on Nebius Token Factory"
      title={running ? "Model calls so far" : `This plan cost ≈ $${totalUsd.toFixed(3)} in inference`}
    >
      <p className="mb-3 max-w-3xl text-[13px] leading-relaxed text-ink-2">
        Each step runs on the Nemotron that suits it: Lightning (fast, no reasoning) drives the research loop, Super VL reads menu photos, Ultra (Quick) or
        Super (Economy) writes the plan, and Ultra repairs failed citations. Token counts come from Token Factory’s <code>usage</code> field; cost multiplies them by the published per-token prices (
        <a href={PRICES_SOURCE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          catalog
        </a>
        , {PRICES_RETRIEVED}).
      </p>
      <EngineTimeline calls={calls} />
      {/* Phone: one card per model, cost first; the full table from sm up. */}
      <ul className="space-y-2 text-[13px] sm:hidden" aria-label="Cost per model">
        {[...byModel.entries()].map(([id, m]) => (
          <li key={id} className="rounded-xl border border-line bg-paper/40 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{m.label}</p>
                <p className="truncate text-[11px] text-muted">{id}</p>
              </div>
              <span className="shrink-0 font-semibold tabular-nums">{usd(m.usd)}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {[
                ["Tokens in", m.inTok.toLocaleString("en-GB")],
                ["Tokens out", m.outTok.toLocaleString("en-GB")],
                ["Calls", String(m.calls)],
                ["Time", fmtMs(m.ms)],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">{k}</dt>
                  <dd className="tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {m.reason > 0 && <p className="mt-1 text-[11px] text-muted">{m.reason.toLocaleString("en-GB")} of the output tokens were reasoning</p>}
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 px-1 pt-1">
          <span className="text-[12px] text-muted">
            <span className="uppercase tracking-[0.12em]">Total</span> · {calls.reduce((n, c) => n + callCount(c), 0)} calls ·{" "}
            {totalTok.toLocaleString("en-GB")} tokens
          </span>
          <span className="shrink-0 font-semibold tabular-nums">{usd(totalUsd)}</span>
        </li>
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-muted">
              <th className="py-2 pr-3 font-semibold">Model</th>
              <th className="py-2 pr-3 text-right font-semibold">Calls</th>
              <th className="py-2 pr-3 text-right font-semibold">Tokens in</th>
              <th className="py-2 pr-3 text-right font-semibold">Tokens out</th>
              <th className="py-2 pr-3 text-right font-semibold">Time</th>
              <th className="py-2 text-right font-semibold">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {[...byModel.entries()].map(([id, m]) => (
              <tr key={id} className="border-b border-line/60">
                <td className="py-2 pr-3">
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-[11px] text-muted">{id}</span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{m.calls}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{m.inTok.toLocaleString("en-GB")}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {m.outTok.toLocaleString("en-GB")}
                  {m.reason > 0 && <span className="block text-[11px] text-muted">{m.reason.toLocaleString("en-GB")} reasoning</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtMs(m.ms)}</td>
                <td className="py-2 text-right tabular-nums">{usd(m.usd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-2 text-xs uppercase tracking-[0.12em] text-muted">Total</td>
              <td className="pt-2 pr-3 text-right tabular-nums">{calls.reduce((n, c) => n + callCount(c), 0)}</td>
              <td colSpan={2} className="pt-2 pr-3 text-right tabular-nums">
                {totalTok.toLocaleString("en-GB")} tokens
              </td>
              <td />
              <td className="pt-2 text-right font-semibold tabular-nums">{usd(totalUsd)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer select-none text-ink-2">Every call, in order</summary>
        <ol className="mt-2 space-y-1">
          {calls.map((c, i) => (
            <li key={i} className="flex flex-wrap gap-x-2 text-muted">
              <span className="w-5 tabular-nums">{i + 1}.</span>
              <span className="text-ink-2">{PHASE_LABEL[c.phase]}</span>
              <span>· {c.label}</span>
              <span>· {fmtMs(c.ms)}</span>
              {c.ttft_ms != null && <span>· first token {fmtMs(c.ttft_ms)}</span>}
              {c.tool_calls != null && (
                <span>
                  · {c.tool_calls} tool call{c.tool_calls === 1 ? "" : "s"}
                </span>
              )}
              {c.tools_ms != null && <span>(tools {fmtMs(c.tools_ms)}, parallel)</span>}
              {c.prompt_tokens != null && (
                <span>
                  · {c.prompt_tokens}→{c.completion_tokens ?? 0} tok
                </span>
              )}
              {c.usage_estimated && <span>· usage estimated</span>}
              {c.note && <span>· {c.note}</span>}
            </li>
          ))}
        </ol>
      </details>
      <p className="mt-3 text-[12px] text-muted">
        {synth?.completion_tokens && synth.ms
          ? `${synth.label.replace(/^Nemotron /, "")} streamed ${Math.round(synth.completion_tokens / (synth.ms / 1000))} tokens/s for the plan. `
          : ""}
        {tavilyCredits ? `Web research used ${tavilyCredits} Tavily credit${tavilyCredits === 1 ? "" : "s"}. ` : ""}
        {calls.some((c) => c.usage_estimated)
          ? "Calls cut by the loop guard never report usage; their tokens are estimated from the streamed text (~4 characters per token)."
          : ""}
      </p>
    </Section>
  );
}

const MODEL_TONE: [RegExp, string][] = [
  [/lightning/i, "bg-saffron"],
  [/vl/i, "bg-plum"],
  [/ultra/i, "bg-olive"],
  [/super/i, "bg-terracotta"],
];
const toneOf = (label: string) => MODEL_TONE.find(([re]) => re.test(label))?.[1] ?? "bg-ink-2";

// Where the run's time went: every Nemotron call on a real time axis (server clock), with the tools
// each research turn asked for drawn hatched right after it.
function EngineTimeline({ calls }: { calls: EngineCall[] }) {
  const timed = calls.filter((c) => c.started_at);
  if (timed.length < 2) return null;
  const t0 = Math.min(...timed.map((c) => c.started_at as number));
  const t1 = Math.max(...timed.map((c) => (c.started_at as number) + c.ms + (c.tools_ms ?? 0)));
  const span = Math.max(1, t1 - t0);
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  const legend = [...new Map(timed.map((c) => [c.label, toneOf(c.label)])).entries()];
  return (
    <figure className="mb-5 rounded-xl border border-line bg-paper/40 p-3 sm:p-4" aria-label="Timeline of model calls">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="font-semibold uppercase tracking-[0.12em]">Where the time went</span>
        {legend.map(([label, tone]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-3 rounded-sm ${tone}`} /> {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="hatch h-2 w-3 rounded-sm border border-line" /> tools (parallel)
        </span>
      </figcaption>
      <ol className="space-y-1">
        {timed.map((c, i) => {
          const start = (c.started_at as number) - t0;
          return (
            <li key={i} className="grid grid-cols-[112px_1fr] items-center gap-2 text-[11px] sm:grid-cols-[130px_1fr]">
              <span className="truncate text-ink-2" title={`${PHASE_LABEL[c.phase]} · ${c.label}`}>
                {PHASE_LABEL[c.phase]}
              </span>
              <span className="relative h-3.5">
                <span
                  className={`grow-x absolute top-0 h-full rounded-[3px] ${toneOf(c.label)}`}
                  style={{ left: pct(start), width: pct(Math.max(c.ms, span * 0.004)), animationDelay: `${i * 60}ms` }}
                  title={`${c.label} · ${fmtMs(c.ms)}`}
                />
                {c.tools_ms ? (
                  <span
                    className="hatch grow-x absolute top-0 h-full rounded-[3px] border border-line"
                    style={{ left: pct(start + c.ms), width: pct(c.tools_ms), animationDelay: `${i * 60 + 120}ms` }}
                    title={`tools · ${fmtMs(c.tools_ms)}`}
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-1 grid grid-cols-[112px_1fr] gap-2 text-[10px] tabular-nums text-muted sm:grid-cols-[130px_1fr]">
        <span />
        <span className="flex justify-between">
          <span>0 s</span>
          <span>{fmtMs(span / 2)}</span>
          <span>{fmtMs(span)}</span>
        </span>
      </div>
    </figure>
  );
}
