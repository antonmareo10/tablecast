import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BufferClient, TtlCache, type Channel } from "@/lib/buffer/client";
import { bufferConfig } from "@/lib/buffer/config";
import { buildAuthorizeUrl, createPkcePair, exchangeCode, TokenManager, type Tokens, type TokenStore } from "@/lib/buffer/oauth";
import { writePosts, type WriterInput } from "@/lib/post-writer";
import { applyMoves, proposeMoves, type Snapshot } from "@/lib/replan";
import { schedulePlan, textFor } from "@/lib/schedule";
import type { DayForecast, Playbook } from "@/lib/types";
import plans from "../fixtures/buffer/plans.json";
import { startMockBuffer, type MockBuffer } from "../helpers/mock-buffer";

// Two forecasts for the same week. The first is the one recorded with the plan (Gjelina, Los Angeles, rain on
// Wed and Thu). No second recording exists yet, so the second is the first edited by hand to say what a Monday
// update might say: Thursday dries out and Sunday turns wet. The test is about the rule, not about the weather.
type Fx = { timezone: string; playbook: unknown; days: DayForecast[]; events: WriterInput["events"]; sources: WriterInput["sources"] };
const fx = (plans as unknown as Record<string, Fx>)["gjelina-los-angeles"];
const NOW = new Date("2026-10-28T07:30:00Z"); // Wed 28 Oct, 00:30 in Los Angeles: the plan moves forward 7 days
const shiftDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
const shifted = (days: DayForecast[]) => days.map((d) => ({ ...d, date: shiftDay(d.date) }));

const previous: Snapshot = { days: shifted(fx.days), events: fx.events };
const next: Snapshot = {
  events: fx.events,
  days: previous.days.map((d) =>
    d.date === "2026-10-29" ? { ...d, condition: "overcast", precip_mm: 0, precip_prob: 5 }
    : d.date === "2026-11-01" ? { ...d, condition: "moderate rain", precip_mm: 14.2, precip_prob: 90 }
    : d),
};

const REDIRECT = "https://localhost:3000/api/buffer/callback";
const SECRET = "r".repeat(40);
let mock: MockBuffer;
let client: BufferClient;
const channel: Channel = { id: "ch-bsky", name: "antonmareo.bsky.social", displayName: null, service: "bluesky", avatar: "x", timezone: "America/Los_Angeles", isDisconnected: false, isLocked: false, isQueuePaused: false };

const written = () => writePosts({ playbook: fx.playbook as Playbook, days: fx.days, events: fx.events, sources: fx.sources, timezone: fx.timezone, now: NOW, rebase: true });

beforeAll(async () => {
  mock = await startMockBuffer({ clientId: "c", redirectUri: REDIRECT });
  mock.state.channels = [channel as unknown as Record<string, unknown>];
  const cfg = bufferConfig({ BUFFER_CLIENT_ID: "c", SESSION_SECRET: SECRET, BUFFER_REDIRECT_URI: REDIRECT, BUFFER_AUTH_URL: mock.authUrl, BUFFER_TOKEN_URL: mock.tokenUrl, BUFFER_API_URL: mock.apiUrl });
  const { verifier, challenge } = createPkcePair();
  const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
  if ("error" in out) throw new Error(out.error);
  let tokens: Tokens | null = await exchangeCode(cfg, { code: new URL(out.redirect).searchParams.get("code")!, codeVerifier: verifier });
  const store: TokenStore = { get: () => tokens, set: (t) => void (tokens = t), clear: () => void (tokens = null) };
  client = new BufferClient({ apiUrl: cfg.apiUrl, tokens: new TokenManager(cfg, store), accountKey: "r", cache: new TtlCache(60_000) });
});
afterAll(() => mock.close());

describe("the queue follows the weather", () => {
  it("proposes moving the dry Thursday's rain post to the new rainy Sunday, at the same local time, across the DST change", async () => {
    const w = written();
    await schedulePlan({ client, organizationId: "org-1", channels: [channel], specs: w.posts, origin: "https://app.test", imageSecret: SECRET, draft: true });
    const queue = (await client.posts("org-1", { status: ["draft", "scheduled"] })).posts;
    expect(queue.length).toBe(w.posts.length);

    const proposals = proposeMoves({ specs: w.posts, previous, next, queue, textOf: (s, ch) => textFor(s, ch === channel.id ? channel.service : "bluesky"), now: NOW });
    const moves = proposals.filter((p) => p.action === "move");
    expect(moves).toHaveLength(1);
    const m = moves[0];
    expect(m.from).toEqual({ date: "2026-10-29", time: "10:00" });
    expect(m.to).toEqual({ date: "2026-11-01", time: "10:00", utc: "2026-11-01T18:00:00.000Z" }); // PST after the clocks change
    expect(m.reason).toContain("changed from 11.3 mm to 0 mm");
    expect(m.reason).toContain("Sun 1 Nov is now moderate rain, 14.2 mm");
    expect(m.edit).toEqual({ id: m.postId, mode: "customScheduled", dueAt: "2026-11-01T18:00:00.000Z", saveToDraft: true });
    // The post for Wednesday (still rainy) is left alone.
    expect(proposals.some((p) => p.from.date === "2026-10-28")).toBe(false);

    // Nothing has changed in Buffer until the owner approves.
    const before = mock.state.posts.find((p) => p.id === m.postId)!.dueAt;
    expect(before).toBe(w.posts.find((s) => s.id === m.specId)!.post_at.utc);

    const done = await applyMoves(client, moves);
    expect(done).toEqual([{ postId: m.postId, status: "moved" }]);
    expect(mock.state.posts.find((p) => p.id === m.postId)!.dueAt).toBe("2026-11-01T18:00:00.000Z");
  });

  it("proposes nothing when the forecast did not change", () => {
    const w = written();
    const queue = w.posts.map((s) => ({ id: `q-${s.id}`, channelId: channel.id, status: "draft" as const, dueAt: s.post_at.utc, text: s.variants.bluesky }));
    expect(proposeMoves({ specs: w.posts, previous, next: previous, queue, textOf: (s) => s.variants.bluesky, now: NOW })).toEqual([]);
  });

  it("flags for review, and changes nothing, when the rain is gone and no other day is rainy", async () => {
    const w = written();
    const queue = w.posts.map((s) => ({ id: `q-${s.id}`, channelId: channel.id, status: "draft" as const, dueAt: s.post_at.utc, text: s.variants.bluesky }));
    const dry: Snapshot = { events: fx.events, days: previous.days.map((d) => ({ ...d, precip_mm: 0, condition: "clear" })) };
    const proposals = proposeMoves({ specs: w.posts, previous, next: dry, queue, textOf: (s) => s.variants.bluesky, now: NOW });
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.action === "review" && !p.edit)).toBe(true);
    expect(await applyMoves(client, proposals)).toSatisfy((r: { status: string }[]) => r.every((x) => x.status === "skipped"));
  });

  it("ignores a post that is no longer in the queue (the owner already deleted or edited it)", () => {
    const w = written();
    expect(proposeMoves({ specs: w.posts, previous, next, queue: [], textOf: (s) => s.variants.bluesky, now: NOW })).toEqual([]);
  });
});
