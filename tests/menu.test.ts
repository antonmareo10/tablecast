import { describe, expect, it } from "vitest";
import { cleanMenu, dropContradictedPrices, parseMenuEntry } from "../src/lib/menu";

// Entries as the writer copied them from a menu page flattened to one line (recorded Gjelina run).
describe("parseMenuEntry", () => {
  it("splits a name, its printed price and the description that follows", () => {
    expect(parseMenuEntry({ name: "Four Onion $24 Goat Cheese, Asiago, Parmesan, Thyme", price: 24 })).toEqual({
      name: "Four Onion",
      price: 24,
      description: "Goat Cheese, Asiago, Parmesan, Thyme",
      section: null,
    });
    expect(parseMenuEntry({ name: "Squash Blossom $29 Baby Zucchini, Cherry Tomato, Confit Garlic", price: 29 })).toEqual({
      name: "Squash Blossom",
      price: 29,
      description: "Baby Zucchini, Cherry Tomato, Confit Garlic",
      section: null,
    });
  });

  it("drops the tail of the previous dish's description glued before the name", () => {
    expect(parseMenuEntry({ name: "Fontina, Burrata Mushroom $27 Truffle Tremor, Fontina, Thyme Gruyère", price: 27 })).toMatchObject({
      name: "Burrata Mushroom",
      price: 27,
      description: "Truffle Tremor, Fontina, Thyme Gruyère",
    });
  });

  it("rejects an ingredient list copied in place of a dish name", () => {
    expect(parseMenuEntry({ name: "Bottarga, Confit Tomato, Garlic, Calabrian Chile, Breadcrumb", price: 32 })).toBeNull();
    expect(parseMenuEntry({ name: "Squash Blossom, Baby Zucchini, Confit Leek, Ricotta Salata, Arugula Smoked Salmon", price: 24 })).toBeNull();
    expect(parseMenuEntry({ name: "$25", price: 25 })).toBeNull();
  });

  it("leaves clean entries alone", () => {
    expect(parseMenuEntry({ name: "Saffron Spaghetti", price: 28 })).toEqual({ name: "Saffron Spaghetti", price: 28, description: null, section: null });
    expect(parseMenuEntry({ name: "Wagyu Beef Cheek Bolognese, Whipped Ricotta", price: 30 })?.name).toBe("Wagyu Beef Cheek Bolognese, Whipped Ricotta");
    expect(parseMenuEntry({ name: "Huevos estrellados", price: 12, section: "Entrantes" })).toEqual({
      name: "Huevos estrellados",
      price: 12,
      description: null,
      section: "Entrantes",
    });
  });

  it("only treats a number with a currency mark as a price", () => {
    expect(parseMenuEntry({ name: "Pizza 4 Formaggi", price: 14 })).toMatchObject({ name: "Pizza 4 Formaggi", price: 14, description: null });
    expect(parseMenuEntry({ name: "Ribeye 300 g", price: null })).toMatchObject({ name: "Ribeye 300 g", price: null });
  });

  it("reads prices in other formats and positions", () => {
    expect(parseMenuEntry({ name: "Latkes $16.95", price: null })).toMatchObject({ name: "Latkes", price: 16.95, description: null });
    expect(parseMenuEntry({ name: "Menú del día 15,50 € primero, segundo y postre", price: null })).toMatchObject({
      name: "Menú del día",
      price: 15.5,
      description: "primero, segundo y postre",
    });
    expect(parseMenuEntry({ name: "Fish pie — £18.50", price: null })).toMatchObject({ name: "Fish pie", price: 18.5 });
    expect(parseMenuEntry({ name: "Pastrami Sandwich US$30.95", price: 30.95 })).toMatchObject({ name: "Pastrami Sandwich", price: 30.95 });
    expect(parseMenuEntry({ name: "$25 Smoked Salmon", price: null })).toMatchObject({ name: "Smoked Salmon", price: 25, description: null });
  });
});

describe("cleanMenu", () => {
  it("drops non-dishes and repeats of the same dish", () => {
    const items = [
      { name: "Squash Blossom $29 Baby Zucchini, Cherry Tomato, Confit Garlic", price: 29 },
      { name: "Arugula Squash Blossom $29 Baby Zucchini, Cherry Tomato, Confit Garlic", price: 29 },
      { name: "Saffron Spaghetti", price: 28 },
      { name: "Bottarga, Confit Tomato, Garlic, Calabrian Chile, Breadcrumb", price: 32 },
      { name: "saffron spaghetti", price: 28 },
    ];
    expect(cleanMenu(items).map((e) => [e.name, e.price])).toEqual([
      ["Squash Blossom", 29],
      ["Saffron Spaghetti", 28],
    ]);
  });
});

describe("dropContradictedPrices (recorded runs)", () => {
  // The first 600 characters of gjelina.com/los-angeles-menus as the Gjelina replay (21 Oct) keeps them.
  const excerpt = [
    "$22",
    "Warm Crouton, Parmesan, Cream Anchovy Dressing",
    " Smoked Trout",
    "$22",
    "Arugula, Citrus, Avocado, Red Onion, Lemon & Olive Oil",
    " Le Puy Lentil Soup",
    "$22",
    "Cilantro, Dill, Spice Blend Oil",
    " Beef Tartare",
    "$27",
    "Sourdough, Dijon Mustard, Caper, Shallot",
    " $30",
    "Honeynut Squash, Miso Butter, Pepita Gremolata, Belper Knolle Cheese",
    " $27",
    "Cacio e Pepe",
    " Saffron Spaghetti",
    "$28",
    "Bottarga, Confit Tomato, Garlic, Calabrian Chile, Breadcrumb",
    " $32",
    "Wagyu Beef Cheek Bolognese, Whipped Ricotta",
    " Braised Pork Meatball",
    "$23",
    "Tomato Sauce, Parmesan, Sourdough Toast",
    " Grilled Squid",
    "$22",
    "Pickled Melon, Arugula, Cherry Tomato, Salsa Verde…",
  ].join(String.fromCharCode(10));
  const sources = [
    { kind: "menu" as const, text: excerpt },
    { kind: "weather" as const, text: "Wed 21 Oct: heavy rain, max 23°C / min 16°C, 22.4 mm" },
  ];

  it("drops the replay's “Cacio e Pepe $28”: the page prints $27 before it and $28 after the next dish", () => {
    const out = dropContradictedPrices(
      [
        { name: "Le Puy Lentil Soup", price: 22 },
        { name: "Cacio e Pepe", price: 28 },
        { name: "Saffron Spaghetti", price: 28 },
        { name: "Wagyu Beef Cheek Bolognese, Whipped Ricotta", price: 23 },
        { name: "BLT", price: 19 },
      ],
      sources,
    );
    expect(out.map((i) => [i.name, i.price])).toEqual([
      ["Le Puy Lentil Soup", 22],
      ["Cacio e Pepe", null],
      ["Saffron Spaghetti", 28],
      ["Wagyu Beef Cheek Bolognese, Whipped Ricotta", null],
      ["BLT", 19], // not in the saved text: it can't be settled, so it stays
    ]);
  });

  it("leaves items without a price and pages that aren't menus alone", () => {
    expect(dropContradictedPrices([{ name: "Smoked Trout", price: null }], sources)).toEqual([{ name: "Smoked Trout", price: null }]);
    expect(dropContradictedPrices([{ name: "Heavy Rain", price: 9 }], [{ kind: "weather", text: `Heavy Rain${String.fromCharCode(10)}$1` }])).toEqual([{ name: "Heavy Rain", price: 9 }]);
  });
});
