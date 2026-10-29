"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { domMax, LazyMotion, m } from "motion/react";
import { SPRING } from "../motion";
import type { DemoSummary } from "../TablecastApp";
import Board from "./Board";
import Connect from "./Connect";
import { Logo, RecordedTag } from "./parts";
import Queue from "./Queue";
import Replan from "./Replan";
import Review from "./Review";
import Schedule from "./Schedule";
import { LIVE_KEY, STEPS, useWeekStore, type StepId } from "./store";

export default function WeekApp({ demos }: { demos: DemoSummary[] }) {
  const w = useWeekStore();
  const params = useMemo(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search)), []);
  const notice = w.hydrated ? params?.get("buffer") ?? null : null;

  // Arrivals: back from Buffer's consent screen, from a replay on the home page, or from a live run.
  const { hydrated, loadPlan, setStep } = w;
  useEffect(() => {
    if (!hydrated || !params) return;
    const bufferParam = params.get("buffer");
    const plan = params.get("plan");
    const from = params.get("from");
    if (bufferParam) setStep("connect");
    else if (plan) { void loadPlan({ plan }); setStep("week"); }
    else if (from === "live") {
      try {
        const raw = sessionStorage.getItem(LIVE_KEY);
        if (raw) void loadPlan({ live: JSON.parse(raw) });
      } catch { /* an unreadable hand-off leaves the picker */ }
      setStep("week");
    }
    if (bufferParam || plan || from) window.history.replaceState(null, "", "/week");
  }, [hydrated, params, loadPlan, setStep]);

  const rate = (w.scheduled?.result.rate ?? (w.session.status === "ready" && w.session.info.connected ? w.session.info.rate : []))[0];
  const state = (id: StepId): "done" | "now" | "todo" =>
    id === w.step ? "now" : id === "connect" ? (w.connected ? "done" : "todo") : id === "week" ? (w.plan ? "done" : "todo") : id === "schedule" ? (w.scheduled ? "done" : "todo") : "todo";

  return (
    <LazyMotion features={domMax} strict>
      <div className="relative flex min-h-screen flex-col">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] overflow-hidden">
          <div className="absolute -right-40 -top-56 h-[560px] w-[560px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--saffron)_16%,transparent),transparent)]" />
          <div className="absolute -left-48 -top-64 h-[560px] w-[560px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--olive-2)_14%,transparent),transparent)]" />
        </div>

        <header className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="group flex items-center gap-2.5" aria-label="Tablecast home">
            <Logo />
            <span className="font-display whitespace-nowrap text-xl tracking-tight">Tablecast <span className="text-olive">Week</span></span>
          </Link>
          <div className="flex items-center gap-3 text-xs text-muted">
            {w.plan?.source.kind === "replay" && <span className="hidden sm:inline-flex"><RecordedTag /></span>}
            {rate && <span className="hidden tabular-nums sm:inline" title={`Buffer API window: ${rate.name}`}>{rate.remaining} API calls left, resets in {Math.ceil(rate.resetsInSeconds / 60)} min</span>}
            <Link href="/" className="inline-flex min-h-11 items-center rounded-full border border-line bg-card/60 px-3 text-ink-2 transition hover:border-ink-2/40 hover:text-ink sm:min-h-9"><span className="sm:hidden">New week</span><span className="hidden sm:inline">Plan a new week</span></Link>
          </div>
        </header>

        <nav aria-label="Steps" className="sticky top-0 z-40 border-y border-line/70 bg-paper/90 backdrop-blur">
          <ol className="mx-auto flex w-full max-w-[1440px] gap-1 px-2 py-2 sm:px-6">
            {STEPS.map((s, i) => {
              const st = state(s.id);
              return (
                <li key={s.id} className={`min-w-0 sm:flex-none ${st === "now" ? "flex-[2.4]" : "flex-1"}`}>
                  <button
                    type="button"
                    onClick={() => w.setStep(s.id)}
                    aria-current={st === "now" ? "step" : undefined}
                    className="relative flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-2 text-[13px] font-medium text-ink-2 transition hover:text-ink sm:min-h-10 sm:px-4"
                  >
                    {st === "now" && <m.span layoutId="step-pill" transition={SPRING} className="absolute inset-0 rounded-full bg-ink" aria-hidden />}
                    <span className={`relative grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] tabular-nums ${st === "now" ? "bg-paper/20 text-paper" : st === "done" ? "bg-olive text-paper" : "bg-paper-2 text-muted"}`}>{st === "done" ? "✓" : i + 1}</span>
                    <span className={`relative ${st === "now" ? "text-paper" : "hidden sm:inline"}`}>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-24 pt-6 sm:px-6 sm:pt-8" id="main">
          {!w.hydrated ? (
            <div className="h-72" aria-busy="true" />
          ) : (
            <div key={w.step} className="rise">
              {w.step === "connect" && <Connect w={w} notice={notice} />}
              {w.step === "week" && <Board w={w} demos={demos} />}
              {w.step === "review" && <Review w={w} />}
              {w.step === "schedule" && <Schedule w={w} />}
              {w.step === "queue" && <Queue w={w} />}
              {w.step === "replan" && <Replan w={w} />}
            </div>
          )}
        </main>

        <footer className="mx-auto w-full max-w-[1440px] px-4 pb-8 text-[12px] leading-relaxed text-muted sm:px-6">
          Built on the Buffer API. Tablecast Week is an independent app, not made or endorsed by Buffer. Weather by Open-Meteo.com (CC BY 4.0).
        </footer>
      </div>
    </LazyMotion>
  );
}
