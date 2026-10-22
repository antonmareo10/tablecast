"use client";

import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef } from "react";
import { IconAlert } from "./icons";
import { EASE_OUT, SPRING } from "./motion";
import { CountUp } from "./ui";

export type Step = {
  id: string;
  tool: string;
  label: string;
  done: boolean;
  error?: boolean;
  summary?: string;
  sources?: string[];
  provider?: string; // overrides the per-tool default, e.g. which Nemotron drafts the plan
};

export type TimelineItem =
  | { kind: "step"; step: Step }
  | { kind: "note"; text: string; key: string };

/** A Nemotron model's part in the run, as the agent's own events report it. */
export type ModelChip = { key: string; model: string; role: string; state: "waiting" | "active" | "done" };

/** Live counters and stage, all derived from the run's events (nothing estimated on the client). */
export type AgentStatus = {
  stage: number; // 0 context · 1 research · 2 write · 3 verify · 4 done
  chips: ModelChip[];
  sources: number;
  tavily?: number;
  tokens: number;
  cost: number;
};

const ENTER = { duration: 0.42, ease: EASE_OUT };

export default function Timeline({
  items,
  running,
  elapsedMs,
  agent,
  eta,
  onStop,
}: {
  items: TimelineItem[];
  running: boolean;
  elapsedMs: number;
  agent: AgentStatus;
  eta?: string; // a live run's usual length, shown next to the timer ("usually 1–2 min")
  onStop?: () => void; // live runs only: cancel the run (the server stops its model calls too)
}) {
  // While the agent runs, follow the newest step, unless the reader has scrolled up to read.
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const autoUntil = useRef(0); // our own smooth scroll is not the reader scrolling away
  useEffect(() => {
    const el = list.current;
    if (!el || !running || !follow.current) return;
    autoUntil.current = Date.now() + 700;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [items.length, running]);
  return (
    <section aria-label="What the agent is doing" className="rounded-2xl border border-line bg-card">
      <header className="border-b border-line px-5 pb-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Agent log</p>
            <h2 className="font-display text-lg leading-tight">How Tablecast read your week</h2>
          </div>
          <span className="flex shrink-0 flex-col items-end gap-1 text-right tabular-nums text-xs text-muted">
            {running ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-terracotta" />
                {(elapsedMs / 1000).toFixed(0)}s
              </span>
            ) : elapsedMs > 0 ? (
              `${(elapsedMs / 1000).toFixed(0)}s`
            ) : null}
            {running && eta && <span className="text-[11px]">{eta}</span>}
            {running && onStop && (
              <button
                type="button"
                onClick={onStop}
                className="min-h-7 rounded-full border border-line px-2.5 text-[11px] font-medium text-ink-2 transition-[color,border-color,scale] hover:border-terracotta/50 hover:text-terracotta motion-safe:active:scale-[0.97]"
              >
                Stop
              </button>
            )}
          </span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Nemotron models in this run">
          {agent.chips.map((c) => (
            <ModelPill key={c.key} chip={c} />
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-4 divide-x divide-line overflow-hidden rounded-xl border border-line bg-paper/50 text-center">
          <Counter label="Sources" value={agent.sources} />
          <Counter label="Tavily" hint=" credits" value={agent.tavily} />
          <Counter label="Tokens" value={agent.tokens} format={(n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))} />
          <Counter label="Est. cost" value={agent.cost} format={(n) => `$${n.toFixed(3)}`} decimals={4} />
        </dl>
      </header>
      <ol
        ref={list}
        data-lenis-prevent
        // A scroll box keyboard users can reach and scroll (axe: scrollable-region-focusable).
        tabIndex={0}
        aria-label="Agent log, step by step"
        onScroll={(e) => {
          if (Date.now() < autoUntil.current) return;
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="max-h-[46vh] space-y-1 overflow-y-auto px-3 py-3 lg:max-h-[calc(100vh-18rem)]"
      >
        {items.length === 0 && running && <li className="px-2 py-3 text-sm text-muted">Waking up the agent…</li>}
        {items.length === 0 && !running && <li className="px-2 py-3 text-sm text-muted">The agent stopped before its first step.</li>}
        {items.map((item) =>
          item.kind === "note" ? (
            <m.li
              key={item.key}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={ENTER}
              className="px-2 py-1.5 text-[13px] italic leading-snug text-ink-2"
            >
              {item.text}
            </m.li>
          ) : (
            <StepRow key={item.step.id} step={item.step} running={running} />
          ),
        )}
      </ol>
    </section>
  );
}

function ModelPill({ chip }: { chip: ModelChip }) {
  const tone =
    chip.state === "active"
      ? "border-olive bg-olive text-paper"
      : chip.state === "done"
        ? "border-olive/25 bg-olive/5 text-olive"
        : "border-line bg-paper/40 text-muted";
  return (
    <m.li
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-300 ${tone}`}
    >
      <span aria-hidden className="grid h-3 w-3 place-items-center">
        {chip.state === "active" ? (
          <span className="pulse-ring relative h-1.5 w-1.5 rounded-full bg-saffron [--ring:var(--saffron)]" />
        ) : chip.state === "done" ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full border border-current" />
        )}
      </span>
      <span className="font-semibold">{chip.model}</span>
      <span className="opacity-80">{chip.role}</span>
      <span className="sr-only">{chip.state === "active" ? " (working now)" : chip.state === "done" ? " (done)" : " (not yet)"}</span>
    </m.li>
  );
}

function Counter({
  label,
  hint,
  value,
  format,
  decimals,
}: {
  label: string;
  hint?: string;
  value?: number;
  format?: (n: number) => string;
  decimals?: number;
}) {
  return (
    <div className="min-w-0 px-1 py-2">
      <dt className="truncate text-[10px] uppercase tracking-[0.08em] text-muted">
        {label}
        {hint && <span className="sr-only">{hint}</span>}
      </dt>
      <dd className="mt-0.5 text-[15px] font-semibold text-ink">
        {value == null ? <span className="text-muted">–</span> : <CountUp value={value} format={format} decimals={decimals} duration={700} />}
      </dd>
    </div>
  );
}

const PROVIDER: Record<string, string> = {
  locate: "OpenStreetMap",
  block: "OpenStreetMap",
  forecast: "Open-Meteo",
  holidays: "Nager.Date",
  events: "Ticketmaster",
  web_search: "Tavily",
  read_pages: "Tavily",
  site_map: "Tavily",
  menu_photo: "Nemotron Super VL",
  draft_playbook: "Nemotron",
};

function StatusIcon({ step, running }: { step: Step; running: boolean }) {
  const active = !step.done && !step.error;
  return (
    <span
      className={`relative mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors duration-300 ${
        step.error
          ? "border-terracotta/40 bg-terracotta/10 text-terracotta"
          : step.done
            ? "border-olive/30 bg-olive/10 text-olive"
            : `border-line bg-paper text-terracotta ${running ? "pulse-ring" : ""}`
      }`}
    >
      <AnimatePresence initial={false}>
        {step.error ? (
          <m.span key="error" className="[grid-area:1/1]" initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={SPRING}>
            <IconAlert size={13} />
          </m.span>
        ) : step.done ? (
          <m.svg
            key="done"
            className="[grid-area:1/1]"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={SPRING}
            aria-hidden
          >
            <m.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.36, ease: EASE_OUT, delay: 0.05 }} />
          </m.svg>
        ) : (
          <m.svg
            key="running"
            className={`[grid-area:1/1] ${running && active ? "spin" : ""}`}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
            exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.15 } }}
          >
            <circle cx="12" cy="12" r="8" stroke="var(--line)" strokeWidth="2.6" />
            <path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </m.svg>
        )}
      </AnimatePresence>
      <span className="sr-only">{step.error ? "Failed" : step.done ? "Done" : "Working"}</span>
    </span>
  );
}

function StepRow({ step, running }: { step: Step; running: boolean }) {
  const ids = step.sources ? [...new Set(step.sources)] : [];
  return (
    <m.li
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={ENTER}
      className="rounded-xl px-2 py-2.5 transition-colors hover:bg-paper/60"
    >
      <div className="flex items-start gap-3">
        <StatusIcon step={step} running={running} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">
            {step.label}
            {(step.provider ?? PROVIDER[step.tool]) && (
              <span className="ml-1.5 rounded-full bg-paper-2 px-1.5 py-px align-middle text-[10px] font-normal text-ink-2">
                {step.provider ?? PROVIDER[step.tool]}
              </span>
            )}
          </p>
          <AnimatePresence initial={false}>
            {step.summary && (
              <m.p key="summary" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="mt-0.5 text-[13px] leading-snug text-ink-2">
                {step.summary}
              </m.p>
            )}
          </AnimatePresence>
          {ids.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Sources added">
              {ids.slice(0, 8).map((id, i) => (
                <m.li
                  key={id}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ ...SPRING, delay: i * 0.035 }}
                  className="rounded-full border border-line bg-paper px-1.5 py-px text-[10px] tabular-nums text-ink-2"
                >
                  {id}
                </m.li>
              ))}
              {ids.length > 8 && <li className="text-[10px] text-muted">+{ids.length - 8}</li>}
            </ul>
          )}
        </div>
      </div>
    </m.li>
  );
}
