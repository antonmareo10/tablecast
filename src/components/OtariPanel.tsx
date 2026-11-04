"use client";

// What Otari did in this run, read from the run's own events: the session id to find it in Otari's traces, which model
// and provider served each role (and every fallback), what Otari billed the restaurant against its weekly budget, what
// the prompt-injection guardrail did with the web sources, the pages read through the Tablecast MCP server, and the
// supplier order computed in Otari's code sandbox. Nothing here is estimated: every figure is one Otari reported.

import { useState } from "react";
import type { EngineCall, Playbook } from "@/lib/types";
import type { QuartermasterReport } from "@/lib/quartermaster";
import { IconAlert, IconCheck, IconSpark } from "./icons";
import { Pill, Section } from "./ui";

export type OtariLive = {
  otari?: { run_id: string; api: string; routing: Record<string, string>; missing?: string[]; end_user?: string };
  budget?: { start?: BudgetLine; end?: BudgetLine & { before?: number } };
  screening?: NonNullable<Playbook["verification"]>["screening"];
  quartermaster?: QuartermasterReport;
  mcpReads?: number;
  inProcessReads?: number;
};
export type BudgetLine = { end_user: string; spend: number; limit: number | null; budget?: string; period?: string };

const ROLES: { phase: EngineCall["phase"][]; role: string; what: string }[] = [
  { phase: ["gather"], role: "research", what: "Researcher" },
  { phase: ["synthesize"], role: "write", what: "Writer" },
  { phase: ["verify", "repair"], role: "check", what: "Checker" },
  { phase: ["code"], role: "quartermaster", what: "Quartermaster" },
  { phase: ["vision"], role: "vision", what: "Menu photo" },
  { phase: ["screen"], role: "screen", what: "Guardrail screen" },
];

const usd = (v: number) => (v === 0 ? "$0" : v < 0.0001 ? "<$0.0001" : `$${v.toFixed(4)}`);

function roleRows(calls: EngineCall[]) {
  return ROLES.map((r) => {
    const mine = calls.filter((c) => r.phase.includes(c.phase));
    if (!mine.length) return null;
    const asked = [...new Set(mine.map((c) => c.model))];
    const served = [...new Set(mine.map((c) => c.served?.model ?? "").filter(Boolean))];
    const labels = [...new Set(mine.map((c) => c.label))];
    const providers = [...new Set(mine.flatMap((c) => (c.served?.provider ?? "").split(", ").filter(Boolean)))];
    const fallbacks = mine.reduce((n, c) => n + (c.served?.fallbacks ?? (c.served?.fallback ? 1 : 0)), 0);
    const requests = mine.reduce((n, c) => n + (c.count ?? 1), 0);
    const cost = mine.reduce((n, c) => n + (c.cost_usd ?? 0), 0);
    return { ...r, asked, served, labels, providers, fallbacks, requests, cost };
  }).filter((x): x is NonNullable<typeof x> => !!x);
}

export function OtariPanel({ calls, live }: { calls: EngineCall[]; live: OtariLive }) {
  if (!live.otari && !calls.some((c) => c.served || c.cost_usd != null)) return null;
  const rows = roleRows(calls);
  const inline = calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0);
  const start = live.budget?.start;
  const end = live.budget?.end;
  const billed = end && end.before != null ? end.spend - end.before : null;
  const writer = rows.find((r) => r.role === "write");
  const tieredDown =
    !!writer && writer.asked.includes("tablecast-write") && writer.labels.some((l) => /super/i.test(l)) && !!start?.limit && start.spend / start.limit >= 0.6;
  const s = live.screening;
  const q = live.quartermaster;
  return (
    <Section icon={<IconSpark size={16} />} kicker="Built on Otari" title="What Otari did in this run">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 text-[13px] leading-relaxed text-ink-2">
          {live.otari && (
            <p>
              Session <code className="rounded bg-paper px-1 text-[12px]">{live.otari.run_id}</code>: every request of this run carried it as{" "}
              <code className="text-[12px]">Otari-Conversation-Id</code>, so the whole run is one session in Otari’s agent traces.
              {live.otari.end_user ? (
                <>
                  {" "}
                  It was billed to the end user <code className="rounded bg-paper px-1 text-[12px]">{live.otari.end_user}</code>.
                </>
              ) : null}
            </p>
          )}
          {live.otari?.missing?.length ? (
            <p className="text-terracotta">
              The workspace had no {live.otari.missing.join(", ")} routing polic{live.otari.missing.length > 1 ? "ies" : "y"}: those steps ran on the model’s catalog id.
            </p>
          ) : null}
          {(start || end) && (
            <div className="rounded-xl border border-line bg-paper/50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">This restaurant’s budget on Otari</p>
              {(() => {
                const line = end ?? start;
                if (!line) return null;
                const pct = line.limit ? Math.min(100, (line.spend / line.limit) * 100) : null;
                return (
                  <>
                    <p className="mt-1 font-display text-xl tabular-nums">
                      {usd(line.spend)}
                      {line.limit != null ? <span className="text-sm text-muted"> of ${line.limit.toFixed(2)}</span> : null}
                    </p>
                    {pct != null && (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-2" aria-hidden>
                        <div className={`h-full rounded-full ${pct >= 80 ? "bg-terracotta" : pct >= 60 ? "bg-saffron" : "bg-olive"}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <p className="mt-1.5 text-[12px] text-muted">
                      {line.budget ? `${line.budget}${line.period ? `, ${line.period.replace(/_/g, " ")}` : ""}` : "end-user budget"}
                      {billed != null ? ` · Otari billed this run ${usd(billed)}` : start && !end ? " · before this run" : ""}
                    </p>
                  </>
                );
              })()}
            </div>
          )}
          <p className="text-[12px] text-muted">
            Model calls in this run cost {usd(inline)} by Otari’s own <code>usage.cost_usd</code>
            {billed != null ? "; the restaurant’s end-user record above also counts the searches and tool calls" : ""}.
          </p>
          {tieredDown && (
            <p className="rounded-xl border border-saffron/40 bg-saffron/10 px-3 py-2 text-[12px] text-ink">
              Otari tiered the writer down to {writer?.labels.join(", ")}: this restaurant had used {Math.round(((start?.spend ?? 0) / (start?.limit ?? 1)) * 100)}% of
              its weekly budget, past the 60% rule of tablecast-write.
            </p>
          )}
        </div>
        <ul className="space-y-1.5 text-[13px]" aria-label="Which model served each role">
          {rows.map((r) => (
            <li key={r.role} className="rounded-xl border border-line bg-paper/40 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{r.what}</span>
                <span className="tabular-nums text-muted">
                  {r.requests} request{r.requests === 1 ? "" : "s"} · {usd(r.cost)}
                </span>
              </div>
              <p className="text-[12px] text-ink-2">
                asked <code className="text-[11px]">{r.asked.join(", ")}</code> → {r.labels.join(", ")}
                {r.providers.length ? ` on ${r.providers.join(", ")}` : ""}
              </p>
              {r.fallbacks > 0 && (
                <p className="text-[12px] text-terracotta">
                  {r.fallbacks} answered by a fallback: the policy’s first candidate failed and Otari moved on
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-paper/40 p-3 text-[12px] leading-relaxed text-ink-2">
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
            {s && s.flagged.length ? <IconAlert size={13} className="text-terracotta" /> : <IconCheck size={13} className="text-olive" />} Guardrails
          </p>
          {!s ? (
            "No guardrail report in this run."
          ) : !s.available ? (
            `This Otari deployment offers no ${s.profile} profile, so web sources were not screened.`
          ) : (
            <>
              Otari’s <code>{s.profile}</code> guardrail screened {s.screened} web source{s.screened === 1 ? "" : "s"} before the writer saw them: {s.passed} passed,{" "}
              {s.flagged.length} withheld{s.unscreened ? `, ${s.unscreened} could not be screened (kept, and counted here)` : ""}.
              {s.flagged.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-terracotta">
                  {s.flagged.map((f, i) => (
                    <li key={i}>{f.url ?? f.title}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          <GuardrailCheck />
        </div>
        <div className="rounded-xl border border-line bg-paper/40 p-3 text-[12px] leading-relaxed text-ink-2">
          <p className="mb-1 font-semibold text-ink">Web search and MCP</p>
          {calls.filter((c) => c.phase === "search").length} searches through Otari’s search API.{" "}
          {live.mcpReads
            ? `${live.mcpReads} page${live.mcpReads === 1 ? "" : "s"} read by the Tablecast MCP server, which Otari connected to the researcher inside its tool loop.`
            : live.inProcessReads
              ? `${live.inProcessReads} page read${live.inProcessReads === 1 ? "" : "s"} in-process: no MCP server was configured for this run.`
              : "No page was read beyond the search results."}
        </div>
        <div className="rounded-xl border border-line bg-paper/40 p-3 text-[12px] leading-relaxed text-ink-2">
          <p className="mb-1 font-semibold text-ink">Code execution</p>
          {q ? (
            <>
              The supplier order and break-even were computed by a Python program run in Otari’s sandbox.{" "}
              {q.checks.totals && q.checks.break_even ? <Pill tone="olive">sums checked in code</Pill> : <Pill tone="terracotta">a sum differs from the plan</Pill>}
            </>
          ) : (
            "No sandbox run in this plan."
          )}
        </div>
      </div>
    </Section>
  );
}

type CheckResult = { profile: string; available: boolean; samples: { id: string; label: string; text: string; verdict: string; score: number | null; reason: string | null; ms: number }[] };

/** Sends a clean review and a poisoned copy of it through the same Otari guardrail check, live (/api/guardrail-check). */
function GuardrailCheck() {
  const [state, setState] = useState<{ busy: boolean; result?: CheckResult; error?: string }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    try {
      const res = await fetch("/api/guardrail-check", { method: "POST" });
      const body = (await res.json()) as CheckResult & { error?: string };
      setState(res.ok ? { busy: false, result: body } : { busy: false, error: body.error ?? `HTTP ${res.status}` });
    } catch {
      setState({ busy: false, error: "The check could not reach the server." });
    }
  };
  return (
    <div className="mt-2 border-t border-line pt-2">
      <button
        type="button"
        onClick={run}
        disabled={state.busy}
        className="min-h-8 rounded-full border border-line bg-paper px-3 text-[11px] font-medium text-ink-2 transition-[color,border-color] hover:border-ink-2/40 hover:text-ink disabled:opacity-60"
      >
        {state.busy ? "Asking Otari…" : "Try it: send a poisoned review through the same check"}
      </button>
      {state.error && <p className="mt-1 text-terracotta">{state.error}</p>}
      {state.result && !state.result.available && <p className="mt-1">This deployment offers no {state.result.profile} profile.</p>}
      {state.result?.samples.map((x) => (
        <p key={x.id} className="mt-1">
          <span className={x.verdict === "flagged" ? "font-semibold text-terracotta" : x.verdict === "passed" ? "font-semibold text-olive" : "font-semibold"}>
            {x.verdict === "flagged" ? "Blocked by Otari" : x.verdict === "passed" ? "Passed" : "Not screened"}
          </span>{" "}
          · {x.label}
          {x.score != null ? ` · score ${x.score.toFixed(2)}` : ""}
          {x.reason ? ` · ${x.reason}` : ""} · {x.ms} ms
        </p>
      ))}
    </div>
  );
}

/** The supplier order as the sandbox computed it, under the shopping list. */
export function SandboxOrder({ report, money }: { report: QuartermasterReport; money: (v: number, c: string) => string }) {
  const r = report.result;
  const ok = report.checks.totals && report.checks.break_even;
  return (
    <div className="mt-5 rounded-xl border border-line bg-paper/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Computed in Otari’s code sandbox</p>
        {ok ? <Pill tone="olive">every sum checked against the list above</Pill> : <Pill tone="terracotta">a sum differs from the list above</Pill>}
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[12px] font-semibold text-ink-2">Order by supplier</p>
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {r.order.map((g) => (
              <li key={g.category} className="flex justify-between gap-3">
                <span>
                  {g.category} <span className="text-muted">({g.lines.length})</span>
                </span>
                <span className="tabular-nums">{money(g.total, report.currency)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{money(r.grand_total, report.currency)}</span>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-[12px] font-semibold text-ink-2">Portions that pay for each test</p>
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {r.dishes.map((d) => (
              <li key={d.dish} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{d.dish}</span>
                <span className="shrink-0 tabular-nums">
                  {d.break_even_portions} × {money(d.price, report.currency)}
                </span>
              </li>
            ))}
          </ul>
          {r.unmatched?.missing?.length ? <p className="mt-1 text-[12px] text-terracotta">Not on the list: {r.unmatched.missing.join(", ")}</p> : null}
        </div>
      </div>
      {!ok && report.checks.notes.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-[12px] text-terracotta">
          {report.checks.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {report.code && (
        <details className="mt-3 text-[12px]">
          <summary className="cursor-pointer select-none text-ink-2">The program the sandbox ran</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-ink p-3 text-[11px] leading-relaxed text-paper">{report.code}</pre>
        </details>
      )}
    </div>
  );
}
