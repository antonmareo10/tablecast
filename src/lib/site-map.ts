// Tavily Map → the restaurant's own menu page, in code. Map lists the pages its site links to, keeping only
// paths that look like a menu (Tavily filters server-side with `select_paths`, so only those are billed); code
// ranks them, sets aside other branches' menus ("/las-vegas-menus" for a Los Angeles restaurant), and Tavily
// Extract reads the best one before the research model starts, so the plan stands on the real menu.

import { citiesIn, host, ownCities, urlWords } from "./place";
import { extract, map } from "./sources/tavily";

/** Server-side path filter for Tavily Map: pages whose path looks like a menu or food page. */
export const MENU_PATHS = [
  "/.*(menu|men%C3%BA|carta|carte|food|drink|lunch|dinner|brunch|breakfast|tapas|platos|bebidas|comida|cena|almuerzo|raciones|speisekarte).*",
];

const STRONG = /\b(menu|menus|carta|cartas|carte|speisekarte|food (and )?drinks?)\b/;
const WEAK = /\b(food|drinks?|lunch|dinner|brunch|breakfast|tapas|platos|bebidas|comida|cena|almuerzo|raciones)\b/;
// Pages that are not the dining menu: shop products, jobs, the blog, gift cards.
const NOT_MENU = /\b(store|shop|products?|gift|giftcards?|careers?|jobs?|blog|journal|press|login|account|cart|checkout|merch|apparel|recipes?)\b/;
// Menus, but not the everyday one.
const SIDE_MENU = /\b(catering|package|packages|delivery|collection|children|kids|christmas|valentines?|group|groups|feast|feasts|private|events?|allergens?)\b/;
// A drinks list says little about the food.
const DRINKS = /\b(drinks?|bebidas|wines?|cocktails?|bar)\b/;
const FOOD = /\b(food|lunch|dinner|brunch|breakfast|all day|tapas|platos|comida|cena|almuerzo|raciones|carta|carte)\b/;

export type MenuPagePick = { pages: string[]; otherBranches: string[] };

/**
 * Ranks the menu-like pages of a site map: this branch's menus first (the path names its city or neighbourhood),
 * then generic menu pages, then food pages; shop, job and blog pages are dropped, and menus whose path names
 * another city are set aside as another branch's.
 */
export function pickMenuPages(urls: string[], anchors: string[], max = 5): MenuPagePick {
  const own = ownCities(anchors);
  const otherBranches: string[] = [];
  const scored: { url: string; score: number; len: number }[] = [];
  for (const url of new Set(urls)) {
    let path: string;
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      continue;
    }
    const words = urlWords(path);
    const padded = ` ${words} `;
    if (!words || !(STRONG.test(words) || WEAK.test(words))) continue;
    // "/store/collections/food-and-drink" is a shop; "/store-menu" (Katz's) is the menu.
    const segments = path.split("/").filter(Boolean).map(urlWords);
    const last = segments.pop() ?? "";
    if (segments.some((s) => NOT_MENU.test(s)) || (NOT_MENU.test(last) && !STRONG.test(last))) continue;
    if (citiesIn(words).some((c) => !own.has(c)) && !anchors.some((a) => padded.includes(` ${a} `))) {
      otherBranches.push(url);
      continue;
    }
    let score = STRONG.test(words) ? 4 : 1;
    if (anchors.some((a) => padded.includes(` ${a} `))) score += 3;
    if (SIDE_MENU.test(words)) score -= 3;
    if (DRINKS.test(words) && !FOOD.test(words)) score -= 2;
    if (/\.pdf$/i.test(path)) score -= 1;
    if (score <= 0) continue; // a catering package that mentions lunch is not the menu
    scored.push({ url, score, len: path.split("/").filter(Boolean).length * 100 + path.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return { pages: scored.slice(0, max).map((s) => s.url), otherBranches };
}

// Websites that are a profile on someone else's platform: nothing of the restaurant's own to map.
const NOT_OWN_SITE = /(^|\.)(instagram|facebook|tiktok|linktr|tripadvisor|yelp|google|thefork|opentable|ubereats|deliveroo|glovo|just-eat|wixsite)\./i;

export function mappable(website: string | undefined): website is string {
  if (!website) return false;
  const h = host(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  return !!h && !NOT_OWN_SITE.test(`${h}.`);
}

export type MenuPagesResult = MenuPagePick & { credits: number | null; error?: string };

/** One Tavily Map call on the restaurant's site, filtered to menu pages and ranked for this branch. */
export async function findMenuPages(website: string, anchors: string[]): Promise<MenuPagesResult> {
  // A home page often links 100+ pages (Dishoom's: 137); Tavily's default breadth of 20 stops at the nav bar.
  const m = await map(website, { maxDepth: 1, maxBreadth: 150, limit: 150, selectPaths: MENU_PATHS, timeoutMs: 20_000 });
  return { ...pickMenuPages(m.urls, anchors), credits: m.credits, ...(m.error ? { error: m.error } : {}) };
}

/** Tavily Extract on the best menu page, focused on dishes and prices. */
export async function readMenuPage(url: string): Promise<{ page: { url: string; content: string } | null; credits: number | null; failed: boolean }> {
  const r = await extract([url], { query: "menu dishes and prices", chunksPerSource: 5 });
  return { page: r.results[0] ?? null, credits: r.credits, failed: r.failed.length > 0 };
}

/** "https://www.dishoom.com/menu/covent-garden-all-day" → "dishoom.com/menu/covent-garden-all-day". */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
