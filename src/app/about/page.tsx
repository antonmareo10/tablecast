import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How it works · Tastecraft",
  description:
    "How Tastecraft plans a restaurant's week on NVIDIA Nemotron and Nebius Token Factory: model routing, live web research with Tavily, open data, and claims verified in code.",
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
    what: "Locates the restaurant on OpenStreetMap, then fetches the 7-day forecast (Open-Meteo), public holidays (Nager.Date), events within 5 km (Ticketmaster) and every food & drink venue within 600 m (OpenStreetMap). Each item becomes a numbered source.",
  },
  {
    step: "2 · Menu photo",
    who: "Nemotron 3.5 Super VL",
    what: "If the owner uploads a photo of the menu, the vision model transcribes dishes and prices into a structured list through a forced function call.",
  },
  {
    step: "3 · Research",
    who: "Nemotron 3.5 Lightning + Tavily",
    what: "A fast agent loop (reasoning off) decides what to look up: the restaurant’s site and current menu, what guests and critics say, local news for the coming days, a same-cuisine rival’s prices. It searches, picks pages and reads them with Tavily Search and Extract; tools requested in one turn run in parallel.",
  },
  {
    step: "4 · Write",
    who: "Nemotron 3 Ultra",
    what: "The reasoning model writes the plan as one forced, streamed function call against a strict schema: demand moments, three dishes, rivals, an event, a post, a shopping list and a 7-day plan. Every claim must cite the numbered sentences of the sources it stands on.",
  },
  {
    step: "5 · Verify",
    who: "Code, then Ultra once",
    what: "Code checks that every cited sentence exists, that every number in the claim appears in it, and that it talks about the claim. Failures go to Nemotron Ultra (low effort) once — one small call per claim, in parallel — with candidate sentences; a fix is kept only if it passes the same check. What still fails is shown as unverified.",
  },
];

export default function About() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-6 sm:px-6">
      <Link href="/" className="text-sm text-ink-2 underline decoration-line underline-offset-4 hover:text-ink">
        ← Back to Tastecraft
      </Link>

      <header className="mt-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-terracotta">How it works</p>
        <h1 className="font-display mt-3 text-4xl leading-[1.05] tracking-tight sm:text-5xl">The Monday-morning plan chains get from an insight team.</h1>
      </header>

      <section className="mt-12 grid gap-4 sm:grid-cols-3">
        <Stat value="412,498" label="independent restaurants left in the US at the end of 2025" href={SOURCES.technomic} />
        <Stat value="−2.3%" label="independents lost in 2025 — about 9,500 closures — while chains grew 1.4%" href={SOURCES.nrn} />
        <Stat value="7 in 10" label="US restaurants are single-unit operations, with no insight team" href={SOURCES.nra} />
      </section>

      <Block title="The problem">
        <p>
          A restaurant’s week is shaped by things outside its walls: a wet Thursday, a match two streets away, a holiday, a rival’s new menu. Chains
          plan for them with data teams. An independent owner finds out on the night. Generic AI doesn’t help: ask it what to add this week and every
          restaurant gets the same answer, with no way to check any of it.
        </p>
      </Block>

      <Block title="The pipeline">
        <p>Every step runs on the model that suits it, on Nebius Token Factory. All model calls are measured and shown in the app’s engine room.</p>
        <ol className="mt-4 space-y-3">
          {PIPELINE.map((p) => (
            <li key={p.step} className="rounded-2xl border border-line bg-card p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-terracotta">
                {p.step} · <span className="text-olive">{p.who}</span>
              </p>
              <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{p.what}</p>
            </li>
          ))}
        </ol>
      </Block>

      <Block title="Responsible by design">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Code decides what is verified.</strong> No model is asked whether a claim is true; cited sentences and numbers are matched against the sources
            fetched in that run, and failures are shown, not hidden.
          </li>
          <li>
            <strong>Web pages are data, never instructions.</strong> Fetched text is passed to the models as quoted sources with an explicit rule to
            ignore instructions inside them, and the agent can only search and read — it cannot post, buy or send anything.
          </li>
          <li>
            <strong>No personal data.</strong> Tastecraft reads public pages, open data and aggregate listings. It never collects information about
            individual guests.
          </li>
          <li>
            <strong>The owner decides.</strong> Dishes are bets to test for a week; nothing is ordered or posted without the owner.
          </li>
          <li>
            <strong>Credit where it’s due.</strong> Map data © OpenStreetMap contributors (ODbL), weather by Open-Meteo (CC BY 4.0), holidays by
            Nager.Date, events by Ticketmaster, web research by Tavily.
          </li>
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
          plan its week on gut feel is where Tastecraft started.
        </p>
      </Block>
    </div>
  );
}

function Stat({ value, label, href }: { value: string; label: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="block rounded-2xl border border-line bg-card p-5 transition hover:border-ink-2/30">
      <p className="font-display text-4xl text-olive">{value}</p>
      <p className="mt-2 text-sm leading-snug text-ink-2">{label}</p>
      <p className="mt-3 text-[11px] text-muted underline underline-offset-2">Source</p>
    </a>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="font-display text-2xl sm:text-3xl">{title}</h2>
      <div className="mt-3 space-y-3 text-[16px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}
