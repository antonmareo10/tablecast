// Minimal DevTools-protocol driver for a headless Chromium browser (Edge or Chrome), for the demo-video recorder.
// Adapted from clocked-reconcile/scripts/lib/cdp.mjs: several tabs, real mouse input (so hover and pointer events are
// the browser's own), smooth scrolling, element lookups. No dependencies beyond Node 22+ (global WebSocket and fetch).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function findBrowser() {
  const p = [
    process.env.BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((x) => x && fs.existsSync(x));
  if (!p) throw new Error("No Chromium-based browser found; set BROWSER=/path/to/chrome");
  return p;
}

/**
 * Starts a headless browser. `width`/`height` are CSS pixels, `scale` the device pixel ratio (frames come out at
 * width*scale x height*scale). Returns { newPage(), close() }.
 */
export async function launch({ width = 1440, height = 810, scale = 4 / 3, port = 9347 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tablecast-video-"));
  const proc = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      "--lang=en-GB",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await sleep(400);
  }
  if (!up) throw new Error("browser did not start");

  const pages = [];
  async function newPage() {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    if (!r.ok) throw new Error(`could not open a tab (${r.status})`);
    const target = await r.json();
    const page = await connect(target, { width, height, scale });
    pages.push(page);
    return page;
  }
  return {
    pid: proc.pid,
    newPage,
    async close() {
      for (const p of pages) p.disconnect();
      proc.kill();
      await sleep(600);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the browser may still hold a lock; the OS temp cleaner gets it */
      }
    },
  };
}

async function connect(target, { width, height, scale }) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.error ? { __error: msg.error } : msg.result);
      pending.delete(msg.id);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });
  const send = (method, params = {}) => {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((r) => pending.set(msgId, r));
  };
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r?.__error) throw new Error(`evaluate: ${r.__error.message}`);
    if (r?.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.setBypassCSP", { enabled: true }); // GitHub's CSP would otherwise refuse the cursor overlay
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });

  let mouse = { x: width * 0.72, y: height * 0.62 };
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  const page = {
    targetId: target.id,
    send,
    on,
    evaluate,
    get mouse() {
      return { ...mouse };
    },
    disconnect() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    async bringToFront() {
      await send("Page.bringToFront");
    },
    async addInitScript(source) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    /** Navigates and waits for the load event (or `timeout` ms), then `settle` ms more. */
    async goto(url, { timeout = 30000, settle = 800 } = {}) {
      let loaded;
      const done = new Promise((r) => (loaded = r));
      const onLoad = () => loaded();
      on("Page.loadEventFired", onLoad);
      const r = await send("Page.navigate", { url });
      if (r?.__error || r?.errorText) throw new Error(`navigate ${url}: ${r.__error?.message ?? r.errorText}`);
      await Promise.race([done, sleep(timeout)]);
      listeners.set("Page.loadEventFired", (listeners.get("Page.loadEventFired") ?? []).filter((f) => f !== onLoad));
      await sleep(settle);
    },
    /** Polls a JS expression until it is truthy; returns its value, or null after `timeout` ms. */
    async waitFor(expression, { timeout = 20000, every = 150 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          const v = await evaluate(expression);
          if (v) return v;
        } catch {
          /* page navigating */
        }
        await sleep(every);
      }
      return null;
    },
    /** Moves the real mouse along an eased path (pointer events fire as for a person). */
    async moveTo(x, y, ms = 700) {
      const from = { ...mouse };
      const steps = Math.max(2, Math.round(ms / 16));
      const t0 = Date.now();
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        const p = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, pointerType: "mouse" });
        await sleep(t0 + (ms * i) / steps - Date.now());
      }
      mouse = { x, y };
    },
    async click(x, y, { move = 650 } = {}) {
      if (x != null) await page.moveTo(x, y, move);
      await sleep(120);
      const base = { x: mouse.x, y: mouse.y, button: "left", clickCount: 1, pointerType: "mouse" };
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await sleep(90);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    },
    /** Smoothly scrolls the window (or the element matched by `scroller`) so `y` is at the top. */
    // Animated with requestAnimationFrame, which a hidden tab never runs: short or hidden scrolls jump instead, and a
    // timer finishes the scroll if the frames stop.
    async scrollTo(y, ms = 1200, scroller = null) {
      await evaluate(`(() => {
        const box = ${scroller ? `document.querySelector(${JSON.stringify(scroller)})` : "null"};
        const get = () => box ? box.scrollTop : window.scrollY;
        const set = (v) => box ? (box.scrollTop = v) : window.scrollTo({ top: v, behavior: "instant" });
        const max = box ? box.scrollHeight - box.clientHeight : document.documentElement.scrollHeight - innerHeight;
        const y0 = get(), y1 = Math.max(0, Math.min(max, ${Number(y)})), dy = y1 - y0, d = ${ms}, s = performance.now();
        if (Math.abs(dy) < 2) return true;
        if (d <= 30 || document.hidden) { set(y1); return true; }
        return new Promise(res => {
          let done = false;
          const end = () => { if (!done) { done = true; set(y1); res(true); } };
          setTimeout(end, d + 600);
          const step = now => { if (done) return; const k = Math.min(1, (now - s) / d); const e = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k + 2, 3) / 2; set(y0 + dy * e); k < 1 ? requestAnimationFrame(step) : end(); };
          requestAnimationFrame(step);
        });
      })()`);
      await sleep(80);
    },
    async scrollY() {
      return evaluate("window.scrollY");
    },
  };
  return page;
}
