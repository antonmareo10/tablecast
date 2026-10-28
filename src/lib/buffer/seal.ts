// Sealed cookies: AES-256-GCM over a small JSON document, key derived from SESSION_SECRET. Works on serverless
// (no server-side session store), tamper-evident, and expires on its own. Used for the OAuth state and for the
// token session.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "tablecast-buffer", `seal:${purpose}`, 32));
}

export function seal(data: unknown, secret: string, purpose: string, ttlSeconds: number, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const body = JSON.stringify({ exp: now + ttlSeconds * 1000, data });
  const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), Buffer.concat([ct, cipher.getAuthTag()]).toString("base64url")].join(".");
}

/** The document, or null when the value is missing, forged, from another purpose or expired. */
export function unseal<T>(token: string | undefined | null, secret: string, purpose: string, now = Date.now()): T | null {
  if (!token) return null;
  const [v, ivText, bodyText] = token.split(".");
  if (v !== VERSION || !ivText || !bodyText) return null;
  try {
    const raw = Buffer.from(bodyText, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(secret, purpose), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(text) as { exp: number; data: T };
    return typeof parsed.exp === "number" && parsed.exp > now ? parsed.data : null;
  } catch {
    return null;
  }
}
