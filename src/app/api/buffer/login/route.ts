import { bufferConfig } from "@/lib/buffer/config";
import { errorResponse } from "@/lib/buffer/http";
import { buildAuthorizeUrl, createPkcePair, createState } from "@/lib/buffer/oauth";
import { setOAuthFlow } from "@/lib/buffer/session";

// Starts the Buffer sign-in: a PKCE verifier and a state go into a sealed HttpOnly cookie, only the challenge goes to Buffer.
export async function GET() {
  try {
    const cfg = bufferConfig();
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    await setOAuthFlow(cfg, { state, verifier });
    return Response.redirect(buildAuthorizeUrl(cfg, { state, codeChallenge: challenge }), 302);
  } catch (err) {
    return errorResponse(err);
  }
}
