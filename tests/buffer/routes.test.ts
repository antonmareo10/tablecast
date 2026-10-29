import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferClient, TtlCache, type Channel } from "@/lib/buffer/client";
import { bufferConfig } from "@/lib/buffer/config";
import { buildAuthorizeUrl, createPkcePair, exchangeCode, TokenManager, type Tokens, type TokenStore } from "@/lib/buffer/oauth";
import { startMockBuffer, type MockBuffer } from "../helpers/mock-buffer";

// The routes, called as functions. The sealed-cookie session is replaced by a client wired straight to the local
// mock of api.buffer.com (the cookie layer has its own tests); everything else is the real route code.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/buffer/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/buffer/context")>()),
  bufferContext: async () => ({ cfg: {}, client: h.client, organizationId: "org-1" }),
}));

import { POST as replan } from "@/app/api/buffer/replan/route";
import { GET as queue } from "@/app/api/buffer/queue/route";
import { POST as schedule } from "@/app/api/buffer/schedule/route";
import { POST as write } from "@/app/api/buffer/write/route";

const REDIRECT = "https://localhost:3000/api/buffer/callback";
const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-28T07:30:00Z");
let mock: MockBuffer;
let client: BufferClient;
const ch = (id: string, service: string, over: Partial<Channel> = {}): Channel => ({ id, name: id, displayName: null, service: service as Channel["service"], avatar: "x", timezone: "America/Los_Angeles", isDisconnected: false, isLocked: false, isQueuePaused: false, ...over });

const post = (body: unknown) => new Request("http://localhost:3000/api/x", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });

type W = { posts: { id: string; title: string; variants: Record<string, string>; text: string; post_at: object }[]; snapshot: unknown; location: unknown };
const written = async () => (await (await write(post({ plan: "gjelina-los-angeles" }))).json()) as W;

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  mock = await startMockBuffer({ clientId: "c", redirectUri: REDIRECT });
  const cfg = bufferConfig({ BUFFER_CLIENT_ID: "c", SESSION_SECRET: SECRET, BUFFER_REDIRECT_URI: REDIRECT, BUFFER_AUTH_URL: mock.authUrl, BUFFER_TOKEN_URL: mock.tokenUrl, BUFFER_API_URL: mock.apiUrl });
  const { verifier, challenge } = createPkcePair();
  const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
  if ("error" in out) throw new Error(out.error);
  let tokens: Tokens | null = await exchangeCode(cfg, { code: new URL(out.redirect).searchParams.get("code")!, codeVerifier: verifier });
  const store: TokenStore = { get: () => tokens, set: (t) => void (tokens = t), clear: () => void (tokens = null) };
  h.client = client = new BufferClient({ apiUrl: cfg.apiUrl, tokens: new TokenManager(cfg, store), accountKey: "routes", cache: new TtlCache(0), sleep: async () => {} });
});
afterAll(async () => {
  delete process.env.SESSION_SECRET;
  await mock.close();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mock.state.posts.length = 0;
  mock.state.tags.length = 0;
  mock.state.fail429 = { times: 0, retryAfter: 1 };
  mock.state.channels = [ch("ch-bsky", "bluesky"), ch("ch-ig", "instagram")];
  client.rate = [];
});

describe("/api/buffer/write", () => {
  it("writes a recorded plan with signed picture paths, the snapshot and the location", async () => {
    const r = await (await write(post({ plan: "gjelina-los-angeles" }))).json();
    expect(r.source).toMatchObject({ kind: "replay", restaurant: "Gjelina", timezone: "America/Los_Angeles" });
    expect(r.posts.length).toBeGreaterThan(3);
    expect(r.problems).toEqual([]);
    expect(r.images[r.posts[0].id]).toMatch(/^\/api\/post-image\?d=.+&sig=.+$/);
    expect(r.snapshot.days.length).toBeGreaterThanOrEqual(7);
    expect(r.location).toMatchObject({ timezone: "America/Los_Angeles" });
  });

  it("refuses a foreign origin, an unknown plan and a malformed live plan", async () => {
    const foreign = new Request("http://localhost:3000/api/x", { method: "POST", headers: { origin: "https://evil.test", host: "localhost:3000" }, body: "{}" });
    expect((await write(foreign)).status).toBe(403);
    expect((await write(post({ plan: "nope" }))).status).toBe(404);
    const bad = await write(post({ live: { playbook: {}, days: [] } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("bad_plan");
  });

  it("accepts the plan of a live run in the shape the browser sends it", async () => {
    const { DEMOS } = await import("@/data/demos");
    const d = DEMOS.find((x) => x.slug === "casa-lucio-madrid")!;
    const week = d.events.find((e) => e.type === "week")!;
    const pb = d.events.find((e) => e.type === "playbook")!;
    const src = d.events.find((e) => e.type === "sources")!;
    if (week.type !== "week" || pb.type !== "playbook" || src.type !== "sources") throw new Error("fixture");
    const live = {
      playbook: pb.playbook, days: week.days, events: week.events, timezone: "Europe/Madrid", location: { lat: 40.41, lon: -3.7 },
      sources: src.sources.map((s) => ({ id: s.id, title: s.title, url: s.url })),
    };
    // The recorded week lies in the past, so the writer skips every post as already past: it says so, it does not invent dates.
    const res = await write(post({ live }));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.source.kind).toBe("live");
    expect(r.posts.length + r.skipped.length).toBeGreaterThan(3);
  });
});

describe("/api/buffer/schedule with edited posts", () => {
  it("creates drafts for the channels each post was assigned to, with the edited text", async () => {
    const w = await written();
    const posts = w.posts.map((p, i) => (i === 0 ? { ...p, variants: { ...p.variants, bluesky: "My own words." } } : p));
    const targets = Object.fromEntries(posts.map((p, i) => [p.id, i === 1 ? ["ch-ig"] : i === 2 ? [] : ["ch-bsky"]]));
    const res = await schedule(post({ posts, targets, channelIds: ["ch-bsky", "ch-ig"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toBe(true);
    expect(body.outcomes.filter((o: { status: string }) => o.status === "created")).toHaveLength(posts.length - 1);
    expect(mock.state.posts.every((p) => p.status === "draft")).toBe(true);
    expect(mock.state.posts.some((p) => p.text === "My own words.")).toBe(true);
    expect(mock.state.posts.filter((p) => p.channelId === "ch-ig")).toHaveLength(1);
  });

  it("rejects text over a network limit, a post moved into the past and a forged tag, before any Buffer write", async () => {
    const w = await written();
    const long = w.posts.map((p, i) => (i === 0 ? { ...p, variants: { ...p.variants, bluesky: "x".repeat(301) } } : p));
    const r1 = await schedule(post({ posts: long, channelIds: ["ch-bsky"] }));
    expect(r1.status).toBe(422);
    expect((await r1.json()).error).toBe("text_limit");

    const past = w.posts.map((p, i) => (i === 0 ? { ...p, post_at: { ...p.post_at, utc: "2026-01-01T00:00:00.000Z" } } : p));
    expect((await schedule(post({ posts: past, channelIds: ["ch-bsky"] }))).status).toBe(422);

    const forged = w.posts.map((p, i) => (i === 0 ? { ...p, tag: "Anything I like" } : p));
    expect((await schedule(post({ posts: forged, channelIds: ["ch-bsky"] }))).status).toBe(400);
    expect(mock.state.posts).toHaveLength(0);
  });

  it("answers 429 with Retry-After when Buffer's limit is spent, and says how long to wait", async () => {
    const w = await written();
    mock.state.fail429 = { times: 5, retryAfter: 120 };
    const res = await schedule(post({ posts: w.posts, channelIds: ["ch-bsky"] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect((await res.json()).retryAfter).toBe(120);
  });
});

describe("/api/buffer/queue", () => {
  it("lists what Buffer holds, with tags, and the daily limits when asked", async () => {
    const w = await written();
    await schedule(post({ posts: w.posts, channelIds: ["ch-bsky"] }));
    const r = await (await queue(new Request("http://localhost:3000/api/buffer/queue?limits=1"))).json();
    expect(r.posts).toHaveLength(w.posts.length);
    expect(r.posts[0].tags[0].name).toMatch(/^Tablecast · /);
    expect(r.limits[0]).toMatchObject({ channelId: expect.any(String), limit: 25 });
    expect(r.channels).toHaveLength(2);
  });
});

describe("/api/buffer/replan", () => {
  async function seeded() {
    const w = await written();
    await schedule(post({ posts: w.posts, channelIds: ["ch-bsky"] }));
    return { posts: w.posts, previous: w.snapshot, location: w.location, scenario: "simulated", channelIds: ["ch-bsky"] };
  }
  const dues = () => mock.state.posts.map((p) => `${p.id}@${p.dueAt}`);

  it("proposes without changing anything, then applies only what is approved and only if unchanged", async () => {
    const base = await seeded();
    const before = dues();
    const r = await (await replan(post(base))).json();
    expect(r.scenario).toBe("simulated");
    const moves = r.proposals.filter((p: { action: string }) => p.action === "move");
    expect(moves.length).toBeGreaterThan(0);
    expect(dues()).toEqual(before);
    expect(r.diff.some((d: { changed: boolean }) => d.changed)).toBe(true);

    // A stale approval (the instant is not the one proposed) changes nothing.
    const stale = await (await replan(post({ ...base, approve: [{ postId: moves[0].postId, dueAt: "2030-01-01T00:00:00.000Z" }] }))).json();
    expect(stale.outcomes).toEqual([]);
    expect(stale.stale).toEqual([moves[0].postId]);
    expect(dues()).toEqual(before);

    const done = await (await replan(post({ ...base, approve: [{ postId: moves[0].postId, dueAt: moves[0].to.utc }] }))).json();
    expect(done.outcomes).toEqual([{ postId: moves[0].postId, status: "moved" }]);
    expect(mock.state.posts.find((p) => p.id === moves[0].postId)!.dueAt).toBe(moves[0].to.utc);
    // Only that post moved, and every post is still a draft.
    expect(dues().filter((d) => !before.includes(d))).toEqual([`${moves[0].postId}@${moves[0].to.utc}`]);
    expect(mock.state.posts.every((p) => p.status === "draft")).toBe(true);
  });

  it("applies nothing for a post that has no proposal", async () => {
    const base = await seeded();
    const before = dues();
    const r = await (await replan(post({ ...base, approve: [{ postId: "q-unknown", dueAt: "2030-01-01T00:00:00.000Z" }] }))).json();
    expect(r.outcomes).toEqual([]);
    expect(r.stale).toEqual(["q-unknown"]);
    expect(dues()).toEqual(before);
  });

  it("refuses a bad body and a foreign origin, and reports a spent Buffer limit as 429", async () => {
    expect((await replan(post({ posts: [] }))).status).toBe(400);
    const base = await seeded();
    const foreign = new Request("http://localhost:3000/api/x", { method: "POST", headers: { origin: "https://evil.test", host: "localhost:3000" }, body: JSON.stringify(base) });
    expect((await replan(foreign)).status).toBe(403);
    mock.state.fail429 = { times: 5, retryAfter: 90 };
    const limited = await replan(post(base));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
  });
});
