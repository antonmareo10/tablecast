// What ties a text to THIS restaurant: its location anchors (city, street, postcode), the distinctive words of
// its name, and the other cities a page might be about instead. Shared by the research step (same-name
// results), Tavily Map (which menu page is this branch's) and the verifier's subject check.

import { normalizeText } from "./evidence";

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A URL as plain words: "https://gjelina.com/las-vegas-menus" → "gjelina com las vegas menus". */
export function urlWords(url: string): string {
  return normalizeText(url.replace(/^https?:\/\//i, "").replace(/[/._\-?=&#%]+/g, " "));
}

const STREET_WORDS = new Set(
  "calle c de del la las los el y avenida av avda avenue ave street st boulevard blvd road rd carretera ctra plaza pl paseo po rue via strada piazza place lane ln drive dr".split(
    " ",
  ),
);
const CITY_ALIASES: Record<string, string[]> = {
  "new york": ["nyc", "manhattan", "brooklyn"],
  "los angeles": ["venice", "santa monica"],
  london: ["covent garden", "soho"],
};

/**
 * Words that tie a page to THIS restaurant's location: the city (and a few well-known aliases), the
 * distinctive part of its street name and its postcode. Same-name restaurants are common ("Casa Lucio" in
 * Madrid and in Barco de Ávila), so a page that mentions none of them is treated as being about somewhere else.
 */
export function placeAnchors(place: { city: string; address?: string }): string[] {
  const city = normalizeText(place.city);
  const out = new Set<string>([city, ...(CITY_ALIASES[city] ?? [])]);
  if (place.address) {
    const street = normalizeText(place.address.split(/,|\d/)[0] ?? "")
      .split(" ")
      .filter((w) => w.length > 2 && !STREET_WORDS.has(w))
      .join(" ");
    if (street.length >= 4) out.add(street);
    const postcode = place.address.match(/(?<!\d)\d{5}(?!\d)/)?.[0];
    if (postcode) out.add(postcode);
  }
  return [...out].filter(Boolean);
}

export function isAboutPlace(url: string, text: string, anchors: string[], siteHost: string | null): boolean {
  if (siteHost && host(url) === siteHost) return true;
  const t = ` ${normalizeText(`${url.replace(/[/._-]+/g, " ")} ${text}`)} `;
  return anchors.some((a) => t.includes(` ${a} `));
}

// ---- other cities ------------------------------------------------------------------------------

// Cities where restaurant groups open branches, with the ways pages write them. Enough to notice that a page
// (or a sentence) is about "Gjelina in Las Vegas" or "Au Cheval — New York City" rather than the branch at hand.
// Two-letter abbreviations ("LA", "NY") are left out: too ambiguous in running text.
const CITIES: Record<string, string[]> = {
  "new york": ["new york", "new york city", "nyc", "manhattan", "brooklyn", "nueva york"],
  "los angeles": ["los angeles"],
  "las vegas": ["las vegas"],
  "san francisco": ["san francisco"],
  chicago: ["chicago"],
  miami: ["miami"],
  boston: ["boston"],
  seattle: ["seattle"],
  austin: ["austin"],
  houston: ["houston"],
  dallas: ["dallas"],
  philadelphia: ["philadelphia"],
  atlanta: ["atlanta"],
  denver: ["denver"],
  nashville: ["nashville"],
  "new orleans": ["new orleans"],
  "san diego": ["san diego"],
  honolulu: ["honolulu"],
  toronto: ["toronto"],
  montreal: ["montreal"],
  vancouver: ["vancouver"],
  "mexico city": ["mexico city", "ciudad de mexico"],
  london: ["london", "londres"],
  manchester: ["manchester"],
  edinburgh: ["edinburgh"],
  birmingham: ["birmingham"],
  glasgow: ["glasgow"],
  dublin: ["dublin"],
  paris: ["paris"],
  lyon: ["lyon"],
  marseille: ["marseille"],
  madrid: ["madrid"],
  barcelona: ["barcelona"],
  valencia: ["valencia"],
  seville: ["seville", "sevilla"],
  malaga: ["malaga"],
  bilbao: ["bilbao"],
  ibiza: ["ibiza"],
  marbella: ["marbella"],
  lisbon: ["lisbon", "lisboa"],
  porto: ["porto"],
  rome: ["rome", "roma"],
  milan: ["milan", "milano"],
  florence: ["florence", "firenze"],
  berlin: ["berlin"],
  munich: ["munich", "munchen"],
  hamburg: ["hamburg"],
  amsterdam: ["amsterdam"],
  brussels: ["brussels", "bruxelles"],
  copenhagen: ["copenhagen"],
  stockholm: ["stockholm"],
  vienna: ["vienna", "wien"],
  zurich: ["zurich"],
  geneva: ["geneva", "geneve"],
  prague: ["prague"],
  istanbul: ["istanbul"],
  dubai: ["dubai"],
  "abu dhabi": ["abu dhabi"],
  doha: ["doha"],
  riyadh: ["riyadh"],
  "tel aviv": ["tel aviv"],
  mumbai: ["mumbai"],
  delhi: ["delhi"],
  singapore: ["singapore"],
  "hong kong": ["hong kong"],
  tokyo: ["tokyo"],
  osaka: ["osaka"],
  seoul: ["seoul"],
  shanghai: ["shanghai"],
  bangkok: ["bangkok"],
  sydney: ["sydney"],
  melbourne: ["melbourne"],
};

// "New York-style pizza", "the New York Times", "LA Times": a city named without being where the text is about.
const NOT_A_PLACE_AFTER = new Set(["style", "styled", "inspired", "times", "post", "magazine", "tribune", "daily", "marathon"]);

/** The cities (canonical names) a text mentions, e.g. "Gjelina at the Venetian, Las Vegas" → ["las vegas"]. */
export function citiesIn(text: string): string[] {
  const words = normalizeText(text).split(" ");
  const t = ` ${words.join(" ")} `;
  const found = new Set<string>();
  for (const [city, names] of Object.entries(CITIES)) {
    for (const name of names) {
      let at = t.indexOf(` ${name} `);
      while (at >= 0) {
        const next = t.slice(at + name.length + 2).split(" ")[0];
        if (!NOT_A_PLACE_AFTER.has(next)) {
          found.add(city);
          break;
        }
        at = t.indexOf(` ${name} `, at + 1);
      }
      if (found.has(city)) break;
    }
  }
  return [...found];
}

/**
 * The cities that count as "here" for a place: its own, plus any whose name its anchors use (a Barcelona
 * restaurant on Carrer de València is not "about Valencia").
 */
export function ownCities(anchors: string[]): Set<string> {
  const own = new Set<string>();
  for (const [city, names] of Object.entries(CITIES))
    if ([city, ...names].some((n) => anchors.some((a) => ` ${a} `.includes(` ${n} `)))) own.add(city);
  return own;
}

/** Cities a text names that are not this place's (and the text doesn't name one of its anchors either). */
export function otherCities(text: string, anchors: string[], own: Set<string>): string[] {
  const t = ` ${normalizeText(text)} `;
  if (anchors.some((a) => t.includes(` ${a} `))) return [];
  return citiesIn(text).filter((c) => !own.has(c));
}

// ---- the restaurant's name ---------------------------------------------------------------------

// Words that many restaurant names share: "Casa" Lucio is not "Casa" Lucas, "Bar" Cañete is not any bar.
const GENERIC_NAME = new Set(
  "the a an and of el la los las le les de del da di do du au aux chez casa bar cafe caffe restaurant restaurante ristorante trattoria osteria pizzeria taberna taverna tavern bistro bistrot brasserie bodega meson cantina kitchen grill house deli delicatessen diner tapas bakery".split(
    " ",
  ),
);

/** The distinctive words of a restaurant's name: "Dishoom Covent Garden" → ["dishoom"], "Katz's Delicatessen" → ["katz"]. */
export function brandWords(name: string, anchors: string[] = []): string[] {
  let n = ` ${normalizeText(name)} `;
  for (const a of anchors) n = n.replace(` ${a} `, " ");
  const all = n.split(" ").filter((w) => w.length >= 2);
  const distinctive = all.filter((w) => !GENERIC_NAME.has(w) && !/^\d+$/.test(w));
  return distinctive.length ? distinctive : all;
}

/** True if a text names the restaurant: every distinctive word of its name, as whole words. */
export function namesBrand(text: string, brand: string[]): boolean {
  if (!brand.length) return false;
  const t = ` ${normalizeText(text)} `;
  return brand.every((w) => t.includes(` ${w} `));
}

/** True if a URL names the restaurant: its host and path contain every distinctive word ("katzsdelicatessen.com"). */
export function urlNamesBrand(url: string, brand: string[]): boolean {
  if (!brand.length) return false;
  const words = urlWords(url);
  const compact = words.replace(/ /g, "");
  return brand.every((w) => (w.length >= 4 ? compact.includes(w) : ` ${words} `.includes(` ${w} `)));
}
