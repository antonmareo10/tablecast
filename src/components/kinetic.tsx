import { Fragment, type CSSProperties } from "react";

/**
 * Splits a line into masked words for the `.kinetic` CSS reveal (each word slides up out of its mask).
 * Plain markup and CSS only, so it animates from the first paint, before any JavaScript runs.
 * `start` continues the stagger from an earlier run of words.
 */
export function SplitWords({ text, start = 0 }: { text: string; start?: number }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="w">
            <span style={{ "--i": start + i } as CSSProperties}>{w}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}

/** A loose hand-drawn stroke under a phrase; draws itself once the headline has landed. */
export function Underline({ delayMs = 760, className = "" }: { delayMs?: number; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 300 18" preserveAspectRatio="none" className={`pointer-events-none absolute -bottom-[0.12em] left-0 h-[0.3em] w-full ${className}`}>
      <path
        d="M3 12.5C58 6.5 118 4.2 178 5.4c40 .8 80 3.4 118 7.6"
        pathLength={1}
        fill="none"
        stroke="var(--saffron)"
        strokeWidth="5"
        strokeLinecap="round"
        className="draw-line"
        style={{ "--d": `${delayMs}ms` } as CSSProperties}
      />
    </svg>
  );
}
