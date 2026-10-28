// Buffer OAuth 2.0 Authorization Code with PKCE (S256).
// Flow: /api/buffer/login makes a verifier and a state, seals them in an HttpOnly cookie and redirects to
// auth.buffer.com; /api/buffer/callback checks the state, swaps the code (plus the verifier) for tokens.
// Refresh tokens rotate and are single use: reusing an old one revokes the grant, so exactly one component
// (TokenManager) ever refreshes, and the replacement is stored before anything else happens.

import { createHash, randomBytes } from "node:crypto";
import type { BufferConfig } from "./config";

export type Tokens = {
  accessToken: string;
  refreshToken: string | null;
  scope?: string;
  expiresAt: number; // epoch ms, with a safety margin already taken off
  connectedAt: number;
  accountId?: string;
};

/** The owner has to connect again (no tokens, expired grant, revoked, 401 from the API, disconnected channel). */
export class ReconnectRequired extends Error {
  readonly status = 401;
  constructor(message = "Your Buffer connection ended. Connect again to continue.") {
    super(message);
  }
}

export class OAuthError extends Error {
  constructor(message: string, readonly oauthError?: string, readonly httpStatus?: number) {
    super(message);
  }
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(16).toString("base64url");
}

export function buildAuthorizeUrl(cfg: BufferConfig, p: { state: string; codeChallenge: string }): string {
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  return url.toString();
}

const HINTS: Record<string, string> = {
  invalid_client: "check BUFFER_CLIENT_ID and BUFFER_CLIENT_SECRET (a private client needs the secret)",
  invalid_grant: "the code or refresh token was already used or expired, or redirect_uri differs from the authorize request",
  invalid_scope: "a requested scope is not enabled on this app client",
  unsupported_grant_type: "this client may not use that grant type",
};

type FetchLike = typeof fetch;

async function requestTokens(cfg: BufferConfig, params: Record<string, string>, f: FetchLike, now: number, previous?: Tokens): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: cfg.clientId, ...params });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const res = await f(cfg.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.error) {
    const code = typeof json.error === "string" ? json.error : undefined;
    const detail = (typeof json.error_description === "string" && json.error_description) || code || `HTTP ${res.status}`;
    const hint = code ? HINTS[code] : undefined;
    throw new OAuthError(hint ? `${detail}: ${hint}` : detail, code, res.status);
  }
  if (typeof json.access_token !== "string") throw new OAuthError("The token response had no access_token", undefined, res.status);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    scope: typeof json.scope === "string" ? json.scope : previous?.scope,
    expiresAt: now + (Number(json.expires_in) || 3600) * 1000 - 60_000,
    connectedAt: previous?.connectedAt ?? now,
    accountId: previous?.accountId,
  };
}

export async function exchangeCode(cfg: BufferConfig, p: { code: string; codeVerifier: string }, f: FetchLike = fetch, now = Date.now()): Promise<Tokens> {
  const tokens = await requestTokens(cfg, { grant_type: "authorization_code", code: p.code, redirect_uri: cfg.redirectUri, code_verifier: p.codeVerifier }, f, now);
  if (!tokens.refreshToken) throw new OAuthError("Buffer returned no refresh token: enable offline_access for this app client");
  return tokens;
}

export async function refreshTokens(cfg: BufferConfig, previous: Tokens, f: FetchLike = fetch, now = Date.now()): Promise<Tokens> {
  if (!previous.refreshToken) throw new ReconnectRequired();
  const next = await requestTokens(cfg, { grant_type: "refresh_token", refresh_token: previous.refreshToken }, f, now, previous);
  // A rotating flow must hand back a replacement; carrying on with the old one would be unsafe.
  if (!next.refreshToken) throw new OAuthError("Buffer returned no replacement refresh token");
  return next;
}

/** Where a request's tokens live (a sealed cookie in the app, a variable in the tests). */
export interface TokenStore {
  get(): Promise<Tokens | null> | Tokens | null;
  set(tokens: Tokens): Promise<void> | void;
  clear(): Promise<void> | void;
}

// One refresh per refresh token at a time inside this process: concurrent requests share the same promise instead
// of spending the single-use token twice. (Across serverless instances the cookie cannot coordinate; the app keeps
// to one browser-side caller, see docs/BUFFER_API_NOTES.md.)
const inflight = new Map<string, Promise<Tokens>>();

export class TokenManager {
  constructor(
    private readonly cfg: BufferConfig,
    private readonly store: TokenStore,
    private readonly f: FetchLike = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A valid access token, refreshing first when it is about to expire. Throws ReconnectRequired when it cannot. */
  async accessToken(): Promise<string> {
    const tokens = await this.store.get();
    if (!tokens) throw new ReconnectRequired("Not connected to Buffer.");
    if (this.clock() < tokens.expiresAt) return tokens.accessToken;
    return (await this.refresh(tokens)).accessToken;
  }

  /** The access token was refused (401): forget the connection. */
  async rejected(): Promise<void> {
    await this.store.clear();
  }

  private async refresh(tokens: Tokens): Promise<Tokens> {
    const id = tokens.refreshToken;
    if (!id) {
      await this.store.clear();
      throw new ReconnectRequired("Your Buffer session expired. Connect again to continue.");
    }
    let run = inflight.get(id);
    if (!run) {
      run = (async () => {
        try {
          const next = await refreshTokens(this.cfg, tokens, this.f, this.clock());
          await this.store.set(next); // the replacement is saved at once
          return next;
        } catch (err) {
          if (err instanceof OAuthError && (err.oauthError || err.httpStatus === 400 || err.httpStatus === 401)) {
            await this.store.clear();
            throw new ReconnectRequired("Your Buffer session expired. Connect again to continue.");
          }
          throw err; // network trouble: keep the tokens, the caller can retry
        } finally {
          inflight.delete(id);
        }
      })();
      inflight.set(id, run);
    }
    return run;
  }
}
