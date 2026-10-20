// Best-effort abuse protection for the public demo (per server instance).
// Live runs call paid APIs, so we cap concurrency, per-IP rate and a daily budget.

const PER_IP_PER_HOUR = Number(process.env.LIVE_RUNS_PER_IP_PER_HOUR || 4);
const DAILY_CAP = Number(process.env.LIVE_RUNS_DAILY_CAP || 80);
const MAX_CONCURRENT = Number(process.env.LIVE_RUNS_MAX_CONCURRENT || 3);

const perIp = new Map<string, number[]>();
let day = new Date().toISOString().slice(0, 10);
let dailyCount = 0;
let running = 0;

export type Gate = { ok: true; release: () => void } | { ok: false; reason: string };

export function acquireLiveRun(ip: string): Gate {
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

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
}
