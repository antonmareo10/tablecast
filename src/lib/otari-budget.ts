// Per-restaurant budgets on Otari: each restaurant is an Otari end user of the app's service key, with its own spend
// and its own copy of the weekly end-user budget (docs/OTARI_SETUP.md). The app names it on every request (`user`),
// reads where it stands before a run (so a restaurant that cannot afford a plan is told so before anything is spent),
// and reads it again after the run to show what Otari billed it.
//
// Field names of the end-user routes are read defensively: the docs list what the routes return (budget, counters,
// blocked) but the app only relies on a spend figure and a limit when they are there.

import { otariJSON } from "./otari";

export type EndUserBudget = { id: string; name?: string; max_budget?: number | null; period?: string; end_users?: number };
export type EndUserStatus = {
  external_id: string;
  budget_id?: string;
  spend?: number; // USD spent in the current period
  max_budget?: number | null; // the period's limit
  resets_at?: string;
  blocked?: boolean;
};

let serviceKey: { at: number; enabled: boolean; budgets: EndUserBudget[] } | null = null;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function first(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function parseBudget(raw: Record<string, unknown>): EndUserBudget {
  const b = (raw.budget && typeof raw.budget === "object" ? raw.budget : raw) as Record<string, unknown>;
  return {
    id: String(first(raw, ["budget_id", "id"]) ?? first(b, ["budget_id", "id"]) ?? ""),
    name: str(first(b, ["name", "budget_name"])),
    max_budget: num(first(b, ["max_budget", "limit", "max_budget_usd"])) ?? null,
    period: str(first(b, ["reset_alignment", "budget_duration", "period", "resets"])),
    end_users: num(first(raw, ["end_user_count", "user_count"])),
  };
}

export function parseEndUser(raw: Record<string, unknown>, externalId: string): EndUserStatus {
  const budget = raw.budget && typeof raw.budget === "object" ? (raw.budget as Record<string, unknown>) : {};
  return {
    external_id: str(raw.external_id) ?? externalId,
    budget_id: str(first(raw, ["budget_id"])) ?? str(first(budget, ["budget_id", "id"])),
    spend: num(first(raw, ["spend", "spend_usd", "current_spend", "period_spend", "total_spend"])) ?? num(first(budget, ["spend", "current_spend"])),
    max_budget: num(first(raw, ["max_budget", "budget_limit"])) ?? num(first(budget, ["max_budget", "limit"])) ?? null,
    resets_at: str(first(raw, ["next_budget_reset_at", "budget_reset_at", "resets_at", "period_end", "reset_at"])) ?? str(first(budget, ["budget_reset_at", "resets_at"])),
    blocked: typeof raw.blocked === "boolean" ? raw.blocked : undefined,
  };
}

/**
 * Whether the app's key is a service key that may name end users (GET /v1/end-user-budgets answers only a service
 * key), and the budgets its end users start on. Cached 10 minutes; any failure means "no".
 */
export async function endUsersEnabled(signal?: AbortSignal): Promise<{ enabled: boolean; budgets: EndUserBudget[] }> {
  if (process.env.OTARI_END_USERS === "off") return { enabled: false, budgets: [] };
  if (serviceKey && Date.now() - serviceKey.at < 600_000) return serviceKey;
  try {
    const { data } = await otariJSON<unknown>("/v1/end-user-budgets", { method: "GET", signal, timeoutMs: 10_000 });
    const list = (Array.isArray(data) ? data : ((data as { data?: unknown[]; budgets?: unknown[] }).data ?? (data as { budgets?: unknown[] }).budgets ?? [])) as Record<string, unknown>[];
    serviceKey = { at: Date.now(), enabled: true, budgets: list.map(parseBudget) };
  } catch {
    serviceKey = { at: Date.now(), enabled: false, budgets: [] };
  }
  return serviceKey;
}

export function resetEndUserCache(): void {
  serviceKey = null;
}

/** Where one restaurant stands on Otari: its budget, its spend this period. Null if it has never made a request. */
export async function endUserStatus(externalId: string, signal?: AbortSignal): Promise<EndUserStatus | null> {
  const { data } = await otariJSON<unknown>(`/v1/end-users?external_id=${encodeURIComponent(externalId)}`, { method: "GET", signal, timeoutMs: 10_000 });
  const list = (Array.isArray(data) ? data : ((data as { data?: unknown[]; end_users?: unknown[] }).data ?? (data as { end_users?: unknown[] }).end_users ?? [])) as Record<string, unknown>[];
  const row = list[0];
  return row ? parseEndUser(row, externalId) : null;
}

/** What a run is expected to cost at most, to refuse it before research when the restaurant cannot cover it. */
export function runEstimateUsd(): number {
  const v = Number(process.env.OTARI_RUN_ESTIMATE_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.12;
}

/** The restaurant's budget line as the app shows it, from Otari's end-user record and the key's budget list. */
export function budgetLine(status: EndUserStatus | null, budgets: EndUserBudget[]): { spend: number; limit: number | null; budget?: string; period?: string } {
  const b = budgets.find((x) => x.id && x.id === status?.budget_id) ?? budgets[0];
  return {
    spend: status?.spend ?? 0,
    limit: status?.max_budget ?? b?.max_budget ?? null,
    ...(b?.name || b?.id ? { budget: b.name ?? b.id } : {}),
    ...(b?.period ? { period: b.period } : {}),
  };
}
