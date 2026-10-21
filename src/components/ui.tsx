"use client";

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { m } from "motion/react";
import { IconAlert, IconCheck, IconCopy } from "./icons";
import { Reveal, SPRING, useReveal } from "./motion";
import { useToast } from "./toast";
import type { Cite, Evidence, Source } from "@/lib/types";

export function Section({
  icon,
  kicker,
  title,
  children,
  aside,
}: {
  icon?: ReactNode;
  kicker: string;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Reveal as="section" className="scroll-mt-20 rounded-2xl border border-line bg-card p-5 sm:p-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper text-olive">
              {icon}
            </span>
          )}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{kicker}</p>
            <h3 className={`font-display leading-tight ${title.length > 80 ? "text-lg sm:text-xl" : "text-xl sm:text-2xl"}`}>{title}</h3>
          </div>
        </div>
        {aside}
      </header>
      {children}
    </Reveal>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const what = label.replace(/^Copy\s*/, "");
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast(what ? `${what[0].toUpperCase()}${what.slice(1)} copied` : "Copied");
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
          toast("Couldn’t copy here — select the text and copy it instead");
        }
      }}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 transition-[color,border-color,scale] hover:border-ink-2/40 hover:text-ink motion-safe:active:scale-[0.97]"
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "olive" | "terracotta" }) {
  const tones = {
    plain: "border-line bg-paper text-ink-2",
    olive: "border-olive/25 bg-olive/10 text-olive",
    terracotta: "border-terracotta/25 bg-terracotta/10 text-terracotta",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${tones[tone]}`}>
      {children}
    </span>
  );
}

const SourcesContext = createContext<Map<string, Source>>(new Map());
export const SourcesProvider = SourcesContext.Provider;

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Places a floating card next to its anchor: below it if it fits, else above if there is more room there,
// and always inside the viewport (8 px margin). Written straight to the element's style so it can follow
// the anchor on every scroll without re-rendering.
function placeNear(anchor: HTMLElement, card: HTMLElement) {
  const a = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const gap = 6;
  const margin = 8;
  const { offsetWidth: w, offsetHeight: h } = card;
  const fitsBelow = a.bottom + gap + h <= vh - margin;
  const below = fitsBelow || vh - a.bottom >= a.top;
  card.style.top = `${below ? a.bottom + gap : Math.max(margin, a.top - gap - h)}px`;
  card.style.transformOrigin = `${Math.max(0, a.left - Math.max(margin, Math.min(a.left, vw - w - margin))) + 12}px ${below ? "0%" : "100%"}`;
  card.style.left = `${Math.max(margin, Math.min(a.left, vw - w - margin))}px`;
  card.style.visibility = "visible";
}

/**
 * One chip per source; its card lists every sentence the claim cites from that source. The card shows on
 * hover (mouse) or keyboard focus, and a click or tap pins it open until a tap elsewhere or Escape. It is
 * rendered in a portal with fixed positioning, so no later card, scroll container or stacking context can
 * cover or clip it.
 */
export function SourceChip({ cites }: { cites: Cite[] }) {
  const cite = cites[0];
  const bad = cites.some((c) => c.ok === false);
  const sources = useContext(SourcesContext);
  const src = sources.get(cite.source);
  const label = src ? (src.provider === "Tavily" ? hostOf(src.url) ?? src.title : src.provider) : cite.source;
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const open = hover || pinned || keyboard;
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const cardId = useId();

  useLayoutEffect(() => {
    const chip = chipRef.current;
    const card = cardRef.current;
    if (!open || !chip || !card) return;
    const place = () => placeNear(chip, card);
    place();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chip.contains(t) && !card.contains(t)) {
        setHover(false);
        setPinned(false);
        setKeyboard(false);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inside = card.contains(document.activeElement);
      setHover(false);
      setPinned(false);
      setKeyboard(false);
      if (inside) chip.focus();
    };
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // Hover only for a real mouse: on touch screens the tap (click) is the only way to open it.
  const enter = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(hideTimer.current);
    setHover(true);
  };
  const leave = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 160);
  };
  // Focus leaving both the chip and its card closes it (Tab away, or a click elsewhere).
  const blur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (chipRef.current?.contains(next) || cardRef.current?.contains(next))) return;
    setKeyboard(false);
    setPinned(false);
  };

  const cls = `inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] transition pointer-coarse:px-2.5 pointer-coarse:py-1.5 ${
    bad ? "border-terracotta/30 text-terracotta" : "border-line text-ink-2 hover:border-ink-2/40 hover:text-ink"
  } ${open ? "border-ink-2/40 text-ink" : ""}`;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={cls}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-describedby={open ? cardId : undefined}
        onClick={() => setPinned((p) => !p)}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && setKeyboard(true)}
        onBlur={blur}
        onKeyDown={(e) => {
          // The card lives at the end of <body>: Tab from the chip goes into it, as if it were inline.
          const link = cardRef.current?.querySelector("a");
          if (e.key === "Tab" && !e.shiftKey && open && link) {
            e.preventDefault();
            link.focus();
          }
        }}
      >
        <span className="tabular-nums text-muted">{cite.source}</span> {label}
        {cites.length > 1 && <span className="tabular-nums text-muted">×{cites.length}</span>}
      </button>
      {open &&
        createPortal(
          <m.div
            ref={cardRef}
            id={cardId}
            style={{ visibility: "hidden" }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={SPRING}
            onPointerEnter={enter}
            onPointerLeave={leave}
            onBlur={blur}
            className="no-print fixed left-0 top-0 z-[1200] w-72 max-w-[calc(100vw-16px)] rounded-xl border border-line bg-card p-3 text-left text-[12px] leading-snug text-ink shadow-[0_12px_32px_-12px_rgba(29,27,23,0.35)]"
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              {cite.source}
              {src ? ` · ${src.provider}` : ""}
            </span>
            {src && <span className="mt-0.5 block font-medium text-ink-2">{src.title}</span>}
            {cites.map((c, i) => (
              <span key={i} className="mt-1.5 block">
                <span className="font-display block text-[14px] leading-snug">
                  “{c.quote}”{c.ok === false && <span className="font-sans text-[11px] text-terracotta"> ✗</span>}
                </span>
                {c.context?.length ? (
                  <span className="mt-1 block border-l-2 border-line pl-2 text-[11px] leading-snug text-ink-2">
                    <span className="block text-[10px] uppercase tracking-[0.1em] text-muted">Next to it in the source</span>
                    {c.context.map((line, j) => (
                      <span key={j} className="block">
                        “{line}”
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ))}
            <span className={`mt-1.5 block text-[11px] ${bad ? "text-terracotta" : "text-olive"}`}>
              {bad ? "✗ Not found in this source" : cites.length > 1 ? "✓ Exact sentences from this source" : "✓ Exact sentence from this source"}
            </span>
            {src?.url && (
              <a
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-[11px] text-olive underline underline-offset-2"
                onKeyDown={(e) => {
                  if (e.key !== "Tab") return;
                  if (e.shiftKey) {
                    e.preventDefault();
                    chipRef.current?.focus();
                  } else {
                    // Back to the chip, then the browser's own Tab moves on to whatever follows it.
                    chipRef.current?.focus();
                  }
                }}
              >
                Open source ↗
              </a>
            )}
          </m.div>,
          document.body,
        )}
    </>
  );
}

function groupBySource(cites: Cite[]): Cite[][] {
  const groups = new Map<string, Cite[]>();
  for (const c of cites) groups.set(c.source, [...(groups.get(c.source) ?? []), c]);
  return [...groups.values()];
}

export function EvidenceLine({ evidence }: { evidence: Evidence }) {
  const ok = evidence.verified === true;
  const unknown = evidence.verified === undefined;
  return (
    <li className="text-[13px] leading-snug text-ink-2">
      <div className="flex gap-2">
        <span
          className={`mt-0.5 shrink-0 ${ok ? "text-olive" : unknown ? "text-saffron" : "text-terracotta"}`}
          title={
            ok
              ? evidence.across
                ? `Verified in code across languages: the cited sentences (in ${LANGUAGE_LABEL[evidence.across] ?? evidence.across}) exist and contain every number of the claim; words can't be matched across languages`
                : "Verified in code: the cited sentences exist and contain every number and nearly every word of the claim"
              : unknown
                ? "Not checked yet"
                : `Not verified: ${evidence.issue ?? "not backed by its sources"}`
          }
        >
          {ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
          <span className="sr-only">{ok ? "Verified against its sources" : "Not verified"}</span>
        </span>
        <div className="min-w-0">
          <span>{evidence.text}</span>
          {evidence.cites?.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {groupBySource(evidence.cites).map((group) => (
                <SourceChip key={group[0].source} cites={group} />
              ))}
            </span>
          )}
          {!ok && !unknown && evidence.issue && <span className="mt-0.5 block text-[11px] text-terracotta">Not verified: {evidence.issue}</span>}
          {ok && evidence.across && (
            <span className="mt-0.5 block text-[11px] text-muted">
              Source in {LANGUAGE_LABEL[evidence.across] ?? evidence.across}: numbers and names checked
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

const LANGUAGE_LABEL: Record<string, string> = { en: "English", es: "Spanish", fr: "French", it: "Italian", pt: "Portuguese", de: "German", ca: "Catalan" };

/**
 * A number that counts up to its value when it first appears or changes (instant with reduced motion).
 * `whenVisible` waits until the reader reaches it (same rules as Reveal). Screen readers get the final value.
 */
export function CountUp({
  value,
  duration = 900,
  decimals = 0,
  format,
  whenVisible = false,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  format?: (n: number) => string;
  whenVisible?: boolean;
}) {
  const { ref, phase } = useReveal<HTMLSpanElement>();
  const [shown, setShown] = useState(0);
  const cur = useRef(0);
  const wait = whenVisible && phase === "hidden";
  useEffect(() => {
    if (wait) {
      // Hidden until the reader gets here: start again from zero when it is revealed.
      cur.current = 0;
      const raf = requestAnimationFrame(() => setShown(0));
      return () => cancelAnimationFrame(raf);
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const a = cur.current;
    const k10 = 10 ** decimals;
    let raf = 0;
    const step = (now: number) => {
      const k = reduce ? 1 : Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = k >= 1 ? value : Math.round((a + (value - a) * eased) * k10) / k10;
      cur.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, decimals, wait]);
  const fmt = format ?? ((n: number) => n.toFixed(decimals));
  return (
    <span ref={ref} className="tabular-nums">
      <span aria-hidden>{fmt(shown)}</span>
      <span className="sr-only">{fmt(value)}</span>
    </span>
  );
}
