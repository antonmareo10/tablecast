import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BufferClient, TtlCache, type Channel } from "@/lib/buffer/client";
import { bufferConfig } from "@/lib/buffer/config";
import { buildAuthorizeUrl, createPkcePair, exchangeCode, TokenManager, type Tokens, type TokenStore } from "@/lib/buffer/oauth";
import { imageSecret, normalizeSpec, signedImagePath, signedImageUrl, verifyImage } from "@/lib/post-image";
import { writePosts, type WriterInput } from "@/lib/post-writer";
import { buildCreateInput, metadataFor, schedulePlan } from "@/lib/schedule";
import type { Playbook } from "@/lib/types";
import plans from "../fixtures/buffer/plans.json";
import { startMockBuffer, type MockBuffer } from "../helpers/mock-buffer";

const REDIRECT = "https://localhost:3000/api/buffer/callback";
const SECRET = "k".repeat(40);
const ORIGIN = "https://tablecast-week.example";
const NOW = new Date("2026-10-28T07:30:00Z");

let mock: MockBuffer;
let client: BufferClient;
const ch = (id: string, service: string, over: Partial<Channel> = {}): Channel => ({ id, name: id, displayName: null, service: service as Channel["service"], avatar: "x", timezone: "Europe/Madrid", isDisconnected: false, isLocked: false, isQueuePaused: false, ...over });

function writer() {
  const p = (plans as unknown as Record<string, { timezone: string; playbook: unknown; days: WriterInput["days"]; events: WriterInput["events"]; sources: WriterInput["sources"] }>)["casa-lucio-madrid"];
  return writePosts({ playbook: p.playbook as Playbook, days: p.days, events: p.events, sources: p.sources, timezone: p.timezone, now: NOW, rebase: true });
}

beforeAll(async () => {
  mock = await startMockBuffer({ clientId: "c", redirectUri: REDIRECT });
  const cfg = bufferConfig({ BUFFER_CLIENT_ID: "c", SESSION_SECRET: SECRET, BUFFER_REDIRECT_URI: REDIRECT, BUFFER_AUTH_URL: mock.authUrl, BUFFER_TOKEN_URL: mock.tokenUrl, BUFFER_API_URL: mock.apiUrl });
  const { verifier, challenge } = createPkcePair();
  const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
  if ("error" in out) throw new Error(out.error);
  let tokens: Tokens | null = await exchangeCode(cfg, { code: new URL(out.redirect).searchParams.get("code")!, codeVerifier: verifier });
  const store: TokenStore = { get: () => tokens, set: (t) => void (tokens = t), clear: () => void (tokens = null) };
  client = new BufferClient({ apiUrl: cfg.apiUrl, tokens: new TokenManager(cfg, store), accountKey: "a", cache: new TtlCache(60_000) });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.state.posts.length = 0;
  mock.state.tags.length = 0;
  mock.state.limits = {};
  mock.state.channels = [
    ch("ch-bsky", "bluesky", { name: "antonmareo.bsky.social" }),
    ch("ch-ig", "instagram"),
    ch("ch-gbp", "googlebusiness", { timezone: "Europe/London" }),
  ];
});

describe("signed images", () => {
  const spec = { restaurant: "Casa Lucio", kicker: "Wed 28 Oct", headline: "Huevos estrellados", detail: "EUR 14", tone: "dish" as const };
  it("verifies its own signature and nothing else", () => {
    const path = signedImagePath(spec, SECRET);
    const q = new URL(`https://x.test${path}`).searchParams;
    expect(verifyImage(q.get("d"), q.get("sig"), SECRET)).toEqual(spec);
    expect(verifyImage(q.get("d"), q.get("sig"), "z".repeat(40))).toBeNull();
    expect(verifyImage(q.get("d"), "A" + q.get("sig")!.slice(1), SECRET)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...spec, headline: "Free money" })).toString("base64url");
    expect(verifyImage(forged, q.get("sig"), SECRET)).toBeNull();
    expect(verifyImage(null, null, SECRET)).toBeNull();
  });
  it("is stable: the same spec always gives the same URL, with no expiry in it", () => {
    expect(signedImagePath(spec, SECRET)).toBe(signedImagePath({ ...spec }, SECRET));
    expect(signedImagePath(spec, SECRET)).not.toMatch(/exp|ts=|expires/i);
    expect(signedImageUrl(ORIGIN + "/", spec, SECRET).startsWith(`${ORIGIN}/api/post-image?d=`)).toBe(true);
  });
  it("trims long text so the picture cannot overflow and the URL stays short", () => {
    const long = { ...spec, headline: "x".repeat(300), detail: "y".repeat(500) };
    expect(normalizeSpec(long).headline.length).toBeLessThanOrEqual(70);
    expect(signedImagePath(long, SECRET).length).toBeLessThan(700);
  });
  it("needs a real secret", () => {
    expect(() => imageSecret({})).toThrow();
    expect(imageSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("building posts", () => {
  it("sets the metadata Buffer requires per service and the network's own text", () => {
    expect(metadataFor("instagram")).toEqual({ instagram: { type: "post", shouldShareToFeed: true } });
    expect(metadataFor("googlebusiness")).toEqual({ google: { type: "whats_new" } });
    expect(metadataFor("bluesky")).toBeUndefined();
    const s = writer().posts[0];
    const bsky = buildCreateInput(s, ch("a", "bluesky"), { imageUrl: "https://i.test/1", draft: true });
    expect(bsky).toMatchObject({ mode: "customScheduled", dueAt: s.post_at.utc, saveToDraft: true, needsApproval: false, schedulingType: "automatic", text: s.variants.bluesky });
    expect(bsky.metadata).toBeUndefined();
    expect(bsky.assets).toEqual([{ image: { url: "https://i.test/1" } }]);
    expect(buildCreateInput(s, ch("b", "instagram"), { imageUrl: "u", draft: false }).saveToDraft).toBe(false);
  });
});

describe("scheduling a written plan into Buffer (against the mock)", () => {
  it("creates every post as a draft with its tag, signed image and UTC time, and reports time zone differences", async () => {
    const w = writer();
    const channels = mock.state.channels as unknown as Channel[];
    const r = await schedulePlan({ client, organizationId: "org-1", channels, specs: w.posts, origin: ORIGIN, imageSecret: SECRET, draft: true });
    const created = r.outcomes.filter((o) => o.status === "created");
    expect(created.length).toBe(w.posts.length * 3);
    expect(r.outcomes.every((o) => o.status === "created")).toBe(true);
    expect(mock.state.posts.every((p) => p.status === "draft")).toBe(true);
    expect(r.tagsCreated.length).toBeGreaterThan(0);
    expect(r.timezoneNotes).toHaveLength(1);
    expect(r.timezoneNotes[0]).toContain("Europe/London");
    type Sent = { assets: { image: { url: string } }[]; dueAt: string; channelId: string; metadata?: unknown };
    const sent = mock.requests
      .filter((q) => (q.body as { query?: string }).query?.includes("mutation CreatePost"))
      .map((q) => (q.body as { variables: { input: Sent } }).variables.input);
    for (const i of sent) {
      expect(i.assets[0].image.url.startsWith(`${ORIGIN}/api/post-image?d=`)).toBe(true);
      expect(i.dueAt).toMatch(/Z$/);
    }
    expect(sent.find((i) => i.channelId === "ch-ig")!.metadata).toEqual({ instagram: { type: "post", shouldShareToFeed: true } });
    expect(r.apiCalls).toBe(1 + r.tagsCreated.length + 1 + created.length); // tag list, tag creates, existing posts, creates
  });

  it("does not post twice when run again", async () => {
    const w = writer();
    const args = { client, organizationId: "org-1", channels: [ch("ch-bsky", "bluesky")], specs: w.posts, origin: ORIGIN, imageSecret: SECRET, draft: true };
    await schedulePlan(args);
    const again = await schedulePlan(args);
    expect(again.outcomes.every((o) => o.status === "exists")).toBe(true);
    expect(mock.state.posts).toHaveLength(w.posts.length);
  });

  it("skips disconnected channels with a reason and keeps going for the others", async () => {
    const w = writer();
    const r = await schedulePlan({ client, organizationId: "org-1", channels: [ch("ch-bsky", "bluesky"), ch("dead", "facebook", { isDisconnected: true })], specs: w.posts, origin: ORIGIN, imageSecret: SECRET, draft: true });
    expect(r.outcomes.filter((o) => o.channelId === "dead").every((o) => o.status === "skipped" && /disconnected/.test(o.reason ?? ""))).toBe(true);
    expect(r.outcomes.filter((o) => o.channelId === "ch-bsky").every((o) => o.status === "created")).toBe(true);
  });

  it("when scheduling for real, checks the daily limit and skips a full channel; drafts skip the check", async () => {
    const w = writer();
    mock.state.limits["ch-bsky"] = { isAtLimit: true, limit: 1, scheduled: 1, sent: 0 };
    const real = await schedulePlan({ client, organizationId: "org-1", channels: [ch("ch-bsky", "bluesky")], specs: w.posts.slice(0, 2), origin: ORIGIN, imageSecret: SECRET, draft: false });
    expect(real.outcomes.every((o) => o.status === "skipped" && /daily posting limit/.test(o.reason ?? ""))).toBe(true);
    const drafts = await schedulePlan({ client, organizationId: "org-1", channels: [ch("ch-bsky", "bluesky")], specs: w.posts.slice(0, 2), origin: ORIGIN, imageSecret: SECRET, draft: true });
    expect(drafts.outcomes.every((o) => o.status === "created")).toBe(true);
  });

  it("reports a refused post and carries on", async () => {
    const w = writer();
    mock.state.mutationError = "Text too long";
    const r = await schedulePlan({ client, organizationId: "org-1", channels: [ch("ch-bsky", "bluesky")], specs: w.posts.slice(0, 2), origin: ORIGIN, imageSecret: SECRET, draft: true });
    mock.state.mutationError = null;
    expect(r.outcomes.map((o) => [o.status, o.reason])).toEqual([["failed", "Text too long"], ["failed", "Text too long"]]);
  });
});
