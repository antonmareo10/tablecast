"use client";

import Link from "next/link";
import { m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentEvent, AgentRequest } from "@/lib/types";
import type { DemoPreview } from "@/data/demos";
import { readNdjson } from "@/lib/ndjson";
import Timeline, { type AgentStatus, type ModelChip, type Step, type TimelineItem } from "./Timeline";
import PlaybookView, { type LiveState } from "./PlaybookView";
import ReplayWeek from "./ReplayWeek";
import { IconAlert, IconArrow, IconSearch } from "./icons";
import { SplitWords, Underline } from "./kinetic";
import { CursorLight, Reveal, STAGGER, scrollToEl, useMagnetic, usePillClip } from "./motion";

// Routing measured in eval/SUMMARY.md (v5 and v6, strict verifier): Ultra at medium effort has the best average and is fast; Super is as faithful at a third to half the cost, but slower.
const MODES = [
  { id: "quick", label: "Quick", hint: "Nemotron Ultra · ~1–2 min, best average in my eval" },
  { id: "economy", label: "Economy", hint: "Nemotron Super · ~2–3 min, a third to half the cost" },
] as const;

const LANGUAGES = [
  { id: "English", label: "English" },
  { id: "Español", label: "Español" },
] as const;

const GOALS = ["Fill quiet weeknights", "Make the most of this week’s weather", "Win more lunch covers", "Launch a seasonal special", "Grow takeaway orders"];

const SAMPLES: AgentRequest[] = [
  { restaurant: "Casa Lucio", city: "Madrid", goal: "Fill quiet weeknights" },
  { restaurant: "Katz's Delicatessen", city: "New York", goal: "Make the most of this week’s weather" },
  { restaurant: "Gjelina", city: "Los Angeles", goal: "Win more lunch covers" },
];

const PROVIDERS = ["NVIDIA Nemotron", "Nebius Token Factory", "Tavily", "OpenStreetMap", "Open-Meteo", "Nager.Date", "Ticketmaster"];

const MAX_PHOTO_EDGE = 1600;

type Phase = "idle" | "running" | "done" | "error";

const timestamp = () => Date.now();

export type DemoSummary = { slug: string; restaurant: string; city: string; goal?: string; recordedAt: string; preview?: DemoPreview };

// Downscale the owner's menu photo in the browser so it uploads fast and stays under the API limit.
async function photoToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

export default function TablecastApp({ demos = [] }: { demos?: DemoSummary[] }) {
  const [form, setForm] = useState<AgentRequest>({ restaurant: "", city: "", goal: GOALS[0], language: "English" });
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<DemoSummary | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false); // the reader scrolled during the run: don't move the page for them
  const submit = useMagnetic<HTMLButtonElement>(6);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(timestamp()), 500);
    return () => clearInterval(t);
  }, [phase]);

  // While a run streams, note whether the reader scrolls on their own.
  useEffect(() => {
    if (phase !== "running") return;
    movedRef.current = false;
    const moved = () => (movedRef.current = true);
    const keys = (e: KeyboardEvent) => ["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes(e.key) && moved();
    window.addEventListener("wheel", moved, { passive: true });
    window.addEventListener("touchmove", moved, { passive: true });
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("wheel", moved);
      window.removeEventListener("touchmove", moved);
      window.removeEventListener("keydown", keys);
    };
  }, [phase]);

  // When the plan is ready and the reader has just been watching the agent log (on a phone the log fills the
  // screen), glide down to the result. On a wide screen the result is already beside the log: nothing moves.
  useEffect(() => {
    if (phase !== "done" || movedRef.current) return;
    const hero = document.getElementById("playbook-hero");
    if (!hero) return;
    const top = hero.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.6 || top < 0) scrollToEl(hero, -12);
  }, [phase]);

  const { items, live, agent } = useMemo(() => derive(events), [events]);
  const doneEvent = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> | undefined;
  const elapsed = doneEvent ? doneEvent.elapsed_ms : phase === "running" && startedAt ? now - startedAt : 0;

  async function run(req: AgentRequest, demo?: DemoSummary) {
    if (!req.restaurant.trim() || !req.city.trim()) return;
    setReplay(demo ?? null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setEvents([]);
    setError(null);
    setPhase("running");
    const t0 = timestamp();
    setStartedAt(t0);
    setNow(t0);
    requestAnimationFrame(() => scrollToEl(resultsRef.current, -16));
    try {
      const res = demo
        ? await fetch(`/api/demo/${demo.slug}`, { signal: controller.signal })
        : await fetch("/api/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
            signal: controller.signal,
          });
      if (!res.ok || !res.body) {
        const info = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(info?.error ?? `The agent could not start (${res.status}).`);
      }
      for await (const ev of readNdjson<AgentEvent>(res.body)) {
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "error") setError(ev.message);
      }
      setPhase((p) => (p === "running" ? "done" : p));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("error");
    }
  }

  function startReplay(d: DemoSummary) {
    const req: AgentRequest = { restaurant: d.restaurant, city: d.city, goal: d.goal, language: "English" };
    setForm(req);
    setPhotoName(null);
    run(req, d);
  }

  const started = phase !== "idle";
  const hasPreview = demos.some((d) => d.preview);
  const inputCls =
    "w-full rounded-lg border border-line bg-paper/60 px-3 py-2.5 text-[15px] outline-none transition placeholder:text-muted focus:border-olive focus:bg-card focus-visible:ring-2 focus-visible:ring-olive/25";

  return (
    <div className="relative isolate flex min-h-screen flex-col overflow-x-clip">
      {/* Light behind the hero: a soft saffron glow that follows the cursor (static on touch / reduced motion). */}
      <div
        aria-hidden
        className="no-print pointer-events-none absolute inset-x-0 top-0 -z-10 h-[min(1100px,130vh)] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]"
      >
        <div className="absolute -right-48 -top-56 h-[620px] w-[620px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--olive-2)_16%,transparent),transparent)]" />
        <CursorLight
          scope="window"
          size={720}
          rest={[0.22, 0.3]}
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in srgb, var(--saffron) 26%, transparent), color-mix(in srgb, var(--saffron) 7%, transparent) 55%, transparent)",
          }}
        />
      </div>

      <header className="no-print mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Tablecast home">
          <Logo />
          <span className="font-display text-xl tracking-tight">Tablecast</span>
        </Link>
        <nav className="flex items-center gap-4 text-xs text-muted">
          <span className="hidden sm:inline">Live local data × NVIDIA Nemotron</span>
          <Link
            href="/about"
            className="group inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-card/60 px-3 text-ink-2 transition hover:border-ink-2/40 hover:text-ink"
          >
            How it works <IconArrow size={12} className="nudge" />
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 sm:px-6">
        <section
          className={`no-print flex flex-col gap-6 ${started ? "py-4" : "pb-10 pt-4 sm:pb-14 sm:pt-6"} lg:grid lg:grid-cols-[1.1fr_1fr] lg:items-start lg:gap-x-12`}
        >
          <div className="contents lg:flex lg:flex-col lg:gap-5">
            <div className="order-1 lg:order-none">
              <p className="rise text-[11px] font-semibold uppercase tracking-[0.18em] text-terracotta">For independent restaurants</p>
              <h1 className="kinetic font-display mt-3 text-4xl leading-[1.05] tracking-tight sm:text-6xl">
                <SplitWords text="Plan this week with what’s happening" />{" "}
                <span className="relative inline-block text-olive">
                  <SplitWords text="around you." start={6} />
                  <Underline delayMs={6 * 60 + 2 * 60 + 560} />
                </span>
              </h1>
              <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-ink-2">
                Rain on Wednesday, a match two streets away, a holiday on Sunday, the rival next door’s prices. Tablecast reads your week —
                forecast, events, your block, your menu and what guests say online — and turns it into three dishes to test, an event, a post and a
                supplier order. Every cited claim links to the exact sentence it stands on, checked in code.
              </p>
            </div>

            {!started && hasPreview && (
              <ReplayWeek demos={demos} onPlay={startReplay} className="rise order-2 lg:order-none [--d:240ms]" />
            )}
            {!started && !hasPreview && demos.length > 0 && (
              <div className="order-2 max-w-xl rounded-2xl border border-olive/25 bg-olive/5 p-4 lg:hidden">
                <p className="text-[14px] font-semibold text-olive">Watch a real recorded run — no wait</p>
                <p className="mt-1 text-[12px] text-ink-2">Instant replays of live runs, labelled as recorded.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {demos.map((d) => (
                    <button
                      key={d.slug}
                      type="button"
                      onClick={() => startReplay(d)}
                      className="group inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-card px-3 text-[13px] text-ink-2 transition hover:border-ink-2/40 hover:text-ink"
                    >
                      {d.restaurant}, {d.city} <IconArrow size={12} className="nudge" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="contents lg:flex lg:flex-col lg:gap-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(form);
              }}
              className="rise order-5 rounded-2xl border border-line bg-card p-5 shadow-[0_1px_0_rgba(29,27,23,0.04),0_18px_40px_-28px_rgba(29,27,23,0.35)] [--d:120ms] sm:p-6 lg:order-none"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Restaurant">
                  <input required value={form.restaurant} onChange={(e) => setForm({ ...form, restaurant: e.target.value })} placeholder="e.g. Casa Lucio" className={inputCls} />
                </Field>
                <Field label="City">
                  <input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="e.g. Madrid" className={inputCls} />
                </Field>
                <Field label="Website (optional)">
                  <input
                    value={form.website ?? ""}
                    onChange={(e) => setForm({ ...form, website: e.target.value || undefined })}
                    placeholder="e.g. yourrestaurant.com"
                    inputMode="url"
                    className={inputCls}
                  />
                </Field>
                <Field label="Menu photo (optional)" asDiv>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line bg-paper/60 px-3 py-2.5 text-[14px] text-ink-2 transition hover:border-olive has-[:focus-visible]:border-olive has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-olive/25">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        setPhotoError(null);
                        if (!file) return;
                        try {
                          const dataUrl = await photoToDataUrl(file);
                          if (dataUrl.length > 2_900_000) throw new Error("too large");
                          setForm((f) => ({ ...f, menu_photo: dataUrl }));
                          setPhotoName(file.name);
                        } catch {
                          setPhotoError("Could not use that image. Try a JPEG or PNG photo.");
                        }
                      }}
                    />
                    <span className="truncate">{photoName ?? "Add a photo of your menu"}</span>
                    {photoName && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setPhotoName(null);
                          setForm((f) => ({ ...f, menu_photo: undefined }));
                        }}
                        className="ml-auto text-xs text-muted hover:text-ink"
                        aria-label="Remove menu photo"
                      >
                        ✕
                      </button>
                    )}
                  </label>
                  {photoError && <p className="mt-1 text-xs text-terracotta">{photoError}</p>}
                </Field>
              </div>
              <fieldset className="mt-4">
                <legend className="mb-2 text-xs font-medium text-ink-2">What do you want this week?</legend>
                <div className="flex flex-wrap gap-2">
                  {GOALS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={form.goal === g}
                      onClick={() => setForm({ ...form, goal: g })}
                      className={`min-h-9 rounded-full border px-3 text-[13px] transition-[color,background-color,border-color,scale] duration-200 motion-safe:active:scale-[0.97] ${
                        form.goal === g ? "border-olive bg-olive text-paper" : "border-line bg-paper/60 text-ink-2 hover:border-ink-2/40 hover:text-ink"
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="mt-4 flex items-center gap-3 text-xs text-ink-2">
                <span>Plan language</span>
                <Segmented label="Plan language" options={LANGUAGES} value={form.language ?? "English"} onChange={(l) => setForm({ ...form, language: l })} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-2">
                <span>Writer</span>
                <Segmented label="Which Nemotron writes the plan" options={MODES} value={form.mode ?? "quick"} onChange={(mode) => setForm({ ...form, mode })} />
                <span className="text-muted">{MODES.find((md) => md.id === (form.mode ?? "quick"))?.hint}</span>
              </div>
              <button
                ref={submit}
                type="submit"
                disabled={phase === "running"}
                className="magnetic group mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 text-[15px] font-medium text-paper hover:bg-olive disabled:cursor-wait disabled:opacity-70"
              >
                {phase === "running" ? (
                  <>
                    <span className="pulse-dot h-2 w-2 rounded-full bg-saffron" /> Reading your week…
                  </>
                ) : (
                  <>
                    <IconSearch size={17} /> Plan my week
                    <IconArrow size={15} className="nudge opacity-70" />
                  </>
                )}
              </button>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted">
                <span>{demos.length ? "Instant replays of real runs:" : "Try:"}</span>
                {(demos.length ? demos : SAMPLES).map((s) => (
                  <button
                    key={s.restaurant}
                    type="button"
                    onClick={() => {
                      if ("slug" in s) return startReplay(s);
                      const req: AgentRequest = { restaurant: s.restaurant, city: s.city, goal: s.goal, language: "English" };
                      setForm(req);
                      setPhotoName(null);
                      run(req);
                    }}
                    disabled={phase === "running"}
                    className="hit group inline-flex items-center gap-1 text-ink-2 underline decoration-line underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-2 disabled:opacity-60"
                  >
                    {s.restaurant}, {s.city} <IconArrow size={12} className="nudge" />
                  </button>
                ))}
              </div>
            </form>

            <div className="order-4 flex flex-wrap items-center gap-2 text-[12px] text-muted lg:order-none">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-olive" />
                Runs on <strong className="font-medium text-ink-2">NVIDIA Nemotron</strong> · Nebius Token Factory
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">⚡ Lightning researches · 👁 Super VL reads menus · 🧠 Ultra or Super writes</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">🔎 Live web by Tavily</span>
            </div>

            {!started && (
              <div className="rise order-3 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 [--d:320ms] sm:flex-row sm:items-center sm:gap-5 sm:p-5 lg:order-none">
                <div className="flex shrink-0 items-baseline gap-3 sm:block sm:text-center">
                  <div className="font-display text-5xl leading-none text-olive tabular-nums">
                    <span aria-hidden>
                      <span className="css-count" style={{ "--to": 94, "--d": "500ms" } as CSSProperties} />
                      <span className="text-2xl text-muted">/100</span>
                    </span>
                    <span className="sr-only">94 of 100</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">verified claims right · audit</div>
                </div>
                <p className="text-[13px] leading-snug text-ink-2">
                  <span className="font-semibold text-ink">Measured, not promised.</span> I read 100 verified claims against their sources: 94 were right,
                  4 had a minor slip, 2 were wrong. On 8 restaurants never used for tuning, 73% of Quick claims (Nemotron Ultra) passed the strict code
                  check after one repair pass (84% on the 8 I tuned on): every number and nearly every word must be in the sentences they cite, and every
                  price and date in the plan is checked. What fails is marked, not hidden. A plan costs a few cents of inference ·{" "}
                  <a
                    href="https://github.com/antonmareo10/tablecast/blob/main/eval/AUDIT.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-line underline-offset-2 hover:text-ink"
                  >
                    audit
                  </a>{" "}
                  ·{" "}
                  <a
                    href="https://github.com/antonmareo10/tablecast/blob/main/eval/SUMMARY.md#v7-held-out-round"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-line underline-offset-2 hover:text-ink"
                  >
                    eval
                  </a>
                </p>
              </div>
            )}
          </div>
        </section>

        {!started && <HowItWorks />}

        <div ref={resultsRef}>
          {started && (
            // At least a screen tall, so the glide at the start of a run can bring the results to the top.
            <m.div key={startedAt} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="min-h-[calc(100svh-2rem)] space-y-4">
              {replay && <RecordedBanner replay={replay} running={phase === "running"} />}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
                <div className="no-print min-w-0 lg:sticky lg:top-4">
                  <Timeline items={items} running={phase === "running"} elapsedMs={elapsed} agent={agent} />
                </div>
                <div className="min-w-0">
                  {error && (
                    <ErrorState
                      message={error}
                      replay={replay}
                      demos={demos}
                      onRetry={() => (replay ? startReplay(replay) : run(form))}
                      onReplay={startReplay}
                    />
                  )}
                  <PlaybookView live={live} running={phase === "running"} language={form.language} stage={agent.stage} />
                  {phase === "running" && !live.place && !error && <SkeletonCards />}
                </div>
              </div>
            </m.div>
          )}
        </div>
      </main>

      <footer className="no-print border-t border-line pt-5 pb-6 text-center text-xs leading-relaxed text-muted">
        <Marquee items={PROVIDERS} />
        <p className="mt-4 px-4 sm:px-6">
          Built for the Nebius × NVIDIA Global AI Hackathon · Reasoning by NVIDIA Nemotron on Nebius Token Factory · Web research by Tavily · Map data
          © OpenStreetMap contributors · Weather by Open-Meteo
        </p>
      </footer>
    </div>
  );
}

function derive(events: AgentEvent[]): { items: TimelineItem[]; live: LiveState; agent: AgentStatus } {
  const items: TimelineItem[] = [];
  const steps = new Map<string, Step>();
  const live: LiveState = { sources: [], engine: [] };
  // Where the run is (0 context · 1 research · 2 write · 3 verify · 4 done), read from the agent's own events.
  let stage = 0;
  let vision: Step | undefined;
  let repairing = false;
  let repaired = false;
  const seenSources = new Set<string>();
  events.forEach((ev, i) => {
    switch (ev.type) {
      case "note": {
        items.push({ kind: "note", text: ev.text, key: `note-${i}` });
        // The writer is Ultra (Quick) or Super (Economy), and Ultra may take over a retry: the agent says which.
        const writer = /^🧠 (Nemotron [\w. ]+?) is writing your week/.exec(ev.text) ?? / — (Nemotron [\w. ]+?) takes over/.exec(ev.text);
        if (writer) live.writer = writer[1];
        if (/researching the live web/.test(ev.text)) stage = Math.max(stage, 1);
        if (writer) stage = Math.max(stage, 2);
        if (/^🔎 Verifier/.test(ev.text)) {
          stage = Math.max(stage, 3);
          if (/sending them to|asking Nemotron/.test(ev.text)) repairing = repaired = true;
          else repairing = false;
        }
        break;
      }
      case "tool_start": {
        const step: Step = { id: ev.id, tool: ev.tool, label: ev.label, done: false, provider: ev.tool === "draft_playbook" ? live.writer : undefined };
        steps.set(ev.id, step);
        items.push({ kind: "step", step });
        if (ev.tool === "menu_photo") vision = step;
        break;
      }
      case "tool_end": {
        const step = steps.get(ev.id);
        if (step) {
          step.done = true;
          step.error = ev.error;
          step.summary = ev.summary;
          step.sources = ev.sources;
        }
        ev.sources?.forEach((s) => seenSources.add(s));
        break;
      }
      case "place":
        live.place = ev.place;
        break;
      case "week":
        live.week = { days: ev.days, holidays: ev.holidays, events: ev.events };
        break;
      case "block":
        live.block = { radius_m: ev.radius_m, total: ev.total, venues: ev.venues, by_cuisine: ev.by_cuisine };
        break;
      case "menu":
        live.menu = { items: ev.items, from: ev.from, url: ev.url };
        break;
      case "sources":
        live.sources = ev.sources;
        break;
      case "baseline":
        live.baseline = ev.text;
        break;
      case "playbook":
        live.playbook = ev.playbook;
        break;
      case "playbook_draft":
        live.draft = ev.draft;
        break;
      case "engine":
        live.engine = [...live.engine, ev.call];
        if (ev.call.phase === "synthesize") live.writer = ev.call.label;
        if (ev.call.phase === "gather") stage = Math.max(stage, 1);
        if (ev.call.phase === "synthesize") stage = Math.max(stage, 2);
        break;
      case "tavily":
        live.tavilyCredits = ev.credits;
        break;
      case "done":
        stage = 4;
        repairing = false;
        break;
    }
  });

  const state = (s: number): ModelChip["state"] => (stage === s ? "active" : stage > s ? "done" : "waiting");
  const chips: ModelChip[] = [{ key: "research", model: "Lightning", role: "researches", state: state(1) }];
  if (vision) chips.push({ key: "vision", model: "Super VL", role: "reads the menu", state: vision.done ? "done" : "active" });
  chips.push({ key: "write", model: live.writer?.replace(/^Nemotron /, "") ?? "Nemotron", role: "writes", state: state(2) });
  if (repaired) chips.push({ key: "repair", model: "Ultra", role: "repairs", state: repairing && stage < 4 ? "active" : "done" });

  const agent: AgentStatus = {
    stage,
    chips,
    sources: Math.max(seenSources.size, live.sources.length),
    tavily: live.tavilyCredits,
    tokens: live.engine.reduce((n, c) => n + (c.prompt_tokens ?? 0) + (c.completion_tokens ?? 0), 0),
    cost: live.engine.reduce((n, c) => n + (c.est_cost_usd ?? 0), 0),
  };
  return { items, live, agent };
}

/** Two-option switch with a sliding pill (language, writer). */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = Math.max(0, options.findIndex((o) => o.id === value));
  usePillClip(ref, active);
  return (
    <div ref={ref} className="relative">
      <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-line bg-paper/60 p-0.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            data-pill-item=""
            data-active={value === o.id}
            onClick={() => onChange(o.id)}
            className="min-h-8 rounded-full px-3 text-ink-2 transition-colors hover:text-ink"
          >
            {o.label}
          </button>
        ))}
      </div>
      <div aria-hidden className="pill-layer pointer-events-none absolute inset-0 inline-flex rounded-full border border-transparent bg-ink p-0.5">
        {options.map((o) => (
          <span key={o.id} className="grid min-h-8 place-items-center rounded-full px-3 text-paper">
            {o.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecordedBanner({ replay, running }: { replay: DemoSummary; running: boolean }) {
  return (
    <p className="no-print flex flex-col items-start gap-x-3 gap-y-1.5 rounded-xl border border-saffron/50 bg-saffron/10 px-4 py-2.5 text-[13px] text-ink-2 sm:flex-row sm:items-center">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-paper">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-saffron ${running ? "pulse-dot" : ""}`} />
        {running ? "Replaying" : "Replay"}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="font-semibold text-ink">Recorded run</strong> — an instant replay of a real live run from{" "}
        {new Date(replay.recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (same events, same sources, sped
        up). The week it describes is that week. Use the form to run it live for any restaurant.
      </span>
    </p>
  );
}

function ErrorState({
  message,
  replay,
  demos,
  onRetry,
  onReplay,
}: {
  message: string;
  replay: DemoSummary | null;
  demos: DemoSummary[];
  onRetry: () => void;
  onReplay: (d: DemoSummary) => void;
}) {
  const others = demos.filter((d) => d.slug !== replay?.slug).slice(0, 3);
  return (
    <m.div
      role="alert"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 flex gap-3 rounded-2xl border border-terracotta/30 bg-terracotta/5 px-5 py-4 text-sm"
    >
      <span aria-hidden className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-terracotta/10 text-terracotta">
        <IconAlert size={16} />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-terracotta">The agent hit a problem</p>
        <p className="mt-1 text-ink-2">{message}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="min-h-9 rounded-full bg-ink px-4 text-xs font-medium text-paper transition-[background-color,scale] hover:bg-olive motion-safe:active:scale-[0.97]"
          >
            Try again
          </button>
          {others.length > 0 && (
            <>
              <span className="text-xs text-muted">or watch a recorded real run:</span>
              {others.map((d) => (
                <button
                  key={d.slug}
                  type="button"
                  onClick={() => onReplay(d)}
                  className="group inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-card px-3 text-xs font-medium text-ink-2 transition hover:text-ink"
                >
                  {d.restaurant} <IconArrow size={12} className="nudge" />
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </m.div>
  );
}

function Field({ label, children, asDiv }: { label: string; children: React.ReactNode; asDiv?: boolean }) {
  // asDiv: the child is itself a <label> (file picker), and labels must not nest.
  const Tag = asDiv ? "div" : "label";
  return (
    <Tag className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
    </Tag>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#2f4a35" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#f6f1e7" strokeWidth="1.6" />
      <g className="origin-center transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] [transform-box:fill-box] motion-safe:group-hover:rotate-90">
        <path d="M16 6.5v19M6.5 16h19" stroke="#dd9a2e" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <circle cx="16" cy="16" r="3" fill="#c0532c" />
    </svg>
  );
}

function HowItWorks() {
  const steps = [
    ["Your week", "The 7-day forecast at your door, public holidays, and the concerts and matches within 5 km."],
    ["Your block", "Every restaurant, bar and café within 600 m from OpenStreetMap — who serves your cuisine next door."],
    ["The live web", "An agent reads your menu, what guests and critics say, local news and a rival’s prices, with Tavily."],
    ["A plan you can check", "Three dishes, an event, a post and a supplier order — every cited claim linked to the sentence it stands on and checked in code."],
  ];
  return (
    <section aria-label="How it works" className="grid gap-6 border-t border-line py-10 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map(([t, d], i) => (
        <Reveal key={t} delay={i * STAGGER * 1.4}>
          <p className="font-display text-3xl text-terracotta">{String(i + 1).padStart(2, "0")}</p>
          <p className="mt-1 font-semibold">{t}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">{d}</p>
        </Reveal>
      ))}
    </section>
  );
}

/** Shapes of what is coming (the playbook header, the week strip, a section), while the agent locates the place. */
function SkeletonCards() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="shimmer rounded-2xl bg-olive/85 p-6 sm:p-8">
        <div className="h-2.5 w-36 rounded-full bg-paper/25" />
        <div className="mt-4 h-8 w-56 rounded-lg bg-paper/25" />
        <div className="mt-3 h-3 w-72 max-w-full rounded-full bg-paper/20" />
      </div>
      <div className="rounded-2xl border border-line bg-card p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="shimmer h-[148px] rounded-xl border border-line bg-paper/60" style={{ "--d": `${i * 60}ms` } as CSSProperties} />
          ))}
        </div>
      </div>
      <div className="shimmer h-56 rounded-2xl border border-line bg-card" />
    </div>
  );
}

/** The providers behind every plan, drifting by; pauses on hover, sits still with reduced motion. */
function Marquee({ items }: { items: string[] }) {
  const row = (copy: boolean) => (
    <ul aria-hidden={copy || undefined} className={`flex shrink-0 items-center ${copy ? "marquee-copy" : ""}`}>
      {items.map((p) => (
        <li key={p} className="flex items-center whitespace-nowrap px-5 font-display text-[17px] text-ink-2/80 sm:text-[19px]">
          {p}
          <span aria-hidden className="ml-10 h-1 w-1 rounded-full bg-terracotta/60" />
        </li>
      ))}
    </ul>
  );
  return (
    <div className="marquee overflow-hidden">
      <div className="marquee-track flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
