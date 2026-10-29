import { describe, expect, it } from "vitest";
import { simulateUpdate, diffForecasts, proposeMoves, type Snapshot } from "@/lib/replan";
import { replayPosts } from "@/lib/demo-plans";
import { checkPostTimes } from "@/lib/post-writer";
import { boardDays, dailyCounts, defaultTargets, estimateCalls, movePost, overBy, overLimit, setVariantText } from "@/lib/week";

const NOW = new Date("2026-10-28T07:30:00Z");
const plan = () => replayPosts("gjelina-los-angeles", NOW)!;

describe("moving and editing posts", () => {
  it("keeps the exact instant, the weekday in the title and the picture weekday consistent", () => {
    const p = plan().posts[0];
    const moved = movePost(p, "2026-11-03", "18:30")!;
    expect(moved.post_at).toMatchObject({ date: "2026-11-03", time: "18:30", timezone: "America/Los_Angeles", basis: "moved by you" });
    expect(moved.post_at.utc).toBe("2026-11-04T02:30:00.000Z"); // 18:30 PST, the clocks changed on 1 Nov
    expect(moved.title).toMatch(/· Tue 3 Nov$/);
    expect(moved.image.kicker).toBe("Tue 3 Nov");
    expect(checkPostTimes([moved], NOW)).toEqual([]);
  });

  it("refuses a malformed date or time and flags a move into the past", () => {
    const p = plan().posts[0];
    expect(movePost(p, "3 Nov", "18:30")).toBeNull();
    expect(movePost(p, "2026-11-03", "6pm")).toBeNull();
    expect(checkPostTimes([movePost(p, "2026-10-20", "09:00")!], NOW).join()).toContain("in the past");
  });

  it("writes one network text without touching the others", () => {
    const p = plan().posts[0];
    const e = setVariantText(p, "bluesky", "Short and mine.");
    expect(e.variants.bluesky).toBe("Short and mine.");
    expect(e.variants.instagram).toBe(p.variants.instagram);
    expect(overBy("x".repeat(305), 300)).toBe(5);
    expect(overBy("short", 300)).toBe(0);
  });
});

describe("board and counters", () => {
  it("builds a column for each forecast day with its posts in time order", () => {
    const r = plan();
    const days = boardDays(r.posts, r.snapshot.days, r.snapshot.events);
    expect(days.length).toBeGreaterThanOrEqual(7);
    expect(days.flatMap((d) => d.posts).length).toBe(r.posts.length);
    for (const d of days) expect([...d.posts].sort((a, b) => a.post_at.time.localeCompare(b.post_at.time))).toEqual(d.posts);
  });

  it("counts scheduled posts per channel and local day, and counts the plan only when scheduling for real", () => {
    const r = plan();
    const ch = [{ id: "c1", timezone: "America/Los_Angeles" }];
    const targets = defaultTargets(r.posts, ["c1"]);
    const queue = [
      { channelId: "c1", status: "scheduled" as const, dueAt: r.posts[0].post_at.utc },
      { channelId: "c1", status: "draft" as const, dueAt: r.posts[0].post_at.utc }, // drafts do not count
    ];
    const draft = dailyCounts({ queue, plan: r.posts, targets, channels: ch, real: false });
    expect(draft.reduce((n, c) => n + c.inBuffer + c.fromPlan, 0)).toBe(1);
    const real = dailyCounts({ queue, plan: r.posts, targets, channels: ch, real: true });
    expect(real.reduce((n, c) => n + c.fromPlan, 0)).toBe(r.posts.length);
    const first = real.find((c) => c.date === r.posts[0].post_at.date)!;
    expect(overLimit(real, [{ channelId: "c1", limit: first.inBuffer + first.fromPlan - 1 }]).map((c) => c.date)).toContain(first.date);
    expect(overLimit(real, [{ channelId: "c1", limit: null }])).toEqual([]);
  });

  it("estimates the API calls of a run", () => {
    const r = plan();
    const t = defaultTargets(r.posts, ["a"]);
    const draft = estimateCalls(r.posts, t, false);
    expect(estimateCalls(r.posts, t, true)).toBe(draft + r.posts.length);
    expect(estimateCalls(r.posts, defaultTargets(r.posts, ["a", "b"]), false)).toBe(draft + r.posts.length);
  });
});

describe("re-plan helpers", () => {
  it("does not read a day the new forecast does not cover as the rain being gone", () => {
    const r = plan();
    const previous: Snapshot = r.snapshot;
    const queue = r.posts.map((s) => ({ id: `q-${s.id}`, channelId: "c", status: "draft" as const, dueAt: s.post_at.utc, text: s.variants.bluesky }));
    const empty: Snapshot = { days: [], events: [] };
    expect(proposeMoves({ specs: r.posts, previous, next: empty, queue, textOf: (s) => s.variants.bluesky, now: NOW })).toEqual([]);
  });

  it("simulates one dried-out day and one new rainy day, and never alters the input", () => {
    const r = plan();
    const before = JSON.stringify(r.snapshot);
    const sim = simulateUpdate(r.snapshot);
    expect(JSON.stringify(r.snapshot)).toBe(before);
    const diff = diffForecasts(r.snapshot.days, sim.days);
    expect(diff.filter((d) => d.changed).length).toBe(2);
  });
});
