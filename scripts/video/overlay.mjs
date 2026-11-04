// Injected into every page the recorder opens (the app and GitHub). It only draws on top of the real page:
// a visible mouse cursor that follows the browser's real mouse events, a ripple on each click, a highlight frame the
// recorder puts around the thing being talked about, and the closing card. It never changes the page's own content.
export const OVERLAY = String.raw`(() => {
  if (window.__tc) return;
  const ready = (fn) => (document.body ? fn() : document.addEventListener("DOMContentLoaded", fn, { once: true }));
  const css = "position:fixed;pointer-events:none;z-index:2147483647;";
  let cursor, ring, hl, card;
  ready(() => {
    cursor = document.createElement("div");
    cursor.style.cssText = css + "left:0;top:0;width:26px;height:26px;transform:translate(-100px,-100px);transition:transform 40ms linear;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));";
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.3 L11.6 24 L15 22.5 L11.7 14.9 L18.8 14.9 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    ring = document.createElement("div");
    ring.style.cssText = css + "left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(214,150,40,.95);opacity:0;";
    hl = document.createElement("div");
    hl.style.cssText = css + "left:0;top:0;width:0;height:0;border-radius:14px;border:3px solid rgba(214,150,40,.95);box-shadow:0 0 0 6px rgba(214,150,40,.18),0 10px 30px -10px rgba(0,0,0,.25);opacity:0;transition:opacity 260ms ease, left 420ms cubic-bezier(.2,.7,.2,1), top 420ms cubic-bezier(.2,.7,.2,1), width 420ms cubic-bezier(.2,.7,.2,1), height 420ms cubic-bezier(.2,.7,.2,1);";
    document.documentElement.append(hl, ring, cursor);
  });
  addEventListener("mousemove", (e) => cursor && (cursor.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"), { capture: true, passive: true });
  addEventListener("mousedown", (e) => {
    if (!ring) return;
    ring.style.left = e.clientX + "px";
    ring.style.top = e.clientY + "px";
    ring.animate([{ opacity: 1, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.6)" }], { duration: 520, easing: "ease-out" });
  }, { capture: true, passive: true });

  let hlEl = null, hlPad = 8, hlClip = null;
  const place = () => {
    if (!hlEl || !hl) return;
    // a function target is looked up again on every frame (e.g. "the newest matching step of the agent log")
    let el = hlEl;
    if (typeof hlEl === "function") try { el = hlEl(); } catch { el = null; }
    if (!el) return void (hl.style.opacity = "0");
    const r = el.getBoundingClientRect();
    let top = r.top - hlPad, bottom = r.bottom + hlPad;
    if (hlClip) {
      // inside a scroll box (the agent log): never draw outside the box
      const c = hlClip.getBoundingClientRect();
      const full = bottom - top;
      top = Math.max(top, c.top + 2);
      bottom = Math.min(bottom, c.bottom - 2);
      // mostly scrolled out of the box: drop the frame rather than frame the wrong item
      hl.style.opacity = bottom - top > Math.max(12, full * 0.75) ? "1" : "0";
    }
    hl.style.left = r.left - hlPad + "px";
    hl.style.top = top + "px";
    hl.style.width = r.width + hlPad * 2 + "px";
    hl.style.height = Math.max(0, bottom - top) + "px";
  };
  addEventListener("scroll", place, { capture: true, passive: true });
  (function loop() { try { place(); } finally { requestAnimationFrame(loop); } })();

  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  window.__tc = {
    /** The smallest visible element matching a CSS selector whose text includes every given string. */
    find(selector, ...texts) {
      const all = [...document.querySelectorAll(selector)].filter((el) => visible(el) && texts.every((t) => (el.textContent || "").includes(t)));
      all.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      return all[0] || null;
    },
    box(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, top: r.top + scrollY };
    },
    highlight(el, pad = 8, clip = null) {
      hlEl = el || null;
      hlPad = pad;
      hlClip = clip || null;
      if (!hl) return !!el;
      if (el) { place(); hl.style.opacity = "1"; } else hl.style.opacity = "0";
      return !!el;
    },
    card(lines) {
      if (card) card.remove();
      if (window.__tcDim) window.__tcDim.remove();
      card = null;
      if (!lines) return;
      const dim = (window.__tcDim = document.createElement("div"));
      dim.style.cssText = css + "inset:0;background:rgba(29,27,23,.38);backdrop-filter:blur(2px);";
      document.documentElement.append(dim);
      dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: "ease-out" });
      card = document.createElement("div");
      card.style.cssText = css + "left:50%;top:50%;transform:translate(-50%,-50%);min-width:640px;padding:34px 46px;border-radius:22px;background:rgba(250,247,240,.97);border:1px solid rgba(29,27,23,.12);box-shadow:0 30px 80px -30px rgba(29,27,23,.55);text-align:center;font-family:'Segoe UI',system-ui,sans-serif;color:#1d1b17;";
      card.innerHTML = lines.map((l, i) => '<div style="' + (i === 0 ? "font:600 40px/1.2 Georgia,serif;margin-bottom:14px;" : "font:500 22px/1.5 'Segoe UI',system-ui,sans-serif;color:#3d3a33;") + '">' + l + "</div>").join("");
      document.documentElement.append(card);
      card.animate([{ opacity: 0, transform: "translate(-50%,-46%)" }, { opacity: 1, transform: "translate(-50%,-50%)" }], { duration: 600, easing: "cubic-bezier(.2,.7,.2,1)" });
    },
  };
})();`;
