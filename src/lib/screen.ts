// Otari guardrails on fetched web content: no page or search result reaches the writer unless Otari's
// prompt-injection guardrail passed it.
//
// Otari runs a guardrail on a request's input before the provider is called. The only way for an app holding an API
// key to have a piece of text checked is therefore a completion that carries it, so each source is sent alone, as the
// whole input of a one-token request to a small open-weight model, with the guardrail in block mode:
//   • flagged   → Otari refuses with 403 guardrail_violation and never calls the model (nothing is billed); the source
//                 is withheld and listed under Proof.
//   • passed    → the Otari-Guardrails header says evaluated / valid: true; the source is kept.
//   • unscreened → the guardrail could not run (on_unavailable: monitor lets the request through, and the header says
//                 unavailable). The source is kept and marked as unscreened, never silently passed.
// What is screened is exactly what the writer will see of the source (its first characters, by kind).

import { chatCompletion, isOtariError, otariJSON, type GuardrailVerdict } from "./otari";

export const SCREEN_MODEL = process.env.OTARI_SCREEN_MODEL || "mistralai/ministral-3-3b";
export const GUARDRAIL_PROFILE = process.env.OTARI_GUARDRAIL_PROFILE || "prompt-injection";
const CHUNK = 2_000;

export type Screen = {
  verdict: "passed" | "flagged" | "unscreened";
  reason?: string; // why it is unscreened (not_configured, evaluation_failed, an error)
  score?: number | null;
  calls: number;
  cost_usd: number;
  ms: number;
};

let profiles: { at: number; available: boolean; names: string[] } | null = null;

/** Whether the deployment's guardrails service offers the profile (GET /v1/tool-settings/guardrails/profiles), cached 10 min. */
export async function guardrailAvailable(signal?: AbortSignal): Promise<{ available: boolean; profile: string; names: string[] }> {
  if (process.env.OTARI_GUARDRAILS === "off") return { available: false, profile: GUARDRAIL_PROFILE, names: [] };
  if (!profiles || Date.now() - profiles.at > 600_000) {
    try {
      const { data } = await otariJSON<{ available?: boolean; profiles?: { profile?: string; name?: string }[] }>("/v1/tool-settings/guardrails/profiles", {
        method: "GET",
        signal,
        timeoutMs: 10_000,
      });
      const names = (data.profiles ?? []).map((p) => p.profile ?? p.name ?? "").filter(Boolean);
      profiles = { at: Date.now(), available: !!data.available && names.includes(GUARDRAIL_PROFILE), names };
    } catch {
      // The listing failed: try the guardrail anyway; each request reports for itself whether it ran.
      profiles = { at: Date.now(), available: true, names: [] };
    }
  }
  return { available: profiles.available, profile: GUARDRAIL_PROFILE, names: profiles.names };
}

export function resetGuardrailCache(): void {
  profiles = null;
}

function verdictOf(entries: GuardrailVerdict[] | undefined): Pick<Screen, "verdict" | "reason" | "score"> {
  const e = entries?.find((g) => g.profile === GUARDRAIL_PROFILE) ?? entries?.[0];
  if (!e) return { verdict: "unscreened", reason: "no verdict in Otari-Guardrails" };
  if (e.status === "unavailable") return { verdict: "unscreened", reason: e.reason ?? "unavailable" };
  if (e.valid === false) return { verdict: "flagged", score: e.score }; // only in monitor mode; block mode refuses instead
  return { verdict: "passed", score: e.score ?? null };
}

async function screenChunk(text: string, signal?: AbortSignal): Promise<Pick<Screen, "verdict" | "reason" | "score"> & { cost: number }> {
  try {
    const { served } = await chatCompletion(
      "screen",
      {
        model: SCREEN_MODEL,
        messages: [{ role: "user", content: text }],
        max_tokens: 1,
        temperature: 0,
        guardrails: [{ profile: GUARDRAIL_PROFILE, mode: "block", on_unavailable: "monitor" }],
      },
      { signal, timeoutMs: 20_000 },
    );
    return { ...verdictOf(served.guardrails), cost: served.cost_usd ?? 0 };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (isOtariError(err) && (err.code === "guardrail_violation" || (err.status === 403 && /guardrail/i.test(err.detail)))) return { verdict: "flagged", cost: 0 };
    if (isOtariError(err) && (err.code === "budget_exceeded" || err.status === 401 || err.status === 402)) throw err;
    return { verdict: "unscreened", reason: isOtariError(err) ? `${err.status} ${err.code ?? ""}`.trim() : "error", cost: 0 };
  }
}

/** Screens `text` (cut into chunks the guardrail can read whole); flagged if any chunk is. */
export async function screenText(text: string, signal?: AbortSignal): Promise<Screen> {
  const t0 = Date.now();
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < 4; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  if (!chunks.length) return { verdict: "passed", calls: 0, cost_usd: 0, ms: 0 };
  const results = await Promise.all(chunks.map((c) => screenChunk(c, signal)));
  const cost = results.reduce((n, r) => n + r.cost, 0);
  const flagged = results.find((r) => r.verdict === "flagged");
  const unscreened = results.find((r) => r.verdict === "unscreened");
  const pick = flagged ?? unscreened ?? results[0];
  const score = results.map((r) => r.score).filter((s): s is number => typeof s === "number");
  return {
    verdict: pick.verdict,
    ...(pick.reason ? { reason: pick.reason } : {}),
    ...(score.length ? { score: Math.max(...score) } : {}),
    calls: chunks.length,
    cost_usd: cost,
    ms: Date.now() - t0,
  };
}

/** A tally of one run's screening, for the engine room and the Proof section. */
export class ScreenLog {
  screened = 0;
  passed = 0;
  unscreened = 0;
  calls = 0;
  cost = 0;
  ms = 0;
  readonly flagged: { url?: string; title: string }[] = [];
  readonly reasons = new Set<string>();
  add(s: Screen, source: { url?: string; title: string }) {
    this.screened += 1;
    this.calls += s.calls;
    this.cost += s.cost_usd;
    this.ms += s.ms;
    if (s.verdict === "passed") this.passed += 1;
    else if (s.verdict === "flagged") this.flagged.push(source);
    else {
      this.unscreened += 1;
      if (s.reason) this.reasons.add(s.reason);
    }
  }
}
