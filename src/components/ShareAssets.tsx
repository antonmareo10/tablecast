"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Playbook } from "@/lib/types";
import { IconDownload } from "./icons";
import { CopyButton, Section } from "./ui";

type Language = "English" | "Español";

export type ShareAssetsProps = {
  playbook: Playbook;
  /** Language of the text drawn on the images. Defaults to English. */
  language?: Language;
};

// ---------------------------------------------------------------------------
// Content spec: everything the images need, as plain serialisable data.
// ---------------------------------------------------------------------------

const PALETTE = {
  paper: "#f6f1e7",
  card: "#fffdf8",
  ink: "#1d1b17",
  ink2: "#4a4539",
  muted: "#8a8273",
  line: "#e2d8c4",
  olive: "#2f4a35",
  terracotta: "#c0532c",
  saffron: "#dd9a2e",
} as const;

const LABELS = {
  English: {
    kicker: "This week",
    footer: "Planned with live local data · Tablecast",
    comingUp: "Coming up",
    onTheMenu: "On the menu",
    fresh: "New",
    findUs: "Find us",
    emptyMenu: "Ask us about this week’s specials",
    fallbackName: "Our kitchen",
  },
  Español: {
    kicker: "Esta semana",
    footer: "Planificado con datos locales en vivo · Tablecast",
    comingUp: "Próximamente",
    onTheMenu: "En la carta",
    fresh: "Novedad",
    findUs: "Encuéntranos",
    emptyMenu: "Pregunta por las sugerencias de la semana",
    fallbackName: "Nuestra cocina",
  },
} satisfies Record<Language, Record<string, string>>;

type Labels = (typeof LABELS)[Language];

type DishSpec = { name: string; description: string; price: string | null };

type AssetSpec = {
  locale: string;
  labels: Labels;
  name: string;
  city: string;
  concept: string;
  event: string;
  dishes: DishSpec[];
};

function clean(text: string | null | undefined): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function formatPrice(value: number, currency: string, locale: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const digits = Number.isInteger(value) ? 0 : 2;
  const code = clean(currency).toUpperCase();
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    // Missing or invalid ISO 4217 code: plain number followed by whatever code we were given.
    const plain = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    return code ? `${plain} ${code}` : plain;
  }
}

function buildSpec(playbook: Playbook, language: Language): AssetSpec {
  const locale = language === "Español" ? "es-ES" : "en-GB";
  const labels = LABELS[language];
  return {
    locale,
    labels,
    name: clean(playbook.restaurant?.name) || labels.fallbackName,
    city: clean(playbook.restaurant?.city),
    concept: clean(playbook.restaurant?.concept),
    event: clean(playbook.experience?.event_idea),
    dishes: (playbook.menu_moves ?? [])
      .slice(0, 3)
      .map((m) => ({
        name: clean(m.dish),
        description: clean(m.description),
        price: formatPrice(m.price, playbook.currency, locale),
      }))
      .filter((d) => d.name),
  };
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "restaurant";
}

// ---------------------------------------------------------------------------
// Canvas text helpers
// ---------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
type Fonts = { display: string; sans: string };
type Align = "left" | "center" | "right";

function setFont(ctx: Ctx, family: string, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${family}`;
}

function supportsTracking(ctx: Ctx): boolean {
  return "letterSpacing" in ctx;
}

/** Draws one line of text; optional tracking (letter-spacing) is compensated so aligned text stays optically centred. */
function drawText(ctx: Ctx, text: string, x: number, y: number, align: Align = "left", tracking = 0) {
  ctx.textAlign = align;
  if (tracking && supportsTracking(ctx)) {
    ctx.letterSpacing = `${tracking}px`;
    // letter-spacing also adds space after the last glyph; shift so the visible ink is where we asked.
    const nudge = align === "center" ? tracking / 2 : align === "right" ? tracking : 0;
    ctx.fillText(text, x + nudge, y);
    ctx.letterSpacing = "0px";
    return;
  }
  ctx.fillText(text, x, y);
}

function textWidth(ctx: Ctx, text: string, tracking = 0): number {
  if (tracking && supportsTracking(ctx)) {
    ctx.letterSpacing = `${tracking}px`;
    const width = ctx.measureText(text).width - tracking;
    ctx.letterSpacing = "0px";
    return width;
  }
  return ctx.measureText(text).width;
}

const ELLIPSIS = "…";
const trimTrailing = (s: string) => s.replace(/[\s.,;:!?·–—-]+$/u, "");

/** Longest prefix of `text` that fits in `maxWidth` once an ellipsis is appended. */
function withEllipsis(ctx: Ctx, text: string, maxWidth: number): string {
  const chars = Array.from(text.trimEnd());
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(trimTrailing(chars.slice(0, mid).join("")) + ELLIPSIS).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return trimTrailing(chars.slice(0, lo).join("")) + ELLIPSIS;
}

/** Splits a single word that is wider than the line into chunks that fit (URLs, long compounds). */
function breakWord(ctx: Ctx, word: string, maxWidth: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of Array.from(word)) {
    if (current && ctx.measureText(current + ch).width > maxWidth) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Greedy word wrap using the context's current font. When the text needs more than
 * `maxLines`, the last kept line ends with an ellipsis.
 */
function wrapText(ctx: Ctx, text: string, maxWidth: number, maxLines = Infinity): string[] {
  const words = clean(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
    } else {
      const parts = breakWord(ctx, word, maxWidth);
      lines.push(...parts.slice(0, -1));
      line = parts[parts.length - 1] ?? "";
    }
  }
  if (line) lines.push(line);

  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return lines;
  const kept = lines.slice(0, limit);
  kept[limit - 1] = withEllipsis(ctx, kept[limit - 1], maxWidth);
  return kept;
}

type FitOptions = {
  family: string;
  weight: number;
  max: number;
  min: number;
  maxWidth: number;
  maxLines: number;
  lineHeight: number; // multiple of font size
  maxHeight?: number;
};

type Fit = { size: number; lines: string[]; fits: boolean };

/** Largest font size (max → min) at which the text wraps within maxLines/maxHeight; otherwise truncates at min. */
function fitText(ctx: Ctx, text: string, o: FitOptions): Fit {
  const step = 2;
  for (let size = o.max; size >= o.min; size -= step) {
    setFont(ctx, o.family, o.weight, size);
    const lines = wrapText(ctx, text, o.maxWidth);
    const tallEnough = o.maxHeight === undefined || lines.length * size * o.lineHeight <= o.maxHeight;
    if (lines.length <= o.maxLines && tallEnough) return { size, lines, fits: true };
  }
  setFont(ctx, o.family, o.weight, o.min);
  const byHeight = o.maxHeight === undefined ? o.maxLines : Math.floor(o.maxHeight / (o.min * o.lineHeight));
  const allowed = Math.max(1, Math.min(o.maxLines, byHeight));
  return { size: o.min, lines: wrapText(ctx, text, o.maxWidth, allowed), fits: false };
}

/** Fits one line by shrinking (down to `min`) and finally truncating with an ellipsis. */
function fitLine(ctx: Ctx, text: string, family: string, weight: number, max: number, min: number, maxWidth: number) {
  const fit = fitText(ctx, text, { family, weight, max, min, maxWidth, maxLines: 1, lineHeight: 1 });
  setFont(ctx, family, weight, fit.size);
  return { size: fit.size, text: fit.lines[0] ?? "" };
}

// ---------------------------------------------------------------------------
// Canvas drawing primitives
// ---------------------------------------------------------------------------

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser");
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx };
}

/** Fine dot grain, like the `.grain` utility on the page. */
function paintGrain(ctx: Ctx, color: string, alpha: number, x: number, y: number, w: number, h: number) {
  const tile = document.createElement("canvas");
  tile.width = 9;
  tile.height = 9;
  const t = tile.getContext("2d");
  if (!t) return;
  t.globalAlpha = alpha;
  t.fillStyle = color;
  t.beginPath();
  t.arc(4.5, 4.5, 1, 0, Math.PI * 2);
  t.fill();
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return;
  ctx.save();
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function rule(ctx: Ctx, x1: number, x2: number, y: number, color: string, width = 1.5, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function diamond(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function disc(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Menu-style dotted leader between a dish name and its price. */
function leaderDots(ctx: Ctx, x1: number, x2: number, y: number) {
  const step = 13;
  const count = Math.floor((x2 - x1) / step);
  if (count < 2) return;
  const start = x1 + (x2 - x1 - (count - 1) * step) / 2;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = PALETTE.muted;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(start + i * step, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Specials board, 1080 × 1350
// ---------------------------------------------------------------------------

type DishLayout = {
  dish: DishSpec;
  nameSize: number;
  nameLines: string[];
  priceSize: number;
  priceWidth: number;
  descLines: string[];
  height: number;
};

const DISH = { nameLH: 1.08, descSize: 28, descLH: 40, descGap: 50 };

function layoutDish(ctx: Ctx, dish: DishSpec, fonts: Fonts, width: number): DishLayout {
  let priceSize = 46;
  let priceWidth = 0;
  if (dish.price) {
    // Keep exotic/long prices from eating the dish name.
    for (; priceSize >= 30; priceSize -= 2) {
      setFont(ctx, fonts.display, 600, priceSize);
      priceWidth = ctx.measureText(dish.price).width;
      if (priceWidth <= width * 0.38) break;
    }
    priceSize = Math.max(30, priceSize);
  }
  const nameOpts = { family: fonts.display, weight: 600, maxWidth: dish.price ? width - priceWidth - 48 : width, lineHeight: DISH.nameLH };
  // Prefer a single line (slightly smaller) before wrapping to two.
  let name = fitText(ctx, dish.name, { ...nameOpts, max: 54, min: 44, maxLines: 1 });
  if (!name.fits) name = fitText(ctx, dish.name, { ...nameOpts, max: 50, min: 38, maxLines: 2 });
  setFont(ctx, fonts.sans, 400, DISH.descSize);
  const descLines = dish.description ? wrapText(ctx, dish.description, width, 2) : [];
  const nameHeight = name.size * 0.8 + (name.lines.length - 1) * name.size * DISH.nameLH;
  const descHeight = descLines.length ? DISH.descGap + (descLines.length - 1) * DISH.descLH + 10 : 14;
  return {
    dish,
    nameSize: name.size,
    nameLines: name.lines,
    priceSize,
    priceWidth,
    descLines,
    height: nameHeight + descHeight,
  };
}

function drawDish(ctx: Ctx, d: DishLayout, fonts: Fonts, x: number, top: number, width: number) {
  const lh = d.nameSize * DISH.nameLH;
  const firstBaseline = top + d.nameSize * 0.8;
  setFont(ctx, fonts.display, 600, d.nameSize);
  ctx.fillStyle = PALETTE.ink;
  d.nameLines.forEach((line, i) => drawText(ctx, line, x, firstBaseline + i * lh));
  const lastBaseline = firstBaseline + (d.nameLines.length - 1) * lh;
  const lastLineWidth = ctx.measureText(d.nameLines[d.nameLines.length - 1] ?? "").width;

  if (d.dish.price) {
    setFont(ctx, fonts.display, 600, d.priceSize);
    ctx.fillStyle = PALETTE.olive;
    drawText(ctx, d.dish.price, x + width, lastBaseline, "right");
    leaderDots(ctx, x + lastLineWidth + 18, x + width - d.priceWidth - 18, lastBaseline - 8);
  }

  if (d.descLines.length) {
    setFont(ctx, fonts.sans, 400, DISH.descSize);
    ctx.fillStyle = PALETTE.ink2;
    d.descLines.forEach((line, i) => drawText(ctx, line, x, lastBaseline + DISH.descGap + i * DISH.descLH));
  }
}

function drawSpecialsBoard(spec: AssetSpec, fonts: Fonts): string {
  const W = 1080;
  const H = 1350;
  const { canvas, ctx } = createCanvas(W, H);
  const L = spec.labels;
  const cx = W / 2;
  const left = 140;
  const contentW = W - left * 2;

  // Paper with a warm centre glow and fine grain.
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(cx, H * 0.38, 60, cx, H * 0.5, H * 0.75);
  glow.addColorStop(0, "rgba(255, 253, 248, 0.95)");
  glow.addColorStop(1, "rgba(255, 253, 248, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  paintGrain(ctx, PALETTE.ink, 0.05, 0, 0, W, H);

  // Double-rule frame with saffron corner points.
  ctx.strokeStyle = PALETTE.olive;
  ctx.lineWidth = 3;
  ctx.strokeRect(46, 46, W - 92, H - 92);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.25;
  ctx.strokeRect(60, 60, W - 120, H - 120);
  ctx.restore();
  for (const [x, y] of [
    [60, 60],
    [W - 60, 60],
    [60, H - 60],
    [W - 60, H - 60],
  ]) {
    diamond(ctx, x, y, 7, PALETTE.saffron);
  }

  // Kicker with flanking rules.
  let y = 176;
  setFont(ctx, fonts.sans, 600, 24);
  ctx.fillStyle = PALETTE.terracotta;
  const kicker = L.kicker.toLocaleUpperCase(spec.locale);
  drawText(ctx, kicker, cx, y, "center", 7);
  const kw = textWidth(ctx, kicker, 7);
  rule(ctx, cx - kw / 2 - 96, cx - kw / 2 - 24, y - 9, PALETTE.terracotta, 1.5, 0.7);
  rule(ctx, cx + kw / 2 + 24, cx + kw / 2 + 96, y - 9, PALETTE.terracotta, 1.5, 0.7);

  // Restaurant name: one line if it fits at a generous size, else two smaller lines.
  const nameOpts = { family: fonts.display, weight: 600, maxWidth: contentW, lineHeight: 1.04 };
  let name = fitText(ctx, spec.name, { ...nameOpts, max: 112, min: 72, maxLines: 1 });
  if (!name.fits) name = fitText(ctx, spec.name, { ...nameOpts, max: 72, min: 52, maxLines: 2 });
  setFont(ctx, fonts.display, 600, name.size);
  ctx.fillStyle = PALETTE.ink;
  y += 40 + name.size * 0.78;
  name.lines.forEach((line, i) => drawText(ctx, line, cx, y + i * name.size * 1.04, "center"));
  y += (name.lines.length - 1) * name.size * 1.04;

  // Concept · city.
  const place = [spec.concept, spec.city].filter(Boolean).join(" · ");
  if (place) {
    y += 56;
    setFont(ctx, fonts.sans, 400, 26);
    ctx.fillStyle = PALETTE.ink2;
    drawText(ctx, wrapText(ctx, place, contentW, 1)[0] ?? "", cx, y, "center");
  }

  // Ornamental divider.
  y += 52;
  rule(ctx, cx - 132, cx - 22, y, PALETTE.olive, 1.25, 0.5);
  rule(ctx, cx + 22, cx + 132, y, PALETTE.olive, 1.25, 0.5);
  diamond(ctx, cx, y, 7, PALETTE.saffron);
  const regionTop = y + 44;

  // Footer.
  const footerY = H - 108;
  rule(ctx, cx - 36, cx + 36, footerY - 44, PALETTE.olive, 1.25, 0.4);
  const footer = L.footer.toLocaleUpperCase(spec.locale);
  let footerSize = 18;
  setFont(ctx, fonts.sans, 600, footerSize);
  while (footerSize > 13 && textWidth(ctx, footer, 4) > contentW) {
    footerSize -= 1;
    setFont(ctx, fonts.sans, 600, footerSize);
  }
  ctx.fillStyle = PALETTE.muted;
  drawText(ctx, footer, cx, footerY, "center", 4);
  const regionBottom = footerY - 76;
  const available = regionBottom - regionTop;

  // Menu moves, centred vertically in the space between header and footer.
  if (spec.dishes.length === 0) {
    setFont(ctx, fonts.display, 500, 44);
    ctx.fillStyle = PALETTE.ink2;
    const lines = wrapText(ctx, L.emptyMenu, contentW, 2);
    const mid = regionTop + available / 2;
    lines.forEach((line, i) => drawText(ctx, line, cx, mid + (i - (lines.length - 1) / 2) * 54 + 14, "center"));
  } else {
    const blocks = spec.dishes.map((d) => layoutDish(ctx, d, fonts, contentW));
    const total = blocks.reduce((s, b) => s + b.height, 0);
    const gaps = blocks.length - 1;
    const gap = gaps ? Math.min(96, Math.max(32, (available - total) / (gaps + 2))) : 0;
    let top = regionTop + Math.max(0, (available - total - gap * gaps) / 2);
    blocks.forEach((block, i) => {
      drawDish(ctx, block, fonts, left, top, contentW);
      top += block.height;
      if (i < gaps) {
        rule(ctx, cx - 44, cx + 44, top + gap / 2, PALETTE.line, 2);
        top += gap;
      }
    });
  }

  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Instagram post, 1080 × 1080
// ---------------------------------------------------------------------------

function drawInstagramPost(spec: AssetSpec, fonts: Fonts): string {
  const W = 1080;
  const H = 1080;
  const split = 640; // bottom edge of the olive block
  const band = 340; // width of the terracotta block
  const pad = 84;
  const { canvas, ctx } = createCanvas(W, H);
  const L = spec.labels;
  const paperSoft = "rgba(246, 241, 231, 0.88)";

  // Colour blocks: olive top, terracotta lower-left, paper lower-right, saffron disc where they meet.
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, W, H);
  paintGrain(ctx, PALETTE.ink, 0.045, band, split, W - band, H - split);

  ctx.fillStyle = PALETTE.olive;
  ctx.fillRect(0, 0, W, split);
  const sheen = ctx.createLinearGradient(0, 0, W, split);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.07)");
  sheen.addColorStop(1, "rgba(0, 0, 0, 0.1)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, split);
  paintGrain(ctx, PALETTE.paper, 0.08, 0, 0, W, split);

  ctx.fillStyle = PALETTE.terracotta;
  ctx.fillRect(0, split, band, H - split);
  paintGrain(ctx, PALETTE.paper, 0.07, 0, split, band, H - split);
  disc(ctx, band, split, 46, PALETTE.saffron);

  // Restaurant name + saffron rule.
  const maxW = W - pad * 2;
  const name = fitLine(ctx, spec.name, fonts.display, 600, 46, 30, maxW);
  ctx.fillStyle = PALETTE.paper;
  drawText(ctx, name.text, pad, 132);
  rule(ctx, pad, pad + 64, 170, PALETTE.saffron, 4);

  // Event idea as the headline, anchored to the bottom of the olive block, kicker right above it.
  const headTop = 270;
  const headBottom = split - 70;
  const headline = fitText(ctx, spec.event || spec.concept || spec.name, {
    family: fonts.display,
    weight: 600,
    max: 104,
    min: 50,
    maxWidth: maxW,
    maxLines: 5,
    lineHeight: 1.04,
    maxHeight: headBottom - headTop,
  });
  const hlh = headline.size * 1.04;
  const lastBaseline = headBottom - headline.size * 0.2;
  const firstBaseline = lastBaseline - (headline.lines.length - 1) * hlh;
  setFont(ctx, fonts.display, 600, headline.size);
  ctx.fillStyle = PALETTE.paper;
  headline.lines.forEach((line, i) => drawText(ctx, line, pad, firstBaseline + i * hlh));

  setFont(ctx, fonts.sans, 600, 24);
  ctx.fillStyle = PALETTE.saffron;
  drawText(ctx, L.comingUp.toLocaleUpperCase(spec.locale), pad, firstBaseline - headline.size * 0.8 - 34, "left", 7);

  // Terracotta block: "New" + the teaser dish's price.
  const dish = spec.dishes[0];
  const bandPad = 56;
  if (dish) {
    setFont(ctx, fonts.sans, 600, 22);
    ctx.fillStyle = paperSoft;
    drawText(ctx, L.fresh.toLocaleUpperCase(spec.locale), bandPad, 736, "left", 6);
  }
  if (dish?.price) {
    const price = fitLine(ctx, dish.price, fonts.display, 600, 84, 34, band - bandPad * 2);
    ctx.fillStyle = PALETTE.paper;
    drawText(ctx, price.text, bandPad, H - 84);
  }

  // Paper block: the first menu move as a teaser.
  const x0 = band + 72;
  const tw = W - x0 - 76;
  const footerBaseline = H - 64;
  let y = 736;
  setFont(ctx, fonts.sans, 600, 22);
  ctx.fillStyle = PALETTE.terracotta;
  drawText(ctx, (dish ? L.onTheMenu : L.findUs).toLocaleUpperCase(spec.locale), x0, y, "left", 6);

  const teaser = dish?.name || [spec.concept, spec.city].filter(Boolean).join(" · ") || spec.name;
  const dn = fitText(ctx, teaser, {
    family: fonts.display,
    weight: 600,
    max: 60,
    min: 38,
    maxWidth: tw,
    maxLines: 2,
    lineHeight: 1.06,
  });
  setFont(ctx, fonts.display, 600, dn.size);
  ctx.fillStyle = PALETTE.ink;
  y += 30 + dn.size * 0.8;
  dn.lines.forEach((line, i) => drawText(ctx, line, x0, y + i * dn.size * 1.06));
  y += (dn.lines.length - 1) * dn.size * 1.06;

  if (dish?.description) {
    const descLH = 37;
    const first = y + 44;
    const room = Math.floor((footerBaseline - 40 - first) / descLH) + 1;
    const maxLines = Math.min(3, room);
    if (maxLines > 0) {
      setFont(ctx, fonts.sans, 400, 26);
      ctx.fillStyle = PALETTE.ink2;
      wrapText(ctx, dish.description, tw, maxLines).forEach((line, i) => drawText(ctx, line, x0, first + i * descLH));
    }
  }

  if (spec.city) {
    const city = spec.city.toLocaleUpperCase(spec.locale);
    setFont(ctx, fonts.sans, 600, 18);
    ctx.fillStyle = PALETTE.muted;
    const fitted = textWidth(ctx, city, 4) <= tw ? city : withEllipsis(ctx, city, tw - 40);
    drawText(ctx, fitted, x0, footerBaseline, "left", 4);
  }

  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Fonts + rendering pipeline
// ---------------------------------------------------------------------------

async function prepareFonts(): Promise<Fonts> {
  const root = getComputedStyle(document.documentElement);
  const fraunces = root.getPropertyValue("--font-fraunces").trim();
  const inter = root.getPropertyValue("--font-inter").trim();
  const fonts: Fonts = {
    display: [fraunces, 'Georgia, "Times New Roman", serif'].filter(Boolean).join(", "),
    sans: [inter, '"Helvetica Neue", Arial, sans-serif'].filter(Boolean).join(", "),
  };

  if ("fonts" in document) {
    // Ask for the exact faces we draw with (a face unused on the page would otherwise never load),
    // then wait for the font set to settle. Never block the previews for more than a few seconds.
    const sample = "Aa Éé Ññ €£$ 0123456789";
    const faces = [`600 64px ${fonts.display}`, `500 64px ${fonts.display}`, `400 28px ${fonts.sans}`, `600 24px ${fonts.sans}`];
    const loaded = Promise.allSettled(faces.map((f) => document.fonts.load(f, sample))).then(() => document.fonts.ready);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
  return fonts;
}

async function renderAssets(spec: AssetSpec): Promise<{ specials: string; instagram: string }> {
  const fonts = await prepareFonts();
  return { specials: drawSpecialsBoard(spec, fonts), instagram: drawInstagramPost(spec, fonts) };
}

type RenderState =
  | { signature: string; status: "ready"; specials: string; instagram: string }
  | { signature: string; status: "error" };

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export function ShareAssets({ playbook, language = "English" }: ShareAssetsProps) {
  const spec = useMemo(() => buildSpec(playbook, language), [playbook, language]);
  // Content-based key: images are only redrawn when what they show actually changes.
  const signature = useMemo(() => JSON.stringify(spec), [spec]);
  const [rendered, setRendered] = useState<RenderState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const current = JSON.parse(signature) as AssetSpec;
    renderAssets(current).then(
      (images) => {
        if (!cancelled) setRendered({ signature, status: "ready", ...images });
      },
      (error: unknown) => {
        console.error("ShareAssets: could not draw the images", error);
        if (!cancelled) setRendered({ signature, status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signature]);

  const state = rendered?.signature === signature ? rendered : null;
  const status = state?.status ?? "loading";
  const images = state?.status === "ready" ? state : null;
  const slug = slugify(spec.name);
  const caption = playbook.marketing?.instagram_post?.trim() ?? "";

  const boardAlt = [
    `${spec.labels.kicker} specials board for ${spec.name}${spec.city ? ` in ${spec.city}` : ""}`,
    spec.dishes.length
      ? `: ${spec.dishes.map((d) => (d.price ? `${d.name} (${d.price})` : d.name)).join(", ")}.`
      : ".",
  ].join("");
  const teaser = spec.dishes[0];
  const postAlt = `Square Instagram image for ${spec.name} announcing “${spec.event || spec.name}”${
    teaser ? `, with ${teaser.name}${teaser.price ? ` (${teaser.price})` : ""} as a teaser from the menu` : ""
  }.`;

  return (
    <Section icon={<IconDownload size={16} />} kicker="Ready to use" title="Print it, post it">
      <p className="mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
        Two images drawn from this playbook: a specials board for the window or the counter, and a square post for
        Instagram. Download and use them as they are.
      </p>
      <div className="grid gap-5 lg:grid-cols-2">
        <AssetCard
          title="Specials board"
          meta="1080 × 1350 PNG · print or screen"
          src={images?.specials}
          status={status}
          alt={boardAlt}
          width={1080}
          height={1350}
          filename={`${slug}-specials-board.png`}
        />
        <AssetCard
          title="Instagram post"
          meta="1080 × 1080 PNG · square feed post"
          src={images?.instagram}
          status={status}
          alt={postAlt}
          width={1080}
          height={1080}
          filename={`${slug}-instagram-post.png`}
        >
          {caption && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Caption</p>
                <CopyButton text={caption} label="Copy caption" />
              </div>
              <p className="whitespace-pre-line rounded-lg border border-line bg-card p-3 text-sm leading-relaxed">
                {caption}
              </p>
            </div>
          )}
        </AssetCard>
      </div>
    </Section>
  );
}

export default ShareAssets;

function AssetCard({
  title,
  meta,
  src,
  status,
  alt,
  width,
  height,
  filename,
  children,
}: {
  title: string;
  meta: string;
  src?: string;
  status: "loading" | "ready" | "error";
  alt: string;
  width: number;
  height: number;
  filename: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  const ready = status === "ready" && Boolean(src);

  return (
    <article aria-labelledby={headingId} className="flex flex-col rounded-xl border border-line bg-paper/50 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={headingId} className="font-display text-lg leading-tight">
            {title}
          </h4>
          <p className="mt-0.5 text-xs text-muted">{meta}</p>
        </div>
        {ready ? (
          <a
            href={src}
            download={filename}
            className="no-print inline-flex shrink-0 items-center gap-1.5 rounded-full border border-olive bg-olive px-3.5 py-1.5 text-xs font-medium text-paper transition hover:border-olive-2 hover:bg-olive-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-olive"
          >
            <IconDownload size={14} />
            Download PNG<span className="sr-only">: {title.toLowerCase()}</span>
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="no-print inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 rounded-full border border-line bg-paper px-3.5 py-1.5 text-xs font-medium text-muted"
          >
            <IconDownload size={14} />
            {status === "error" ? "Unavailable" : "Preparing…"}
          </button>
        )}
      </div>

      <div className="mx-auto w-full max-w-md">
        {ready ? (
          // eslint-disable-next-line @next/next/no-img-element -- client-generated data URL; next/image adds nothing here
          <img
            src={src}
            alt={alt}
            width={width}
            height={height}
            className="block h-auto w-full rounded-lg border border-line bg-card shadow-[0_10px_30px_-18px_rgba(29,27,23,0.45)]"
          />
        ) : (
          <div
            role="status"
            style={{ aspectRatio: `${width} / ${height}` }}
            className={`grid w-full place-items-center rounded-lg border border-line bg-paper-2 px-6 text-center text-xs text-muted ${
              status === "loading" ? "motion-safe:animate-pulse" : ""
            }`}
          >
            {status === "error"
              ? "This browser couldn’t draw the preview. Try another browser to download the image."
              : `Drawing the ${title.toLowerCase()}…`}
          </div>
        )}
      </div>
      {children}
    </article>
  );
}
