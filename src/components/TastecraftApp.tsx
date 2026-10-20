"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentRequest } from "@/lib/types";
import { readNdjson } from "@/lib/ndjson";
import Timeline, { type Step, type TimelineItem } from "./Timeline";
import PlaybookView, { type LiveState } from "./PlaybookView";
import { IconArrow, IconSearch } from "./icons";

const GOALS = ["Fill quiet weeknights", "Make the most of this week’s weather", "Win more lunch covers", "Launch a seasonal special", "Grow takeaway orders"];

const SAMPLES: AgentRequest[] = [
  { restaurant: "Casa Lucio", city: "Madrid", goal: "Fill quiet weeknights" },
  { restaurant: "Katz's Delicatessen", city: "New York", goal: "Make the most of this week’s weather" },
  { restaurant: "Gjelina", city: "Los Angeles", goal: "Win more lunch covers" },
];

const MAX_PHOTO_EDGE = 1600;

type Phase = "idle" | "running" | "done" | "error";

const timestamp = () => Date.now();

export type DemoSummary = { slug: string; restaurant: string; city: string; goal?: string; recordedAt: string };

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

export default function TastecraftApp({ demos = [] }: { demos?: DemoSummary[] }) {
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

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(timestamp()), 500);
    return () => clearInterval(t);
  }, [phase]);

  const { items, live } = useMemo(() => derive(events), [events]);
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
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
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

  const started = phase !== "idle";
  const inputCls = "w-full rounded-lg border border-line bg-paper/60 px-3 py-2.5 text-[15px] outline-none transition focus:border-olive focus:bg-card";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Tastecraft home">
          <Logo />
          <span className="font-display text-xl tracking-tight">Tastecraft</span>
        </Link>
        <nav className="flex items-center gap-4 text-xs text-muted">
          <span className="hidden sm:inline">Live local data × NVIDIA Nemotron</span>
          <Link href="/about" className="rounded-full border border-line px-3 py-1 text-ink-2 transition hover:border-ink-2/40 hover:text-ink">
            How it works
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 sm:px-6">
        <section className={`no-print grid gap-10 ${started ? "py-4" : "py-10 sm:py-16"} lg:grid-cols-[1.1fr_1fr] lg:items-center`}>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-terracotta">For independent restaurants</p>
            <h1 className="font-display mt-3 text-4xl leading-[1.05] tracking-tight sm:text-6xl">Plan this week with what’s happening around you.</h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
              Rain on Thursday, a match two streets away, a holiday on Sunday, a rival that just raised its prices. Tastecraft reads your week —
              forecast, events, your block, your menu and what guests say online — and turns it into three dishes to test, an event, a post and a
              supplier order. Every claim links to the exact sentence it stands on, checked in code.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-olive" />
                Runs on <strong className="font-medium text-ink-2">NVIDIA Nemotron</strong> · Nebius Token Factory
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">⚡ Lightning researches · 👁 Super VL reads menus · 🧠 Ultra writes</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1">🔎 Live web by Tavily</span>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(form);
            }}
            className="rounded-2xl border border-line bg-card p-5 shadow-[0_1px_0_rgba(29,27,23,0.04),0_18px_40px_-28px_rgba(29,27,23,0.35)] sm:p-6"
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
                  placeholder="casalucio.es"
                  inputMode="url"
                  className={inputCls}
                />
              </Field>
              <Field label="Menu photo (optional)" asDiv>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line bg-paper/60 px-3 py-2.5 text-[14px] text-ink-2 transition hover:border-olive">
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
                    className={`rounded-full border px-3 py-1.5 text-[13px] transition ${
                      form.goal === g ? "border-olive bg-olive text-paper" : "border-line bg-paper/60 text-ink-2 hover:border-ink-2/40"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="mt-4 flex items-center gap-3 text-xs text-ink-2">
              <span>Plan language</span>
              <div role="radiogroup" aria-label="Plan language" className="inline-flex rounded-full border border-line bg-paper/60 p-0.5">
                {(["English", "Español"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={(form.language ?? "English") === l}
                    onClick={() => setForm({ ...form, language: l })}
                    className={`rounded-full px-3 py-1 transition ${(form.language ?? "English") === l ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={phase === "running"}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-paper transition hover:bg-olive disabled:cursor-wait disabled:opacity-70"
            >
              {phase === "running" ? (
                <>
                  <span className="pulse-dot h-2 w-2 rounded-full bg-saffron" /> Reading your week…
                </>
              ) : (
                <>
                  <IconSearch size={17} /> Plan my week
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
                    const req: AgentRequest = { restaurant: s.restaurant, city: s.city, goal: s.goal, language: "English" };
                    setForm(req);
                    setPhotoName(null);
                    run(req, "slug" in s ? s : undefined);
                  }}
                  disabled={phase === "running"}
                  className="inline-flex items-center gap-1 text-ink-2 underline decoration-line underline-offset-4 hover:text-ink hover:decoration-ink-2"
                >
                  {s.restaurant}, {s.city} <IconArrow size={12} />
                </button>
              ))}
            </div>
          </form>
        </section>

        {!started && <HowItWorks />}

        <div ref={resultsRef} className="scroll-mt-4">
          {started && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
              <div className="no-print min-w-0 lg:sticky lg:top-4">
                <Timeline items={items} running={phase === "running"} elapsedMs={elapsed} />
              </div>
              <div className="min-w-0">
                {replay && (
                  <p className="mb-4 rounded-xl border border-line bg-card px-4 py-2.5 text-[13px] text-ink-2">
                    <strong className="font-semibold">Recorded run</strong> — an instant replay of a real live run from{" "}
                    {new Date(replay.recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (same events, same
                    sources, sped up). The week it describes is that week. Use the form to run it live for any restaurant.
                  </p>
                )}
                {error && (
                  <div role="alert" className="mb-5 rounded-2xl border border-terracotta/30 bg-terracotta/5 px-5 py-4 text-sm">
                    <p className="font-semibold text-terracotta">The agent hit a problem</p>
                    <p className="mt-1 text-ink-2">{error}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => run(form)} className="rounded-full border border-line bg-card px-3 py-1.5 text-xs font-medium">
                        Try again
                      </button>
                      {demos.length > 0 && (
                        <>
                          <span className="text-xs text-muted">or watch a recorded real run:</span>
                          {demos.slice(0, 3).map((d) => (
                            <button
                              key={d.slug}
                              type="button"
                              onClick={() => {
                                const req: AgentRequest = { restaurant: d.restaurant, city: d.city, goal: d.goal };
                                setForm(req);
                                run(req, d);
                              }}
                              className="rounded-full border border-line bg-card px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink"
                            >
                              {d.restaurant} →
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
                <PlaybookView live={live} running={phase === "running"} language={form.language} />
                {phase === "running" && !live.place && !error && <SkeletonCards />}
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="no-print border-t border-line py-6 text-center text-xs text-muted">
        Built for the Nebius × NVIDIA Global AI Hackathon · Reasoning by NVIDIA Nemotron on Nebius Token Factory · Web research by Tavily · Map data
        © OpenStreetMap contributors · Weather by Open-Meteo
      </footer>
    </div>
  );
}

function derive(events: AgentEvent[]): { items: TimelineItem[]; live: LiveState } {
  const items: TimelineItem[] = [];
  const steps = new Map<string, Step>();
  const live: LiveState = { sources: [], engine: [] };
  events.forEach((ev, i) => {
    switch (ev.type) {
      case "note":
        items.push({ kind: "note", text: ev.text, key: `note-${i}` });
        break;
      case "tool_start": {
        const step: Step = { id: ev.id, tool: ev.tool, label: ev.label, done: false };
        steps.set(ev.id, step);
        items.push({ kind: "step", step });
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
        break;
      case "tavily":
        live.tavilyCredits = ev.credits;
        break;
    }
  });
  return { items, live };
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
      <path d="M16 6.5v19M6.5 16h19" stroke="#dd9a2e" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3" fill="#c0532c" />
    </svg>
  );
}

function HowItWorks() {
  const steps = [
    ["Your week", "The 7-day forecast at your door, public holidays, and the concerts and matches within 5 km."],
    ["Your block", "Every restaurant, bar and café within 600 m from OpenStreetMap — who serves your cuisine next door."],
    ["The live web", "An agent reads your menu, what guests and critics say, local news and a rival’s prices, with Tavily."],
    ["A plan you can check", "Three dishes, an event, a post and a supplier order — every claim linked to a source and verified in code."],
  ];
  return (
    <section aria-label="How it works" className="grid gap-4 border-t border-line py-10 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map(([t, d], i) => (
        <div key={t}>
          <p className="font-display text-3xl text-terracotta">{String(i + 1).padStart(2, "0")}</p>
          <p className="mt-1 font-semibold">{t}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">{d}</p>
        </div>
      ))}
    </section>
  );
}

function SkeletonCards() {
  return (
    <div className="space-y-5" aria-hidden>
      {[180, 260, 220].map((h) => (
        <div key={h} className="animate-pulse rounded-2xl border border-line bg-card" style={{ height: h }} />
      ))}
    </div>
  );
}
