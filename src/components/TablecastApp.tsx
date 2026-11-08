"use client";

import Link from "next/link";
import { m } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { AgentEvent, AgentRequest } from "@/lib/types";
import type { DemoPreview } from "@/data/demos";
import { captureLinkTokens, linkTokenHeaders } from "@/lib/link-tokens";
import { readNdjson } from "@/lib/ndjson";
import dynamic from "next/dynamic";
import type { AgentStatus, ModelChip, Step, TimelineItem } from "./Timeline";
import type { LiveState } from "./PlaybookView";
import JudgeNote from "./JudgeNote";
import ReplayWeek from "./ReplayWeek";
import { IconAlert, IconArrow, IconSearch } from "./icons";
import { Reveal, STAGGER, scrollToEl, useMagnetic, usePillClip } from "./motion";
import { OtariChips, OtariMap } from "./OtariMap";

// Routing measured in eval/SUMMARY.md: Ultra at medium effort has the best average and is fast; Super costs a third to a half of Quick on the
// tuning set and 43–63% on held-out restaurants, verifies close to Quick within run-to-run noise (69% vs 79% in the latest round), but is slower.
const MODES = [
  { id: "quick", label: "Quick", hint: "tablecast-write · Nemotron 3 Ultra on Otari" },
  { id: "economy", label: "Economy", hint: "tablecast-economy · Nemotron 3 Super, cheaper" },
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

// The agent log and the playbook only render once a run starts: they load then, so the first screen stays light.
const Timeline = dynamic(() => import("./Timeline"));
const PlaybookView = dynamic(() => import("./PlaybookView"));

const PROVIDERS = ["Otari by Mozilla.ai", "Nemotron 3 Ultra", "Qwen3 235B", "gpt-oss-120b", "OpenStreetMap", "Open-Meteo", "Nager.Date", "Ticketmaster"];

const MAX_PHOTO_EDGE = 1600;

type Phase = "idle" | "running" | "done" | "error";

const timestamp = () => Date.now();

// The link tokens live in the address bar or the tab's sessionStorage and never change while the page is open.
const noSubscription = () => () => {};
const hasLinkToken = () => Object.keys(linkTokenHeaders()).length > 0;

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

/**
 * `liveLocked`: the server keeps live runs for the owner's and the judges' links (LIVE_RUNS_TOKEN is set), so a visitor
 * without one is told up front instead of after pressing the button.
 */
export default function TablecastApp({ demos = [], liveLocked = false }: { demos?: DemoSummary[]; liveLocked?: boolean }) {
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

  // An owner's or judges' link: keep its token for this tab and take it out of the address bar (src/lib/link-tokens.ts).
  useEffect(() => captureLinkTokens(), []);
  // Whether this tab has one: null on the server and during hydration, so the note for visitors without a link never
  // flashes for someone who has one.
  const hasLink = useSyncExternalStore(noSubscription, hasLinkToken, () => null);

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
            headers: { "content-type": "application/json", ...linkTokenHeaders() },
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

  // Cancel a live run: closing the stream aborts the server's model calls and frees the slot. Back to the form, which keeps what was typed.
  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setEvents([]);
    setError(null);
    setReplay(null);
    setPhase("idle");
    requestAnimationFrame(() => scrollToEl(document.body));
  }

  const started = phase !== "idle";
  const liveEta = (form.mode ?? "quick") === "economy" ? "usually 2–3 min" : "usually 1–2 min";
  const hasPreview = demos.some((d) => d.preview);
  const inputCls =
    "min-h-11 w-full border border-line bg-paper px-3 py-2.5 text-[15px] transition-colors placeholder:text-muted hover:border-ink-2/50 focus:border-olive focus-visible:outline-2 focus-visible:outline-offset-0";

  const formEl = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(form);
      }}
      className="rise min-w-0 border border-line bg-card p-4 [--d:120ms] sm:p-6"
    >
      <JudgeNote phase={phase} />
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
          <label className="flex min-h-11 cursor-pointer items-center gap-2 border border-dashed border-line bg-paper px-3 py-2.5 text-[14px] text-ink-2 transition hover:border-olive has-[:focus-visible]:border-olive has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-olive">
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
      <fieldset className="mt-5">
        <legend className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">What do you want this week?</legend>
        <div className="flex flex-wrap gap-1.5">
          {GOALS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={form.goal === g}
              onClick={() => setForm({ ...form, goal: g })}
              className={`min-h-10 border px-3 text-[13px] transition-[color,background-color,border-color,scale] duration-200 motion-safe:active:scale-[0.97] ${
                form.goal === g ? "border-olive bg-olive text-paper" : "border-line bg-paper text-ink-2 hover:border-ink-2/50 hover:text-ink"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2">
        <span className="w-20 shrink-0">Language</span>
        <Segmented label="Plan language" options={LANGUAGES} value={form.language ?? "English"} onChange={(l) => setForm({ ...form, language: l })} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2">
        <span className="w-20 shrink-0">Writer</span>
        <Segmented label="Which writer plans the week" options={MODES} value={form.mode ?? "quick"} onChange={(mode) => setForm({ ...form, mode })} />
        <span className="normal-case tracking-normal text-muted">{MODES.find((md) => md.id === (form.mode ?? "quick"))?.hint}</span>
      </div>
      <button
        ref={submit}
        type="submit"
        disabled={phase === "running"}
        className="magnetic group mt-6 inline-flex min-h-13 w-full items-center justify-center gap-2.5 bg-ink px-5 font-mono text-[13px] font-semibold uppercase tracking-[0.06em] text-paper hover:bg-olive disabled:cursor-wait disabled:opacity-70"
      >
        {phase === "running" ? (
          <>
            <span className="pulse-dot h-2 w-2 rounded-full bg-terracotta" /> Reading your week…
          </>
        ) : (
          <>
            <IconSearch size={16} /> Plan my week
            <IconArrow size={15} className="nudge opacity-70" />
          </>
        )}
      </button>
      {liveLocked && hasLink === false && (
        <p className="mt-2.5 text-[12.5px] leading-snug text-muted">
          A live run takes 2 to 4 minutes and spends real Otari credit, so on this public page it needs the owner’s link or the judges’ link.
          The recorded runs are real runs on Otari and play at once.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
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
            className="hit group inline-flex items-center gap-1 text-ink-2 underline decoration-line underline-offset-4 transition-colors hover:text-olive hover:decoration-olive disabled:opacity-60"
          >
            {s.restaurant}, {s.city} <IconArrow size={12} className="nudge" />
          </button>
        ))}
      </div>
    </form>
  );

  return (
    <div className="relative isolate flex min-h-screen flex-col overflow-x-clip">
      <header className="no-print flex w-full items-center justify-between gap-4 border-b border-line px-4 py-2.5 sm:px-8">
        <Link href="/" className="group flex min-h-11 items-center gap-2.5" aria-label="Tablecast home">
          <Logo />
          <span className="font-wordmark text-xl tracking-tight">Tablecast</span>
        </Link>
        <nav className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em]">
          <span className="hidden pr-4 text-muted lg:inline">Live local data × open-weight models on Otari</span>
          {!started && (
            <a href="#otari-map" className="hidden min-h-10 items-center px-3 text-ink-2 transition-colors hover:text-olive sm:inline-flex">
              Otari map
            </a>
          )}
          <Link
            href="/about"
            className="group inline-flex min-h-10 items-center gap-1.5 border border-line px-3 text-ink transition-colors hover:border-olive hover:text-olive"
          >
            How it works <IconArrow size={12} className="nudge" />
          </Link>
        </nav>
      </header>

      <main className="w-full flex-1 px-4 pb-20 sm:px-8">
        <section
          className={`no-print grid gap-8 ${started ? "py-6" : "pb-14 pt-8 sm:pt-12"} lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12 xl:gap-x-16`}
        >
          <div className="flex min-w-0 flex-col lg:col-start-1 lg:row-start-1">
            <h1
              className={`ruled font-display uppercase leading-[0.92] [--lh:0.92em] ${
                started ? "text-[clamp(2.6rem,9vw,4.2rem)]" : "text-[clamp(3.3rem,13.6vw,5.4rem)] lg:text-[clamp(5rem,6.7vw,7.4rem)]"
              }`}
            >
              Plan this week with what’s happening around you.
            </h1>
            <p className="rise mt-6 max-w-[34rem] text-[17px] leading-relaxed text-ink-2 [--d:420ms] sm:text-[18px]">
              Rain on Wednesday, a match two streets away, a holiday on Sunday. Tablecast reads a restaurant’s week and turns it into three dishes to
              test, an event, a post and a supplier order. Every cited claim links to the sentence it stands on, checked in code.
            </p>
            {!started && (
              <>
                <a
                  href="#run-live"
                  className="rise group mt-5 inline-flex min-h-11 w-fit items-center gap-2 font-mono text-[12px] uppercase tracking-[0.06em] text-olive underline decoration-olive/40 underline-offset-[6px] transition-colors hover:decoration-olive [--d:520ms]"
                >
                  Or plan your own restaurant’s week <IconArrow size={13} className="rotate-90" />
                </a>
              </>
            )}
          </div>

          {started ? (
            formEl
          ) : hasPreview ? (
            <ReplayWeek demos={demos} onPlay={startReplay} className="rise [--d:200ms] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:-mr-8 lg:self-start lg:border-r-0" />
          ) : (
            demos.length > 0 && (
              <div className="border border-line bg-card p-5">
                <p className="text-[14px] font-semibold text-olive">Watch a real recorded run, no wait</p>
                <p className="mt-1 text-[12px] text-ink-2">Instant replays of live runs, labelled as recorded.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {demos.map((d) => (
                    <button
                      key={d.slug}
                      type="button"
                      onClick={() => startReplay(d)}
                      className="group inline-flex min-h-11 items-center gap-1 border border-line bg-paper px-3 text-[13px] text-ink-2 transition hover:border-olive hover:text-ink"
                    >
                      {d.restaurant}, {d.city} <IconArrow size={12} className="nudge" />
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
          {!started && <OtariChips className="rise min-w-0 [--d:600ms] lg:col-start-1 lg:row-start-2 lg:self-end" />}
        </section>

        {!started && (
          <section
            id="run-live"
            aria-labelledby="run-live-title"
            className="no-print -mx-4 scroll-mt-4 border-y border-line bg-paper-2/50 px-4 py-12 sm:-mx-8 sm:px-8 sm:py-16"
          >
            <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12 xl:gap-16">
              <div className="min-w-0">
                <h2 id="run-live-title" className="font-display text-[clamp(2.6rem,9vw,4.6rem)] uppercase leading-[0.9]">
                  Your restaurant,
                  <br />
                  <span className="text-olive">this week</span>
                </h2>
                <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-2">
                  Type a restaurant and its city. Tablecast reads its week, its block and the live web through Otari, writes the plan and checks every
                  cited claim in code.
                </p>
                <MeasuredOnOtari demos={demos} className="mt-10" />
              </div>
              {formEl}
            </div>
          </section>
        )}

        {!started && <OtariMap />}
        {!started && <HowItWorks />}

        <div ref={resultsRef}>
          {started && (
            // At least a screen tall, so the glide at the start of a run can bring the results to the top.
            <m.div key={startedAt} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="min-h-[calc(100svh-2rem)] space-y-4">
              {replay && <RecordedBanner replay={replay} running={phase === "running"} />}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
                <div className="no-print min-w-0 lg:sticky lg:top-4">
                  <Timeline
                    items={items}
                    running={phase === "running"}
                    elapsedMs={elapsed}
                    agent={agent}
                    eta={replay ? undefined : liveEta}
                    onStop={replay ? undefined : stop}
                  />
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

      <footer className="no-print border-t border-line pb-6 pt-4">
        <Marquee items={PROVIDERS} />
        <p className="mt-4 border-t border-line px-4 pt-4 font-mono text-[11px] leading-relaxed text-muted sm:px-8">
          Built for MozFest Developers Wilding (Mozilla.ai) · Every model call, web search, guardrail check and sandbox run through Otari · Open-weight
          models on Otari’s hosted providers · Map data © OpenStreetMap contributors · Weather by Open-Meteo
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
        // The writer is tablecast-write (Quick) or tablecast-economy, and the Quick writer may take over a retry: the agent says which.
        const writer = /^🧠 (.+?) is writing your week/.exec(ev.text) ?? / — ([\w. -]+?) takes over \(/.exec(ev.text);
        if (writer) live.writer = writer[1];
        if (/researching the live web/.test(ev.text)) stage = Math.max(stage, 1);
        if (writer) stage = Math.max(stage, 2);
        if (/^🔎 Verifier/.test(ev.text)) {
          stage = Math.max(stage, 3);
          if (/sending (them|it) to|asking /.test(ev.text)) repairing = repaired = true;
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
      case "otari":
        live.otari = { run_id: ev.run_id, api: ev.api, routing: ev.routing, missing: ev.missing, end_user: ev.end_user, judge: ev.judge };
        break;
      case "budget": {
        const line = { end_user: ev.end_user, spend: ev.spend, limit: ev.limit, budget: ev.budget, period: ev.period, before: ev.before };
        live.budget = { ...live.budget, [ev.stage]: line };
        break;
      }
      case "guardrails":
        live.screening = ev.screening;
        break;
      case "quartermaster":
        live.quartermaster = ev.report;
        break;
      case "engine":
        live.engine = [...live.engine, ev.call];
        if (ev.call.phase === "synthesize") live.writer = ev.call.label;
        if (ev.call.phase === "gather") live.researcher ??= ev.call.label;
        if (ev.call.phase === "verify") live.checker = ev.call.label;
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

  // Pages read through the Tablecast MCP server (inside Otari's tool loop) or by the in-process reader.
  for (const st of steps.values()) {
    if (st.tool !== "read_pages" || !st.done || st.error || !st.sources?.length) continue;
    if (/Tablecast MCP/.test(st.label)) live.mcpReads = (live.mcpReads ?? 0) + st.sources.length;
    else live.inProcessReads = (live.inProcessReads ?? 0) + st.sources.length;
  }
  const state = (s: number): ModelChip["state"] => (stage === s ? "active" : stage > s ? "done" : "waiting");
  // Older recordings (the Nebius version) name Nemotrons; Otari runs name whatever model Otari says answered.
  const short = (l?: string) => l?.replace(/^Nemotron (3\.?5? )?/, "");
  const chips: ModelChip[] = [{ key: "research", model: short(live.researcher) ?? "Researcher", role: "researches", state: state(1) }];
  if (vision) chips.push({ key: "vision", model: "Vision", role: "reads the menu", state: vision.done ? "done" : "active" });
  chips.push({ key: "write", model: short(live.writer) ?? "Writer", role: "writes", state: state(2) });
  if (repaired) chips.push({ key: "repair", model: short(live.checker) ?? "Checker", role: "repairs", state: repairing && stage < 4 ? "active" : "done" });

  const agent: AgentStatus = {
    stage,
    chips,
    sources: Math.max(seenSources.size, live.sources.length),
    tavily: live.tavilyCredits,
    searches: live.engine.filter((c) => c.phase === "search").length,
    tokens: live.engine.reduce((n, c) => n + (c.prompt_tokens ?? 0) + (c.completion_tokens ?? 0), 0),
    cost: live.engine.reduce((n, c) => n + (c.cost_usd ?? c.est_cost_usd ?? 0), 0),
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
      <div role="radiogroup" aria-label={label} className="inline-flex border border-line bg-paper p-0.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            data-pill-item=""
            data-active={value === o.id}
            onClick={() => onChange(o.id)}
            className="min-h-9 px-3 uppercase text-ink-2 transition-colors hover:text-ink"
          >
            {o.label}
          </button>
        ))}
      </div>
      <div aria-hidden className="pill-layer pointer-events-none absolute inset-0 inline-flex border border-transparent bg-olive p-0.5">
        {options.map((o) => (
          <span key={o.id} className="grid min-h-9 place-items-center px-3 uppercase text-paper">
            {o.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecordedBanner({ replay, running }: { replay: DemoSummary; running: boolean }) {
  return (
    <p className="no-print flex flex-col items-start gap-x-3 gap-y-1.5 border border-terracotta/50 bg-terracotta/[0.06] px-4 py-2.5 text-[13px] text-ink-2 sm:flex-row sm:items-center">
      <span className="inline-flex items-center gap-1.5 bg-terracotta px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-paper ${running ? "pulse-dot" : ""}`} />
        {running ? "Replaying" : "Replay"}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="font-semibold text-ink">Recorded run:</strong> an instant replay of a real live run{replay.preview?.otari ? " on Otari" : ""} from{" "}
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
  // Paused, switched off, out of budget or kept for the owner's and judges' links: retrying won't help, so offer only the recorded runs.
  const locked = /kept for its owner/i.test(message);
  const resting = locked || /paused|used up|switched off/i.test(message);
  return (
    <m.div
      role="alert"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 flex gap-3 border border-terracotta/40 bg-terracotta/[0.06] px-5 py-4 text-sm"
    >
      <span aria-hidden className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-terracotta/10 text-terracotta">
        <IconAlert size={16} />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-terracotta">
          {locked ? "Live runs need the owner’s or the judges’ link" : resting ? "Live runs are resting right now" : "The agent hit a problem"}
        </p>
        <p className="mt-1 text-ink-2">{message}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!resting && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-9 rounded-[3px] bg-ink px-4 text-xs font-medium text-paper transition-[background-color,scale] hover:bg-olive motion-safe:active:scale-[0.97]"
            >
              Try again
            </button>
          )}
          {others.length > 0 && (
            <>
              <span className="text-xs text-muted">{resting ? "Watch a recorded real run:" : "or watch a recorded real run:"}</span>
              {others.map((d) => (
                <button
                  key={d.slug}
                  type="button"
                  onClick={() => onReplay(d)}
                  className="group inline-flex min-h-9 items-center gap-1 rounded-[3px] border border-line bg-card px-3 text-xs font-medium text-ink-2 transition hover:text-ink"
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

/** Figures measured on Otari, next to the form: what Otari billed each recorded run (read from the recordings) and the drill. */
function MeasuredOnOtari({ demos, className = "" }: { demos: DemoSummary[]; className?: string }) {
  const billed = demos.filter((d) => d.preview?.onOtari?.billed != null);
  return (
    <div className={className}>
      <p className="border-b border-line pb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
        Measured on Otari <span className="text-muted">· single runs from 4 Nov 2026, not an eval</span>
      </p>
      <dl>
        {billed.length > 0 && (
          <div className="grid gap-x-5 gap-y-1 border-b border-line py-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-baseline">
            <dt className="sr-only">What Otari billed each recorded plan</dt>
            <dd className="font-display text-[40px] leading-none text-olive tabular-nums">
              {billed.map((d) => `$${d.preview!.onOtari!.billed!.toFixed(3)}`).join(" · ")}
            </dd>
            <dd className="text-[13px] leading-snug text-ink-2">
              billed by Otari to each restaurant’s own end user for {billed.length === 1 ? "the recorded plan" : `the ${billed.length} recorded plans`} (
              {billed.map((d) => d.restaurant).join(", ")}), against a $1 weekly budget
            </dd>
          </div>
        )}
        <div className="grid gap-x-5 gap-y-1 border-b border-line py-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-baseline">
          <dt className="sr-only">The failover drill</dt>
          <dd className="font-display text-[40px] leading-none text-olive tabular-nums">2 attempts</dd>
          <dd className="text-[13px] leading-snug text-ink-2">
            in the failover drill: Mistral Large 3 refuses a parameter the drill sends, Otari moves on by itself and Nemotron 3 Ultra answers (
            <code className="text-[11.5px] text-ink">Otari-Fallback: true</code>)
          </dd>
        </div>
      </dl>
      <a
        href="https://github.com/antonmareo10/tablecast/tree/otari-wilding#what-i-measured-on-otari"
        target="_blank"
        rel="noopener noreferrer"
        className="group mt-3 inline-flex min-h-11 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2 underline decoration-line underline-offset-4 hover:text-olive hover:decoration-olive"
      >
        What I measured <IconArrow size={12} className="nudge" />
      </a>
    </div>
  );
}

/** The four stops from the forecast to the plan, drawn as a line with stations. */
function HowItWorks() {
  const steps = [
    ["Your week", "The 7-day forecast at your door, public holidays, and the concerts and matches within 5 km."],
    ["Your block", "Every restaurant, bar and café within 600 m, from OpenStreetMap: who serves your cuisine next door."],
    ["The live web", "An agent searches the web through Otari and reads your menu, what guests and critics say, local news and a rival’s prices."],
    ["A plan you can check", "Three dishes, an event, a post and a supplier order. Every cited claim is linked to the sentence it stands on and checked in code."],
  ];
  return (
    <section aria-labelledby="how-title" className="py-14 sm:py-20">
      <h2 id="how-title" className="font-display text-[clamp(2.4rem,7vw,4.2rem)] uppercase leading-[0.9]">
        From the forecast <span className="text-muted">to the plan</span>
      </h2>
      <ol className="mt-10 grid gap-8 lg:grid-cols-4 lg:gap-0">
        {steps.map(([t, d], i) => (
          <Reveal
            as="li"
            key={t}
            delay={i * STAGGER * 1.4}
            className="relative pl-9 before:absolute before:bottom-[-2rem] before:left-[7px] before:top-0 before:w-px before:bg-line last:before:hidden lg:pl-0 lg:pr-8 lg:pt-10 lg:before:bottom-auto lg:before:left-0 lg:before:right-0 lg:before:top-[7px] lg:before:h-px lg:before:w-auto lg:last:before:block lg:last:before:right-1/2"
          >
            <span aria-hidden className={`absolute left-0 top-0 h-[15px] w-[15px] rounded-full border-2 ${i === 3 ? "border-olive bg-olive" : "border-olive bg-paper"}`} />
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-olive">Stop {String(i + 1).padStart(2, "0")}</p>
            <p className="mt-1 font-display text-[28px] uppercase leading-none">{t}</p>
            <p className="mt-2 max-w-xs text-[14px] leading-relaxed text-ink-2">{d}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

/** Shapes of what is coming (the playbook header, the week strip, a section), while the agent locates the place. */
function SkeletonCards() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="shimmer border border-line bg-card p-6 sm:p-8">
        <div className="h-2.5 w-36 bg-paper-2" />
        <div className="mt-4 h-8 w-56 bg-paper-2" />
        <div className="mt-3 h-3 w-72 max-w-full bg-paper-2" />
      </div>
      <div className="border border-line bg-card p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="shimmer h-[148px] border border-line bg-paper" style={{ "--d": `${i * 60}ms` } as CSSProperties} />
          ))}
        </div>
      </div>
      <div className="shimmer h-56 border border-line bg-card" />
    </div>
  );
}

/** The providers behind every plan, drifting by like a station ticker; pauses on hover, sits still with reduced motion. */
function Marquee({ items }: { items: string[] }) {
  const row = (copy: boolean) => (
    <ul aria-hidden={copy || undefined} className={`flex shrink-0 items-center ${copy ? "marquee-copy" : ""}`}>
      {items.map((p) => (
        <li key={p} className="flex items-center whitespace-nowrap px-6 font-display text-[34px] uppercase text-ink-2 sm:text-[48px]">
          {p}
          <span aria-hidden className="ml-12 h-2 w-2 bg-olive" />
        </li>
      ))}
    </ul>
  );
  return (
    <div className="marquee overflow-hidden py-2">
      <div className="marquee-track flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
