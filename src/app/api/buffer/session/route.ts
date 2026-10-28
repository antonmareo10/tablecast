import { ReconnectRequired } from "@/lib/buffer/oauth";
import { errorResponse } from "@/lib/buffer/http";
import { CookieTokenStore, requestClient } from "@/lib/buffer/session";
import { bufferConfig } from "@/lib/buffer/config";

// Who is connected and which channels they have (with time zone). Costs no API call when the cache is warm.
export async function GET() {
  try {
    const cfg = bufferConfig();
    const tokens = await new CookieTokenStore(cfg).get();
    if (!tokens) return Response.json({ connected: false });
    const { client } = requestClient(cfg, tokens.accountId);
    const organizations = await client.organizations();
    const channels = organizations[0] ? await client.channels(organizations[0].id) : [];
    return Response.json({ connected: true, organizations, channels, rate: client.rate });
  } catch (err) {
    if (err instanceof ReconnectRequired) return Response.json({ connected: false, reason: err.message });
    return errorResponse(err);
  }
}

// Disconnect: forget the tokens on this browser.
export async function DELETE() {
  try {
    await new CookieTokenStore(bufferConfig()).clear();
    return Response.json({ connected: false });
  } catch (err) {
    return errorResponse(err);
  }
}
