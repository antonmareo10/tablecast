// Menu entries for display ("On your menu now"). The writer copies dish names from a menu page's text,
// and pages flattened to one line run each dish into the next: "Four Onion $24 Goat Cheese, Asiago,
// Parmesan, Thyme" is a name, a price and a description, and "Bottarga, Confit Tomato, Garlic, Calabrian
// Chile, Breadcrumb" is the description of the dish before it, not a dish. This splits the first kind
// and drops the second. Display only: the verifier never reads these entries.

import type { MenuItem } from "./types";

export type MenuEntry = { name: string; price: number | null; description: string | null; section: string | null };

// A price with its currency mark, before or after the number: "$24", "US$ 24.00", "€12", "12,50 €", "15.50 EUR".
// A bare number is never taken for a price ("Pizza 4 Formaggi", "Ribeye 300 g").
const PRICE =
  /(?:(?:US|CA|AU|NZ)?\$|€|£|¥)\s?(\d{1,4}(?:[.,]\d{1,2})?)(?![\d.,]*\d)|(?<![\w.,])(\d{1,4}(?:[.,]\d{1,2})?)\s?(?:€|£|EUR|USD|GBP)(?![A-Za-z])/;

// Separators left at the edges once a price is cut out ("Mushroom —", ": Truffle…").
const EDGE_JUNK = /^[\s\-–—:·|,;/]+|[\s\-–—:·|,;/]+$/g;

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(EDGE_JUNK, "").trim();

/** Three or more comma-separated parts is an ingredient list, not a dish name. */
function isIngredientList(s: string): boolean {
  return s.split(",").filter((p) => p.trim()).length >= 3;
}

/**
 * Splits one entry into name / price / description; null when it is not a dish (an ingredient list, or
 * nothing left once the price is cut out). The price printed next to the name wins over the given one.
 */
export function parseMenuEntry(item: MenuItem): MenuEntry | null {
  const text = tidy(item.name ?? "");
  let name = text;
  let description: string | null = null;
  let price = item.price ?? null;

  const m = PRICE.exec(text);
  if (m) {
    const before = tidy(text.slice(0, m.index));
    const after = tidy(text.slice(m.index + m[0].length));
    const printed = Number((m[1] ?? m[2]).replace(",", "."));
    if (Number.isFinite(printed)) price = printed;
    if (before) {
      // "…, Fontina, Burrata Mushroom $27": the commas before the name belong to the previous dish's description.
      name = tidy(before.includes(",") ? before.slice(before.lastIndexOf(",") + 1) : before);
      description = after || null;
    } else {
      name = after; // "$25 Squash Blossom": price first
    }
  }

  if (name.length < 2 || isIngredientList(name)) return null;
  return { name, price, description, section: item.section ?? null };
}

const key = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Parses every entry, drops what isn't a dish and removes repeats (same name, or same price and description). */
export function cleanMenu(items: MenuItem[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  const names = new Set<string>();
  const dishes = new Set<string>();
  for (const item of items) {
    const e = parseMenuEntry(item);
    if (!e) continue;
    const n = key(e.name);
    const d = e.description ? `${e.price ?? ""}|${key(e.description)}` : null;
    if (names.has(n) || (d && dishes.has(d))) continue;
    names.add(n);
    if (d) dishes.add(d);
    out.push(e);
  }
  return out;
}
