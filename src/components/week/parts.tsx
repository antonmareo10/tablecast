"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Channel } from "@/lib/buffer/client";
import { serviceLabel } from "@/lib/week";
import { IconAlert, IconCheck } from "../icons";
import { ApiError } from "./api";

// ---- Class strings shared by the screens (one look for buttons and cards) ---------------------------------------

export const BTN = "magnetic inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_PRIMARY = `${BTN} bg-ink text-paper hover:bg-olive`;
export const BTN_SECOND = `${BTN} border border-line bg-card text-ink-2 hover:border-ink-2/40 hover:text-ink`;
export const BTN_SMALL = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-line bg-paper/70 px-3 text-[13px] font-medium text-ink-2 transition hover:border-ink-2/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9";
export const CARD = "rounded-2xl border border-line bg-card";
export const FIELD = "w-full rounded-lg border border-line bg-paper/60 px-3 py-2.5 text-[15px] outline-none transition placeholder:text-muted focus:border-olive focus:bg-card focus-visible:ring-2 focus-visible:ring-olive/25";

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-terracotta">{children}</p>;
}

export function ScreenHead({ kicker, title, children, aside }: { kicker: string; title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <Kicker>{kicker}</Kicker>
        <h2 className="font-display mt-1.5 text-3xl leading-tight tracking-tight sm:text-4xl">{title}</h2>
        {children && <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{children}</p>}
      </div>
      {aside}
    </header>
  );
}

// ---- Countdown for a rate limit ---------------------------------------------------------------------------------

export function useCountdown(seconds: number | undefined) {
  const [tick, setTick] = useState<{ of: number | undefined; left: number }>({ of: seconds, left: seconds ?? 0 });
  useEffect(() => {
    if (!seconds) return;
    const t0 = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, seconds - Math.round((Date.now() - t0) / 1000));
      setTick({ of: seconds, left });
      if (left === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [seconds]);
  return tick.of === seconds ? tick.left : (seconds ?? 0);
}

const clock = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`);

/** One place for failures: says what happened, what is safe, and the one next step. */
export function ErrorNotice({ error, onRetry, retryLabel = "Try again", children }: { error: unknown; onRetry?: () => void; retryLabel?: string; children?: ReactNode }) {
  const e = error instanceof ApiError ? error : new ApiError(error instanceof Error ? error.message : "Something went wrong.", "server", 0);
  const left = useCountdown(e.kind === "rate_limit" ? e.retryAfter : undefined);
  const waiting = e.kind === "rate_limit" && left > 0;
  return (
    <div role="alert" className="rounded-2xl border border-terracotta/30 bg-terracotta/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-terracotta"><IconAlert size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-ink">
            {e.kind === "rate_limit" ? "Buffer's request limit is used up for now" : e.kind === "reconnect" ? "Buffer needs you to connect again" : e.kind === "not_configured" ? "Buffer is not set up on this server" : e.kind === "network" ? "No connection" : "That did not work"}
          </p>
          {e.kind !== "rate_limit" && <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{e.message}</p>}
          {e.kind === "rate_limit" && (
            <p className="mt-1 text-[14px] text-ink-2">
              {waiting ? <>Try again in <strong className="font-semibold tabular-nums">{clock(left)}</strong>.</> : e.retryAfter ? "You can try again now." : "Wait a few minutes before trying again. The limit is shared by everyone using this app."}
            </p>
          )}
          {e.problems && e.problems.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
              {e.problems.slice(0, 6).map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {children}
          <div className="mt-3 flex flex-wrap gap-2">
            {e.kind === "reconnect" && <a href="/api/buffer/login" className={BTN_PRIMARY}>Connect Buffer</a>}
            {onRetry && e.kind !== "reconnect" && e.kind !== "not_configured" && (
              <button type="button" onClick={onRetry} disabled={waiting} className={BTN_SECOND}>
                {waiting ? `${retryLabel} in ${clock(left)}` : retryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card/60 px-5 py-10 text-center sm:py-14">
      <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-paper text-olive"><IconCheck size={18} /></span>
      <p className="font-display mt-3 text-xl">{title}</p>
      {children && <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-2">{children}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-xl bg-paper-2/70 ${className}`} aria-hidden />;
}

// ---- Replay label -----------------------------------------------------------------------------------------------

export function RecordedTag({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-saffron/50 bg-saffron/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2 ${className}`}>
      <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-saffron" aria-hidden /> Recorded replay
    </span>
  );
}

// ---- Channels ---------------------------------------------------------------------------------------------------

export function Avatar({ channel, size = 36 }: { channel: Pick<Channel, "avatar" | "name" | "displayName" | "service">; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = (channel.displayName ?? channel.name).replace(/^@/, "").slice(0, 2).toUpperCase();
  return (
    <span className="relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-olive/10 text-[11px] font-semibold text-olive" style={{ width: size, height: size }}>
      {channel.avatar && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- the avatar is a Buffer CDN URL of unknown host
        <img src={channel.avatar} alt="" width={size} height={size} className="h-full w-full object-cover" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
      ) : (
        initials
      )}
    </span>
  );
}

export function channelName(c: Pick<Channel, "name" | "displayName">) {
  return c.displayName ?? c.name;
}

export function ServiceChip({ channel }: { channel: Pick<Channel, "service"> }) {
  return <span className="rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] text-ink-2">{serviceLabel(channel.service)}</span>;
}

export function channelProblem(c: Pick<Channel, "isDisconnected" | "isLocked" | "isQueuePaused">): string | null {
  if (c.isDisconnected) return "Disconnected in Buffer";
  if (c.isLocked) return "Locked by your Buffer plan";
  if (c.isQueuePaused) return "Queue paused in Buffer";
  return null;
}

// ---- Dates ------------------------------------------------------------------------------------------------------

export const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "Wed 4 Nov, 10:00" for a UTC instant seen in a time zone. */
export function zonedLabel(utc: string, tz: string): string {
  try {
    const d = new Date(utc);
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    return `${day.replace(",", "")}, ${time}`;
  } catch {
    return utc;
  }
}

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#2f4a35" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#f6f1e7" strokeWidth="1.6" />
      <path d="M16 6.5v19M6.5 16h19" stroke="#dd9a2e" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3" fill="#c0532c" />
    </svg>
  );
}
