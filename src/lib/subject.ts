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
//   4. a price is not a combo or add-on price ("As a Reuben, $33.95" under "Combos") stated as the item's own;
//   5. an add-on ("Add egg $3", "+ avocado $4") belongs to the dish right above it on the menu: a claim that pairs
//      it with another dish fails (addOnIssue).
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
  return addOnIssue(claim, cites.filter((c) => PAGE_KINDS.has(c.source.kind)));
}

// ---- add-ons ------------------------------------------------------------------------------------

// A menu line that offers an add-on: "Add egg $3", "+ avocado $4", "Extra shot 1 €", "With pastrami, add $1.00".
// It belongs to the dish directly above it. Lines for a whole section ("Add to any salad…") are left alone.
const ADD_ON_LINE = /^\s*(?:\+|add\b|adds\b|extra\b|supplement\b|with\s[^,]{1,40},\s*add\b)/i;
const WHOLE_SECTION = /\b(any|all|each|every)\b/i;
const NOT_A_NAME = new Set(
  "add adds added adding extra option options with and for the menu menus shows show lists list offers offer serves served comes come plus also can guests guest price".split(" "),
);

/** Comparable words of a line that could name a dish or ingredient (3+ letters, plurals folded). */
function nameWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeText(s).split(" ")) if (w.length >= 3 && !/\d/.test(w) && !NOT_A_NAME.has(w)) out.add(w.replace(/(ies|es|s)$/, ""));
  return out;
}

/**
 * Why a claim pairs a menu add-on with the wrong dish, or null: the add-on line the claim uses (by its price or
 * its item) belongs to the dish right above it (up to 3 lines up), and the claim names none of that dish's words
 * while naming another item from the lines it cites. Real case: "Vegetable Sandwich … and an add-egg option for
 * $3", where "Add egg $3" sits under the BLT on Gjelina's menu.
 */
export function addOnIssue(claim: string, cites: CitedLines[]): string | null {
  const claimWords = nameWords(claim);
  const claimNumbers = new Set(numbersIn(claim));
  for (const c of cites) {
    const lines = [...c.before, c.sentence, ...c.after];
    const start = Math.max(0, c.before.length - 1); // the line above the cited one can hold the claim's number
    for (let k = start; k < lines.length; k++) {
      const line = lines[k];
      if (!ADD_ON_LINE.test(line) || WHOLE_SECTION.test(line)) continue;
      const item = nameWords(line);
      const uses = numbersIn(line).some((n) => claimNumbers.has(n)) || [...item].some((w) => claimWords.has(w));
      if (!uses) continue;
      let top = Math.max(0, k - 3);
      for (let j = k - 1; j >= top; j--) if (ADD_ON_LINE.test(lines[j])) top = j + 1;
      const owner = lines.slice(top, k).filter((l) => nameWords(l).size > 0);
      if (!owner.length) continue; // nothing above it in view: can't tell whose it is
      const ownerWords = nameWords(owner.join(" "));
      if ([...claimWords].some((w) => ownerWords.has(w) && !item.has(w))) continue; // the claim names its dish
      // Words of the claim found on the other lines it cites (another dish), not on the add-on or its dish.
      const elsewhere = cites
        .flatMap((x) => (x === c ? [...lines.slice(0, top), ...lines.slice(k + 1)] : [...x.before, x.sentence, ...x.after]))
        .filter((l) => !owner.includes(l) && l !== line);
      const otherWords = nameWords(elsewhere.join(" "));
      const other = [...claimWords].filter((w) => otherWords.has(w) && !item.has(w) && !ownerWords.has(w));
      if (other.length)
        return `${quote(line.trim(), 40)} on ${c.id} is an add-on of the dish above it (${quote(owner.join(" · "), 60)}), not of the ${other.slice(0, 2).join(" ")} the claim pairs it with`;
    }
  }
  return null;
}
