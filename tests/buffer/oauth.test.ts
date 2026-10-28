import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bufferConfig, ConfigError, type BufferConfig } from "@/lib/buffer/config";
import { buildAuthorizeUrl, createPkcePair, createState, exchangeCode, OAuthError, ReconnectRequired, TokenManager, type Tokens, type TokenStore } from "@/lib/buffer/oauth";
import { seal, unseal } from "@/lib/buffer/seal";
import { startMockBuffer, type MockBuffer } from "../helpers/mock-buffer";

const REDIRECT = "https://localhost:3000/api/buffer/callback";
const SECRET = "x".repeat(40);

let mock: MockBuffer;
let cfg: BufferConfig;

beforeAll(async () => {
  mock = await startMockBuffer({ clientId: "client-123", redirectUri: REDIRECT });
  cfg = bufferConfig({
    BUFFER_CLIENT_ID: "client-123",
    BUFFER_CLIENT_SECRET: "s3cret",
    BUFFER_REDIRECT_URI: REDIRECT,
    SESSION_SECRET: SECRET,
    BUFFER_AUTH_URL: mock.authUrl,
    BUFFER_TOKEN_URL: mock.tokenUrl,
    BUFFER_API_URL: mock.apiUrl,
  });
  mock.state.secret = "s3cret";
});
afterAll(() => mock.close());

class MemoryStore implements TokenStore {
  sets = 0;
  constructor(public tokens: Tokens | null = null) {}
  get() { return this.tokens; }
  set(t: Tokens) { this.tokens = t; this.sets++; }
  clear() { this.tokens = null; }
}

async function connect(): Promise<Tokens> {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const url = new URL(buildAuthorizeUrl(cfg, { state, codeChallenge: challenge }));
  const out = mock.authorize(url.searchParams);
  if ("error" in out) throw new Error(out.error);
  const back = new URL(out.redirect);
  expect(back.searchParams.get("state")).toBe(state);
  return exchangeCode(cfg, { code: back.searchParams.get("code")!, codeVerifier: verifier });
}

describe("config", () => {
  it("refuses to start without a client id or with a short session secret", () => {
    expect(() => bufferConfig({ SESSION_SECRET: SECRET })).toThrow(ConfigError);
    expect(() => bufferConfig({ BUFFER_CLIENT_ID: "a", SESSION_SECRET: "short", BUFFER_REDIRECT_URI: REDIRECT })).toThrow(/32/);
  });
  it("ignores endpoint overrides in production", () => {
    const c = bufferConfig({ BUFFER_CLIENT_ID: "a", SESSION_SECRET: SECRET, BUFFER_REDIRECT_URI: REDIRECT, NODE_ENV: "production", BUFFER_TOKEN_URL: "http://evil.test/token" });
    expect(c.tokenUrl).toBe("https://auth.buffer.com/token");
  });
  it("uses the production host as the default callback on Vercel production only", () => {
    const base = { BUFFER_CLIENT_ID: "a", SESSION_SECRET: SECRET };
    expect(bufferConfig({ ...base, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "tablecast-week.vercel.app" }).redirectUri).toBe("https://tablecast-week.vercel.app/api/buffer/callback");
    expect(() => bufferConfig({ ...base, VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toThrow(ConfigError);
  });
});

describe("authorize URL and PKCE", () => {
  it("sends the S256 challenge, the state, the exact redirect and only the scopes the code uses", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).not.toBe(challenge);
    const u = new URL(buildAuthorizeUrl(cfg, { state: "st", codeChallenge: challenge }));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(challenge);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe("account:read posts:read posts:write offline_access");
    expect(u.searchParams.get("code_verifier")).toBeNull();
    expect(u.searchParams.get("client_secret")).toBeNull();
  });
});

describe("token exchange against the mock of auth.buffer.com", () => {
  it("trades the code and verifier for tokens, with the secret in the form body", async () => {
    const t = await connect();
    expect(t.accessToken).toMatch(/^at_/);
    expect(t.refreshToken).toMatch(/^rt_/);
    const last = mock.requests.filter((r) => r.path === "/token").at(-1)!.body as Record<string, string>;
    expect(last.grant_type).toBe("authorization_code");
    expect(last.client_secret).toBe("s3cret");
  });

  it("fails with a readable reason when the verifier is wrong", async () => {
    const { challenge } = createPkcePair();
    const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
    if ("error" in out) throw new Error(out.error);
    const code = new URL(out.redirect).searchParams.get("code")!;
    const err = await exchangeCode(cfg, { code, codeVerifier: "not-the-verifier" }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).oauthError).toBe("invalid_grant");
    expect((err as OAuthError).message).toMatch(/redirect_uri|expired|used/);
  });

  it("does not let a code be used twice", async () => {
    const { verifier, challenge } = createPkcePair();
    const out = mock.authorize(new URL(buildAuthorizeUrl(cfg, { state: "s", codeChallenge: challenge })).searchParams);
    if ("error" in out) throw new Error(out.error);
    const code = new URL(out.redirect).searchParams.get("code")!;
    await exchangeCode(cfg, { code, codeVerifier: verifier });
    await expect(exchangeCode(cfg, { code, codeVerifier: verifier })).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects a redirect URI that differs by one character", () => {
    const { challenge } = createPkcePair();
    const p = new URL(buildAuthorizeUrl({ ...cfg, redirectUri: REDIRECT + "/" }, { state: "s", codeChallenge: challenge })).searchParams;
    expect(mock.authorize(p)).toEqual({ error: "redirect_uri_mismatch" });
  });

  it("asks the owner to enable offline_access when no refresh token comes back", async () => {
    mock.state.omitRefresh = true;
    await expect(connect()).rejects.toThrow(/offline_access/);
    mock.state.omitRefresh = false;
  });
});

describe("single-owner rotating refresh", () => {
  it("keeps a fresh access token and does not touch the token endpoint", async () => {
    const store = new MemoryStore(await connect());
    const before = mock.requests.length;
    const tm = new TokenManager(cfg, store);
    await tm.accessToken();
    expect(mock.requests.length).toBe(before);
  });

  it("refreshes an expired token once, stores the replacement at once, and the old refresh token is spent", async () => {
    const first = await connect();
    const store = new MemoryStore({ ...first, expiresAt: Date.now() - 1 });
    const tm = new TokenManager(cfg, store);
    const access = await tm.accessToken();
    expect(access).not.toBe(first.accessToken);
    expect(store.sets).toBe(1);
    expect(store.tokens!.refreshToken).not.toBe(first.refreshToken);
    // Reusing the spent token revokes the grant, exactly the failure the single owner avoids.
    const stale = new TokenManager(cfg, new MemoryStore({ ...first, expiresAt: 0 }));
    await expect(stale.accessToken()).rejects.toBeInstanceOf(ReconnectRequired);
    const again = new TokenManager(cfg, new MemoryStore({ ...store.tokens!, expiresAt: 0 }));
    await expect(again.accessToken()).rejects.toBeInstanceOf(ReconnectRequired); // grant is revoked now
  });

  it("shares one refresh between concurrent requests", async () => {
    const first = await connect();
    const store = new MemoryStore({ ...first, expiresAt: 0 });
    const tm = new TokenManager(cfg, store);
    const before = mock.requests.filter((r) => (r.body as Record<string, string>).grant_type === "refresh_token").length;
    const tokens = await Promise.all([tm.accessToken(), tm.accessToken(), tm.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    const after = mock.requests.filter((r) => (r.body as Record<string, string>).grant_type === "refresh_token").length;
    expect(after - before).toBe(1);
  });

  it("forgets the connection and asks to reconnect when there is no refresh token or no tokens", async () => {
    const store = new MemoryStore({ accessToken: "a", refreshToken: null, expiresAt: 0, connectedAt: 0 });
    await expect(new TokenManager(cfg, store).accessToken()).rejects.toBeInstanceOf(ReconnectRequired);
    expect(store.tokens).toBeNull();
    await expect(new TokenManager(cfg, new MemoryStore(null)).accessToken()).rejects.toBeInstanceOf(ReconnectRequired);
  });
});

describe("sealed cookies", () => {
  it("round-trips, expires, and rejects tampering or another purpose", () => {
    const sealed = seal({ a: 1 }, SECRET, "state", 60, 1_000);
    expect(unseal(sealed, SECRET, "state", 2_000)).toEqual({ a: 1 });
    expect(unseal(sealed, SECRET, "state", 1_000 + 61_000)).toBeNull();
    expect(unseal(sealed, SECRET, "session", 2_000)).toBeNull();
    expect(unseal(sealed, "y".repeat(40), "state", 2_000)).toBeNull();
    const parts = sealed.split(".");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "BB" : "AA");
    expect(unseal(parts.join("."), SECRET, "state", 2_000)).toBeNull();
    expect(unseal(undefined, SECRET, "state")).toBeNull();
  });
  it("does not leak the plaintext", () => {
    expect(seal({ refresh: "rt_secret_value" }, SECRET, "session", 60)).not.toContain("rt_secret_value");
  });
});
