"use client";

// Shown only to someone who opened the judges' link: live runs are on for them, billed to the judges' own Otari end
// user, and this is what its budget has left (read from Otari, /api/judge). Refreshed whenever a run starts or ends.

import { useEffect, useState } from "react";
import { linkTokenHeaders } from "@/lib/link-tokens";

type Status =
  | { kind: "ok"; end_user: string; spend: number; limit: number; left: number; run_estimate_usd: number; runs_per_hour: number; expires?: string }
  | { kind: "error"; error: string };

export default function JudgeNote({ phase }: { phase: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const headers = linkTokenHeaders();
    if (!headers["x-tablecast-judge"]) return;
    let cancelled = false;
    fetch("/api/judge", { headers, cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (Omit<Extract<Status, { kind: "ok" }>, "kind"> & { error?: string }) | null;
        if (cancelled) return;
        if (res.ok && body && !body.error) setStatus({ kind: "ok", ...body });
        else setStatus({ kind: "error", error: body?.error ?? `The judge link could not be checked (${res.status}).` });
      })
      .catch(() => !cancelled && setStatus({ kind: "error", error: "The judge link could not be checked. Try reloading the page." }));
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (!status) return null;
  if (status.kind === "error")
    return <p className="mb-4 rounded-xl border border-terracotta/30 bg-terracotta/5 px-3 py-2 text-[13px] leading-snug text-ink-2">{status.error}</p>;
  const enough = status.left >= status.run_estimate_usd;
  return (
    <div className="mb-4 rounded-xl border border-olive/25 bg-olive/5 px-3 py-2.5 text-[13px] leading-snug text-ink-2" role="status">
      <p className="font-semibold text-olive">Judge link · live runs are on</p>
      <p className="mt-1">
        Each run you start here is billed to the judges’ own Otari end user, <code className="rounded bg-paper px-1 text-[12px]">{status.end_user}</code>, on its
        own budget: <span className="font-medium tabular-nums text-ink">${status.left.toFixed(2)} left of ${status.limit.toFixed(2)}</span>, and Otari refuses any
        request past it. A run takes 2–4 minutes and costs about $0.10–0.20. One at a time, up to {status.runs_per_hour} an hour.
      </p>
      {!enough && <p className="mt-1 text-terracotta">That is less than a plan can cost, so new live runs are refused. The recorded runs below still play.</p>}
    </div>
  );
}
