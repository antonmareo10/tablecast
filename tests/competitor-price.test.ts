import { describe, expect, it } from "vitest";
import {
  attributionContext,
  blockVenueNames,
  clauses,
  competitorPriceFlags,
  misattributed,
  proseFields,
  unbackedAmounts,
  unbackedLabel,
  venueAliases,
  type PlanText,
} from "@/lib/amounts";
import type { Evidence } from "@/lib/types";

// The Gjelina replay's block (OpenStreetMap lines as the agent writes them) and the claims it verified.
const BLOCK = [
  "Within 600 m: 21 food & drink venues — 8 restaurants, 5 cafes, 5 fast-food places, 2 bars, 1 pub",
  "Gjelina — restaurant, 0 m away",
  "GTA (Gjelina Take Away) — fast food, 9 m away",
  "The Brig — bar, 71 m away",
  "Abbot's Pizza Company — restaurant, pizza, 73 m away",
  "Cha Cha Matcha — cafe, tea, 85 m away",
  "TBD — restaurant, 151 m away",
].join("\n");

const claim = (text: string): Evidence => ({ text, cites: [], verified: true });
const CLAIMS = [
  claim("Pomodoro pizza at Gjelina is $22; Abbot's Pizza Company is a pizza restaurant 73 m away."),
  claim("Le Puy Lentil Soup is priced at $22 on the current menu."),
];

function ctx(claims = CLAIMS) {
  return attributionContext(
    blockVenueNames([{ kind: "block", text: BLOCK }], "Gjelina"),
    [
      { name: "Rain Bowl — Braised White Bean & Kale Stew", price: 22 },
      { name: "Pomodoro", price: 22 },
      { name: "Le Puy Lentil Soup", price: 22 },
    ],
    claims,
  );
}

describe("competitor prices in the plan's text (v7.1)", () => {
  it("reads the block's venues, without the restaurant and its own takeaway", () => {
    expect(blockVenueNames([{ kind: "block", text: BLOCK }], "Gjelina")).toEqual(["The Brig", "Abbot's Pizza Company", "Cha Cha Matcha", "TBD"]);
  });

  it("knows the short ways a plan writes a venue, but not a street that shares a word", () => {
    expect(venueAliases("Abbot's Pizza Company")).toContain("abbot s");
    expect(venueAliases("The Brig")).toContain("brig");
    expect(venueAliases("TBD")).toEqual([]);
    expect(misattributed("Abbot Kinney strollers pay $32 for the board", "$32", ctx())).toBeNull();
  });

  it("splits clauses at commas, semicolons and joining words, not inside numbers or brackets", () => {
    expect(clauses("the nearest pizza is $22 at Abbot's, while Gjelina's Pomodoro is also $22.").map((c) => c.text.trim())).toEqual([
      "the nearest pizza is $22 at Abbot's",
      "Gjelina's Pomodoro is also $22",
    ]);
    expect(clauses("Sits between Orecchiette ($32) and Black Cod at 1,200 covers").map((c) => c.text.trim())).toEqual([
      "Sits between Orecchiette ($32)",
      "Black Cod at 1,200 covers",
    ]);
  });

  it("flags the replay's invented competitor price, not the restaurant's own one in the same sentence", () => {
    const text = "No other Italian lunch exists on the block; the nearest pizza is $22 at Abbot's, while Gjelina's Pomodoro is also $22.";
    const pb = { rivals: { summary: text } } as unknown as PlanText;
    const field = proseFields({ ...plan(), ...pb }).filter((f) => f.where === "rivals.summary");
    expect(unbackedAmounts(field, new Set(["22"]), ctx()).unbacked).toEqual([{ where: "rivals.summary", amount: "$22", venue: "Abbot's Pizza Company" }]);
    // Without the attribution context the number check alone passes both, as before v7.1.
    expect(unbackedAmounts(field, new Set(["22"])).unbacked).toEqual([]);
  });

  it("accepts a competitor price a checked claim gives, and the restaurant's own dish named next to a competitor", () => {
    const withPrice = ctx([...CLAIMS, claim("Abbot's Pizza Company sells a cheese slice for $4.50.")]);
    expect(misattributed("a slice at Abbot's costs $4.50", "$4.50", withPrice)).toBeNull();
    expect(misattributed("a slice at Abbot's costs $4.50", "$4.50", ctx())).toBe("Abbot's Pizza Company");
    expect(misattributed("our $22 Pomodoro against Abbot's slices", "$22", ctx())).toBeNull();
    expect(misattributed("The Brig pours $8 pints", "$8", ctx())).toBe("The Brig");
  });

  it("labels it for the owner", () => {
    expect(unbackedLabel({ where: "your block", amount: "$22", venue: "Abbot's Pizza Company" })).toBe(
      "$22 (your block: next to Abbot's Pizza Company, which no source prices)",
    );
    expect(unbackedLabel({ where: "headline", amount: "$24" })).toBe("$24 (headline)");
  });

  it("runs late on a written plan, from the block's venues and the menu the browser holds", () => {
    const pb = {
      ...plan(),
      restaurant: { name: "Gjelina" },
      snapshot: { summary: "", loved_for: [], watch_outs: [] },
      moments: [],
      rivals: { summary: "The nearest pizza is $22 at Abbot's.", evidence: CLAIMS },
      experience: { event_idea: "", event_why: "", evidence: [] },
    };
    const venues = [
      { name: "Gjelina", distance_m: 0 },
      { name: "Abbot's Pizza Company", distance_m: 73 },
    ];
    expect(competitorPriceFlags(pb, venues, [{ name: "Pomodoro", price: 22 }])).toEqual([
      { where: "your block", amount: "$22", venue: "Abbot's Pizza Company" },
    ]);
  });
});

function plan(): PlanText {
  return {
    headline: "",
    snapshot: { summary: "" },
    moments: [],
    menu_moves: [{ dish: "Rain Bowl — Braised White Bean & Kale Stew", description: "", why: "", price: 22, evidence: [] }],
    rivals: { summary: "" },
    experience: { event_idea: "", event_why: "" },
    marketing: { instagram_post: "" },
    week_plan: [],
  };
}
