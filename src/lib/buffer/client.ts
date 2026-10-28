// A small typed client for the Buffer GraphQL API (https://api.buffer.com).
// - Asks only for the fields the screens paint (query cost and the shared 100 / 15 min, 250 / day quota).
// - Reads the RateLimit headers on every response, waits out a short 429 Retry-After once, otherwise reports it.
// - Caches organizations and channels in memory (they change rarely; every judge shares the app's quota).
// - Mutations come back as data (PostActionSuccess or a MutationError), not as exceptions.
// Field names were checked against https://developers.buffer.com/reference.md on 28 Oct 2026, see docs/BUFFER_API_NOTES.md.

import { ReconnectRequired, type TokenManager } from "./oauth";

// ---- Types ------------------------------------------------------------------------------

export type Service =
  | "bluesky" | "facebook" | "googlebusiness" | "instagram" | "linkedin" | "mastodon" | "pinterest"
  | "startPage" | "substack" | "threads" | "tiktok" | "twitter" | "whatsapp" | "youtube";

export type Organization = { id: string; name: string };
export type Channel = {
  id: string;
  name: string;
  displayName: string | null;
  service: Service;
  avatar: string;
  timezone: string; // IANA; Buffer's default when unset is Europe/London
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
};
export type Asset = { id?: string; mimeType?: string | null };
export type PostStatus = "draft" | "error" | "needs_approval" | "scheduled" | "sending" | "sent";
export type PostTag = { id: string; name: string; color: string };
export type BufferPost = {
  id: string;
  text: string;
  status: PostStatus;
  dueAt: string | null;
  channelId: string;
  channelService: Service;
  tags: PostTag[];
  assets: Asset[];
};
export type PostsPage = { posts: BufferPost[]; hasNextPage: boolean; endCursor: string | null };
export type DailyLimit = { channelId: string; isAtLimit: boolean; limit: number | null; scheduled: number; sent: number };

export type AssetInput = { image: { url: string; thumbnailUrl?: string } } | { video: { url: string } };
export type PostMetadataInput = {
  instagram?: { type: "post"; shouldShareToFeed: boolean };
  facebook?: { type: "post" };
  google?: { type: "whats_new" };
};
export type CreatePostInput = {
  channelId: string;
  text: string;
  assets: AssetInput[];
  needsApproval: boolean;
  schedulingType: "automatic" | "notification";
  mode: "addToQueue" | "shareNext" | "shareNow" | "customScheduled";
  dueAt?: string; // ISO 8601, UTC
  saveToDraft?: boolean;
  tagIds?: string[];
  metadata?: PostMetadataInput;
  aiAssisted?: boolean;
  source?: string;
};
export type EditPostInput = Partial<Omit<CreatePostInput, "channelId" | "needsApproval">> & { id: string };

export type MutationResult<T> = { ok: true; value: T } | { ok: false; error: { type: string; message: string } };

export class BufferApiError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limit" | "graphql" | "http",
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export type RateWindow = { name: string; remaining: number; resetsInSeconds: number };

// ---- GraphQL documents ------------------------------------------------------------------

const POST_FIELDS = `id text status dueAt channelId channelService tags { id name color } assets { id mimeType }`;

export const QUERIES = {
  account: `query Account { account { id organizations { id name } } }`,
  channels: `query Channels($organizationId: OrganizationId!) {
  channels(input: { organizationId: $organizationId }) { id name displayName service avatar timezone isDisconnected isLocked isQueuePaused }
}`,
  createPost: `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`,
  editPost: `mutation EditPost($input: EditPostInput!) {
  editPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`,
  deletePost: `mutation DeletePost($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on DeletePostSuccess { id }
    ... on MutationError { message }
  }
}`,
  posts: `query Posts($input: PostsInput!, $first: Int, $after: String) {
  posts(input: $input, first: $first, after: $after) {
    edges { node { ${POST_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  dailyPostingLimits: `query DailyLimits($input: DailyPostingLimitsInput!) {
  dailyPostingLimits(input: $input) { channelId isAtLimit limit scheduled sent }
}`,
  createTag: `mutation CreateTag($input: CreateTagInput!) {
  createTag(input: $input) {
    __typename
    ... on TagActionSuccess { tag { id name color } }
    ... on MutationError { message }
  }
}`,
  tags: `query Tags($input: TagsInput!, $first: Int) {
  tagsV2(input: $input, first: $first) { edges { node { id name color } } }
}`,
} as const;

// ---- Cache ------------------------------------------------------------------------------

export class TtlCache {
  private items = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}
  async getOrSet<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.items.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as T;
    const value = await load();
    this.items.set(key, { at: this.now(), value });
    return value;
  }
  delete(prefix: string) {
    for (const k of this.items.keys()) if (k.startsWith(prefix)) this.items.delete(k);
  }
}

// One cache for the whole process; keys include the account so two owners never see each other's channels.
const sharedCache = new TtlCache(10 * 60_000);

// ---- Client -----------------------------------------------------------------------------

export type ClientOptions = {
  apiUrl: string;
  tokens: Pick<TokenManager, "accessToken" | "rejected">;
  accountKey: string; // stable per owner (the Buffer account id), scopes the cache
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cache?: TtlCache;
  maxWaitSeconds?: number; // longest Retry-After that is waited out in-request
};

/** "150-in-15min";r=98;t=897 -> one entry per window. The API sends a space after each semicolon. */
export function parseRateLimit(header: string | null): RateWindow[] {
  if (!header) return [];
  const out: RateWindow[] = [];
  for (const part of header.split(/,\s*(?=")/)) {
    const name = /"([^"]+)"/.exec(part)?.[1];
    const r = /;\s*r=(\d+)/.exec(part)?.[1];
    const t = /;\s*t=(\d+)/.exec(part)?.[1];
    if (name && r !== undefined && t !== undefined) out.push({ name, remaining: Number(r), resetsInSeconds: Number(t) });
  }
  return out;
}

export class BufferClient {
  rate: RateWindow[] = [];
  /** Requests this client has sent (for the "API calls" line in the demo). */
  calls = 0;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache: TtlCache;
  private readonly maxWait: number;

  constructor(private readonly o: ClientOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cache = o.cache ?? sharedCache;
    this.maxWait = o.maxWaitSeconds ?? 5;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    // Do not spend a call we know will be refused: report the wait instead.
    const exhausted = this.rate.find((w) => w.remaining <= 0 && w.resetsInSeconds > 0);
    if (exhausted) throw new BufferApiError(`Buffer API limit reached (${exhausted.name}). Try again in ${exhausted.resetsInSeconds}s.`, "rate_limit", "RATE_LIMIT_EXCEEDED", exhausted.resetsInSeconds);

    const token = await this.o.tokens.accessToken();
    this.calls++;
    const res = await this.f(this.o.apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const windows = parseRateLimit(res.headers.get("ratelimit"));
    if (windows.length) this.rate = windows;

    if (res.status === 401) {
      await this.o.tokens.rejected();
      throw new ReconnectRequired("Buffer rejected the access token. Connect again.");
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 0;
      if (!retried && wait > 0 && wait <= this.maxWait) {
        await this.sleep(wait * 1000);
        return this.graphql<T>(query, variables, true);
      }
      throw new BufferApiError(`Buffer API limit reached${wait ? `. Try again in ${wait}s` : ""}.`, "rate_limit", "RATE_LIMIT_EXCEEDED", wait || undefined);
    }
    const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] } | null;
    if (json?.errors?.length) {
      const e = json.errors[0];
      const code = e.extensions?.code;
      if (code === "UNAUTHORIZED" || code === "UNAUTHENTICATED") {
        await this.o.tokens.rejected();
        throw new ReconnectRequired("Buffer says this connection is not authorized. Connect again.");
      }
      if (code === "RATE_LIMIT_EXCEEDED") throw new BufferApiError("Buffer API limit reached.", "rate_limit", code);
      throw new BufferApiError(e.message, "graphql", code);
    }
    if (!res.ok || !json?.data) throw new BufferApiError(`Buffer answered HTTP ${res.status}.`, "http");
    return json.data;
  }

  // ---- Reads (cached) ----

  async account(): Promise<{ id: string; organizations: Organization[] }> {
    const data = await this.cache.getOrSet(`${this.o.accountKey}:account`, () => this.graphql<{ account: { id: string; organizations: Organization[] } }>(QUERIES.account));
    return data.account;
  }

  async organizations(): Promise<Organization[]> {
    return (await this.account()).organizations;
  }

  async channels(organizationId: string, opts: { fresh?: boolean } = {}): Promise<Channel[]> {
    const key = `${this.o.accountKey}:channels:${organizationId}`;
    if (opts.fresh) this.cache.delete(key);
    const data = await this.cache.getOrSet(key, () => this.graphql<{ channels: Channel[] }>(QUERIES.channels, { organizationId }));
    return data.channels;
  }

  async posts(organizationId: string, filter: { status?: PostStatus[]; channelIds?: string[]; tagIds?: string[] } = {}, page: { first?: number; after?: string } = {}): Promise<PostsPage> {
    const data = await this.graphql<{
      posts: { edges: { node: BufferPost }[] | null; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(QUERIES.posts, {
      input: { organizationId, filter, sort: [{ field: "dueAt", direction: "asc" }] },
      first: page.first ?? 50,
      after: page.after,
    });
    return { posts: (data.posts.edges ?? []).map((e) => e.node), ...data.posts.pageInfo };
  }

  async dailyPostingLimits(channelIds: string[], date?: string): Promise<DailyLimit[]> {
    const data = await this.graphql<{ dailyPostingLimits: DailyLimit[] }>(QUERIES.dailyPostingLimits, { input: { channelIds, date } });
    return data.dailyPostingLimits;
  }

  async tags(organizationId: string): Promise<PostTag[]> {
    const data = await this.graphql<{ tagsV2: { edges: { node: PostTag }[] } }>(QUERIES.tags, { input: { organizationId }, first: 100 });
    return data.tagsV2.edges.map((e) => e.node);
  }

  // ---- Writes ----

  async createPost(input: CreatePostInput): Promise<MutationResult<BufferPost>> {
    const data = await this.graphql<{ createPost: PostPayload }>(QUERIES.createPost, { input });
    return postResult(data.createPost);
  }

  async editPost(input: EditPostInput): Promise<MutationResult<BufferPost>> {
    const data = await this.graphql<{ editPost: PostPayload }>(QUERIES.editPost, { input });
    return postResult(data.editPost);
  }

  async deletePost(id: string): Promise<MutationResult<{ id: string }>> {
    const data = await this.graphql<{ deletePost: { __typename: string; id?: string; message?: string } }>(QUERIES.deletePost, { input: { id } });
    const r = data.deletePost;
    return r.id ? { ok: true, value: { id: r.id } } : { ok: false, error: { type: r.__typename, message: r.message ?? "Buffer did not delete the post." } };
  }

  async createTag(organizationId: string, name: string, color: string): Promise<MutationResult<PostTag>> {
    const data = await this.graphql<{ createTag: { __typename: string; tag?: PostTag; message?: string } }>(QUERIES.createTag, { input: { organizationId, tag: { name, color } } });
    const r = data.createTag;
    return r.tag ? { ok: true, value: r.tag } : { ok: false, error: { type: r.__typename, message: r.message ?? "Buffer did not create the tag." } };
  }
}

type PostPayload = { __typename: string; post?: BufferPost; message?: string };
function postResult(r: PostPayload): MutationResult<BufferPost> {
  return r.post ? { ok: true, value: r.post } : { ok: false, error: { type: r.__typename, message: r.message ?? "Buffer did not accept the post." } };
}
