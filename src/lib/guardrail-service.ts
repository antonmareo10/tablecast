// HTTP side of Tablecast's guardrails service (see injection-detector.ts): the two calls of Otari's guardrails
// contract. Otari reaches it at TABLECAST_GUARDRAIL_URL, which ends in a secret path segment (Otari's per-request
// guardrail entry has a `url` but no credential field, so the secret lives in the path).

import { timingSafeEqual } from "node:crypto";
import { detectInjection, GUARD_MODEL, PROFILE } from "./injection-detector";

const PER_HOUR = Number(process.env.GUARDRAIL_CHECKS_PER_HOUR || 3000);
let window: { start: number; count: number } = { start: Date.now(), count: 0 };

export function tokenOk(got: string | undefined): boolean {
  const want = process.env.TABLECAST_GUARDRAIL_TOKEN;
  if (!want || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET <url>/profiles: what this service offers, in the shape Otari's dashboard reads. */
export function profilesResponse(token: string | undefined): Response {
  if (!process.env.TABLECAST_GUARDRAIL_TOKEN) return Response.json({ error: "not configured" }, { status: 503 });
  if (!tokenOk(token)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json([{ name: PROFILE, guardrail_name: "tablecast_prompt_injection", model_id: GUARD_MODEL }]);
}

/** POST <url>/validate {profile, input_text, validate_kwargs} → {profile, result: {valid, explanation, score}}. */
export async function validateResponse(request: Request, token: string | undefined): Promise<Response> {
  if (!process.env.TABLECAST_GUARDRAIL_TOKEN) return Response.json({ error: "not configured" }, { status: 503 });
  if (!tokenOk(token)) return Response.json({ error: "not found" }, { status: 404 });
  if (Date.now() - window.start > 3_600_000) window = { start: Date.now(), count: 0 };
  if (++window.count > PER_HOUR) return Response.json({ error: "rate limited" }, { status: 429 });
  let body: { profile?: unknown; input_text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const profile = typeof body.profile === "string" ? body.profile : PROFILE;
  const text = typeof body.input_text === "string" ? body.input_text : "";
  if (profile !== PROFILE) return Response.json({ profile, result: { valid: null, explanation: `unknown profile ${profile}`, score: null } });
  if (!text.trim()) return Response.json({ profile, result: { valid: true, explanation: null, score: 0 } });
  const v = await detectInjection(text, request.signal);
  return Response.json({ profile, result: { valid: v.valid, explanation: v.explanation, score: v.score } }, { headers: { "cache-control": "no-store" } });
}
