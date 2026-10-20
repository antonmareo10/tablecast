"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { IconAlert, IconCheck, IconCopy } from "./icons";
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
    <section className="rise rounded-2xl border border-line bg-card p-5 sm:p-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper text-olive">
              {icon}
            </span>
          )}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{kicker}</p>
            <h3 className="font-display text-xl leading-tight sm:text-2xl">{title}</h3>
          </div>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-ink-2/40 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-olive"
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

export function SourceChip({ cite }: { cite: Cite }) {
  const sources = useContext(SourcesContext);
  const src = sources.get(cite.source);
  const label = src ? (src.provider === "Tavily" ? hostOf(src.url) ?? src.title : src.provider) : cite.source;
  const [open, setOpen] = useState(false);
  const cls = `inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] transition ${
    cite.ok === false ? "border-terracotta/30 text-terracotta" : "border-line text-ink-2 hover:border-ink-2/40 hover:text-ink"
  }`;
  // A small card with the verbatim quote: on hover/focus on desktop, on tap on touch screens.
  return (
    <span className="group relative inline-flex" onMouseLeave={() => setOpen(false)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" className={cls} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tabular-nums text-muted">{cite.source}</span> {label}
      </button>
      <span
        role="tooltip"
        className={`absolute left-0 top-full z-[1200] mt-1 w-72 max-w-[80vw] rounded-xl border border-line bg-card p-3 text-left text-[12px] leading-snug text-ink shadow-[0_12px_32px_-12px_rgba(29,27,23,0.35)] ${
          open ? "block" : "hidden group-hover:block group-focus-within:block"
        }`}
      >
        <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          {cite.source}
          {src ? ` · ${src.provider}` : ""}
        </span>
        {src && <span className="mt-0.5 block font-medium text-ink-2">{src.title}</span>}
        <span className="font-display mt-1.5 block text-[14px] leading-snug">“{cite.quote}”</span>
        <span className={`mt-1.5 block text-[11px] ${cite.ok === false ? "text-terracotta" : "text-olive"}`}>
          {cite.ok === false ? "✗ Not found in this source" : "✓ Found word for word in this source"}
        </span>
        {src?.url && (
          <a href={src.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[11px] text-olive underline underline-offset-2">
            Open source ↗
          </a>
        )}
      </span>
    </span>
  );
}

export function EvidenceLine({ evidence }: { evidence: Evidence }) {
  const ok = evidence.verified === true;
  const unknown = evidence.verified === undefined;
  return (
    <li className="text-[13px] leading-snug text-ink-2">
      <div className="flex gap-2">
        <span
          className={`mt-0.5 shrink-0 ${ok ? "text-olive" : unknown ? "text-saffron" : "text-terracotta"}`}
          title={ok ? "Verified: every quote was found word for word in its source" : unknown ? "Not checked yet" : `Not verified: ${evidence.issue ?? "quote not found"}`}
        >
          {ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
          <span className="sr-only">{ok ? "Verified against its sources" : "Not verified"}</span>
        </span>
        <div className="min-w-0">
          <span>{evidence.text}</span>
          {evidence.cites?.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {evidence.cites.map((c, i) => (
                <SourceChip key={`${c.source}-${i}`} cite={c} />
              ))}
            </span>
          )}
          {!ok && !unknown && evidence.issue && <span className="mt-0.5 block text-[11px] text-terracotta">Not verified: {evidence.issue}</span>}
        </div>
      </div>
    </li>
  );
}
