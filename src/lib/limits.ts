// Best-effort abuse protection for the public demo (per server instance).
// Live runs spend real money through Otari, so we cap concurrency, per-IP rate and a daily number of runs, and pause
// live runs when Otari rejects the key or the account is out of funds, so visitors are sent straight to the recorded
// runs (offered next to every error) instead of waiting for a run that can't finish. Spend itself is capped by Otari:
// a budget on the key, and one budget per restaurant (see docs/OTARI_SETUP.md).

import { isOtariError, type OtariError } from "./otari";
import { isLocalCapError } from "./otari-ledger";

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

/** True when Otari rejected the key, the account is out of funds, or the app's own spend cap is reached: retrying won't help. */
export function isAccountError(err: unknown): boolean {
  if (isLocalCapError(err)) return true;
  if (!isOtariError(err)) return false;
  if (err.status === 401 || err.status === 402 || err.code === "insufficient_funds" || err.code === "not_configured") return true;
  // A budget on the key, its workspace or the organization refuses every run; a restaurant's own budget only its own.
  return err.code === "budget_exceeded" && err.budgetScope !== "user";
}

function resetsIn(err: OtariError): string {
  const s = err.retryAfterS;
  if (!s) return "";
  const h = Math.round(s / 3600);
  return h >= 24 ? ` It resets in about ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"}.` : h >= 1 ? ` It resets in about ${h} hour${h === 1 ? "" : "s"}.` : " It resets within the hour.";
}

/**
 * Turns an Otari failure into a plain message for the visitor. Key, funds and app-wide budget problems also pause
 * live runs on this instance, because every following run would fail the same way.
 */
export function describeLiveFailure(err: unknown): string {
  if (isLocalCapError(err)) {
    console.warn(`[tablecast] live runs paused: ${err.message}`);
    const msg = "Live runs are paused: this machine reached its local spending cap for Otari. Every recorded run is a real run and plays instantly.";
    pauseLiveRuns(msg);
    return msg;
  }
  if (isOtariError(err)) {
    if (err.code === "budget_exceeded" && err.budgetScope === "user")
      return `This restaurant has used its weekly AI budget on Otari, so the run was stopped before it could spend more.${resetsIn(err)} Recorded runs are always available.`;
    if (err.code === "budget_exceeded") {
      console.warn(`[tablecast] live runs paused: ${err.message}`);
      const msg = `Live runs are paused: this demo's Otari budget is used up.${resetsIn(err)} Every recorded run is a real run and plays instantly.`;
      pauseLiveRuns(msg);
      return msg;
    }
    if (err.status === 401 || err.code === "not_configured") {
      console.warn(`[tablecast] live runs paused: ${err.message}`);
      const msg = "Live runs are paused: Otari rejected this demo's API key. Every recorded run is a real run and plays instantly.";
      pauseLiveRuns(msg);
      return msg;
    }
    if (err.status === 402 || err.code === "insufficient_funds") {
      console.warn(`[tablecast] live runs paused: ${err.message}`);
      const msg = "Live runs are paused: this demo's Otari balance is used up. Every recorded run is a real run and plays instantly.";
      pauseLiveRuns(msg);
      return msg;
    }
    if (err.status === 429) return "Otari is rate-limiting this demo. Try again in a minute, or open a recorded run.";
    if (err.status === 0 || err.status >= 500) return "Otari or its model providers aren't answering right now. Try again shortly, or open a recorded run.";
    return `Otari refused the request (${err.code ?? err.status}). Try again, or open a recorded run.`;
  }
  return err instanceof Error ? err.message : "Unexpected error";
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
}
