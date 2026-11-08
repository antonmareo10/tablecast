"use client";

// "How this app uses Otari": every Otari feature Tablecast uses, where it lives in the code, and where a judge can see
// it, in the app or in Otari's dashboard. The README has the same map (keep the two in step). Every line here has to
// stay true to the code it links to. In the texts, `backticks` mark identifiers, shown as code.

import { Fragment, type ReactNode } from "react";
import { IconArrow } from "./icons";
import { Reveal, scrollToEl } from "./motion";

const REPO = "https://github.com/antonmareo10/tablecast/blob/otari-wilding/";

type Code = { path: string; fns?: string };

export type OtariFeature = {
  id: string;
  chip: string; // short name for the chips in the hero
  name: string;
  what: string;
  code: Code[];
  app: string;
  dashboard: string;
};

export const OTARI_FEATURES: OtariFeature[] = [
  {
    id: "otari-models",
    chip: "Open-weight models in 6 roles",
    name: "Open-weight models, each in its own role",
    what: "Qwen3 235B researches. Nemotron 3 Ultra writes and repairs (Nemotron 3 Super in Economy). gpt-oss-120b writes the program the sandbox runs. gpt-oss-safeguard-20b judges prompt injection. Qwen3 VL reads a menu photo when one is uploaded.",
    code: [
      { path: "src/lib/model-runtime.ts", fns: "POLICIES, gather(), synthesize(), repairCitations(), readMenuPhoto()" },
      { path: "src/lib/injection-detector.ts", fns: "detectInjection()" },
    ],
    app: "“What Otari did in this run”: one row per role, with the model and provider Otari says answered",
    dashboard: "Requests, one model per role",
  },
  {
    id: "otari-routing",
    chip: "Routing and fallbacks",
    name: "Model routing and fallbacks",
    what: "The app asks for a routing policy, never for a model. Each policy falls back to another provider and model family, and `tablecast-write` moves a restaurant to Nemotron 3 Super at 60% of its budget. Every answer's `Otari-Model`, `Otari-Provider`, `Otari-Attempt-Count` and `Otari-Fallback` are read and shown.",
    code: [
      { path: "src/lib/model-runtime.ts", fns: "POLICIES, resolveRouting()" },
      { path: "src/lib/otari.ts", fns: "servedFrom()" },
      { path: "src/app/api/failover-drill/route.ts", fns: "POST()" },
    ],
    app: "“asked tablecast-write → Nemotron 3 Ultra on fireworks” for each role, and the Failover drill button",
    dashboard: "Routing, and Requests (the drill shows two attempts)",
  },
  {
    id: "otari-search",
    chip: "Web search and fetch",
    name: "Web search and web fetch",
    what: "The researcher searches with `otari_web_search` inside Otari's tool loop, at most 5 times a run. When my own reader can't open a page, Otari's web fetch reads it through the Messages API.",
    code: [
      { path: "src/lib/agent.ts", fns: "gatherEvidence()" },
      { path: "src/lib/sources/otari-fetch.ts", fns: "otariFetchPage()" },
    ],
    app: "“Searching the web: … (Otari web search)” in the agent log",
    dashboard: "Agent traces, the search spans",
  },
  {
    id: "otari-mcp",
    chip: "MCP",
    name: "MCP",
    what: "Tablecast's page reader is an MCP server with two tools, `read_page` and `find_menu_pages`. Each research turn names it in `mcp_servers`; Otari calls it inside its loop, and the text it returns becomes a numbered source.",
    code: [
      { path: "src/lib/mcp-server.ts", fns: "TOOLS, callTool(), inlineMcpServer()" },
      { path: "src/app/api/mcp/route.ts" },
      { path: "src/lib/agent.ts", fns: "onGatewayCalls" },
    ],
    app: "“Reading timeout.com (Tablecast MCP, via Otari)” in the agent log",
    dashboard: "Agent traces, the MCP spans",
  },
  {
    id: "otari-code",
    chip: "Code sandbox",
    name: "Code execution",
    what: "gpt-oss-120b writes one Python program and Otari runs it with `otari_code_execution`: the order by supplier, its total, and the portions that pay for each new dish. My code then checks every sum.",
    code: [{ path: "src/lib/quartermaster.ts", fns: "runQuartermaster(), checkResult()" }],
    app: "“Computed in Otari’s code sandbox” under the shopping list, with the program it ran",
    dashboard: "Agent traces, the code execution span",
  },
  {
    id: "otari-guardrails",
    chip: "Guardrails",
    name: "Guardrails",
    what: "Each page and search result goes alone through a `prompt-injection` guardrail in block mode before the writer sees it, and Otari refuses flagged text with `403 guardrail_violation`. The EU deployment has no guardrails service, so the guardrail's `url` names my own, on Otari's guardrails contract.",
    code: [
      { path: "src/lib/screen.ts", fns: "screenText()" },
      { path: "src/lib/guardrail-service.ts", fns: "validateResponse()" },
      { path: "src/lib/injection-detector.ts", fns: "detectInjection()" },
    ],
    app: "The 🛡️ line in the log, and “Try it: send a poisoned review through the same check”",
    dashboard: "Requests refused with guardrail_violation",
  },
  {
    id: "otari-budget",
    chip: "Key budget",
    name: "Budgets and spending limits",
    what: "The app's service key has a $12 monthly budget on Otari. When Otari answers `budget_exceeded` for the key or the workspace, or the balance is empty, the server pauses live runs and tells the visitor why.",
    code: [
      { path: "src/lib/limits.ts", fns: "isAccountError(), describeLiveFailure()" },
      { path: "src/lib/otari.ts", fns: "OtariError.budgetScope" },
    ],
    app: "The message a visitor gets when live runs pause",
    dashboard: "Spend & budgets, the key's budget",
  },
  {
    id: "otari-users",
    chip: "A budget per restaurant",
    name: "Per-user budgets",
    what: "Every request names the restaurant as an Otari end user, `restaurant:<name>-<city>`, with its own $1 weekly budget. The app reads it before a run (and refuses one it can't cover, before spending anything) and after it, to show what Otari billed. The judges' link bills one end user of its own.",
    code: [
      { path: "src/lib/otari.ts", fns: "restaurantEndUser(), completionExtras()" },
      { path: "src/lib/otari-budget.ts", fns: "endUserStatus()" },
      { path: "src/app/api/agent/route.ts", fns: "POST()" },
      { path: "src/lib/judge.ts", fns: "judgeBudget()" },
    ],
    app: "“This restaurant’s budget on Otari”: the bar, and what Otari billed this run",
    dashboard: "Spend & budgets, end users",
  },
];

/** Text with `identifiers` shown as code. */
function rich(text: string): ReactNode {
  return text.split("`").map((part, i) =>
    i % 2 ? (
      <code key={i} className="bg-paper-2 px-1 text-[11.5px] text-ink">
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** Scroll to a row of the map and move focus there, without putting a hash in the address bar. */
export function jumpToFeature(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  scrollToEl(el, -16);
  el.focus({ preventScroll: true });
}

/** The hero's index of Otari features: numbered like a timetable, each a link to its row in the map. */
export function OtariChips({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      <p className="max-w-[34rem] border-b border-line pb-2.5 text-[13px] leading-snug text-ink-2">
        Built on <span className="font-semibold text-olive">Otari</span> by Mozilla.ai: every model call, search, page read, guardrail check and code run goes
        through it. What it uses, and where:
      </p>
      <ul className="grid sm:grid-cols-2 sm:gap-x-6" aria-label="Otari features this app uses">
        {OTARI_FEATURES.map((f, i) => (
          <li key={f.id} className="border-b border-line">
            <a
              href={`#${f.id}`}
              onClick={(e) => {
                e.preventDefault();
                jumpToFeature(f.id);
              }}
              className="group flex min-h-11 items-center gap-3 text-[13.5px] text-ink-2 transition-colors hover:text-olive"
            >
              <span className="font-mono text-[11px] tabular-nums text-muted group-hover:text-olive">{String(i + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1">{f.chip}</span>
              <IconArrow size={12} className="nudge text-muted group-hover:text-olive" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeLinks({ code }: { code: Code[] }) {
  return (
    <ul className="space-y-1">
      {code.map((c) => (
        <li key={c.path + (c.fns ?? "")} className="min-w-0 break-words text-[12px] leading-snug">
          <a
            href={REPO + c.path}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block min-h-6 py-0.5 font-mono text-[11.5px] text-olive underline decoration-olive/30 underline-offset-2 hover:decoration-olive"
          >
            {c.path.replace(/^src\//, "")}
          </a>
          {c.fns ? <span className="text-ink-2"> · {c.fns}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The full map: feature → what the app does → where in the code → where you see it. */
export function OtariMap() {
  return (
    <section id="otari-map" aria-labelledby="otari-map-title" className="scroll-mt-4 py-14 sm:py-20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div className="max-w-2xl">
          <h2 id="otari-map-title" className="font-display text-[clamp(2.4rem,7vw,4.2rem)] uppercase leading-[0.9]">
            How this app <span className="text-olive">uses Otari</span>
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
            Eight Otari features, each used by the code of a normal run: what Tablecast does with it, the file and function, and where you can see it work.
            The two recorded runs above show all of them except the menu photo and the web-fetch fallback, which only run when they are needed.
          </p>
        </div>
        <a
          href="https://github.com/antonmareo10/tablecast/tree/otari-wilding#how-this-app-uses-otari"
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start border border-line px-4 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2 transition hover:border-olive hover:text-olive lg:self-auto"
        >
          The same map in the README <IconArrow size={13} className="nudge" />
        </a>
      </div>

      <div className="mt-8 border-y border-line">
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,15rem)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] gap-6 border-b border-line py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted lg:grid"
        >
          <span>Otari feature</span>
          <span>What Tablecast does with it</span>
          <span>In the code</span>
          <span>Where you see it</span>
        </div>
        <ol>
          {OTARI_FEATURES.map((f, i) => (
            <Reveal
              as="li"
              key={f.id}
              delay={Math.min(i, 4) * 0.04}
              y={10}
              id={f.id}
              tabIndex={-1}
              className="grid scroll-mt-4 gap-3 border-b border-line py-5 outline-none transition-colors last:border-b-0 hover:bg-paper-2/60 focus-visible:bg-olive/10 lg:grid-cols-[minmax(0,15rem)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-6"
            >
              <p className="flex items-baseline gap-3 font-display text-[22px] uppercase leading-[1.05] text-ink">
                <span aria-hidden className="font-mono text-[11px] tabular-nums text-olive">{String(i + 1).padStart(2, "0")}</span>
                {f.name}
              </p>
              <p className="text-[13.5px] leading-relaxed text-ink-2">{rich(f.what)}</p>
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted lg:hidden">In the code</p>
                <CodeLinks code={f.code} />
              </div>
              <div className="text-[12.5px] leading-snug text-ink-2">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted lg:hidden">Where you see it</p>
                <p>
                  <span className="font-medium text-ink">App:</span> {f.app}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-ink">Otari dashboard:</span> {f.dashboard}
                </p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        Also used: sessions. Every request of a run carries one <code className="text-[12px]">Otari-Conversation-Id</code> (
        <a href={REPO + "src/lib/otari.ts"} target="_blank" rel="noopener noreferrer" className="inline-block min-h-6 py-0.5 font-mono text-[11.5px] text-olive underline decoration-olive/30 underline-offset-2">
          lib/otari.ts
        </a>{" "}
        · otariFetch()), so a whole run is one session in Otari&apos;s agent traces, and the app shows its id.
      </p>
    </section>
  );
}
