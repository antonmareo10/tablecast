"use client";

// The state of the whole flow, in one hook: which plan, the posts as the owner has edited them, who they go to and
// what was scheduled. It survives the sign-in round trip to Buffer (a full page navigation) through sessionStorage,
// which holds nothing secret: plan text, ids and choices. Tokens stay in HttpOnly cookies on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PostSpec, NetworkKey } from "@/lib/post-writer";
import { defaultTargets, movePost as moveSpec, setVariantText } from "@/lib/week";
import { api, ApiError, type ScheduleResponse, type SessionInfo, type WriteResult } from "./api";

export type StepId = "connect" | "week" | "review" | "schedule" | "queue" | "replan";
export const STEPS: { id: StepId; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "week", label: "Week" },
  { id: "review", label: "Review" },
  { id: "schedule", label: "Schedule" },
  { id: "queue", label: "Queue" },
  { id: "replan", label: "Re-plan" },
];

export type PlanRequest = { plan: string } | { live: unknown };
export type ScheduledRun = { posts: PostSpec[]; channelIds: string[]; draft: boolean; at: string; result: ScheduleResponse };

type Persisted = {
  step: StepId;
  request: PlanRequest | null;
  plan: WriteResult | null;
  posts: PostSpec[];
  removed: string[];
  targets: Record<string, string[]>;
  selected: string[];
  scheduled: ScheduledRun | null;
};

const KEY = "tc_week_v1";
export const LIVE_KEY = "tc_live_plan";

const read = (): Partial<Persisted> => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Partial<Persisted>;
  } catch {
    return {};
  }
};

export type SessionState = { status: "loading" } | { status: "ready"; info: SessionInfo } | { status: "error"; error: unknown };

export function useWeekStore() {
  const [step, setStep] = useState<StepId>("week");
  const [request, setRequest] = useState<PlanRequest | null>(null);
  const [plan, setPlan] = useState<WriteResult | null>(null);
  const [planState, setPlanState] = useState<{ loading: boolean; error: unknown }>({ loading: false, error: null });
  const [posts, setPosts] = useState<PostSpec[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [scheduled, setScheduled] = useState<ScheduledRun | null>(null);
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [hydrated, setHydrated] = useState(false);

  // Restore after mount (sessionStorage does not exist on the server, and the first paint must match it).
  useEffect(() => {
    const p = read();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of the saved flow
    if (p.plan) { setPlan(p.plan); setImages(p.plan.images ?? {}); }
    if (p.posts) setPosts(p.posts);
    if (p.removed) setRemoved(p.removed);
    if (p.targets) setTargets(p.targets);
    if (p.selected) setSelected(p.selected);
    if (p.request) setRequest(p.request);
    if (p.scheduled) setScheduled(p.scheduled);
    if (p.step) setStep(p.step);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const data: Persisted = { step, request, plan: plan ? { ...plan, images: {} } : null, posts, removed, targets, selected, scheduled };
      sessionStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* private window or full storage: the flow still works, it just will not survive a reload */
    }
  }, [hydrated, step, request, plan, posts, removed, targets, selected, scheduled]);

  const refreshSession = useCallback(async () => {
    setSession({ status: "loading" });
    try {
      const info = await api<SessionInfo>("/api/buffer/session");
      setSession({ status: "ready", info });
      if (info.connected) {
        const ids = new Set(info.channels.map((c) => c.id));
        setSelected((cur) => {
          const kept = cur.filter((id) => ids.has(id));
          if (kept.length) return kept;
          const usable = info.channels.filter((c) => !c.isDisconnected && !c.isLocked).slice(0, 1);
          return usable.map((c) => c.id);
        });
      }
    } catch (error) {
      setSession({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the session check once the saved flow is restored
    if (hydrated) void refreshSession();
  }, [hydrated, refreshSession]);

  const selectedRef = useRef<string[]>([]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const lastImageKey = useRef<string>("");

  const loadPlan = useCallback(async (req: PlanRequest) => {
    setPlanState({ loading: true, error: null });
    try {
      const r = await api<WriteResult>("/api/buffer/write", req);
      lastImageKey.current = JSON.stringify(r.posts.map((p) => [p.id, p.image]));
      setRequest(req);
      setPlan(r);
      setPosts(r.posts);
      setImages(r.images);
      setRemoved([]);
      setScheduled(null);
      setTargets(defaultTargets(r.posts, selectedRef.current));
      setPlanState({ loading: false, error: null });
    } catch (error) {
      setPlanState({ loading: false, error });
    }
  }, []);

  const toggleChannel = useCallback((id: string) => {
    const cur = selectedRef.current;
    const on = cur.includes(id);
    if (!on && cur.length >= 5) return;
    setSelected(on ? cur.filter((c) => c !== id) : [...cur, id]);
    setTargets((t) => Object.fromEntries(Object.entries(t).map(([pid, ids]) => [pid, on ? ids.filter((c) => c !== id) : ids.includes(id) ? ids : [...ids, id]])));
  }, []);

  // Posts added to the plan later (none today) or restored get every selected channel.
  const targetsFor = useCallback((id: string) => targets[id] ?? selected, [targets, selected]);

  const toggleTarget = useCallback((postId: string, channelId: string) => {
    setTargets((t) => {
      const cur = t[postId] ?? [];
      return { ...t, [postId]: cur.includes(channelId) ? cur.filter((c) => c !== channelId) : [...cur, channelId] };
    });
  }, []);

  const editText = useCallback((postId: string, network: NetworkKey, text: string) => {
    setPosts((ps) => ps.map((p) => (p.id === postId ? setVariantText(p, network, text) : p)));
  }, []);

  const resetPost = useCallback((postId: string) => {
    const orig = plan?.posts.find((p) => p.id === postId);
    if (orig) setPosts((ps) => ps.map((p) => (p.id === postId ? orig : p)));
  }, [plan]);

  /** Returns an error message when the move is refused. */
  const movePost = useCallback((postId: string, date: string, time: string): string | null => {
    const cur = posts.find((p) => p.id === postId);
    if (!cur) return "That post is gone.";
    const moved = moveSpec(cur, date, time);
    if (!moved) return "Pick a valid date and time.";
    if (new Date(moved.post_at.utc).getTime() <= Date.now() + 15 * 60_000) return "That time is in the past (or less than 15 minutes away).";
    if (posts.some((p) => p.id !== postId && p.post_at.utc === moved.post_at.utc)) return "Another post is already at that exact minute.";
    setPosts((ps) => ps.map((p) => (p.id === postId ? moved : p)));
    return null;
  }, [posts]);

  const toggleRemoved = useCallback((postId: string) => {
    setRemoved((r) => (r.includes(postId) ? r.filter((x) => x !== postId) : [...r, postId]));
  }, []);

  // A moved post changes the weekday printed on its picture: ask the server for fresh signed paths (debounced).
  const imageKey = useMemo(() => JSON.stringify(posts.map((p) => [p.id, p.image])), [posts]);
  useEffect(() => {
    if (!plan || !hydrated || posts.length === 0 || imageKey === lastImageKey.current) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api<{ images: Record<string, string> }>("/api/buffer/images", { posts }, ctl.signal)
        .then((r) => { lastImageKey.current = imageKey; setImages((cur) => ({ ...cur, ...r.images })); })
        .catch(() => { /* a missing thumbnail is not worth an error */ });
    }, 350);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [imageKey, plan, hydrated, posts]);

  const active = useMemo(() => posts.filter((p) => !removed.includes(p.id)), [posts, removed]);

  const reset = useCallback(() => {
    setRequest(null); setPlan(null); setPosts([]); setRemoved([]); setTargets({}); setImages({}); setScheduled(null); setPlanState({ loading: false, error: null });
  }, []);

  return {
    hydrated, step, setStep, request, plan, planState, loadPlan, reset,
    posts, active, removed, targets, targetsFor, selected, images, scheduled, setScheduled,
    session, refreshSession, toggleChannel, toggleTarget, editText, resetPost, movePost, toggleRemoved,
    connected: session.status === "ready" && session.info.connected,
    channels: session.status === "ready" && session.info.connected ? session.info.channels : [],
    edited: posts.some((p, i) => JSON.stringify(p) !== JSON.stringify(plan?.posts[i])),
  };
}

export type WeekStore = ReturnType<typeof useWeekStore>;
export { ApiError };
