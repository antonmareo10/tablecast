import { describe, expect, it } from "vitest";
import { isAboutPlace, placeAnchors } from "@/lib/agent";

describe("same-name restaurants", () => {
  const madrid = placeAnchors({ city: "Madrid", address: "Calle de la Cava Baja 35, 28005 Madrid" });

  it("anchors a place to its city, the distinctive part of its street and its postcode", () => {
    expect(madrid).toEqual(expect.arrayContaining(["madrid", "cava baja", "28005"]));
    const la = placeAnchors({ city: "Los Angeles", address: "Abbot Kinney Boulevard 1429, 90291 Los Angeles" });
    expect(la).toEqual(expect.arrayContaining(["los angeles", "venice", "abbot kinney", "90291"]));
  });

  it("sets aside a page about a same-name restaurant in another town", () => {
    const text = "Carta – Restaurante Casa Lucio de Barco de Ávila. Carrilleras a la reducción Pedro Ximénez 18€. Judías de Barco con chorizo.";
    expect(isAboutPlace("https://restaurantecasalucio.com/carta", text, madrid, "casalucio.es")).toBe(false);
  });

  it("keeps the restaurant's own site, and pages that mention its city or street", () => {
    expect(isAboutPlace("https://www.casalucio.es/carta", "Huevos estrellados", madrid, "casalucio.es")).toBe(true);
    expect(isAboutPlace("https://guide.example/a", "Casa Lucio, on Cava Baja, is famous for its eggs", madrid, null)).toBe(true);
    expect(isAboutPlace("https://news.example/madrid-weekend", "What to do this weekend", madrid, null)).toBe(true);
  });
});
