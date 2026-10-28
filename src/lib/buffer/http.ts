// Shared bits of the /api/buffer routes: one place that turns the library's errors into clear JSON answers.

import { BufferApiError } from "./client";
import { ConfigError } from "./config";
import { OAuthError, ReconnectRequired } from "./oauth";

export function errorResponse(err: unknown): Response {
  if (err instanceof ConfigError) return Response.json({ error: "not_configured", message: err.message }, { status: 503 });
  if (err instanceof ReconnectRequired) return Response.json({ error: "reconnect", message: err.message }, { status: 401 });
  if (err instanceof BufferApiError && err.kind === "rate_limit") {
    return Response.json({ error: "rate_limit", message: err.message, retryAfter: err.retryAfter ?? null }, { status: 429, headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {} });
  }
  if (err instanceof BufferApiError) return Response.json({ error: "buffer", message: err.message }, { status: 502 });
  if (err instanceof OAuthError) return Response.json({ error: "oauth", message: err.message }, { status: 502 });
  console.error(JSON.stringify({ event: "buffer_route_error", message: err instanceof Error ? err.message : String(err) }));
  return Response.json({ error: "internal", message: "Something went wrong on our side." }, { status: 500 });
}

/** A same-origin check for state-changing requests (cookies are SameSite=Lax, this is the second lock). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The public https origin Buffer can reach for images. */
export function publicOrigin(request: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
