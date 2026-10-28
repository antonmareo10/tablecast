// Public image URLs without external storage.
// Buffer has no upload endpoint: it downloads the image from a public HTTPS URL when the post goes out, hours or
// days after the post is created. So the URL must not expire. It carries the post's image spec and an HMAC of it;
// /api/post-image verifies the signature and draws the PNG on the server. The URL stays valid for as long as this
// deploy (and its secret) lives. No signing time, no expiry, nothing stored.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImageSpec } from "./post-writer";

const TONES = new Set(["rain", "sun", "event", "dish"]);
const MAX = { restaurant: 60, kicker: 30, headline: 70, detail: 140 } as const;

/** The fields that get drawn, trimmed so the URL stays short and the layout never overflows. */
export function normalizeSpec(s: ImageSpec): ImageSpec {
  const cut = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v);
  return {
    restaurant: cut(String(s.restaurant ?? ""), MAX.restaurant),
    kicker: cut(String(s.kicker ?? ""), MAX.kicker),
    headline: cut(String(s.headline ?? ""), MAX.headline),
    detail: cut(String(s.detail ?? ""), MAX.detail),
    tone: TONES.has(s.tone) ? s.tone : "dish",
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`post-image.v1.${payload}`).digest("base64url");
}

/** Path (and query) of the signed image for a spec. Prefix it with the deploy's origin. */
export function signedImagePath(spec: ImageSpec, secret: string): string {
  const d = Buffer.from(JSON.stringify(normalizeSpec(spec)), "utf8").toString("base64url");
  return `/api/post-image?d=${d}&sig=${sign(d, secret)}`;
}

/** The spec when the signature is valid, else null. */
export function verifyImage(d: string | null, sig: string | null, secret: string): ImageSpec | null {
  if (!d || !sig || d.length > 2000) return null;
  const expected = Buffer.from(sign(d, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as ImageSpec;
    return normalizeSpec(parsed);
  } catch {
    return null;
  }
}

export function imageSecret(env: Record<string, string | undefined> = process.env): string {
  const s = (env.IMAGE_SIGNING_SECRET || env.SESSION_SECRET || "").trim();
  if (s.length < 32) throw new Error("IMAGE_SIGNING_SECRET (or SESSION_SECRET) must be at least 32 characters.");
  return s;
}

/** Absolute URL Buffer can fetch. `origin` is the public https origin of this deploy. */
export function signedImageUrl(origin: string, spec: ImageSpec, secret: string): string {
  return `${origin.replace(/\/$/, "")}${signedImagePath(spec, secret)}`;
}
