// A local stand-in for auth.buffer.com and api.buffer.com, behaving like the documented service:
// PKCE S256 is verified, authorization codes and refresh tokens are single use, reusing a spent refresh token
// revokes the whole grant, the API answers 401 on a bad bearer, sends RateLimit headers and can be told to 429.
// Responses are shaped like the fixtures recorded from the public reference (tests/fixtures/buffer/).

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Grant = { id: string; revoked: boolean; access: Set<string>; refresh: Set<string> };

export type MockBuffer = {
  url: string;
  authUrl: string;
  tokenUrl: string;
  apiUrl: string;
  /** Mint an authorization code as if the owner had approved (checks like /auth would). */
  authorize(params: URLSearchParams): { redirect: string } | { error: string };
  requests: { path: string; body: unknown }[];
  grants: Map<string, Grant>;
  state: {
    expiresIn: number;
    secret: string | null;
    rateRemaining: number;
    rateReset: number;
    fail429: { times: number; retryAfter: number };
    posts: Record<string, unknown>[];
    tags: { id: string; name: string; color: string }[];
    channels: Record<string, unknown>[];
    limits: Record<string, { isAtLimit: boolean; limit: number | null; scheduled: number; sent: number }>;
    mutationError: string | null;
    omitRefresh: boolean;
  };
  close(): Promise<void>;
};

const b64url = (b: Buffer) => b.toString("base64url");

export async function startMockBuffer(opts: { clientId: string; redirectUri: string }): Promise<MockBuffer> {
  const codes = new Map<string, { challenge: string; redirectUri: string; used: boolean }>();
  const grants = new Map<string, Grant>();
  const accessIndex = new Map<string, Grant>();
  const refreshIndex = new Map<string, { grant: Grant; spent: boolean }>();
  const requests: MockBuffer["requests"] = [];
  const state: MockBuffer["state"] = {
    expiresIn: 3600,
    secret: null,
    rateRemaining: 97,
    rateReset: 800,
    fail429: { times: 0, retryAfter: 1 },
    posts: [],
    tags: [],
    channels: [
      { id: "ch-bsky", name: "antonmareo.bsky.social", displayName: null, service: "bluesky", avatar: "https://example.test/a.png", timezone: "Europe/Madrid", isDisconnected: false, isLocked: false, isQueuePaused: false },
    ],
    limits: {},
    mutationError: null,
    omitRefresh: false,
  };
  let seq = 0;

  function issue(grant: Grant) {
    const access = `at_${b64url(randomBytes(12))}`;
    const refresh = `rt_${b64url(randomBytes(12))}`;
    grant.access.add(access);
    grant.refresh.add(refresh);
    accessIndex.set(access, grant);
    refreshIndex.set(refresh, { grant, spent: false });
    return {
      access_token: access,
      ...(state.omitRefresh ? {} : { refresh_token: refresh }),
      token_type: "Bearer",
      expires_in: state.expiresIn,
      scope: "account:read posts:read posts:write offline_access",
    };
  }

  function authorize(params: URLSearchParams) {
    if (params.get("client_id") !== opts.clientId) return { error: "invalid_client" };
    if (params.get("redirect_uri") !== opts.redirectUri) return { error: "redirect_uri_mismatch" };
    if (params.get("response_type") !== "code") return { error: "unsupported_response_type" };
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return { error: "pkce_required" };
    if (!params.get("state")) return { error: "state_required" };
    const code = `code_${b64url(randomBytes(12))}`;
    codes.set(code, { challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")!, used: false });
    const u = new URL(opts.redirectUri);
    u.searchParams.set("code", code);
    u.searchParams.set("state", params.get("state")!);
    return { redirect: u.toString() };
  }

  function token(form: URLSearchParams): [number, Record<string, unknown>] {
    if (form.get("client_id") !== opts.clientId) return [401, { error: "invalid_client" }];
    if (state.secret !== null && form.get("client_secret") !== state.secret) return [401, { error: "invalid_client" }];
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const rec = codes.get(form.get("code") ?? "");
      if (!rec || rec.used) return [400, { error: "invalid_grant", error_description: "code is invalid or already used" }];
      rec.used = true;
      if (form.get("redirect_uri") !== rec.redirectUri) return [400, { error: "invalid_grant", error_description: "redirect_uri mismatch" }];
      const verifier = form.get("code_verifier") ?? "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== rec.challenge) return [400, { error: "invalid_grant", error_description: "PKCE verification failed" }];
      const grant: Grant = { id: `g${++seq}`, revoked: false, access: new Set(), refresh: new Set() };
      grants.set(grant.id, grant);
      return [200, issue(grant)];
    }
    if (grantType === "refresh_token") {
      const entry = refreshIndex.get(form.get("refresh_token") ?? "");
      if (!entry || entry.grant.revoked) return [400, { error: "invalid_grant" }];
      if (entry.spent) {
        // Reusing a rotated refresh token revokes the whole grant.
        entry.grant.revoked = true;
        for (const a of entry.grant.access) accessIndex.delete(a);
        return [400, { error: "invalid_grant", error_description: "refresh token reuse detected" }];
      }
      entry.spent = true;
      return [200, issue(entry.grant)];
    }
    return [400, { error: "unsupported_grant_type" }];
  }

  function api(body: { query: string; variables: Record<string, any> }): Record<string, unknown> {
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
    const v = body.variables ?? {};
    switch (op) {
      case "Account":
        return { data: { account: { id: "acct-1", organizations: [{ id: "org-1", name: "Mock restaurant" }] } } };
      case "Channels":
        return { data: { channels: state.channels } };
      case "CreatePost": {
        if (state.mutationError) return { data: { createPost: { __typename: "InvalidInputError", message: state.mutationError } } };
        const i = v.input;
        const channel = state.channels.find((c) => c.id === i.channelId) as { service: string } | undefined;
        if (!channel) return { data: { createPost: { __typename: "NotFoundError", message: "Channel not found" } } };
        if (!Array.isArray(i.assets) || typeof i.needsApproval !== "boolean") return { errors: [{ message: "assets and needsApproval are required", extensions: { code: "BAD_USER_INPUT" } }] };
        if (channel.service === "instagram" && !i.metadata?.instagram) return { data: { createPost: { __typename: "InvalidInputError", message: "instagram metadata required" } } };
        const post = {
          id: `post-${++seq}`,
          text: i.text,
          status: i.saveToDraft ? "draft" : "scheduled",
          dueAt: i.dueAt ?? null,
          channelId: i.channelId,
          channelService: channel.service,
          tags: (i.tagIds ?? []).map((id: string) => state.tags.find((t) => t.id === id)).filter(Boolean),
          assets: (i.assets as unknown[]).map((_, n) => ({ id: `as-${n}`, mimeType: "image/png" })),
        };
        state.posts.push(post);
        return { data: { createPost: { __typename: "PostActionSuccess", post } } };
      }
      case "EditPost": {
        const post = state.posts.find((p) => p.id === v.input.id);
        if (!post) return { data: { editPost: { __typename: "NotFoundError", message: "Post not found" } } };
        const { id: _id, mode, ...rest } = v.input;
        void _id;
        void mode;
        Object.assign(post, rest);
        return { data: { editPost: { __typename: "PostActionSuccess", post } } };
      }
      case "DeletePost": {
        const idx = state.posts.findIndex((p) => p.id === v.input.id);
        if (idx < 0) return { data: { deletePost: { __typename: "VoidMutationError", message: "Post not found" } } };
        state.posts.splice(idx, 1);
        return { data: { deletePost: { __typename: "DeletePostSuccess", id: v.input.id } } };
      }
      case "Posts": {
        const statuses: string[] | undefined = v.input.filter?.status;
        const list = state.posts.filter((p) => !statuses || statuses.includes(p.status as string));
        return { data: { posts: { edges: list.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      case "DailyLimits":
        return { data: { dailyPostingLimits: (v.input.channelIds as string[]).map((channelId) => ({ channelId, ...(state.limits[channelId] ?? { isAtLimit: false, limit: 25, scheduled: 0, sent: 0 }) })) } };
      case "CreateTag": {
        const { name, color } = v.input.tag;
        if (state.tags.some((t) => t.name === name)) return { data: { createTag: { __typename: "DuplicateError", message: "Tag name already exists" } } };
        const tag = { id: `tag-${++seq}`, name, color };
        state.tags.push(tag);
        return { data: { createTag: { __typename: "TagActionSuccess", tag } } };
      }
      case "Tags":
        return { data: { tagsV2: { edges: state.tags.map((node) => ({ node })) } } };
      default:
        return { errors: [{ message: `Unknown operation ${op}`, extensions: { code: "BAD_REQUEST" } }] };
    }
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url?.split("?")[0] ?? "/";
      const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      if (path === "/token") {
        const form = new URLSearchParams(raw);
        requests.push({ path, body: Object.fromEntries(form) });
        const [status, json] = token(form);
        return send(status, json);
      }
      if (path === "/graphql") {
        const body = JSON.parse(raw || "{}");
        requests.push({ path, body });
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        const grant = bearer ? accessIndex.get(bearer) : undefined;
        if (!grant || grant.revoked) return send(401, { errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } }] });
        if (state.fail429.times > 0) {
          state.fail429.times--;
          return send(429, { errors: [{ message: "rate limited", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }, { "retry-after": String(state.fail429.retryAfter) });
        }
        state.rateRemaining = Math.max(0, state.rateRemaining - 1);
        const rl = `"100-in-15min";r=${state.rateRemaining}; t=${state.rateReset}, "250-in-1day";r=240; t=80000, "3000-in-30days";r=2900; t=600000`;
        return send(200, api(body), { ratelimit: rl });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    authUrl: `${url}/auth`,
    tokenUrl: `${url}/token`,
    apiUrl: `${url}/graphql`,
    authorize,
    requests,
    grants,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
