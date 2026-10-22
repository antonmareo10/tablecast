// Best-effort abuse protection for the public demo (per server instance).
// Live runs call paid APIs, so we cap concurrency, per-IP rate and a daily budget, and pause live runs
// when Nebius rejects the key or the account is out of credit, so visitors are sent straight to the
// recorded runs (offered next to every error) instead of waiting for a run that can't finish.

import OpenAI from "openai";

const PER_IP_PER_HOUR = Number(process.env.LIVE_RUNS_PER_IP_PER_HOUR || 4);
const DAILY_CAP = Number(process.env.LIVE_RUNS_DAILY_CAP || 80);
const MAX_CONCURRENT = Number(process.env.LIVE_RUNS_MAX_CONCURRENT || 3);
const PAUSE_MS = 30 * 60 * 1000;

const perIp = new Map<string, number[]>();
let day = new Date().toISOString().slice(0, 10);
let dailyCount = 0;
let running = 0;
let pausedUntil = 0;
let pauseReason = "";

export type Gate = { ok: true; release: () => void } | { ok: false; reason: string };

/** Why live runs are off right now (switched off with LIVE_RUNS_DISABLED=1, or paused after an account error), or null. */
export function liveRunsDisabled(): string | null {
  if (process.env.LIVE_RUNS_DISABLED === "1") return "Live runs are switched off on this demo. Open one of the recorded real runs instead.";
  if (Date.now() < pausedUntil) return pauseReason;
  return null;
}

/** Stop accepting live runs on this instance for a while (e.g. the key was rejected or credit ran out). */
export function pauseLiveRuns(reason: string, ms = PAUSE_MS): void {
  pausedUntil = Date.now() + ms;
  pauseReason = reason;
}

export function acquireLiveRun(ip: string): Gate {
  const disabled = liveRunsDisabled();
  if (disabled) return { ok: false, reason: disabled };
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dailyCount = 0;
  }
  if (dailyCount >= DAILY_CAP) {
    return { ok: false, reason: "Today's live-run budget for this demo is used up. Open one of the recorded real runs instead." };
  }
  if (running >= MAX_CONCURRENT) {
    return { ok: false, reason: "The agent is busy with other live runs. Try again in a minute or open a recorded run." };
  }
  const now = Date.now();
  const recent = (perIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_PER_HOUR) {
    return { ok: false, reason: "You've reached the hourly limit of live runs. Recorded runs are always available." };
  }
  recent.push(now);
  perIp.set(ip, recent);
  dailyCount += 1;
  running += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (!released) {
        released = true;
        running = Math.max(0, running - 1);
      }
    },
  };
}

/**
 * Turns a Nebius Token Factory failure (OpenAI-compatible SDK errors) into a plain message for the visitor.
 * Key and credit problems also pause live runs on this instance, because every following run would fail the same way.
 */
/** True when Nebius rejected the key or the account is out of credit: retrying won't help. */
export function isAccountError(err: unknown): boolean {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return true;
  return err instanceof OpenAI.APIError && (err.status === 402 || /insufficient|balance|credit|quota|billing|payment/i.test(err.message));
}

export function describeLiveFailure(err: unknown): string {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    console.warn(`[tablecast] live runs paused: ${err.message}`);
    const msg = "Live runs are paused: Nebius rejected this demo's API key. Every recorded run is a real run and plays instantly.";
    pauseLiveRuns(msg);
    return msg;
  }
  if (err instanceof OpenAI.APIError && (err.status === 402 || /insufficient|balance|credit|quota|billing|payment/i.test(err.message))) {
    console.warn(`[tablecast] live runs paused: ${err.message}`);
    const msg = "Live runs are paused: this demo's inference budget is used up. Every recorded run is a real run and plays instantly.";
    pauseLiveRuns(msg);
    return msg;
  }
  if (err instanceof OpenAI.RateLimitError) return "Nebius Token Factory is rate-limiting this demo. Try again in a minute, or open a recorded run.";
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.InternalServerError) {
    return "Nebius Token Factory isn't answering right now. Try again shortly, or open a recorded run.";
  }
  return err instanceof Error ? err.message : "Unexpected error";
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
}
