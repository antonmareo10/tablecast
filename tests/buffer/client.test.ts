import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BufferApiError, BufferClient, parseRateLimit, TtlCache, type CreatePostInput } from "@/lib/buffer/client";
import { bufferConfig, type BufferConfig } from "@/lib/buffer/config";
import { buildAuthorizeUrl, createPkcePair, exchangeCode, ReconnectRequired, TokenManager, type Tokens, type TokenStore } from "@/lib/buffer/oauth";
import { startMockBuffer, type MockBuffer } from "../helpers/mock-buffer";

const REDIRECT = "https://localhost:3000/api/buffer/callback";
let mock: MockBuffer;
let cfg: BufferConfig;
let store: Store;

class Store implements TokenStore {
  constructor(public tokens: Tokens | null) {}
  get() { return this.tokens; }
  set(t: Tokens) { this.tokens = t; }
  clear() { this.tokens = null; }
}

beforeAll(async () => {
  mock = await startMockBuffer({ clientId: "c1", redirectUri: REDIRECT });
  cfg = bufferConfig({ BUFFER_CLIENT_ID: "c1", SESSION_SECRET: "z".repeat(40), BUFFER_REDIRECT_URI: REDIRECT, BUFFER_AUTH_URL: mock.authUrl, BUFFER_TOKEN_URL: mock.tokenUrl, BUFFER_API_URL: mock.apiUrl });
});
afterAll(() => mock.close());

async function newClient(extra: Partial<ConstructorParameters<typeof BufferClient>[0]> = {}) {
  const { verifier, challenge } = createPkcePair();
  const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
  if ("error" in out) throw new Error(out.error);
  store = new Store(await exchangeCode(cfg, { code: new URL(out.redirect).searchParams.get("code")!, codeVerifier: verifier }));
  const sleeps: number[] = [];
  const client = new BufferClient({ apiUrl: cfg.apiUrl, tokens: new TokenManager(cfg, store), accountKey: `acct-${Math.random()}`, cache: new TtlCache(60_000), sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { client, sleeps };
}

beforeEach(() => {
  mock.state.posts.length = 0;
  mock.state.tags.length = 0;
  mock.state.fail429 = { times: 0, retryAfter: 1 };
  mock.state.mutationError = null;
  mock.state.rateRemaining = 97;
  mock.requests.length = 0;
});

const draft = (over: Partial<CreatePostInput> = {}): CreatePostInput => ({
  channelId: "ch-bsky",
  text: "Rain tonight. Soup is on.",
  assets: [{ image: { url: "https://app.test/api/post-image?s=x&sig=y" } }],
  needsApproval: false,
  schedulingType: "automatic",
  mode: "customScheduled",
  dueAt: "2026-11-04T16:00:00.000Z",
  saveToDraft: true,
  ...over,
});

describe("rate limit headers", () => {
  it("parses the three windows, including the space after each semicolon", () => {
    const w = parseRateLimit(`"100-in-15min";r=98; t=897, "250-in-1day";r=240; t=86397, "3000-in-30days";r=2969; t=696980`);
    expect(w).toEqual([
      { name: "100-in-15min", remaining: 98, resetsInSeconds: 897 },
      { name: "250-in-1day", remaining: 240, resetsInSeconds: 86397 },
      { name: "3000-in-30days", remaining: 2969, resetsInSeconds: 696980 },
    ]);
    expect(parseRateLimit(null)).toEqual([]);
  });
});

describe("reads", () => {
  it("lists organizations and channels with their time zone, and caches both", async () => {
    const { client } = await newClient();
    const orgs = await client.organizations();
    expect(orgs).toEqual([{ id: "org-1", name: "Mock restaurant" }]);
    const ch = await client.channels("org-1");
    expect(ch[0]).toMatchObject({ id: "ch-bsky", service: "bluesky", timezone: "Europe/Madrid" });
    const calls = client.calls;
    await client.organizations();
    await client.channels("org-1");
    expect(client.calls).toBe(calls); // no extra API requests
    await client.channels("org-1", { fresh: true });
    expect(client.calls).toBe(calls + 1);
  });

  it("asks only for the fields the screens paint", async () => {
    const { client } = await newClient();
    await client.channels("org-1");
    const q = (mock.requests.at(-1)!.body as { query: string }).query;
    expect(q).toContain("timezone");
    expect(q).not.toMatch(/postingSchedule|metadata|scopes|products/);
  });

  it("reads the queue as drafts or scheduled posts and the daily limit", async () => {
    const { client } = await newClient();
    await client.createPost(draft());
    await client.createPost(draft({ saveToDraft: false, text: "Scheduled one" }));
    const drafts = await client.posts("org-1", { status: ["draft"] });
    expect(drafts.posts.map((p) => p.text)).toEqual(["Rain tonight. Soup is on."]);
    const sched = await client.posts("org-1", { status: ["scheduled"] });
    expect(sched.posts[0].status).toBe("scheduled");
    expect(await client.dailyPostingLimits(["ch-bsky"], "2026-11-04T16:00:00.000Z")).toEqual([{ channelId: "ch-bsky", isAtLimit: false, limit: 25, scheduled: 0, sent: 0 }]);
  });
});

describe("writes", () => {
  it("creates a draft with dueAt in UTC, an image asset and tags, and edits, then deletes it", async () => {
    const { client } = await newClient();
    const tag = await client.createTag("org-1", "Tablecast · rain Wed 4", "#3B82F6");
    expect(tag.ok).toBe(true);
    if (!tag.ok) return;
    const created = await client.createPost(draft({ tagIds: [tag.value.id] }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({ status: "draft", dueAt: "2026-11-04T16:00:00.000Z", tags: [{ name: "Tablecast · rain Wed 4" }] });
    const sent = (mock.requests.filter((r) => (r.body as { query?: string }).query?.includes("CreatePost")).at(-1)!.body as { variables: { input: CreatePostInput } }).variables.input;
    expect(sent.saveToDraft).toBe(true);
    expect(sent.mode).toBe("customScheduled");
    const edited = await client.editPost({ id: created.value.id, dueAt: "2026-11-05T16:00:00.000Z", mode: "customScheduled" });
    expect(edited.ok && edited.value.dueAt).toBe("2026-11-05T16:00:00.000Z");
    expect((await client.deletePost(created.value.id)).ok).toBe(true);
    expect((await client.deletePost(created.value.id)).ok).toBe(false);
  });

  it("returns mutation errors as data, with their type", async () => {
    const { client } = await newClient();
    mock.state.mutationError = "dueAt is in the past";
    const r = await client.createPost(draft());
    expect(r).toEqual({ ok: false, error: { type: "InvalidInputError", message: "dueAt is in the past" } });
    expect(await client.createTag("org-1", "a", "#000000")).toMatchObject({ ok: true });
    expect(await client.createTag("org-1", "a", "#000000")).toMatchObject({ ok: false, error: { type: "DuplicateError" } });
  });
});

describe("limits and failures", () => {
  it("waits out a short Retry-After once and retries", async () => {
    const { client, sleeps } = await newClient();
    mock.state.fail429 = { times: 1, retryAfter: 2 };
    await expect(client.organizations()).resolves.toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it("reports a long Retry-After instead of holding the request open", async () => {
    const { client, sleeps } = await newClient();
    mock.state.fail429 = { times: 5, retryAfter: 600 };
    const err = await client.organizations().catch((e) => e);
    expect(err).toBeInstanceOf(BufferApiError);
    expect(err).toMatchObject({ kind: "rate_limit", retryAfter: 600 });
    expect(sleeps).toEqual([]);
  });

  it("stops calling once a window is empty and says how long to wait", async () => {
    const { client } = await newClient();
    mock.state.rateRemaining = 1;
    await client.channels("org-1"); // uses the last call: header now says r=0
    const calls = client.calls;
    const err = await client.posts("org-1").catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limit", retryAfter: 800 });
    expect(client.calls).toBe(calls);
  });

  it("clears the session and asks to reconnect on a 401", async () => {
    const { client } = await newClient();
    store.tokens = { ...store.tokens!, accessToken: "at_forged" };
    await expect(client.posts("org-1")).rejects.toBeInstanceOf(ReconnectRequired);
    expect(store.tokens).toBeNull();
  });
});
