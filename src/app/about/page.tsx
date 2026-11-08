import type { Metadata } from "next";
import Link from "next/link";
import { SplitWords } from "@/components/kinetic";
import { Reveal } from "@/components/motion";

export const metadata: Metadata = {
  title: "How it works · Tablecast",
  description:
    "How Tablecast plans a restaurant's week on open-weight models through Otari: routing policies with fallbacks, web search, an MCP page reader, guardrails, a code sandbox, per-restaurant budgets, and claims verified in code.",
};

const SOURCES = {
  technomic: "https://restaurantbusinessonline.com/operations/number-independent-restaurants-declined-23-2025",
  nrn: "https://www.nrn.com/independent-restaurants/the-independent-restaurant-sector-shrunk-by-2-3-in-2025",
  nra: "https://go.restaurant.org/rs/078-ZLA-461/images/SOI-2025-PocketGuide.pdf?version=0",
};

const PIPELINE: { step: string; who: string; what: string }[] = [
  {
    step: "1 · Context",
    who: "Code, in parallel",
    what: "Locates the restaurant on OpenStreetMap, then fetches the 7-day forecast (Open-Meteo), public holidays (Nager.Date), events within 5 km (Ticketmaster) and every food & drink venue within 600 m (OpenStreetMap). Each item becomes a numbered source. The reader opens the restaurant's own menu page.",
  },
  {
    step: "2 · Menu photo",
    who: "Qwen3 VL 235B, through Otari",
    what: "If the owner uploads a photo of the menu, the vision model transcribes dishes and prices into a structured list through a forced function call.",
  },
  {
    step: "3 · Research",
    who: "tablecast-research (Qwen3 235B) + Otari web search + the Tablecast MCP server",
    what: "An agent loop decides what to look up: the restaurant’s site and current menu, what guests and critics say, local news for the coming days, a same-cuisine rival’s prices. It searches with Otari’s web search (otari_web_search) and reads pages with the Tablecast MCP server, both inside Otari’s own tool loop. Every page and search result passes Otari’s prompt-injection guardrail before it can become a source.",
  },
  {
    step: "4 · Write",
    who: "tablecast-write (Nemotron 3 Ultra) or tablecast-economy (Nemotron 3 Super)",
    what: "The writer plans the week as one forced, streamed function call against a strict schema: demand moments, three dishes, rivals, an event, a post, a shopping list and a 7-day plan. Every claim must cite the numbered sentences of the sources it stands on. If Ultra fails, Otari falls back to GLM 5.2 and then Mistral Small 4; once a restaurant has used 60% of its weekly budget, Otari routes its writer to Nemotron 3 Super.",
  },
  {
    step: "5 · Verify",
    who: "Code, then tablecast-check once",
    what: "Code checks that every cited sentence exists, that every number in the claim appears in it, and that it says what the claim says (its specific words; numbers and names only when the page is written in another language). Claims about the restaurant must cite pages about it, an add-on goes with the dish it belongs to, and no date in the plan may fall before today. Failures go to the checker once, one small call per claim, in parallel, with candidate sentences; a fix is kept only if it passes the same check. What still fails is shown as unverified.",
  },
  {
    step: "6 · Supplier order",
    who: "tablecast-quartermaster (gpt-oss-120b) + Otari’s code sandbox",
    what: "A model writes one Python program that groups the order by supplier, totals it and works out how many portions of each new dish pay for its ingredients; Otari runs it in its sandbox. The app shows the program’s own output and checks in code that every sum matches the plan’s lines.",
  },
];

export default function About() {
  return (
    <main className="w-full px-4 pb-24 sm:px-8">
      <div className="-mx-4 flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] sm:-mx-8 sm:px-8">
        <Link href="/" className="group inline-flex min-h-11 items-center gap-1.5 text-ink transition-colors hover:text-olive">
          <span aria-hidden className="inline-block transition-transform duration-300 group-hover:-translate-x-0.5">
            ←
          </span>
          Back to Tablecast
        </Link>
        <span className="text-muted">How it works</span>
      </div>

      <header className="mt-10 sm:mt-14">
        <h1 className="kinetic ruled font-display max-w-[15ch] text-[clamp(3rem,9vw,8.4rem)] uppercase leading-[0.9] [--lh:0.9em]">
          <SplitWords text="The Monday-morning plan chains get from an insight team." />
        </h1>
      </header>

      <section aria-label="Why it matters" className="mt-12 grid border-t border-line lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Stat i={0} value="412,498" label="independent restaurants left in the US at the end of 2025" href={SOURCES.technomic} />
        <Stat i={1} value="−2.3%" label="independents lost in 2025 (about 9,500 closures), while chains grew 1.4%" href={SOURCES.nrn} />
        <Stat i={2} value="7 in 10" label="US restaurants are single-unit operations, with no insight team" href={SOURCES.nra} />
      </section>

      <Block title="The problem">
        <p>
          A restaurant’s week is shaped by things outside its walls: a wet Wednesday, a match two streets away, a holiday, a rival’s new menu. Chains
          plan for them with data teams. An independent owner finds out on the night. Generic AI doesn’t help: ask it what to add this week and every
          restaurant gets the same answer, with no way to check any of it.
        </p>
      </Block>

      <Block title="The pipeline">
        <p>
          Every step asks Otari for a routing policy, and Otari picks the open-weight model and provider that serve it. Every call, with the model that answered
          and what it cost, is shown in the app’s engine room. For each Otari feature, the file and function that use it are in{" "}
          <Link href="/#otari-map" className="underline decoration-line underline-offset-2 hover:text-ink">
            the map on the home page
          </Link>
          .
        </p>
        <ol className="mt-6">
          {PIPELINE.map((p, i) => (
            <Reveal as="li" key={p.step} delay={i * 0.06} y={12} className="border-b border-line py-4 first:border-t">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
                {p.step} · <span className="text-olive">{p.who}</span>
              </p>
              <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{p.what}</p>
            </Reveal>
          ))}
        </ol>
      </Block>

      <Block title="Which Nemotron writes, measured on the Nebius version">
        <p>
          These numbers come from the Nebius version of Tablecast, before it moved to Otari: Nemotron on Nebius Token Factory, the same verifier. On 25 Oct I had seven strategies plan the same 8 restaurants from the same evidence, with the design committed before the run: each of
          Ultra, Super, Lightning and Nano writing and repairing alone, and the three smaller ones writing with Ultra repairing. 56 plans cost
          $2.14 of inference.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Ultra alone (Quick):</strong> 79% of claims verified after repair, 58% of dishes tied to the week, $0.106 a plan.
          </li>
          <li>
            <strong>Super writes, Ultra repairs (Economy):</strong> 69%, 33% of dishes tied to the week, $0.065 a plan.
          </li>
          <li>
            <strong>Lightning writes, Ultra repairs:</strong> 82% for $0.025 a plan, but only 13% of its dishes tied to the week.
          </li>
          <li>
            <strong>Nano:</strong> ran out of tokens or looped in 8 of 16 first attempts and took 4 to 5 minutes to write.
          </li>
        </ul>
        <p>
          Ultra fixed 50–68% of the claims that failed the check, whichever model wrote them, so it repairs in both modes. The same setting moved 11
          points between two runs on the same evidence, so smaller gaps aren’t a ranking.{" "}
          <a
            href="https://github.com/antonmareo10/tablecast/blob/main/eval/SUMMARY.md#model-comparison-four-nemotrons-alone-and-tiered-with-cost-25-oct"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-line underline-offset-2 hover:text-ink"
          >
            Full table and blind precision sample
          </a>
          .
        </p>
        <p>
          <strong>What this doesn’t prove.</strong> Tablecast checks that each cited claim matches the sentences it cites, tested on 24 restaurants
          with one week of evidence each. It isn’t proof that a plan is right or that it sells: no restaurant has run a Tablecast week yet, and when
          I read all 212 verified claims of a held-out round, 26 were wrong or slightly off.
        </p>
      </Block>

      <Block title="Responsible by design">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Code decides what is verified.</strong> No model is asked whether a claim is true; cited sentences and numbers are matched against the sources
            fetched in that run, and failures are shown, not hidden.
          </li>
          <li>
            <strong>Web pages are data, never instructions.</strong> Every page and search result passes Otari’s prompt-injection guardrail before the
            writer sees it, and flagged ones are withheld and listed. Fetched text is passed to the models as quoted sources with an explicit rule to
            ignore instructions inside them, and the agent can only search and read: it cannot post, buy or send anything.
          </li>
          <li>
            <strong>No personal data.</strong> Tablecast reads public pages, open data and aggregate listings. It never collects information about
            individual guests.
          </li>
          <li>
            <strong>Spend has a ceiling.</strong> Each restaurant is an Otari end user with its own weekly budget, the app’s key has a monthly one, and
            a run that a restaurant can’t afford is refused before anything is spent.
          </li>
          <li>
            <strong>The owner decides.</strong> Dishes are bets to test for a week; nothing is ordered or posted without the owner.
          </li>
          <li>
            <strong>Credit where it’s due.</strong> Map data © OpenStreetMap contributors (ODbL), weather by Open-Meteo (CC BY 4.0), holidays by
            Nager.Date, events by Ticketmaster, models, web search, guardrails and the code sandbox through Otari by Mozilla.ai.
          </li>
        </ul>
      </Block>

      <Block title="Accessibility">
        <ul className="list-disc space-y-2 pl-5">
          <li>Plans in English or Spanish, whatever language the sources are in.</li>
          <li>Works on a 390 px phone, and Save as PDF prints the whole plan.</li>
          <li>
            Everything works from the keyboard, with a visible focus ring; source chips open on keyboard focus as well as on hover or tap.
          </li>
          <li>With reduced motion turned on, nothing slides or drifts and scrolling jumps instead of gliding.</li>
          <li>axe-core finds no violations on the home page or on a full plan, on desktop and on a phone (checked 22 Oct 2026).</li>
        </ul>
      </Block>

      <Block title="Why it’s a business">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Who pays:</strong> independent restaurants and small groups. A monthly subscription per location; the plan arrives every Monday.
          </li>
          <li>
            <strong>Why now:</strong> open models are good and cheap enough to run a full research-and-plan loop per restaurant per week for cents.
          </li>
          <li>
            <strong>Distribution:</strong> POS and reservation marketplaces, and food distributors — the shopping list is already an order.
          </li>
        </ul>
      </Block>

      <Block title="Who built it">
        <p>
          Antonio González Fernández, Business Administration and Data Science student at CUNEF (Madrid). He previously built Supplora, an AI tool
          that reads supplier delivery notes for a family-run restaurant in Spain and loads them into its management system. Watching that restaurant
          plan its week on gut feel is where Tablecast started.
        </p>
      </Block>
    </main>
  );
}

function Stat({ value, label, href, i }: { value: string; label: string; href: string; i: number }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ "--d": `${300 + i * 80}ms` } as React.CSSProperties}
      className="rise group block border-b border-line py-6 transition-colors hover:bg-paper-2/60 lg:border-b-0 lg:border-l lg:px-6 lg:first:border-l-0 lg:first:pl-0"
    >
      <p className={`font-display leading-[0.85] tabular-nums ${i === 0 ? "text-[clamp(4.5rem,13vw,10rem)] text-olive" : "text-[clamp(3.2rem,8vw,5rem)] text-ink"}`}>{value}</p>
      <p className="mt-3 max-w-xs text-[15px] leading-snug text-ink-2">{label}</p>
      <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted underline underline-offset-4 group-hover:text-olive">Source</p>
    </a>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Reveal as="section" className="mt-16 grid gap-4 border-t-2 border-ink pt-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
      <h2 className="font-display text-[34px] uppercase leading-[0.92] sm:text-[44px] lg:sticky lg:top-6 lg:self-start">{title}</h2>
      <div className="max-w-3xl space-y-3 text-[16px] leading-relaxed text-ink-2 [&_li]:marker:text-olive">{children}</div>
    </Reveal>
  );
}
