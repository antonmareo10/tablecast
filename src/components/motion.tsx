"use client";

// Tablecast's motion language in one place: one entrance ease, one spring, one reveal distance.
// Everything here respects prefers-reduced-motion (Motion via MotionConfig, the rest by checking it).
import { LazyMotion, MotionConfig, domAnimation, m, type HTMLMotionProps } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type Lenis from "lenis";

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: "spring", stiffness: 420, damping: 32, mass: 0.7 } as const;
export const REVEAL = { duration: 0.56, ease: EASE_OUT };
export const STAGGER = 0.06;

// True once the first render has hydrated: anything that mounts later (a run's results) may play an entrance.
let hydrated = false;

export function MotionProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    hydrated = true;
  }, []);
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={REVEAL}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

const prefersReduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

// ---- Reveal on scroll (once) -----------------------------------------------------------------------
//
// Content is never hidden unless a person is scrolling toward it. Until the reader first scrolls (wheel, touch or
// keys), everything is shown as is, so a print, a full-page capture or a reader who never scrolls sees it all.
// From the first scroll on, whatever is still entirely below the fold is hidden (it is off screen, so nothing
// visibly disappears) and rises in when it enters the viewport. Content that appears on screen later (a run's
// results streaming in) plays its entrance right away.

export type RevealPhase = "hidden" | "shown" | "static";

let armed = false;
const onArm = new Set<() => void>();
let listening = false;
const SCROLL_KEYS = ["ArrowDown", "PageDown", " ", "End"];

function arm() {
  if (armed) return;
  armed = true;
  for (const f of [...onArm]) f();
  onArm.clear();
}

function listenForScroll() {
  if (listening) return;
  listening = true;
  const keys = (e: KeyboardEvent) => {
    if (!SCROLL_KEYS.includes(e.key)) return;
    window.removeEventListener("keydown", keys);
    arm();
  };
  window.addEventListener("wheel", arm, { passive: true, once: true });
  window.addEventListener("touchmove", arm, { passive: true, once: true });
  window.addEventListener("keydown", keys);
}

/** The reveal state machine for one element; see above. */
export function useReveal<T extends Element>(): { ref: RefObject<T | null>; phase: RevealPhase; initial: "hidden" | false } {
  const ref = useRef<T>(null);
  const [late] = useState(() => hydrated);
  const [phase, setPhase] = useState<RevealPhase>(late ? "hidden" : "static");
  useLayoutEffect(() => {
    listenForScroll();
    const el = ref.current;
    if (!el) return;
    let io: IntersectionObserver | undefined;
    let raf = 0;
    const below = () => el.getBoundingClientRect().top > window.innerHeight;
    const watch = () => {
      setPhase("hidden");
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          setPhase("shown");
          io?.disconnect();
        },
        { rootMargin: "0px 0px -8% 0px" },
      );
      io.observe(el);
    };
    const onArmed = () => {
      if (below()) watch();
    };
    if (!below()) {
      if (late) raf = requestAnimationFrame(() => setPhase("shown"));
    } else if (armed) {
      raf = requestAnimationFrame(watch);
    } else {
      if (late) raf = requestAnimationFrame(() => setPhase("static"));
      onArm.add(onArmed);
    }
    return () => {
      cancelAnimationFrame(raf);
      onArm.delete(onArmed);
      io?.disconnect();
    };
  }, [late]);
  return { ref, phase, initial: late ? "hidden" : false };
}

const TAGS = { div: m.div, section: m.section, li: m.li, header: m.header, article: m.article };

type RevealProps = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants" | "transition"> & {
  as?: keyof typeof TAGS;
  delay?: number;
  y?: number;
};

/** Fades and slides its content up when it enters (see the rules above). Prints fully even if never reached. */
export function Reveal({ as = "div", delay = 0, y = 16, children, ...rest }: RevealProps) {
  const C = TAGS[as] as typeof m.div;
  const { ref, phase, initial } = useReveal<HTMLDivElement>();
  return (
    <C
      ref={ref}
      data-reveal=""
      initial={initial}
      animate={phase}
      variants={{
        hidden: { opacity: 0, y, transition: { duration: 0 } },
        shown: { opacity: 1, y: 0, transition: { ...REVEAL, delay } },
        static: { opacity: 1, y: 0, transition: { duration: 0 } },
      }}
      {...rest}
    >
      {children}
    </C>
  );
}

/**
 * Marks its element data-inview="false" while it waits to be revealed, so CSS animations inside (bars that draw)
 * start when the reader reaches them. Same rules as Reveal.
 */
export function SeenGate({ as = "div", children, ...rest }: { as?: "div" | "figure" } & React.HTMLAttributes<HTMLElement>) {
  const { ref, phase } = useReveal<HTMLDivElement>();
  const Tag = as as "div";
  return (
    <Tag ref={ref} data-inview={phase === "hidden" ? "false" : "true"} {...rest}>
      {children}
    </Tag>
  );
}

// ---- Smooth scroll -----------------------------------------------------------------------------------

let lenis: Lenis | null = null;

/** Lenis smooth scrolling for mouse and trackpad users; native scrolling on touch and with reduced motion. */
export function SmoothScroll() {
  useEffect(() => {
    if (!finePointer() || prefersReduced()) return;
    let instance: Lenis | null = null;
    let cancelled = false;
    import("lenis").then(({ default: L }) => {
      if (cancelled) return;
      instance = new L({ autoRaf: true, lerp: 0.12, smoothWheel: true, allowNestedScroll: true });
      lenis = instance;
    });
    return () => {
      cancelled = true;
      instance?.destroy();
      lenis = null;
    };
  }, []);
  return null;
}

/** Scrolls the page so `el` sits `offset` px below the top: eased with Lenis, native otherwise. */
export function scrollToEl(el: HTMLElement | null | undefined, offset = 0) {
  if (!el) return;
  if (lenis) {
    lenis.resize(); // the page may have just grown (a run's results mounting): refresh Lenis's scroll limit first
    lenis.scrollTo(el, { offset, duration: 1.1 });
    return;
  }
  const top = el.getBoundingClientRect().top + window.scrollY + offset;
  window.scrollTo({ top, behavior: prefersReduced() ? "auto" : "smooth" });
}

// ---- Magnetic buttons --------------------------------------------------------------------------------

/** Pulls the element up to `strength` px toward the pointer (mouse only, not with reduced motion). */
export function useMagnetic<T extends HTMLElement>(strength = 6) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !finePointer() || prefersReduced()) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      el.style.setProperty("--mx", `${(Math.max(-1, Math.min(1, dx)) * strength).toFixed(2)}px`);
      el.style.setProperty("--my", `${(Math.max(-1, Math.min(1, dy)) * strength * 0.6).toFixed(2)}px`);
    };
    const leave = () => {
      el.style.setProperty("--mx", "0px");
      el.style.setProperty("--my", "0px");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [strength]);
  return ref;
}

// ---- Cursor light --------------------------------------------------------------------------------------

/**
 * A soft light that follows the pointer inside its parent (eased, transform only) and rests at `rest`
 * (fractions of the parent's size) otherwise. Without a fine pointer, or with reduced motion, it stays at rest.
 */
export function CursorLight({
  size = 640,
  rest = [0.3, 0.35],
  scope = "parent",
  className = "",
  style,
}: {
  size?: number;
  rest?: [number, number];
  scope?: "parent" | "window";
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rx, ry] = rest;
  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const restAt = () => {
      const r = host.getBoundingClientRect();
      return [r.width * rx - size / 2, r.height * ry - size / 2];
    };
    let [x, y] = restAt();
    let [tx, ty] = [x, y];
    const paint = () => {
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    };
    paint();
    const onResize = () => {
      [tx, ty] = restAt();
      if (!finePointer() || prefersReduced()) [x, y] = [tx, ty];
      paint();
    };
    window.addEventListener("resize", onResize);
    if (!finePointer() || prefersReduced()) return () => window.removeEventListener("resize", onResize);

    let raf = 0;
    const loop = () => {
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      paint();
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.6 ? requestAnimationFrame(loop) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = host.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      [tx, ty] = inside ? [e.clientX - r.left - size / 2, e.clientY - r.top - size / 2] : restAt();
      kick();
    };
    const onLeave = () => {
      [tx, ty] = restAt();
      kick();
    };
    const target: HTMLElement | Window = scope === "window" ? window : host;
    target.addEventListener("pointermove", onMove as EventListener, { passive: true });
    if (scope === "parent") host.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      target.removeEventListener("pointermove", onMove as EventListener);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [size, rx, ry, scope]);
  return <div ref={ref} aria-hidden className={`cursor-light ${className}`} style={{ ["--size" as string]: `${size}px`, ...style }} />;
}

// ---- Sliding pill ---------------------------------------------------------------------------------------

/**
 * Clips the container's `.pill-layer` to its active `[data-pill-item]` (CSS transition on clip-path).
 * The first placement is instant; later moves slide.
 */
export function usePillClip(ref: RefObject<HTMLElement | null>, active: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const item = el.querySelectorAll<HTMLElement>("[data-pill-item]")[active];
      if (!item) return;
      el.style.setProperty("--pl", `${item.offsetLeft}px`);
      el.style.setProperty("--pr", `${el.clientWidth - item.offsetLeft - item.offsetWidth}px`);
    };
    place();
    let raf = 0;
    if (el.dataset.ready !== "true") raf = requestAnimationFrame(() => (el.dataset.ready = "true"));
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref, active]);
}
