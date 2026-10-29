"use client";

import { useState } from "react";
import { m } from "motion/react";
import { IconArrow, IconCheck } from "../icons";
import { SPRING } from "../motion";
import { Avatar, BTN_PRIMARY, BTN_SECOND, CARD, channelName, channelProblem, ErrorNotice, ScreenHead, ServiceChip, Skeleton } from "./parts";
import type { WeekStore } from "./store";

const REASONS: Record<string, string> = {
  denied: "You chose not to allow access, so nothing was connected.",
  state: "The sign-in could not be matched to this browser (it may have expired). Start it again.",
  error: "Buffer did not complete the sign-in. Start it again; if it keeps failing, the app client settings may be wrong.",
};

const GRANTS = [
  ["See your channels", "Their names, avatars and time zones, so posts go out at the right local time."],
  ["Read your queue", "What is already scheduled, so nothing is posted twice and the queue can follow the weather."],
  ["Create and edit posts", "Drafts by default. Posts are only scheduled for real if you switch that on, and only moved if you approve it."],
];

export default function Connect({ w, notice }: { w: WeekStore; notice: string | null }) {
  const [busy, setBusy] = useState(false);
  const s = w.session;

  async function disconnect() {
    setBusy(true);
    await fetch("/api/buffer/session", { method: "DELETE" }).catch(() => null);
    await w.refreshSession();
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead kicker="1 · Connect" title="Connect your Buffer account">
        Tablecast reads your week, writes the posts and puts them in your Buffer queue as drafts. You stay in charge of what goes out.
      </ScreenHead>

      {notice && (
        <div role="status" className={`rounded-2xl border p-4 text-[14px] ${notice === "connected" ? "border-olive/30 bg-olive/5 text-olive" : "border-terracotta/30 bg-terracotta/5 text-ink-2"}`}>
          {notice === "connected" ? "Connected. Choose where the posts should go." : (REASONS[notice] ?? REASONS.error)}
        </div>
      )}

      {s.status === "loading" && (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Checking your Buffer connection">
          <Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
      )}

      {s.status === "error" && <ErrorNotice error={s.error} onRetry={() => void w.refreshSession()} retryLabel="Check again" />}

      {s.status === "ready" && !s.info.connected && (
        <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
          <div className={`${CARD} p-5 sm:p-7`}>
            <h3 className="font-display text-2xl">What you are about to allow</h3>
            <ul className="mt-4 space-y-4">
              {GRANTS.map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-olive/10 text-olive"><IconCheck size={14} /></span>
                  <div><p className="text-[15px] font-medium">{t}</p><p className="text-[14px] leading-relaxed text-ink-2">{d}</p></div>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[13px] leading-relaxed text-muted">
              Scopes asked: account:read, posts:read, posts:write and offline_access. Your tokens stay on the server in an encrypted, HttpOnly cookie. You can disconnect here, or revoke access any time in Buffer.
            </p>
            {s.info.reason && <p className="mt-3 text-[13px] text-terracotta">{s.info.reason}</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a href="/api/buffer/login" className={BTN_PRIMARY}>Connect your Buffer account <IconArrow size={14} /></a>
              <button type="button" onClick={() => w.setStep("week")} className={BTN_SECOND}>Look at the week first</button>
            </div>
          </div>
          <aside className="rounded-2xl border border-line bg-paper-2/50 p-5 text-[14px] leading-relaxed text-ink-2 sm:p-6">
            <p className="font-display text-lg text-ink">No account handy?</p>
            <p className="mt-2">You can still pick a recorded week, edit its posts and see the board. Connecting is only needed to send them to Buffer.</p>
            <p className="mt-3">Built on the Buffer API. Tablecast is an independent app and is not made by Buffer.</p>
          </aside>
        </div>
      )}

      {s.status === "ready" && s.info.connected && (
        <section aria-labelledby="channels-h" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 id="channels-h" className="font-display text-2xl">Where should the posts go?</h3>
              <p className="mt-1 text-[14px] text-ink-2">{s.info.organizations[0]?.name} · choose up to 5 channels. Each shows the time zone Buffer will use.</p>
            </div>
            <button type="button" onClick={() => void disconnect()} disabled={busy} className={BTN_SECOND}>{busy ? "Disconnecting" : "Disconnect"}</button>
          </div>

          {s.info.channels.length === 0 ? (
            <div className={`${CARD} p-6 text-[14px] text-ink-2`}>
              This Buffer organization has no channels yet. Add one in Buffer (a Bluesky or Mastodon test account works well), then check again.
              <div className="mt-3"><button type="button" onClick={() => void w.refreshSession()} className={BTN_SECOND}>Check again</button></div>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {s.info.channels.map((c, i) => {
                const problem = channelProblem(c);
                const on = w.selected.includes(c.id);
                const blocked = Boolean(problem) && !on;
                return (
                  <m.li key={c.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: { ...SPRING, delay: i * 0.05 } }}>
                    <label className={`flex min-h-[88px] cursor-pointer items-center gap-3 rounded-2xl border p-4 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-olive/40 ${on ? "border-olive bg-olive/5" : "border-line bg-card hover:border-ink-2/40"} ${problem ? "opacity-70" : ""}`}>
                      <input type="checkbox" className="sr-only" checked={on} disabled={Boolean(problem)} onChange={() => w.toggleChannel(c.id)} aria-describedby={`ch-${c.id}`} />
                      <Avatar channel={c} size={44} />
                      <span className="min-w-0 flex-1" id={`ch-${c.id}`}>
                        <span className="block truncate text-[15px] font-medium">{channelName(c)}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5"><ServiceChip channel={c} /><span className="text-[12px] text-muted">{c.timezone}</span></span>
                        {problem && <span className="mt-1 block text-[12px] text-terracotta">{problem}</span>}
                      </span>
                      <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${on ? "border-olive bg-olive text-paper" : "border-line text-transparent"}`}><IconCheck size={14} /></span>
                      {blocked && <span className="sr-only">Not available</span>}
                    </label>
                  </m.li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => w.setStep("week")} className={BTN_PRIMARY}>{w.plan ? "Back to the week" : "Choose a week"} <IconArrow size={14} /></button>
            <span className="text-[13px] text-muted" aria-live="polite">{w.selected.length} channel{w.selected.length === 1 ? "" : "s"} selected</span>
          </div>
        </section>
      )}
    </div>
  );
}
