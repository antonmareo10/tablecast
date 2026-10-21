// Subject check: a claim about the restaurant itself must stand on pages about THIS restaurant.
//
// The verifier proves that the cited sentences say what a claim says. It cannot see that they say it about
// someone else: a competitor's private room filed under the restaurant's own "loved for", the Las Vegas branch's
// bad review under the Venice one's watch-outs, a combo price read as the dish's own price. For claims about the
// restaurant (loved for, watch-outs, its event, its dishes) code checks, deterministically, every cited web page:
//   1. the page is not about another branch: its URL or title names another city, and not this one;
//   2. the cited sentence is not about another branch: it names the restaurant (or sits on its page) together with
//      another city, and not this one;
//   3. the page is about this restaurant: it is the restaurant's own site, or its URL, title or the cited lines
//      name it. Research labels are not trusted for this (the research model filed Zuni Café's own reviews as
//      "rival"), only names are. A claim that openly names the street, neighbourhood or city instead of the
//      restaurant ("Cava Baja has about 50 tapas bars") may cite a page about the area;
//   4. a price is not a combo or add-on price ("As a Reuben, $33.95" under "Combos") stated as the item's own.
// "Loved for" and "watch-outs" also may not name another city themselves. Moments and rivals are exempt: events,
// news and competitors are what they are about. Forecasts, events, holidays and the block are never checked.

import { moneyIn } from "./amounts";
import { brandWords, host, namesBrand, otherCities, ownCities, placeAnchors, urlNamesBrand, urlWords } from "./place";
import { normalizeText, numbersIn } from "./evidence";
import type { Source } from "./types";

/** A cited sentence with the lines around it on its page (up to 3 before and 2 after). */
export type CitedLines = { id: string; source: Pick<Source, "kind" | "url" | "title">; sentence: string; before: string[]; after: string[] };

export type SubjectProfile = {
  name: string;
  city: string;
  brand: string[]; // distinctive words of the name
  anchors: string[]; // city, aliases, street, postcode
  own: Set<string>; // cities that count as here
  siteHost: string | null;
};

export function subjectProfile(p: { restaurant: string; city: string; address?: string; website?: string | null }): SubjectProfile {
  const anchors = placeAnchors({ city: p.city, address: p.address });
  return {
    name: p.restaurant,
    city: p.city,
    brand: brandWords(p.restaurant, anchors),
    anchors,
    own: ownCities(anchors),
    siteHost: p.website ? host(/^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`) : null,
  };
}

/** Evidence groups whose claims are about the restaurant itself (labels from agent.ts evidenceGroups). */
export function isSelfField(field: string): boolean {
  return field === "loved_for" || field === "watch_outs" || field === "experience" || /^dish \d+$/.test(field);
}
const PAGE_KINDS = new Set(["site", "menu", "review", "rival", "web"]);

// A price introduced as a variant or an add-on, or listed under a combos / extras heading.
const MODIFIER = /\b(as an?|add|extra|supplement|upgrade|make it)\b/i;
const VARIANT_HEADING = /^(combos?|combinations?|combo platters?|add ons?|addons|extras|supplements|upgrades)$/;
const SAYS_VARIANT = /\b(combos?|combinations?|add|adds|added|adding|extra|supplement|upgrade|surcharge|more|plus|as an?)\b/i;

const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const quote = (s: string, max = 70) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

/** Why a claim in `field` is not about this restaurant, or null. */
export function subjectIssue(claim: string, field: string, cites: CitedLines[], p: SubjectProfile): string | null {
  if (!isSelfField(field)) return null;
  if (field === "loved_for" || field === "watch_outs") {
    const other = otherCities(claim, p.anchors, p.own);
    if (other.length) return `the claim is about ${cap(other[0])}, not ${p.name} in ${p.city}`;
  }
  // "Cava Baja has about 50 tapas bars": a claim that names the street, neighbourhood or city (and not the
  // restaurant) is openly about the area, and may cite a page about the area.
  const claimText = ` ${normalizeText(claim)} `;
  const aboutArea = !namesBrand(claim, p.brand) && p.anchors.some((a) => claimText.includes(` ${a} `));
  for (const c of cites) {
    if (!PAGE_KINDS.has(c.source.kind)) continue;
    const url = c.source.url ?? "";
    const title = c.source.title ?? "";
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      path = "";
    }
    const near = [...c.before.slice(-1), c.sentence, ...c.after].join(" ");
    const ownSite = !!p.siteHost && !!url && host(url) === p.siteHost;
    const namesIt = ownSite || (!!url && urlNamesBrand(url, p.brand)) || namesBrand(title, p.brand) || namesBrand(near, p.brand);

    const pageCities = otherCities(`${urlWords(`${host(url)} ${path}`)} ${title}`, p.anchors, p.own);
    if (pageCities.length) return `${c.id} is about ${cap(pageCities[0])}, not ${p.name} in ${p.city} (${quote(title || url)})`;

    const sentenceCities = otherCities(c.sentence, p.anchors, p.own);
    if (sentenceCities.length && (namesIt || namesBrand(c.sentence, p.brand)))
      return `the sentence cited from ${c.id} is about ${cap(sentenceCities[0])}, not ${p.name} in ${p.city}`;

    if (!namesIt && !aboutArea)
      return `${c.id} (${host(url) || title}, ${quote(title, 50)}) never names ${p.name}, so it can't back a claim about ${p.name} itself${
        c.source.kind === "rival" ? " — competitor facts belong under rivals" : ""
      }`;

    if ((c.source.kind === "menu" || c.source.kind === "site") && !SAYS_VARIANT.test(claim)) {
      const lines = [...c.before, c.sentence, ...c.after];
      const from = c.before.length > 0 ? c.before.length - 1 : 0; // the claim's numbers may sit one line up or two down
      for (const n of moneyIn(claim).flatMap(numbersIn)) {
        for (let i = from; i < lines.length; i++) {
          if (!normalizeText(lines[i]).split(" ").includes(n)) continue;
          const heading = lines.slice(Math.max(0, i - 2), i).find((l) => VARIANT_HEADING.test(normalizeText(l)));
          if (MODIFIER.test(lines[i]) || heading)
            return `${n.replace("d", ".")} on ${c.id} is a combo or add-on price (${quote(heading ? `${heading} … ${lines[i]}` : lines[i])}), not the item's own price`;
        }
      }
    }
  }
  return null;
}
