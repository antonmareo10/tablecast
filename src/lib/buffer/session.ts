// Next.js glue: the sealed cookies and a ready-to-use client for one request.
// The token pair lives in a sealed HttpOnly cookie (never in page JavaScript), split over a few cookies when it
// does not fit in one (browsers keep about 4 KB per cookie).

import { cookies } from "next/headers";
import { bufferConfig, type BufferConfig } from "./config";
import { BufferClient, TtlCache } from "./client";
import { TokenManager, type Tokens, type TokenStore } from "./oauth";
import { seal, unseal } from "./seal";

const SESSION = "tc_buf";
const OAUTH = "tc_oauth";
const CHUNK = 3000;
const MAX_CHUNKS = 4;
const SESSION_TTL = 30 * 24 * 3600;

const base = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

export type OAuthFlow = { state: string; verifier: string };

export async function setOAuthFlow(cfg: BufferConfig, flow: OAuthFlow) {
  (await cookies()).set(OAUTH, seal(flow, cfg.sessionSecret, "oauth", 600), { ...base, maxAge: 600 });
}

export async function takeOAuthFlow(cfg: BufferConfig): Promise<OAuthFlow | null> {
  const jar = await cookies();
  const flow = unseal<OAuthFlow>(jar.get(OAUTH)?.value, cfg.sessionSecret, "oauth");
  jar.delete(OAUTH); // one try per login
  return flow;
}

export class CookieTokenStore implements TokenStore {
  constructor(private readonly cfg: BufferConfig) {}

  async get(): Promise<Tokens | null> {
    const jar = await cookies();
    let joined = "";
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const part = jar.get(`${SESSION}_${i}`)?.value;
      if (!part) break;
      joined += part;
    }
    return unseal<Tokens>(joined, this.cfg.sessionSecret, "session");
  }

  async set(tokens: Tokens): Promise<void> {
    const jar = await cookies();
    const sealed = seal(tokens, this.cfg.sessionSecret, "session", SESSION_TTL);
    const parts = sealed.match(new RegExp(`.{1,${CHUNK}}`, "g")) ?? [];
    if (parts.length > MAX_CHUNKS) throw new Error("The Buffer session is too large to store in cookies.");
    parts.forEach((p, i) => jar.set(`${SESSION}_${i}`, p, { ...base, maxAge: SESSION_TTL }));
    for (let i = parts.length; i < MAX_CHUNKS; i++) jar.delete(`${SESSION}_${i}`);
  }

  async clear(): Promise<void> {
    const jar = await cookies();
    for (let i = 0; i < MAX_CHUNKS; i++) jar.delete(`${SESSION}_${i}`);
  }
}

/** Config, token store and a client for this request. Throws ConfigError when the app client is not set up. */
export function requestClient(cfg: BufferConfig = bufferConfig(), accountId?: string) {
  const store = new CookieTokenStore(cfg);
  const tokens = new TokenManager(cfg, store);
  // The shared cache is keyed by Buffer account. Without a known account nothing is cached, so two owners can never see each other's data.
  const client = new BufferClient({ apiUrl: cfg.apiUrl, tokens, accountKey: accountId ?? "unknown", ...(accountId ? {} : { cache: new TtlCache(0) }) });
  return { cfg, store, tokens, client };
}
