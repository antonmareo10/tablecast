import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fresh module state (counters, pause) per test.
async function load() {
  vi.resetModules();
  return import("@/lib/limits");
}

const nebiusError = (status: number, message: string) => OpenAI.APIError.generate(status, { message }, message, new Headers());

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

  it("pauses live runs when Nebius rejects the key", async () => {
    const { describeLiveFailure, liveRunsDisabled, acquireLiveRun } = await load();
    const msg = describeLiveFailure(nebiusError(401, "Incorrect API key provided"));
    expect(msg).toMatch(/^Live runs are paused/);
    expect(msg).not.toMatch(/Incorrect API key/); // no raw provider text in front of a judge
    expect(liveRunsDisabled()).toMatch(/paused/);
    expect(acquireLiveRun("3.3.3.3").ok).toBe(false);
  });

  it("pauses live runs when the inference budget runs out (402 or an insufficient-balance error)", async () => {
    const a = await load();
    expect(a.describeLiveFailure(nebiusError(402, "Payment required"))).toMatch(/budget is used up/);
    expect(a.liveRunsDisabled()).toMatch(/paused/);
    const b = await load();
    expect(b.describeLiveFailure(nebiusError(400, "Insufficient balance to run this request"))).toMatch(/budget is used up/);
    expect(b.liveRunsDisabled()).toMatch(/paused/);
  });

  it("does not pause on a rate limit or an outage, which are temporary", async () => {
    const { describeLiveFailure, liveRunsDisabled } = await load();
    expect(describeLiveFailure(nebiusError(429, "Too many requests"))).toMatch(/rate-limiting/);
    expect(describeLiveFailure(nebiusError(503, "Service unavailable"))).toMatch(/isn't answering/);
    expect(describeLiveFailure(new OpenAI.APIConnectionError({ message: "Connection error." }))).toMatch(/isn't answering/);
    expect(liveRunsDisabled()).toBeNull();
  });
});
