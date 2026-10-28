// Buffer app-client settings, read from the environment when asked for (never at import time, so the build and
// the tests do not need keys). The client ID and secret come from .env.local or the host's settings; they are
// never logged or sent to the browser.

export type BufferConfig = {
  clientId: string;
  clientSecret: string | null; // private client: sent in the form body (the server advertises client_secret_post)
  redirectUri: string;
  scopes: string;
  authUrl: string;
  tokenUrl: string;
  apiUrl: string;
  sessionSecret: string;
};

// Only what the code really calls: account:read (account, organizations, channels), posts:read (the queue),
// posts:write (createPost, editPost, deletePost, createTag), offline_access (refresh token).
export const BUFFER_SCOPES = "account:read posts:read posts:write offline_access";

export class ConfigError extends Error {}

const PROD_AUTH_URL = "https://auth.buffer.com/auth";
const PROD_TOKEN_URL = "https://auth.buffer.com/token";
const PROD_API_URL = "https://api.buffer.com";

export function bufferConfig(env: Record<string, string | undefined> = process.env): BufferConfig {
  const clientId = env.BUFFER_CLIENT_ID?.trim();
  if (!clientId) throw new ConfigError("BUFFER_CLIENT_ID is not set. Create an app client at https://publish.buffer.com/settings/api.");
  const sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (sessionSecret.length < 32) throw new ConfigError("SESSION_SECRET must be at least 32 characters (openssl rand -hex 32).");
  const redirectUri = env.BUFFER_REDIRECT_URI?.trim() || defaultRedirectUri(env);
  if (!redirectUri) throw new ConfigError("BUFFER_REDIRECT_URI is not set and no default exists for this deployment.");
  // Endpoint overrides exist only to point the tests and local development at a mock; they are ignored in production.
  const allowOverride = env.NODE_ENV !== "production";
  return {
    clientId,
    clientSecret: env.BUFFER_CLIENT_SECRET?.trim() || null,
    redirectUri,
    scopes: BUFFER_SCOPES,
    authUrl: (allowOverride && env.BUFFER_AUTH_URL) || PROD_AUTH_URL,
    tokenUrl: (allowOverride && env.BUFFER_TOKEN_URL) || PROD_TOKEN_URL,
    apiUrl: (allowOverride && env.BUFFER_API_URL) || PROD_API_URL,
    sessionSecret,
  };
}

/** Buffer matches redirect URIs character by character, so the default is the one registered for this host. */
export function defaultRedirectUri(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV) {
    return env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/api/buffer/callback`
      : null; // a preview cannot read the production host's cookie, so login stays off there
  }
  return "https://localhost:3000/api/buffer/callback";
}
