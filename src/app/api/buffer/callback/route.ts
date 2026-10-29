import { BufferClient, TtlCache } from "@/lib/buffer/client";
import { bufferConfig } from "@/lib/buffer/config";
import { errorResponse } from "@/lib/buffer/http";
import { exchangeCode, TokenManager } from "@/lib/buffer/oauth";
import { CookieTokenStore, takeOAuthFlow } from "@/lib/buffer/session";

// Where Buffer sends the owner back. Checks the state against the sealed cookie, swaps the code for tokens
// (the verifier is revealed only here), reads the account once, and stores the session.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (reason: string) => Response.redirect(new URL(`/week?buffer=${reason}`, url), 302);
  try {
    const cfg = bufferConfig();
    const flow = await takeOAuthFlow(cfg);
    const denied = url.searchParams.get("error");
    if (denied) return back(denied === "access_denied" ? "denied" : "error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!flow || !code || !state || state !== flow.state) return back("state"); // the "Invalid state parameter" case, named

    const tokens = await exchangeCode(cfg, { code, codeVerifier: flow.verifier });
    const store = new CookieTokenStore(cfg);
    await store.set(tokens);
    const client = new BufferClient({ apiUrl: cfg.apiUrl, tokens: new TokenManager(cfg, store), accountKey: "callback", cache: new TtlCache(0) });
    const account = await client.account();
    await store.set({ ...tokens, accountId: account.id });
    return back("connected");
  } catch (err) {
    console.error(JSON.stringify({ event: "buffer_callback_failed", message: err instanceof Error ? err.message : String(err) }));
    if (err instanceof Error && err.name === "ConfigError") return errorResponse(err);
    return back("error");
  }
}
