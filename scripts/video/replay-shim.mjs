// Injected into the app's tab. The home page replays a REAL recorded run by streaming its events from /api/demo/<slug>
// (the server compresses the run's own rhythm). The recorder needs the replay to keep pace with the narration, so this
// shim reads that same stream from the deployed server and hands its lines to the app in order, a few at a time, when the
// recorder says so: like pausing a video and pressing play again. No event is added, changed, dropped or reordered;
// every other request goes to the network untouched.
export const REPLAY_SHIM = String.raw`(() => {
  if (window.__tcReplay) return;
  const original = window.fetch.bind(window);
  const enc = new TextEncoder();
  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const SLOT = new Set(["note", "tool_start", "week", "place", "block", "playbook_draft", "playbook", "quartermaster"]);
  const R = (window.__tcReplay = { lines: [], sent: 0, ended: false, ctrl: null, chain: Promise.resolve(), streams: 0 });

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !/^\/api\/demo\/[^/]+$/.test(u.pathname)) return original(input, init);
    u.searchParams.set("seconds", "5"); // the server's fastest pace; the recorder sets the pace from here
    const res = await original(u.href, init);
    if (!res.ok || !res.body) return res;
    R.lines = [];
    R.sent = 0;
    R.ended = false;
    R.streams++;
    const body = new ReadableStream({ start: (c) => (R.ctrl = c) });
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) R.lines.push(line);
        }
      }
      if (buf.trim()) R.lines.push(buf.trim());
      R.ended = true;
    })();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  const parse = (l) => { try { return JSON.parse(l); } catch { return {}; } };
  /**
   * Hands the app every line up to (not including) the first one that matches pred (a JS expression over the event e;
   * null = all of them), spreading the visible steps over ms milliseconds. Resolves with how many lines it sent.
   */
  R.release = (pred, ms = 0) => {
    const run = async () => {
      const match = pred ? new Function("e", "return (" + pred + ");") : () => false;
      let idx = -1;
      for (let t0 = Date.now(); ; ) {
        idx = R.lines.findIndex((l, k) => k >= R.sent && match(parse(l)));
        if (idx >= 0 || R.ended || Date.now() - t0 > 30000) break;
        await wait(40);
      }
      const end = idx >= 0 ? idx : R.lines.length;
      const batch = R.lines.slice(R.sent, end);
      const slots = Math.max(1, batch.filter((l) => SLOT.has(parse(l).type)).length - 1);
      let first = true;
      for (const l of batch) {
        if (SLOT.has(parse(l).type)) {
          if (!first) await wait(ms / slots);
          first = false;
        }
        R.ctrl.enqueue(enc.encode(l + "\n"));
        R.sent++;
      }
      if (!pred && R.ended && R.sent >= R.lines.length) R.ctrl.close();
      return { sent: batch.length, matched: idx >= 0, total: R.lines.length };
    };
    R.chain = R.chain.then(run, run);
    return R.chain;
  };
})();`;
