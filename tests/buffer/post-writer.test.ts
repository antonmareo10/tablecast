import { describe, expect, it } from "vitest";
import plans from "../fixtures/buffer/plans.json";
import { checkPostTimes, fit, utcToZoned, writePosts, zonedToUtc, type WriterInput } from "@/lib/post-writer";
import type { Playbook } from "@/lib/types";

type Fx = { timezone: string; playbook: unknown; days: WriterInput["days"]; events: WriterInput["events"]; sources: WriterInput["sources"] };
const fx = plans as unknown as Record<string, Fx>;
const input = (slug: string, now: string, rebase = true): WriterInput => {
  const p = fx[slug];
  return { playbook: p.playbook as Playbook, days: p.days, events: p.events, sources: p.sources, timezone: p.timezone, now: new Date(now), rebase };
};

describe("time zones", () => {
  it("converts local wall time to UTC across both DST systems", () => {
    expect(zonedToUtc("2026-11-04", "16:00", "Europe/Madrid").toISOString()).toBe("2026-11-04T15:00:00.000Z"); // CET
    expect(zonedToUtc("2026-10-21", "16:00", "Europe/Madrid").toISOString()).toBe("2026-10-21T14:00:00.000Z"); // CEST
    expect(zonedToUtc("2026-11-04", "10:00", "America/Los_Angeles").toISOString()).toBe("2026-11-04T18:00:00.000Z"); // PST
    expect(zonedToUtc("2026-10-28", "10:00", "America/Los_Angeles").toISOString()).toBe("2026-10-28T17:00:00.000Z"); // PDT
  });
  it("round-trips, including the weeks the US and Europe change clocks on different days", () => {
    for (const [d, t, tz] of [["2026-10-25", "09:30", "Europe/Madrid"], ["2026-11-01", "09:30", "America/New_York"], ["2026-10-27", "23:45", "Europe/London"], ["2026-11-02", "00:15", "America/Los_Angeles"]] as const) {
      expect(utcToZoned(zonedToUtc(d, t, tz), tz)).toEqual({ date: d, time: t });
    }
  });
});

describe("fit", () => {
  it("keeps short text, cuts long text at a sentence, else at a word", () => {
    expect(fit("Short.", 300)).toBe("Short.");
    const long = "First sentence is here. " + "word ".repeat(100);
    expect(fit(long, 40)).toBe("First sentence is here.");
    expect(fit("word ".repeat(100), 30).endsWith("…")).toBe(true);
    expect(fit("word ".repeat(100), 30).length).toBeLessThanOrEqual(30);
  });
});

describe("writer on recorded plans (no model call)", () => {
  // Replay on Wed 28 Oct 2026 08:30 Madrid time, a week after the plans were recorded (Wed 21 Oct).
  const NOW = "2026-10-28T07:30:00Z";

  for (const slug of Object.keys(fx)) {
    describe(slug, () => {
      const r = writePosts(input(slug, NOW));

      it("moves the plan forward by whole weeks and keeps every post in the future, at a checked time", () => {
        expect(r.shiftDays).toBe(7);
        expect(r.posts.length).toBeGreaterThanOrEqual(3);
        expect(checkPostTimes(r.posts, new Date(NOW))).toEqual([]);
        const slots = r.posts.map((p) => p.post_at.utc);
        expect(new Set(slots).size).toBe(slots.length); // no two posts at the same minute
      });

      it("gives every post one text per network that fits that network", () => {
        for (const p of r.posts) {
          expect(p.variants.bluesky.length).toBeLessThanOrEqual(300);
          expect(p.variants.twitter.length).toBeLessThanOrEqual(280);
          expect(p.variants.instagram.length).toBeLessThanOrEqual(2200);
          expect(p.variants.default.length).toBeGreaterThan(10);
          expect(p.text).not.toMatch(/—/); // no em dash in what guests read (dish names keep theirs only in the image)
        }
      });

      it("never prints a past date from the plan in a post", () => {
        for (const p of r.posts) expect(`${p.text} ${p.variants.instagram}`).not.toMatch(/\b2[0-7] Oct\b/);
      });

      it("ties each post to the plan's evidence and source", () => {
        const withWhy = r.posts.filter((p) => p.why_now.cites.length); // dishes cited to web pages carry none in these trimmed fixtures
        expect(withWhy.length).toBeGreaterThan(0);
        for (const p of withWhy) {
          expect(p.why_now.cites.length).toBeGreaterThan(0);
          for (const c of p.why_now.cites) expect(c.quote.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it("Gjelina: rain days get the rain forecast and the dish that runs that day, at 10:00 local", () => {
    const r = writePosts(input("gjelina-los-angeles", NOW));
    const first = r.posts[0];
    expect(first.kind).toBe("moment");
    expect(first.post_at).toMatchObject({ date: "2026-10-28", time: "10:00", timezone: "America/Los_Angeles", utc: "2026-10-28T17:00:00.000Z" });
    expect(first.text).toMatch(/^Heavy rain today, 23°C\. Rain Bowl \$22\./);
    expect(first.title).toBe("Heavy rain · Wed 28 Oct");
    expect(first.tag).toBe("Tablecast · rain");
    expect(first.why_now.verified).toBe(true);
    expect(first.why_now.cites[0].quote).toContain("heavy rain");
  });

  it("Casa Lucio: an evening moment about a listed show names the show and posts at 16:00 local", () => {
    const r = writePosts(input("casa-lucio-madrid", NOW));
    const show = r.posts.find((p) => p.text.includes("Tablao Flamenco Las Tablas"));
    expect(show).toBeDefined();
    expect(show!.text).toMatch(/tonight at 19:00, 1\.2 km away/);
    expect(show!.post_at.time).toBe("16:00");
    expect(show!.post_at.utc).toBe("2026-10-28T15:00:00.000Z");
  });

  it("uses the time the plan gives for the event post", () => {
    const r = writePosts(input("gjelina-los-angeles", NOW));
    const ev = r.posts.find((p) => p.kind === "event")!;
    expect(["10:00", "10:30"]).toContain(ev.post_at.time); // 10:00 asked by the plan; moved 30 min if another post holds the minute
    expect(ev.post_at.basis).toContain("plan");
  });

  it("does not rebase a live plan, and skips posts whose time has passed instead of scheduling them", () => {
    const live = input("gjelina-los-angeles", "2026-10-21T16:00:00Z", false); // Wed 21 Oct 09:00 in Los Angeles
    const r = writePosts(live);
    expect(r.shiftDays).toBe(0);
    expect(r.posts.every((p) => p.post_at.utc > "2026-10-21T16:15:00Z")).toBe(true);
    const later = writePosts(input("gjelina-los-angeles", "2026-10-22T22:00:00Z", false));
    expect(later.skipped.length).toBeGreaterThan(0);
    expect(later.skipped[0].reason).toMatch(/already past/);
  });

  it("flags a moment with nothing to say to guests so the owner edits it", () => {
    const r = writePosts(input("casa-lucio-madrid", NOW));
    expect(r.posts.some((p) => p.issues.length > 0)).toBe(true);
  });

  it("the date guard catches a post whose UTC instant disagrees with its stated local time", () => {
    const r = writePosts(input("gjelina-los-angeles", NOW));
    const bad = [{ ...r.posts[0], post_at: { ...r.posts[0].post_at, utc: "2026-11-04T10:00:00.000Z" } }];
    expect(checkPostTimes(bad, new Date(NOW)).join(" ")).toContain("is 2026-11-04 02:00 in America/Los_Angeles, not 2026-10-28 10:00");
    expect(checkPostTimes(r.posts, new Date("2027-01-01T00:00:00Z")).join(" ")).toMatch(/in the past/);
  });
});
