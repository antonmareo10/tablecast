// node scripts/video/record-otari-demo.mjs [--plan] [--test] [--no-live | --live] [--only A-B] [--keep-frames] [--voz DIR] [--out FILE] [--base URL]
//
// Records the Otari demo video (MozFest Developers Wilding) as a real screen recording of the deployed app and of the
// branch on GitHub, with Antón's own recorded voice as the only audio. Nothing here generates speech or images.
//
//   1. Reads the 16 lines of the script (voz_lineas.json) and Antón's clips voz/01.wav ... 16.wav; each scene lasts its
//      clip plus 0.6 s. A missing clip gets a placeholder length (words / 2.3 s) and silence: the output is then
//      tablecast_otari_demo_TEST.mp4, to check the pictures before the voice exists.
//   2. Drives a headless Edge/Chrome over the DevTools protocol (scripts/video/cdp.mjs): the app at
//      https://tablecast-otari.vercel.app (the recorded Taberna La Bola run, the Otari panel, the drill, the guardrail
//      check) and the otari-wilding branch on GitHub. Frames come from the browser's own screencast.
//   3. Cuts one window per scene, burns in the line being spoken (Antón's text, verbatim) under the page, cleans the
//      voice lightly (high-pass, gentle gate, loudness) and encodes H.264 + AAC with ffmpeg.
//
// The two buttons that call Otari live ("Send one request to tablecast-drill", "Try it: send a poisoned review") are
// pressed only in the final take (all 16 clips present) or with --live; --no-live hovers them instead.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "./cdp.mjs";
import { OVERLAY } from "./overlay.mjs";
import { REPLAY_SHIM } from "./replay-shim.mjs";

// ---- options ----------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DATA = opt("--data", process.env.OTARI_DATA ?? "C:/Users/anton/data/otari");
const VOZ = opt("--voz", path.join(DATA, "voz"));
const OUT_DIR = path.join(DATA, "video");
const WORK = path.join(OUT_DIR, "work");
const BASE = opt("--base", "https://tablecast-otari.vercel.app").replace(/\/$/, "");
// File views of the branch (not the repo page, whose About box belongs to the earlier Nebius entry)
const GH_README = "https://github.com/antonmareo10/tablecast/blob/otari-wilding/README.md";
const GH_SETUP = "https://github.com/antonmareo10/tablecast/blob/otari-wilding/docs/OTARI_SETUP.md";
const FFMPEG =
  process.env.FFMPEG ??
  "C:/Users/anton/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe";
const FFPROBE = process.env.FFPROBE ?? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");

// Page area 1440 x 708 CSS px at 4/3 = 1920 x 944 video px; the 136 px band under it carries the captions, so they never
// cover the page.
const CSS_W = 1440;
const CSS_H = 708;
const SCALE = 4 / 3;
const VID_W = 1920;
const PAGE_H = 944;
const VID_H = 1080;
const FPS = 30;
const LEAD = 0.25; // silence before each clip (the picture moves first)
const TAIL = 0.35; // silence after it
const WPS = 2.3; // placeholder speaking rate, words per second

// ---- the script and the clips -------------------------------------------------------------------------------------
const LINES = JSON.parse(fs.readFileSync(path.join(DATA, "voz_lineas.json"), "utf8"));
if (!Array.isArray(LINES) || LINES.length !== 16) throw new Error("voz_lineas.json must hold the 16 lines of the script");

function probeDuration(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read the length of ${file}`);
  return d;
}

/** The loudest point of a clip in dBFS (thresholds below follow it, so a quiet recording still works). */
function peak(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr ?? "");
  return m ? Number(m[1]) : -10;
}

/**
 * The recorder starts on Enter and stops a moment after the next one, so a clip has silence at both ends: cut it to
 * 0.1 s before the first word and after the last one (into work/clips). The original files are never changed.
 */
function trimmed(file, i) {
  const dir = path.join(WORK, "clips");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${String(i + 1).padStart(2, "0")}.wav`);
  const th = `${Math.max(-65, Math.min(-30, peak(file) - 34)).toFixed(1)}dB`;
  const cut = `silenceremove=start_periods=1:start_duration=0:start_threshold=${th}:start_silence=0.1`;
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-af", `${cut},areverse,${cut},areverse`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  const before = probeDuration(file);
  const after = probeDuration(out);
  return after > Math.min(0.8, before * 0.5) ? out : file;
}

/** Pauses inside a clip (midpoints, seconds), to put caption changes where Antón actually pauses. */
function pauses(file, dur) {
  const th = `${Math.max(-60, Math.min(-28, peak(file) - 28)).toFixed(1)}dB`;
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${th}:d=0.22`, "-f", "null", "-"], { encoding: "utf8" });
  const text = `${r.stderr ?? ""}`;
  const starts = [...text.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i) => (s + (ends[i] ?? dur)) / 2).filter((m) => m > 0.4 && m < dur - 0.4);
}

const forceTest = flag("--test");
const clips = LINES.map((text, i) => {
  const file = path.join(VOZ, `${String(i + 1).padStart(2, "0")}.wav`);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!forceTest && fs.existsSync(file)) {
    const clip = trimmed(file, i);
    const dur = probeDuration(clip);
    return { file: clip, source: file, text, dur, real: true, pauses: pauses(clip, dur) };
  }
  return { file: null, text, dur: words / WPS, real: false, pauses: [] };
});
const FINAL = clips.every((c) => c.real);
// --only A-B: record just those scenes and save check frames (for scenes that need no earlier state: 12, 13)
const ONLY = opt("--only", null)?.split("-").map(Number).map((v, _, a) => v || a[0]);
if (ONLY && (ONLY.length !== 2 || ONLY.some((v) => !(v >= 1 && v <= LINES.length)) || ONLY[0] > ONLY[1])) throw new Error("--only takes a range like 12-13");
const LIVE = FINAL ? !flag("--no-live") : flag("--live");
const OUT = path.resolve(opt("--out", path.join(OUT_DIR, FINAL ? "tablecast_otari_demo.mp4" : "tablecast_otari_demo_TEST.mp4")));
const missing = clips.map((c, i) => (c.real ? null : String(i + 1).padStart(2, "0"))).filter(Boolean);

// ---- captions: each line in chunks of at most ~2 lines on screen ---------------------------------------------------
const MAX_CHARS = 96;
function chunk(text) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out = [];
  const split = (s) => {
    if (s.length <= MAX_CHARS) return out.push(s);
    const mid = s.length / 2;
    const cands = [...s.matchAll(/[,:;] /g)].map((m) => m.index + 1).filter((k) => k > 20 && k < s.length - 20);
    let k = cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
    if (k == null) k = s.lastIndexOf(" ", Math.round(mid));
    split(s.slice(0, k).trim());
    split(s.slice(k).trim());
  };
  parts.forEach(split);
  let c = 0;
  return out.map((t) => {
    const c0 = text.indexOf(t, c);
    c = c0 + t.length;
    return { text: t, c0, c1: c };
  });
}

// Scene i: [lead][clip][tail]. Scene 1 gets a longer lead (the page first), the last one a longer tail (the end card).
const scenes = clips.map((c, i) => {
  const lead = LEAD + (i === 0 ? 0.6 : 0);
  const tail = TAIL + (i === clips.length - 1 ? 2.6 : 0);
  const chunks = chunk(c.text);
  const len = c.text.length;
  // Chunk k starts where its first character falls in proportion to the line, moved to the nearest real pause.
  let prev = 0;
  chunks.forEach((ch, k) => {
    let t = k === 0 ? 0 : (c.dur * ch.c0) / len;
    if (k > 0 && c.pauses.length) {
      const near = c.pauses.filter((m) => m > prev + 0.6).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      if (near != null && Math.abs(near - t) < 1.2) t = near;
    }
    ch.t0 = lead + Math.max(t, prev);
    prev = t;
  });
  chunks.forEach((ch, k) => (ch.t1 = k + 1 < chunks.length ? chunks[k + 1].t0 : lead + c.dur + 0.25));
  return { i, ...c, lead, tail, D: lead + c.dur + tail, chunks };
});
let acc = 0;
for (const s of scenes) {
  s.offset = acc;
  acc += s.D;
}
const TOTAL = acc;

// --plan: only check the clips and print how long each scene will be (no browser, nothing recorded)
if (flag("--plan")) {
  for (const s of scenes)
    console.log(
      `${String(s.i + 1).padStart(2)} · ${s.real ? `clip ${s.dur.toFixed(1)} s` : `placeholder ${s.dur.toFixed(1)} s`} · scene ${s.D.toFixed(1)} s · ${s.pauses.length} pauses · captions at ${s.chunks.map((c) => c.t0.toFixed(1)).join(", ")}`,
    );
  console.log(`total ${Math.floor(TOTAL / 60)} min ${(TOTAL % 60).toFixed(1)} s${TOTAL < 180 || TOTAL > 300 ? "  (outside 3-5 min!)" : ""}`);
  process.exit(0);
}

/** Seconds from the start of scene s at which the given words of its line are spoken (estimated within its chunk). */
function when(s, phrase) {
  const idx = s.text.indexOf(phrase);
  if (idx < 0) {
    console.warn(`  ! scene ${s.i + 1}: "${phrase}" is not in its line; using its start`);
    return s.lead;
  }
  const ch = s.chunks.find((c) => idx >= c.c0 && idx < c.c1) ?? s.chunks[0];
  return ch.t0 + ((ch.t1 - ch.t0) * (idx - ch.c0)) / Math.max(1, ch.c1 - ch.c0);
}

// ---- frames -------------------------------------------------------------------------------------------------------
fs.mkdirSync(WORK, { recursive: true });
const FRAMES = path.join(WORK, "frames");
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const now = () => performance.now() / 1000;
const recorder = {
  n: 0,
  latest: new Map(), // page -> newest frame outside a window (only that one is kept)
  window: null, // { page, start, end, frames: [] }
  windows: [],
  onFrame(pageName, data) {
    const file = path.join(FRAMES, `f${String(this.n++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    const f = { file, t: now() };
    const w = this.window;
    if (w && w.page === pageName) {
      w.frames.push(f);
      return;
    }
    const old = this.latest.get(pageName);
    if (old && !old.kept) fs.rmSync(old.file, { force: true });
    this.latest.set(pageName, f);
  },
  open(pageName) {
    const first = this.latest.get(pageName);
    if (!first) throw new Error(`no frame yet from the ${pageName} tab`);
    first.kept = true;
    this.window = { page: pageName, start: now(), frames: [], first };
    return this.window;
  },
  close(end) {
    const w = this.window;
    w.end = end;
    // frames that arrived after the window's end belong to the next one; keep the last as its first frame
    const late = w.frames.filter((f) => f.t >= end);
    w.frames = w.frames.filter((f) => f.t < end);
    for (const f of late.slice(0, -1)) fs.rmSync(f.file, { force: true });
    // the screen as it is now: a frame after the window (free to drop later) or the window's own last one (kept)
    this.latest.set(w.page, late.length ? { ...late.at(-1), kept: false } : { ...(w.frames.at(-1) ?? w.first), kept: true });
    this.windows.push(w);
    this.window = null;
  },
};

// ---- the browser --------------------------------------------------------------------------------------------------
const F = (sel, ...texts) => `__tc.find(${[sel, ...texts].map((x) => JSON.stringify(x)).join(", ")})`;

function pageHelpers(page, name) {
  const h = {
    name,
    page,
    async box(expr) {
      return page.evaluate(`__tc.box(${expr})`);
    },
    async hl(expr, pad = 8, clip = null) {
      return page.evaluate(`__tc.highlight(${expr ?? "null"}, ${pad}, ${clip ?? "null"})`);
    },
    /** Highlights an item of the agent log, clipped to the log's scroll box. */
    async hlLog(expr) {
      return page.evaluate(`__tc.highlight(() => (${expr}), 4, ${LOG})`);
    },
    /** Moves the cursor onto an element (ox/oy: where inside it, 0..1). */
    async point(expr, ms = 700, ox = 0.5, oy = 0.5) {
      const b = await h.box(expr);
      if (!b) return console.warn(`  ! ${name}: nothing to point at: ${expr}`), null;
      await page.moveTo(b.x + b.w * ox, b.y + b.h * oy, ms);
      return b;
    },
    async clickOn(expr, ox = 0.5, oy = 0.5) {
      const b = await h.box(expr);
      if (!b) return console.warn(`  ! ${name}: nothing to click: ${expr}`), null;
      await page.click(b.x + b.w * ox, b.y + b.h * oy);
      return b;
    },
    /** Scrolls the window so the element's top sits `offset` px under the top of the page area. */
    async scrollToEl(expr, offset = 70, ms = 1100) {
      const b = await h.box(expr);
      if (!b) return console.warn(`  ! ${name}: nothing to scroll to: ${expr}`), null;
      await page.scrollTo(b.top - offset, ms);
      return b;
    },
    async card(lines) {
      return page.evaluate(`__tc.card(${JSON.stringify(lines)})`);
    },
    async showCursor() {
      const m = page.mouse;
      await page.moveTo(m.x + 1, m.y + 1, 20);
    },
  };
  return h;
}

let camera = null; // the tab on camera
async function onCamera(tab) {
  if (camera === tab) return;
  if (camera) await camera.page.send("Page.stopScreencast");
  await tab.page.bringToFront();
  recorder.latest.delete(tab.name);
  await tab.page.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: VID_W, maxHeight: PAGE_H, everyNthFrame: 1 });
  camera = tab;
  await tab.showCursor();
  for (let k = 0; k < 100 && !recorder.latest.get(tab.name); k++) await sleep(50);
  await sleep(250);
}

const warnings = [];
const warn = (m) => {
  warnings.push(m);
  console.warn(`  ! ${m}`);
};

// ---- the 16 scenes ------------------------------------------------------------------------------------------------
// Each scene: `tab` on camera, `prep` off camera (navigation, scrolling into place), `run` on camera; `at(t)` waits until
// t seconds into the scene, `say(words)` until those words of the line are spoken.
const LOG = `document.querySelector('ol[aria-label="Agent log, step by step"]')`;
const logItem = (...texts) => `[...${LOG}.children].filter(li => ${JSON.stringify(texts)}.every(t => li.textContent.includes(t)))[0]`;
const logItemLast = (...texts) => `[...${LOG}.children].filter(li => ${JSON.stringify(texts)}.every(t => li.textContent.includes(t))).at(-1)`;
const OTARI_SECTION = `(${F("section", "What Otari did in this run")})`;
const ROLES = `document.querySelector('ul[aria-label="Which model served each role"]')`;
const BUDGET_BOX = `(${F("p", "This restaurant’s budget on Otari")})?.parentElement`;
const SESSION = F("p", "Otari-Conversation-Id");
const DRILL_BTN = `[...document.querySelectorAll('button')].find(b => /Send one request to tablecast-drill|Asking Otari/.test(b.textContent) && b.closest('li'))`;
const DRILL_BOX = `${DRILL_BTN}?.parentElement`;
const GUARD_BTN = `[...document.querySelectorAll('button')].find(b => /Try it: send a poisoned review|Asking Otari/.test(b.textContent) && !b.closest('li'))`;
const GUARD_CARD = `${GUARD_BTN}?.closest('div.rounded-xl')`;
const ghHeading = (t) => `[...document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3')].find(h => h.textContent.trim().startsWith(${JSON.stringify(t)}))`;
const ghTableAfter = (t) => `(() => { let el = ${ghHeading(t)}; el = el && (el.closest('.markdown-heading') || el); while (el && el.tagName !== 'TABLE' && !el.querySelector?.('table')) el = el.nextElementSibling; return el && (el.tagName === 'TABLE' ? el : el.querySelector('table')); })()`;
const ghRow = (t) => `[...document.querySelectorAll('.markdown-body tr')].find(r => r.textContent.includes(${JSON.stringify(t)}))`;

const SCENES = [
  // 1 · home page hero
  {
    tab: "app",
    async prep({ app }) {
      await app.page.goto(BASE + "/", { settle: 150 });
      await app.page.scrollTo(0, 10);
    },
    async run({ app, at, say }) {
      await app.page.moveTo(CSS_W * 0.62, CSS_H * 0.28, 10);
      await at(0.3);
      await app.point(F("h1", "Plan this week"), 1400, 0.85, 0.75);
      await at(say("It plans the coming week"));
      await app.point(F("p", "Rain on Wednesday"), 1200, 0.6, 0.5);
      await at(say("the weather, the events nearby"));
      // bring the replay card and the "every model call through Otari" chips into view
      const card = await app.box(`document.querySelector('section[aria-labelledby]')`);
      const chips = await app.box(F("span", "Every model call through"));
      const bottom = Math.max(card ? card.top + card.h : 0, chips ? chips.top + chips.h + 90 : 0);
      await app.page.scrollTo(Math.max(0, bottom - CSS_H + 24), 1500);
      await at(say("Every model call"));
      await app.point(F("span", "Every model call through"), 900, 0.5, 0.5);
      await app.hl(F("span", "Every model call through"), 6);
      await at(say("and every model is open-weight"));
      await app.hl(F("span", "Qwen3 researches"), 6);
      await app.point(F("span", "Qwen3 researches"), 900, 0.35, 0.5);
      await at(say("and every model is open-weight") + 2.2);
      await app.hl(null);
    },
  },
  // 2 · start the Madrid replay: the map, the forecast and the holidays
  {
    tab: "app",
    async run({ app, at, say, s }) {
      await at(0.3);
      await app.clickOn(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes('Madrid'))`);
      await sleep(500);
      await app.hl(`document.querySelector('[role=tabpanel]')`, 8);
      await app.point(`document.querySelector('[role=tabpanel] strong')`, 800, 0.5, 0.5);
      await at(say("It replays fast"));
      await app.hl(null);
      await app.clickOn(F("button", "Watch this run"));
      // the context steps, then hold before the researcher starts
      const ctx = app.page.evaluate(`__tcReplay.release("e.type === 'note' && /researching the live web/.test(e.text)", 2600)`);
      await sleep(1600);
      await at(say("First, code reads"));
      await app.hl(LOG, 4);
      await app.point(logItem("OpenStreetMap"), 900, 0.4, 0.5);
      await at(say("the map"));
      await app.point(logItem("Mapping the block"), 600, 0.4, 0.5);
      await at(say("the forecast"));
      await ctx;
      await app.hl(`document.querySelector('#act-week')?.nextElementSibling`, 6);
      await app.point(logItem("7-day forecast"), 700, 0.4, 0.5);
      await at(say("the holidays"));
      await app.point(logItem("public holidays"), 600, 0.4, 0.5);
      await at(s.D - 0.3);
      await app.hl(null);
    },
  },
  // 3 · the researcher: Otari web search and the Tablecast MCP server, inside Otari's tool loop
  {
    tab: "app",
    async run({ app, at, say, s }) {
      const research = app.page.evaluate(`__tcReplay.release("e.type === 'note' && e.text.startsWith('🛡️')", ${Math.round((when(s, "and the exact page text") - 0.4) * 1000)})`);
      await at(0.6);
      await app.hlLog(logItemLast("researching the live web"));
      await app.point(logItemLast("researching the live web"), 800, 0.3, 0.5);
      await at(say("searches the web"));
      const ws = await app.page.waitFor(`!!${logItem("Otari web search")}`, { timeout: 8000 });
      if (!ws) warn("scene 3: no Otari web search step in the log");
      await app.hlLog(logItemLast("Otari web search"));
      await app.point(logItemLast("Otari web search"), 700, 0.3, 0.4);
      await at(say("The results are only leads"));
      await app.point(logItemLast("leads, read to use"), 600, 0.5, 0.75);
      await at(say("it uses my MCP server"));
      const mcp = await app.page.waitFor(`!!${logItem("Tablecast MCP, via Otari")}`, { timeout: 8000 });
      if (!mcp) warn("scene 3: no 'Tablecast MCP, via Otari' step in the log");
      const read = logItemLast("Tablecast MCP, via Otari", "1 read");
      await app.hlLog(read);
      await app.point(read, 700, 0.35, 0.4);
      await at(say("Otari connects the model"));
      await app.hlLog(read);
      await app.point(read, 600, 0.35, 0.5);
      await at(say("and the exact page text"));
      await app.hlLog(logItemLast("Tablecast MCP, via Otari", "1 read"));
      await app.point(logItemLast("Tablecast MCP, via Otari", "1 read"), 500, 0.35, 0.7);
      await research;
      await at(s.D - 0.2);
    },
  },
  // 4 · the guardrail line
  {
    tab: "app",
    async run({ app, at, s }) {
      const shield = app.page.evaluate(`__tcReplay.release("e.type === 'note' && /is writing your week/.test(e.text)", 900)`);
      await at(0.2);
      await app.page.waitFor(`!!${logItem("🛡️")}`, { timeout: 5000 });
      await sleep(350);
      await app.hlLog(logItem("🛡️"));
      await app.point(logItem("🛡️"), 800, 0.5, 0.5);
      await shield;
      await at(s.D - 0.2);
    },
  },
  // 5 · the writer, the verifier, and the plan with its verified claims
  {
    tab: "app",
    async run({ app, at, say, s }) {
      const tPlan = Math.max(2.5, when(s, "Here eleven") - 0.6);
      const plan = app.page.evaluate(`__tcReplay.release("e.type === 'playbook'", ${Math.round((tPlan - 0.4) * 1000)})`);
      await at(0.3);
      await app.hlLog(logItemLast("is writing your week"));
      await app.point(logItemLast("is writing your week"), 700, 0.4, 0.5);
      await at(say("and my code checks"));
      const v = await app.page.waitFor(`!!${logItem("Verifier")}`, { timeout: 9000 });
      if (v) {
        await app.hlLog(logItemLast("Verifier"));
        await app.point(logItemLast("Verifier"), 600, 0.4, 0.5);
      }
      await plan;
      // the plan, then the supplier order computed in the sandbox, the final budget and the end of the run
      const rest = app.page.evaluate(`__tcReplay.release(null, 2500)`);
      await at(say("Here eleven"));
      // the box with "11 / 12" and its label
      const hero = `(() => { let e = ${F("p", "Claims verified against their sources")}; while (e && !/[0-9]+ *[/] *[0-9]+/.test(e.textContent)) e = e.parentElement; return e; })()`;
      if (!(await app.page.waitFor(`!!${hero}`, { timeout: 4000 }))) warn("scene 5: the verified-claims box did not appear");
      await app.hl(hero, 10);
      await app.point(hero, 800, 0.3, 0.4);
      await at(say("A claim that fails"));
      await app.point(hero, 600, 0.7, 0.8);
      await rest;
      if (!(await app.page.waitFor(`!document.querySelector('.pulse-dot')`, { timeout: 8000 }))) warn("scene 5: the replay did not finish");
      await at(s.D - 0.2);
      await app.hl(null);
    },
  },
  // 6 · a source chip: the exact sentence a claim stands on
  {
    tab: "app",
    async prep({ app }) {
      // the first claim chip in the three dishes, preferring one from a page the researcher read
      await app.page.evaluate(`(() => {
        const chips = [...document.querySelectorAll('[id^="move-dish-"] button[aria-expanded]')];
        const pick = chips.find(c => /labola|minube/.test(c.textContent)) || chips.find(c => !/Open-Meteo/.test(c.textContent)) || chips[0];
        document.querySelectorAll('[data-tc-chip]').forEach(c => c.removeAttribute('data-tc-chip'));
        if (pick) pick.setAttribute('data-tc-chip', '');
        return !!pick;
      })()`);
      if (!(await app.box(`document.querySelector('[data-tc-chip]')`))) warn("scene 6: no source chip found");
    },
    async run({ app, at, say, s }) {
      const chip = `document.querySelector('[data-tc-chip]')`;
      await at(0.1);
      await app.scrollToEl(`${chip}?.closest('li') ?? ${chip}`, 150, 1100);
      await app.hl(`${chip}?.closest('li')`, 6);
      await app.point(chip, 900, 0.5, 0.5); // a real hover opens the chip's card
      await at(say("the exact sentence"));
      if (!(await app.page.waitFor(`!!document.querySelector('[data-tc-chip][aria-expanded="true"]')`, { timeout: 2500 }))) warn("scene 6: the source card did not open");
      await at(s.D - 0.2);
    },
  },
  // 7 · the shopping list and the program Otari's sandbox ran
  {
    tab: "app",
    async run({ app, at, say, s }) {
      await app.page.moveTo(CSS_W * 0.8, CSS_H * 0.5, 300); // leave the chip: its card closes
      await app.hl(null);
      await app.scrollToEl(`document.querySelector('#move-order')`, 20, 1300);
      await app.point(`document.querySelector('#move-order table') ?? document.querySelector('#move-order')`, 800, 0.4, 0.3);
      await at(say("gpt-oss writes"));
      const box = `(${F("p", "Computed in Otari’s code sandbox")})?.parentElement?.parentElement`;
      await app.scrollToEl(box, 84, 1100); // under the plan's sticky section bar
      await app.hl(box, 6);
      await app.clickOn(F("summary", "The program the sandbox ran"), 0.3, 0.5);
      await sleep(400);
      await app.hl(`(${F("summary", "The program the sandbox ran")})?.parentElement`, 6);
      const pre = `(${F("summary", "The program the sandbox ran")})?.parentElement?.querySelector('pre')`;
      const b = await app.box(pre);
      if (!b) warn("scene 7: the sandbox program did not open");
      else if (b.y + b.h > CSS_H - 10) await app.page.scrollTo(b.top + b.h - CSS_H + 24, 900);
      await app.point(pre, 800, 0.45, 0.35);
      await at(say("Otari runs it"));
      await app.page.evaluate(`(() => { const p = ${pre}; if (!p) return; const d = 2600, y0 = p.scrollTop, y1 = Math.min(p.scrollHeight - p.clientHeight, y0 + 260), s0 = performance.now(); return new Promise(r => { const f = n => { const k = Math.min(1, (n - s0) / d); p.scrollTop = y0 + (y1 - y0) * k; k < 1 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); }); })()`);
      await at(say("and my code checks every sum"));
      await app.hl(F("span", "every sum checked against the list above"), 6);
      await app.point(F("span", "every sum checked against the list above"), 800, 0.5, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 8 · "What Otari did in this run": roles, policy -> model and provider, cost
  {
    tab: "app",
    async run({ app, at, say, s }) {
      await app.hl(null);
      await app.scrollToEl(OTARI_SECTION, 62, 1300);
      await app.point(F("h2", "What Otari did in this run") + ` ?? ${OTARI_SECTION}`, 800, 0.2, 0.5);
      await at(say("Each step asks Otari"));
      await app.hl(ROLES, 6);
      await app.point(`${ROLES}?.children[0]?.querySelector('code')`, 800, 0.5, 0.5);
      await at(say("which model and provider"));
      await app.point(`${ROLES}?.children[1]?.querySelector('p')`, 800, 0.75, 0.5);
      await at(say("and the cost"));
      await app.point(`${ROLES}?.children[0]?.querySelector('.tabular-nums')`, 450, 0.7, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 9 · the restaurant's budget on Otari
  {
    tab: "app",
    async run({ app, at, say, s }) {
      await at(0.2);
      await app.hl(BUDGET_BOX, 6);
      await app.point(BUDGET_BOX, 800, 0.35, 0.4);
      await at(say("This run cost the restaurant"));
      await app.point(F("p", "Otari billed this run"), 700, 0.6, 0.5);
      await app.hl(F("p", "Otari billed this run"), 6);
      await at(say("If a restaurant can't afford"));
      await app.hl(BUDGET_BOX, 6);
      await app.point(`${BUDGET_BOX}?.querySelector('[aria-hidden]')`, 800, 0.4, 0.5);
      await at(say("the writer policy"));
      await app.hl(`${ROLES}?.children[1]`, 6);
      await app.point(`${ROLES}?.children[1]?.querySelector('code')`, 800, 0.5, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 10 · the failover drill (one live request to tablecast-drill)
  {
    tab: "app",
    async prep({ app }) {
      const b = await app.box(DRILL_BOX);
      if (b && (b.y < 10 || b.y + b.h > CSS_H - 20)) await app.page.scrollTo(b.top - 280, 10);
    },
    async run({ app, at, say, s }) {
      await app.hl(DRILL_BOX, 8);
      await app.point(DRILL_BTN, 900, 0.5, 0.5);
      await at(0.9);
      if (LIVE) {
        await app.clickOn(DRILL_BTN);
        const ok = await app.page.waitFor(`!!${F("p", "Served by")} || !!(${DRILL_BOX})?.querySelector('.text-terracotta')`, { timeout: Math.max(3000, (s.D - 2.5) * 1000) });
        const res = await app.page.evaluate(`(${F("p", "Served by")})?.textContent ?? (${DRILL_BOX})?.querySelector('.text-terracotta')?.textContent ?? null`);
        console.log(`    drill: ${res ?? "no answer in time"}`);
        if (!ok || !/Served by/.test(res ?? "")) warn(`scene 10: the drill did not answer as expected (${res ?? "nothing"})`);
        else if (!/after 2 attempts/.test(res) || !/Otari-Fallback: true/.test(res)) warn(`scene 10: the drill answered without the expected fallback: ${res}`);
        await app.hl(F("p", "Served by"), 6);
        await app.point(F("p", "Served by"), 700, 0.4, 0.5);
      }
      await at(say("Nemotron Ultra answered"));
      if (LIVE) await app.point(F("p", "Served by"), 600, 0.75, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 11 · the guardrail check: a poisoned review is blocked, the clean one passes
  {
    tab: "app",
    async run({ app, at, say, s }) {
      await app.hl(null);
      const card = await app.box(GUARD_CARD);
      if (card) await app.page.scrollTo(card.top - 150, 1000);
      await app.hl(GUARD_CARD, 6);
      await app.point(GUARD_BTN, 800, 0.5, 0.5);
      await at(0.9);
      if (LIVE) {
        await app.clickOn(GUARD_BTN);
        const ok = await app.page.waitFor(`!!${F("span", "Blocked by Otari")}`, { timeout: Math.max(3000, (s.D - 2.5) * 1000) });
        const res = await app.page.evaluate(`[...(${GUARD_CARD})?.querySelectorAll('p') ?? []].map(p => p.textContent).filter(t => /Blocked|Passed|Not screened|could not/.test(t)).join(' | ')`);
        console.log(`    guardrail: ${res || "no answer in time"}`);
        if (!ok || !/Passed/.test(res)) warn(`scene 11: the guardrail check did not show a block and a pass (${res || "nothing"})`);
        const c2 = await app.box(GUARD_CARD);
        if (c2 && c2.y + c2.h > CSS_H - 10) await app.page.scrollTo(c2.top + c2.h - CSS_H + 30, 700);
        await app.point(F("span", "Blocked by Otari"), 700, 0.5, 0.5);
      }
      await at(say("The clean review passes"));
      if (LIVE) await app.point(F("span", "Passed"), 700, 0.5, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 12 · GitHub, README.md on the branch: the branch name, then the "Built on Otari" table
  {
    tab: "gh",
    async prep({ gh }) {
      await gh.page.goto(GH_README, { settle: 1500 });
      await gh.page.scrollTo(0, 10);
      await gh.page.waitFor(`!!${ghHeading("Built on Otari")}`, { timeout: 15000 });
    },
    async run({ gh, at, say, s, elapsed }) {
      const branch = `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('otari-wilding'))`;
      await at(0.2);
      await gh.hl(branch, 6);
      await gh.point(branch, 900, 0.5, 0.5);
      await at(say("This table maps"));
      await gh.hl(null);
      await gh.scrollToEl(ghHeading("Built on Otari"), 100, 1300); // under the file view's sticky header
      await gh.point(`${ghTableAfter("Built on Otari")}?.querySelector('th:nth-child(3)')`, 700, 0.5, 0.5);
      const rest = Math.max(1, s.D - elapsed() - 0.7);
      const t = await gh.box(ghTableAfter("Built on Otari"));
      if (t) {
        const pan = gh.page.scrollTo(t.top + Math.min(t.h - CSS_H * 0.8, 900), rest * 1000);
        await gh.point(`${ghTableAfter("Built on Otari")}?.querySelector('tbody tr td:nth-child(3) a')`, 900, 0.5, 0.5);
        await pan;
      }
      await at(s.D - 0.2);
    },
  },
  // 13 · GitHub: docs/OTARI_SETUP.md, the six routing policies
  {
    tab: "gh",
    async prep({ gh }) {
      await gh.page.goto(GH_SETUP, { settle: 1500 });
      await gh.page.waitFor(`!!${ghHeading("3. Routing policies")}`, { timeout: 15000 });
      const h = await gh.box(ghHeading("3. Routing policies"));
      if (h) await gh.page.scrollTo(h.top - 100, 10);
    },
    async run({ gh, at, say, s }) {
      const table = ghTableAfter("3. Routing policies");
      await at(0.2);
      const t = await gh.box(table);
      if (t) await gh.page.scrollTo(t.top - 110, 1100);
      await gh.hl(table, 6);
      await gh.point(`${table}?.querySelector('tbody tr td code')`, 800, 0.5, 0.5);
      await at(say("Each one falls back"));
      await gh.hl(null);
      const n = await gh.page.evaluate(`${table}?.querySelectorAll('tbody tr').length ?? 0`);
      const t1 = say("Each one falls back") + 0.2;
      const per = Math.max(0.4, (s.D - t1 - 0.5) / Math.max(1, n));
      for (let r = 1; r <= n; r++) {
        await at(t1 + (r - 1) * per);
        const row = `${table}?.querySelector('tbody tr:nth-child(${r})')`;
        await gh.hl(row, 2);
        await gh.point(`${row}?.querySelector('td:nth-child(3)')`, Math.min(500, per * 500), 0.3, 0.5);
      }
      await at(s.D - 0.2);
    },
  },
  // 14 · back in the app: the run is one session in Otari's agent traces
  {
    tab: "app",
    async prep({ app }) {
      await app.hl(null);
      const b = await app.box(OTARI_SECTION);
      if (b) await app.page.scrollTo(b.top - 62, 10);
    },
    async run({ app, at, say, s }) {
      await at(0.2);
      await app.hl(SESSION, 8);
      await app.point(`(${SESSION})?.querySelector('code')`, 900, 0.5, 0.5);
      await at(say("with every model call"));
      await app.point(`(${SESSION})?.querySelectorAll('code')[1]`, 700, 0.5, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 15 · GitHub: the two budgets (the key's $12 a month, each restaurant's $1 a week)
  {
    tab: "gh",
    async prep({ gh }) {
      await gh.hl(null);
      const h = await gh.box(ghHeading("1. Budgets"));
      if (h) await gh.page.scrollTo(h.top - 100, 10);
    },
    async run({ gh, at, say, s }) {
      await at(0.2);
      await gh.hl(ghRow("tablecast-app-month"), 4);
      await gh.point(`${ghRow("tablecast-app-month")}?.querySelector('td:nth-child(2)')`, 900, 0.5, 0.5);
      await at(say("and every restaurant"));
      await gh.hl(ghRow("tablecast-restaurant-week"), 4);
      await gh.point(`${ghRow("tablecast-restaurant-week")}?.querySelector('td:nth-child(2)')`, 800, 0.5, 0.5);
      await at(s.D - 0.2);
    },
  },
  // 16 · back to the home page, and the end card
  {
    tab: "app",
    async prep({ app }) {
      await app.hl(null);
      await app.page.goto(BASE + "/", { settle: 1200 });
      await app.page.scrollTo(0, 10);
    },
    async run({ app, at, say }) {
      await app.page.moveTo(CSS_W * 0.55, CSS_H * 0.45, 10);
      await app.point(F("h1", "Plan this week"), 1500, 0.6, 0.6);
      await at(say("With Otari it is one key"));
      await app.card(["Tablecast on Otari", "tablecast-otari.vercel.app", "github.com/antonmareo10/tablecast · branch otari-wilding"]);
      await app.page.moveTo(CSS_W * 0.9, CSS_H * 0.9, 1200);
    },
  },
];
if (SCENES.length !== scenes.length) throw new Error("one scene per line");

// ---- record -------------------------------------------------------------------------------------------------------
console.log(`Tablecast × Otari demo · ${FINAL ? "FINAL take" : `TEST (placeholder length for clip${missing.length > 1 ? "s" : ""} ${missing.join(", ")})`}`);
console.log(`  ${scenes.length} scenes, ${TOTAL.toFixed(1)} s · live buttons ${LIVE ? "pressed" : "only hovered"} · ${BASE}`);

const browser = await launch({ width: CSS_W, height: CSS_H, scale: SCALE, port: 9347 });
let ok = false;
try {
  const appPage = await browser.newPage();
  const ghPage = await browser.newPage();
  for (const p of [appPage, ghPage]) await p.addInitScript(OVERLAY);
  await appPage.addInitScript(REPLAY_SHIM);
  const app = pageHelpers(appPage, "app");
  const gh = pageHelpers(ghPage, "gh");
  for (const t of [app, gh]) t.page.on("Page.screencastFrame", (p) => {
    recorder.onFrame(t.name, p.data);
    t.page.send("Page.screencastFrameAck", { sessionId: p.sessionId });
  });
  const tabs = { app, gh };

  for (const [k, sc] of SCENES.entries()) {
    if (ONLY && (k + 1 < ONLY[0] || k + 1 > ONLY[1])) continue;
    const s = scenes[k];
    const tab = tabs[sc.tab];
    // the tab comes to the front first (a hidden tab does not paint); what prep does there is not in the video
    await onCamera(tab);
    if (sc.prep) {
      await sc.prep({ app, gh, s });
      await tab.showCursor();
      await sleep(300);
    }
    const w = recorder.open(tab.name);
    const t0 = w.start;
    const at = (t) => sleep((t0 + t - now()) * 1000);
    const say = (phrase) => when(s, phrase);
    process.stdout.write(`  ${String(k + 1).padStart(2)} · ${s.D.toFixed(1)} s · ${s.text.slice(0, 64)}…\n`);
    await sc.run({ app, gh, at, say, s, elapsed: () => now() - t0 });
    const late = now() - (t0 + s.D);
    if (late > 0.05) warn(`scene ${k + 1}: its actions ran ${late.toFixed(2)} s past the scene's length`);
    await at(s.D);
    recorder.close(t0 + s.D);
  }
  ok = true;
} finally {
  await browser.close();
}
if (!ok) process.exit(1);

// --only: no sound or video, just two frames per recorded scene (30% and 72% in) to look at
if (ONLY) {
  const CHECK = path.join(OUT_DIR, "check");
  fs.mkdirSync(CHECK, { recursive: true });
  recorder.windows.forEach((w, j) => {
    const n = ONLY[0] + j;
    for (const f of [0.3, 0.72]) {
      const t = w.start + (w.end - w.start) * f;
      const frame = [w.first, ...w.frames].filter((x) => x.t <= t).at(-1) ?? w.first;
      fs.copyFileSync(frame.file, path.join(CHECK, `only_scene_${String(n).padStart(2, "0")}_${Math.round(f * 100)}.jpg`));
    }
  });
  fs.rmSync(FRAMES, { recursive: true, force: true });
  console.log(`
Frames of scenes ${ONLY.join("-")} in ${CHECK} (only_scene_*.jpg)`);
  for (const w of warnings) console.log(`  - ${w}`);
  process.exit(0);
}

// ---- audio: Antón's clips, aligned to the scenes ------------------------------------------------------------------
const pre = path.join(WORK, "voice_pre.wav");
const voice = path.join(WORK, "voice.wav");
{
  const inputs = [];
  const chains = [];
  scenes.forEach((s, k) => {
    if (s.real) inputs.push("-i", s.file);
    else inputs.push("-f", "lavfi", "-t", s.dur.toFixed(3), "-i", "anullsrc=r=48000:cl=mono");
    const clean = s.real ? "highpass=f=80,agate=threshold=0.006:ratio=2:range=0.3:attack=5:release=250," : "";
    chains.push(
      `[${k}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,${clean}adelay=delays=${Math.round(s.lead * 1000)}:all=1,apad=whole_dur=${s.D.toFixed(4)},atrim=end=${s.D.toFixed(4)}[a${k}]`,
    );
  });
  const graph = `${chains.join(";")};${scenes.map((_, k) => `[a${k}]`).join("")}concat=n=${scenes.length}:v=0:a=1[out]`;
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", pre], { stdio: "inherit" });
  let normalised = false;
  if (scenes.some((s) => s.real)) {
    const LN = "loudnorm=I=-16:TP=-1.5:LRA=11";
    const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", pre, "-af", `${LN}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
    const m = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(r.stderr ?? "");
    const j = m ? JSON.parse(m[0]) : null;
    if (j && Number.isFinite(Number(j.input_i)) && Number(j.input_i) > -70) {
      const measured = `measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
      execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", pre, "-af", `${LN}:${measured},aresample=48000`, "-c:a", "pcm_s16le", "-ar", "48000", voice], { stdio: "inherit" });
      normalised = true;
      console.log(`  voice: ${Number(j.input_i).toFixed(1)} LUFS → -16 LUFS`);
    }
  }
  if (!normalised) fs.copyFileSync(pre, voice);
}

// ---- captions -----------------------------------------------------------------------------------------------------
const ts = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assText = (t) => t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")");
const ass = [
  "[Script Info]",
  "ScriptType: v4.00+",
  `PlayResX: ${VID_W}`,
  `PlayResY: ${VID_H}`,
  "WrapStyle: 0",
  "ScaledBorderAndShadow: yes",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Cap,Segoe UI,40,&H00EAF2F5,&H00EAF2F5,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,170,170,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
];
for (const s of scenes)
  for (const ch of s.chunks)
    ass.push(`Dialogue: 0,${ts(s.offset + ch.t0)},${ts(s.offset + ch.t1)},Cap,,0,0,0,,{\\an5\\pos(${VID_W / 2},${Math.round(PAGE_H + (VID_H - PAGE_H) / 2)})}${assText(ch.text)}`);
fs.writeFileSync(path.join(WORK, "captions.ass"), ass.join("\n") + "\n", "utf8");

// ---- video --------------------------------------------------------------------------------------------------------
const list = [];
let total = 0;
for (const w of recorder.windows) {
  const entries = [{ file: w.first.file, t: w.start }, ...w.frames.filter((f) => f.t > w.start)];
  entries.forEach((e, k) => {
    const next = k + 1 < entries.length ? entries[k + 1].t : w.end;
    const d = Math.max(0, next - e.t);
    if (d <= 0) return;
    list.push(`file '${e.file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(6)}`);
    total += d;
  });
}
list.push(list.at(-2)); // the concat demuxer needs the last file once more
fs.writeFileSync(path.join(WORK, "frames.txt"), list.join("\n") + "\n");
const frameCount = recorder.windows.reduce((n, w) => n + w.frames.length + 1, 0);
console.log(`  ${frameCount} frames, ${total.toFixed(2)} s of picture for ${TOTAL.toFixed(2)} s of sound · encoding…`);

execFileSync(
  FFMPEG,
  [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", "frames.txt",
    "-i", "voice.wav",
    "-filter_complex", `[0:v]fps=${FPS},scale=${VID_W}:${PAGE_H}:flags=lanczos,pad=${VID_W}:${VID_H}:0:0:color=0x1b1a16,subtitles=captions.ass,format=yuv420p[v]`,
    "-map", "[v]", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-t", TOTAL.toFixed(3), "-movflags", "+faststart",
    OUT,
  ],
  { stdio: "inherit", cwd: WORK },
);

// ---- check frames, one per scene ----------------------------------------------------------------------------------
const CHECK = path.join(OUT_DIR, "check");
fs.rmSync(CHECK, { recursive: true, force: true });
fs.mkdirSync(CHECK, { recursive: true });
for (const s of scenes) {
  const t = s.offset + s.D * 0.72;
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", OUT, "-frames:v", "1", "-update", "1", path.join(CHECK, `scene_${String(s.i + 1).padStart(2, "0")}.png`)]);
}
fs.writeFileSync(
  path.join(WORK, "timeline.json"),
  JSON.stringify({ final: FINAL, live: LIVE, total: TOTAL, scenes: scenes.map((s) => ({ n: s.i + 1, start: +s.offset.toFixed(3), length: +s.D.toFixed(3), clip: s.real ? s.source : null, clipLength: +s.dur.toFixed(3), captions: s.chunks.map((c) => ({ at: +(s.offset + c.t0).toFixed(2), text: c.text })) })) }, null, 1),
);
if (!flag("--keep-frames")) fs.rmSync(FRAMES, { recursive: true, force: true });

const real = probeDuration(OUT);
console.log(`\nSaved ${OUT}\n  ${Math.floor(real / 60)} min ${(real % 60).toFixed(1)} s · one frame per scene in ${CHECK}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning${warnings.length > 1 ? "s" : ""}:`);
  for (const w of warnings) console.log(`  - ${w}`);
}
process.exit(0);
