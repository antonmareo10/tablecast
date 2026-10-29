"use client";

import { useMemo, useState } from "react";
import { charLimit, dailyCounts, estimateCalls, overBy, overLimit, textOn } from "@/lib/week";
import { dayLabel } from "@/lib/sources/format";
import { IconArrow, IconCheck } from "../icons";
import { Avatar, BTN_PRIMARY, BTN_SECOND, CARD, channelName, EmptyState, ErrorNotice, RecordedTag, ScreenHead, zonedLabel } from "./parts";
import { api, type ScheduleResponse } from "./api";
import type { WeekStore } from "./store";
import { useQueue } from "./useQueue";

const STATUS: Record<string, { label: string; tone: string }> = {
  created: { label: "Created", tone: "text-olive" },
  exists: { label: "Already in Buffer", tone: "text-ink-2" },
  skipped: { label: "Skipped", tone: "text-terracotta" },
  failed: { label: "Failed", tone: "text-terracotta" },
};

export default function Schedule({ w }: { w: WeekStore }) {
  const [real, setReal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { state: queue } = useQueue(w.connected && real, true);
  const channels = w.channels.filter((c) => w.selected.includes(c.id));

  const { targetsFor, active, selected } = w;
  const sending = useMemo(() => active.filter((p) => targetsFor(p.id).some((id) => selected.includes(id))), [active, targetsFor, selected]);
  const targets = useMemo(() => Object.fromEntries(sending.map((p) => [p.id, targetsFor(p.id).filter((id) => selected.includes(id))])), [sending, targetsFor, selected]);
  const writes = sending.reduce((n, p) => n + targets[p.id].length, 0);
  const calls = estimateCalls(sending, targets, real);

  const tooLong = useMemo(() => {
    const out: string[] = [];
    for (const p of sending) for (const c of channels) {
      if (!targets[p.id].includes(c.id)) continue;
      const over = overBy(textOn(p, c.service), charLimit(c.service));
      if (over > 0) out.push(`${p.title} on ${channelName(c)}: ${over} characters too long`);
      if (!textOn(p, c.service).trim()) out.push(`${p.title} on ${channelName(c)}: the text is empty`);
    }
    return out;
  }, [sending, channels, targets]);

  const overDays = useMemo(() => {
    if (!real || queue.status !== "ready") return [];
    const rows = dailyCounts({ queue: queue.data.posts, plan: sending, targets, channels, real: true });
    return overLimit(rows, queue.data.limits);
  }, [real, queue, sending, targets, channels]);

  const zone = w.plan?.source.timezone;
  const zoneNotes = channels.filter((c) => zone && c.timezone !== zone);
  const result = w.scheduled?.result;

  if (!w.plan) {
    return (
      <div className="flex flex-col gap-6">
        <ScreenHead kicker="4 · Schedule" title="Send the week to Buffer" />
        <EmptyState title="No week chosen yet" action={<button type="button" onClick={() => w.setStep("week")} className={BTN_PRIMARY}>Pick a week</button>}>Choose a week and review its posts first.</EmptyState>
      </div>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<ScheduleResponse>("/api/buffer/schedule", { posts: sending, targets, channelIds: w.selected, draft: !real });
      w.setScheduled({ posts: sending, channelIds: [...w.selected], draft: res.draft, at: new Date().toISOString(), result: res });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const blockers = !w.connected ? "connect" : w.selected.length === 0 ? "channel" : sending.length === 0 ? "posts" : tooLong.length ? "text" : null;

  return (
    <div className="flex flex-col gap-6">
      <ScreenHead kicker="4 · Schedule" title="Send the week to Buffer">
        By default every post is created as a draft: it shows up in your Buffer queue but never goes out until you schedule it there.
      </ScreenHead>
      {w.plan.source.kind === "replay" && <div><RecordedTag /></div>}

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <section className={`${CARD} p-5 sm:p-6`} aria-labelledby="sum-h">
          <h3 id="sum-h" className="font-display text-2xl">{sending.length} post{sending.length === 1 ? "" : "s"}, {writes} in Buffer</h3>
          {channels.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {channels.map((c) => {
                const n = sending.filter((p) => targets[p.id].includes(c.id)).length;
                return <li key={c.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1 text-[13px]"><Avatar channel={c} size={20} />{channelName(c)}<span className="tabular-nums text-muted">{n}</span></li>;
              })}
            </ul>
          ) : <p className="mt-2 text-[14px] text-ink-2">No channel selected.</p>}
          {zoneNotes.length > 0 && (
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              {zoneNotes.map((c) => `${channelName(c)} is set to ${c.timezone}`).join("; ")}. Times are sent as exact moments, so posts still go out at the restaurant&rsquo;s local time ({zone}).
            </p>
          )}
          <p className="mt-3 text-[13px] text-muted">About {calls} Buffer API calls. The app&rsquo;s quota is 100 per 15 minutes and 250 per day, shared by everyone using it.</p>
          {sending[0] && <p className="mt-1 text-[13px] text-muted">First post: {zonedLabel(sending[0].post_at.utc, sending[0].post_at.timezone)} ({sending[0].post_at.timezone}).</p>}
        </section>

        <section className={`${CARD} p-5 sm:p-6`} aria-labelledby="mode-h">
          <h3 id="mode-h" className="font-display text-2xl">How should they arrive?</h3>
          <div role="radiogroup" aria-label="Mode" className="mt-3 grid gap-2">
            <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-olive/40 ${!real ? "border-olive bg-olive/5" : "border-line hover:border-ink-2/40"}`}>
              <input type="radio" name="mode" className="mt-1 accent-[var(--olive)]" checked={!real} onChange={() => { setReal(false); setConfirm(false); }} />
              <span><span className="block text-[15px] font-medium">Drafts (recommended)</span><span className="block text-[13px] leading-snug text-ink-2">Nothing is published. Open Buffer, look, and schedule them yourself.</span></span>
            </label>
            <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-terracotta/40 ${real ? "border-terracotta bg-terracotta/5" : "border-line hover:border-ink-2/40"}`}>
              <input type="radio" name="mode" className="mt-1 accent-[var(--terracotta)]" checked={real} onChange={() => setReal(true)} />
              <span><span className="block text-[15px] font-medium">Schedule for real</span><span className="block text-[13px] leading-snug text-ink-2">Buffer will publish each post on your channels at its time.</span></span>
            </label>
          </div>
          {real && (
            <div className="rise mt-3 rounded-xl border border-terracotta/30 bg-terracotta/5 p-3">
              <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[13.5px] leading-snug text-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--terracotta)]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                I understand these {writes} post{writes === 1 ? "" : "s"} will be published on {channels.map(channelName).join(", ") || "my channels"}, not saved as drafts.
              </label>
              {queue.status === "loading" && <p className="mt-2 text-[12.5px] text-muted">Checking daily limits</p>}
              {overDays.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[12.5px] text-terracotta">
                  {overDays.map((o) => <li key={o.channelId + o.date}>{channelName(channels.find((c) => c.id === o.channelId)!)} on {dayLabel(o.date)}: {o.inBuffer + o.fromPlan} planned, limit {o.limit}. The extra posts will be skipped.</li>)}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      {tooLong.length > 0 && (
        <div role="alert" className="rounded-2xl border border-terracotta/30 bg-terracotta/5 p-4 text-[14px]">
          <p className="font-medium">Fix these in Review first</p>
          <ul className="mt-1 list-disc pl-5 text-ink-2">{tooLong.slice(0, 6).map((t) => <li key={t}>{t}</li>)}</ul>
          <button type="button" onClick={() => w.setStep("review")} className={`${BTN_SECOND} mt-3`}>Back to Review</button>
        </div>
      )}

      {error != null && <ErrorNotice error={error} onRetry={() => void run()} retryLabel="Send again" />}

      <div className="flex flex-wrap items-center gap-3">
        {blockers === "connect" ? (
          <button type="button" onClick={() => w.setStep("connect")} className={BTN_PRIMARY}>Connect Buffer to continue <IconArrow size={14} /></button>
        ) : (
          <button type="button" onClick={() => void run()} disabled={busy || Boolean(blockers) || (real && !confirm)} className={real ? `${BTN_PRIMARY} !bg-terracotta hover:!bg-ink` : BTN_PRIMARY}>
            {busy ? "Sending to Buffer" : real ? `Schedule ${writes} post${writes === 1 ? "" : "s"} for real` : `Create ${writes} draft${writes === 1 ? "" : "s"} in Buffer`}
          </button>
        )}
        {blockers === "channel" && <span className="text-[13px] text-muted">Choose a channel in Connect.</span>}
        {blockers === "posts" && <span className="text-[13px] text-muted">Every post is removed or has no channel.</span>}
        {busy && <span className="text-[13px] text-muted" aria-live="polite">One call per post. This can take a few seconds.</span>}
      </div>

      {result && <Result w={w} result={result} />}
    </div>
  );
}

function Result({ w, result }: { w: WeekStore; result: ScheduleResponse }) {
  const run = w.scheduled!;
  const count = (s: string) => result.outcomes.filter((o) => o.status === s).length;
  const title = (id: string) => run.posts.find((p) => p.id === id)?.title ?? id;
  const ch = (id: string) => w.channels.find((c) => c.id === id);
  return (
    <section className={`${CARD} rise p-5 sm:p-6`} aria-labelledby="res-h" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="res-h" className="font-display text-2xl">{count("created")} {run.draft ? "draft" : "scheduled post"}{count("created") === 1 ? "" : "s"} created</h3>
          <p className="mt-1 text-[14px] text-ink-2">
            {count("exists") > 0 && `${count("exists")} already in Buffer. `}{count("skipped") > 0 && `${count("skipped")} skipped. `}{count("failed") > 0 && `${count("failed")} failed. `}
            {result.apiCalls} API calls used{result.tagsCreated.length ? `, tags created: ${result.tagsCreated.join(", ")}` : ""}.
          </p>
        </div>
        <button type="button" onClick={() => w.setStep("queue")} className={BTN_PRIMARY}>See it in the queue <IconArrow size={14} /></button>
      </div>
      <ul className="mt-4 divide-y divide-line">
        {result.outcomes.map((o) => {
          const c = ch(o.channelId);
          const st = STATUS[o.status];
          return (
            <li key={o.specId + o.channelId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[14px]">
              <span className={`inline-flex w-36 shrink-0 items-center gap-1.5 font-medium ${st.tone}`}>{o.status === "created" && <IconCheck size={14} />}{st.label}</span>
              <span className="min-w-0 flex-1 truncate">{title(o.specId)}</span>
              {c && <span className="inline-flex items-center gap-1.5 text-[13px] text-muted"><Avatar channel={c} size={18} />{channelName(c)}</span>}
              {o.reason && <span className="basis-full text-[12.5px] text-ink-2">{o.reason}</span>}
            </li>
          );
        })}
      </ul>
      {result.timezoneNotes.length > 0 && <p className="mt-3 text-[12.5px] text-muted">{result.timezoneNotes[0]}</p>}
    </section>
  );
}
