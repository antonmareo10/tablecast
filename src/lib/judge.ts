// The judges' link: https://<deployment>/?judge=<JUDGE_LINK_TOKEN> lets the hackathon's judges start live runs on the
// public demo without any key. Every Otari request of such a run is billed to ONE dedicated Otari end user
// (JUDGE_END_USER), whatever restaurant they type, so what the judges can spend is capped by that end user's own Otari
// budget (JUDGE_BUDGET_ID), not by a fresh per-restaurant budget per run. Otari enforces it (budget_exceeded); the app
// also reads it before each run and refuses one the judges' budget can't cover, before anything is spent.
//
// On top of Otari's cap, per server instance: one judge run at a time, a few an hour and a day, an optional expiry
// date and an optional lower spend cap (JUDGE_SPEND_CAP_USD, checked against Otari's own end-user record).
//
// Fail closed: no token configured, a wrong or expired token, a key that can't name end users, a judges' end user that
// doesn't exist yet, is on another budget than JUDGE_BUDGET_ID, is blocked or has no dollar limit → no judge run.

import { timingSafeEqual } from "node:crypto";
import { acquireLiveRun, type Gate } from "./limits";
import { budgetLine, type EndUserBudget, type EndUserStatus } from "./otari-budget";

export const JUDGE_HEADER = "x-tablecast-judge";

const PER_HOUR = () => Number(process.env.JUDGE_RUNS_PER_HOUR || 3);
const PER_DAY = () => Number(process.env.JUDGE_RUNS_PER_DAY || 6);
const MAX_CONCURRENT = () => Number(process.env.JUDGE_RUNS_MAX_CONCURRENT || 1);

export function judgeEndUser(): string {
  return process.env.JUDGE_END_USER?.trim() || "judges:mozfest-wilding-2026";
}

/** What a judge run is expected to cost at most (recorded runs cost $0.08–0.17 on the deployment), to refuse it before research. */
export function judgeRunEstimateUsd(): number {
  const v = Number(process.env.JUDGE_RUN_ESTIMATE_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.2;
}

export type JudgeAccess = { kind: "none" } | { kind: "judge" } | { kind: "refused"; status: number; error: string };

function sameToken(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether this request comes through the judges' link. No header: an ordinary request. A header with the right token,
 * before the expiry date: a judge. Anything else that claims to be a judge is refused, before any Otari call.
 */
export function judgeAccess(request: Request, now = Date.now()): JudgeAccess {
  const got = request.headers.get(JUDGE_HEADER);
  if (got == null || got === "") return { kind: "none" };
  const want = process.env.JUDGE_LINK_TOKEN?.trim() ?? ""; // trimmed: a value pasted with a newline still works
  // A configured token shorter than 24 characters is treated as no token: it would be guessable.
  if (want.length < 24 || !sameToken(got, want)) return { kind: "refused", status: 403, error: "This judge link isn't valid. Every recorded run is a real run and plays instantly." };
  const expires = Date.parse(process.env.JUDGE_LINK_EXPIRES?.trim() ?? "");
  if (Number.isFinite(expires) && now > expires) return { kind: "refused", status: 403, error: "This judge link has expired. Every recorded run is a real run and plays instantly." };
  return { kind: "judge" };
}

// Per-instance counters for judge runs (the hard cap is the judges' Otari budget).
let running = 0;
let starts: number[] = [];

/** The judges' own gate (one run at a time, a few an hour and a day), then the demo's usual one (concurrency, daily cap). */
export function acquireJudgeRun(ip: string, now = Date.now()): Gate {
  starts = starts.filter((t) => now - t < 86_400_000);
  if (running >= MAX_CONCURRENT()) return { ok: false, reason: "A judge run is already in progress. It takes 2–4 minutes; try again when it has finished." };
  if (starts.filter((t) => now - t < 3_600_000).length >= PER_HOUR()) return { ok: false, reason: "The judge link has reached its hourly limit of live runs. Try again later; recorded runs are always available." };
  if (starts.length >= PER_DAY()) return { ok: false, reason: "The judge link has reached today's limit of live runs. Try again tomorrow; recorded runs are always available." };
  const live = acquireLiveRun(ip);
  if (!live.ok) return live;
  starts.push(now);
  running += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      running = Math.max(0, running - 1);
      live.release();
    },
  };
}

/** For tests: forget this instance's judge runs. */
export function resetJudgeRuns(): void {
  running = 0;
  starts = [];
}

/** The judges' limit: their end user's budget, lowered by JUDGE_SPEND_CAP_USD when that is set. Null: no dollar limit. */
export function judgeLimit(budgetLimit: number | null): number | null {
  if (budgetLimit == null) return null;
  const cap = Number(process.env.JUDGE_SPEND_CAP_USD);
  return Number.isFinite(cap) && cap > 0 ? Math.min(cap, budgetLimit) : budgetLimit;
}

export type JudgeBudget ={ spend: number; limit: number; left: number; budget?: string; period?: string };

/**
 * Where the judges stand on Otari, from the end user's own record and the key's budget list, or why no judge run can
 * start. The limit is the end user's budget, lowered by JUDGE_SPEND_CAP_USD when that is set.
 */
export function judgeBudget(status: EndUserStatus | null, budgets: EndUserBudget[], estimate = judgeRunEstimateUsd()): { ok: true; line: JudgeBudget } | { ok: false; status: number; error: string } {
  const notReady = { ok: false as const, status: 503, error: "The judge link isn't set up on Otari yet, so no live run can be billed to it. Every recorded run is a real run and plays instantly." };
  if (!status) return notReady;
  const want = process.env.JUDGE_BUDGET_ID?.trim();
  if (want && status.budget_id !== want) return notReady;
  if (status.blocked) return { ok: false, status: 403, error: "The judge link has been switched off on Otari. Every recorded run is a real run and plays instantly." };
  // The end user's budget must be one the key lists (its limit is read there), and must have a dollar limit.
  if (!budgets.some((b) => b.id && b.id === status.budget_id)) return notReady;
  const line = budgetLine(status, budgets);
  const limit = judgeLimit(line.limit);
  if (limit == null) return notReady;
  const left = Math.max(0, limit - line.spend);
  if (left < estimate)
    return {
      ok: false,
      status: 429,
      error: `The judges' Otari budget is used up: $${line.spend.toFixed(2)} of $${limit.toFixed(2)} spent, less than a plan can cost (about $${estimate.toFixed(2)}). Every recorded run is a real run and plays instantly.`,
    };
  return { ok: true, line: { spend: line.spend, limit, left, ...(line.budget ? { budget: line.budget } : {}), ...(line.period ? { period: line.period } : {}) } };
}
