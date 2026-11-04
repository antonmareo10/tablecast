import { afterEach, describe, expect, it, vi } from "vitest";
import { OtariError } from "@/lib/otari";
import { LocalCapError } from "@/lib/otari-ledger";

// Fresh module state (counters, pause) per test.
async function load() {
  vi.resetModules();
  return import("@/lib/limits");
}

const otariError = (status: number, detail: string, code?: string, headers: Record<string, string> = {}) =>
  new OtariError(status, detail, code, new Headers(headers));

afterEach(() => {
  delete process.env.LIVE_RUNS_DISABLED;
  delete process.env.LIVE_RUNS_DAILY_CAP;
});

describe("live-run gate", () => {
  it("enforces the daily cap and points to the recorded runs", async () => {
    process.env.LIVE_RUNS_DAILY_CAP = "1";
    const { acquireLiveRun } = await load();
    expect(acquireLiveRun("1.1.1.1").ok).toBe(true);
    const next = acquireLiveRun("2.2.2.2");
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toMatch(/used up.*recorded real runs/);
  });

  it("can be switched off for the whole demo", async () => {
    process.env.LIVE_RUNS_DISABLED = "1";
    const { acquireLiveRun, liveRunsDisabled } = await load();
    expect(liveRunsDisabled()).toMatch(/switched off/);
    expect(acquireLiveRun("1.1.1.1").ok).toBe(false);
  });

  it("pauses live runs when Otari rejects the key", async () => {
    const { describeLiveFailure, liveRunsDisabled, acquireLiveRun } = await load();
    const msg = describeLiveFailure(otariError(401, "Invalid API key"));
    expect(msg).toMatch(/^Live runs are paused: Otari rejected/);
    expect(msg).not.toMatch(/Invalid API key/); // no raw gateway text in front of a judge
    expect(liveRunsDisabled()).toMatch(/paused/);
    expect(acquireLiveRun("3.3.3.3").ok).toBe(false);
  });

  it("pauses live runs when the Otari balance or the app's budget runs out", async () => {
    const a = await load();
    expect(a.describeLiveFailure(otariError(402, "No funds", "insufficient_funds"))).toMatch(/balance is used up/);
    expect(a.liveRunsDisabled()).toMatch(/paused/);
    const b = await load();
    const keyBudget = otariError(403, "has exceeded budget limit", "budget_exceeded", { "otari-budget-scope": "api_token", "retry-after": "90000" });
    expect(b.isAccountError(keyBudget)).toBe(true);
    expect(b.describeLiveFailure(keyBudget)).toMatch(/Otari budget is used up\. It resets in about 1 day/);
    expect(b.liveRunsDisabled()).toMatch(/paused/);
    const c = await load();
    expect(c.describeLiveFailure(new LocalCapError(6.01, 6))).toMatch(/local spending cap/);
    expect(c.liveRunsDisabled()).toMatch(/paused/);
  });

  it("stops one restaurant whose weekly budget is spent, without pausing the demo for everyone", async () => {
    const { describeLiveFailure, isAccountError, liveRunsDisabled } = await load();
    const err = otariError(403, "User 'restaurant:x' has exceeded budget limit", "budget_exceeded", { "otari-budget-scope": "user", "retry-after": "7200" });
    expect(isAccountError(err)).toBe(false);
    expect(describeLiveFailure(err)).toMatch(/This restaurant has used its weekly AI budget.*resets in about 2 hours/);
    expect(liveRunsDisabled()).toBeNull();
  });

  it("does not pause on a rate limit or an outage, which are temporary", async () => {
    const { describeLiveFailure, liveRunsDisabled } = await load();
    expect(describeLiveFailure(otariError(429, "Too many requests", "upstream_rate_limited"))).toMatch(/rate-limiting/);
    expect(describeLiveFailure(otariError(502, "The provider failed the request with HTTP 503"))).toMatch(/aren't answering/);
    expect(describeLiveFailure(otariError(0, "could not reach Otari", "network"))).toMatch(/aren't answering/);
    expect(liveRunsDisabled()).toBeNull();
  });
});
