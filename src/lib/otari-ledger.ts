// A hard local spending cap for development, on top of Otari's own budgets.
//
// Every Otari request made from this machine is appended to a JSON-lines ledger outside the repository, with the cost
// Otari reported for it (usage.cost_usd) or, when it reports none inline, a conservative estimate. Before each request
// the ledger is summed, and once the total reaches the cap the request is refused here, before it leaves the machine.
//
// On by default outside Vercel: ~/data/otari/usage.jsonl, capped at $6 (OTARI_LOCAL_CAP_USD). Set
// OTARI_LOCAL_LEDGER=off to disable it, or another path to move it. On a Vercel deployment it is off: the key's
// Otari budget is the cap there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// What one request is assumed to cost when Otari does not report it inline (a search, an MCP call, code execution,
// a stream cut before its usage chunk). Deliberately on the high side so the cap errs on the safe side.
export const DEFAULT_ESTIMATE_USD = 0.01;

export class LocalCapError extends Error {
  readonly spent: number;
  readonly cap: number;
  constructor(spent: number, cap: number) {
    super(`Local Otari spending cap reached: $${spent.toFixed(4)} recorded of $${cap.toFixed(2)} (OTARI_LOCAL_CAP_USD). No request was sent.`);
    this.name = "LocalCapError";
    this.spent = spent;
    this.cap = cap;
  }
}

export function isLocalCapError(err: unknown): err is LocalCapError {
  return err instanceof LocalCapError || (err instanceof Error && err.name === "LocalCapError");
}

export function ledgerPath(): string | null {
  const v = process.env.OTARI_LOCAL_LEDGER;
  if (v === "off" || v === "0") return null;
  if (v) return v;
  if (process.env.VERCEL || process.env.VITEST) return null;
  return path.join(os.homedir(), "data", "otari", "usage.jsonl");
}

export function localCapUsd(): number {
  const v = Number(process.env.OTARI_LOCAL_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 6;
}

export type LedgerEntry = {
  path: string;
  role?: string;
  model?: string;
  request_id?: string;
  cost_usd: number | null; // Otari's figure, when it gave one
  estimate_usd?: number; // what we assume instead, when it did not
  note?: string;
};

let cached: { file: string; size: number; total: number } | null = null;

/** Total recorded in the ledger (Otari's costs, plus estimates where it reported none). */
export function ledgerTotal(file = ledgerPath()): number {
  if (!file) return 0;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  if (cached && cached.file === file && cached.size === size) return cached.total;
  let total = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      total += e.cost_usd ?? e.estimate_usd ?? DEFAULT_ESTIMATE_USD;
    } catch {
      total += DEFAULT_ESTIMATE_USD; // a damaged line still counts
    }
  }
  cached = { file, size, total };
  return total;
}

export function assertUnderLocalCap(): void {
  const file = ledgerPath();
  if (!file) return;
  const spent = ledgerTotal(file);
  const cap = localCapUsd();
  if (spent >= cap) throw new LocalCapError(spent, cap);
}

export function recordLocalSpend(entry: LedgerEntry): void {
  const file = ledgerPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    console.warn(`[otari-ledger] could not write ${file}: ${err instanceof Error ? err.message : err}`);
  }
}
