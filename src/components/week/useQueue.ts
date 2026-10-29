"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type QueueInfo } from "./api";

export type QueueState = { status: "idle" } | { status: "loading" } | { status: "ready"; data: QueueInfo; at: number } | { status: "error"; error: unknown };

/** What Buffer already holds (and the daily limits). Loads once when `enabled`, again on reload(). */
export function useQueue(enabled: boolean, withLimits: boolean) {
  const [state, setState] = useState<QueueState>({ status: "idle" });
  const ctl = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ status: "loading" });
    try {
      const data = await api<QueueInfo>(`/api/buffer/queue${withLimits ? "?limits=1" : ""}`, undefined, c.signal);
      if (!c.signal.aborted) setState({ status: "ready", data, at: Date.now() });
    } catch (error) {
      if (!c.signal.aborted) setState({ status: "error", error });
    }
  }, [withLimits]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting a fetch when the screen opens
    if (enabled) void reload();
    return () => ctl.current?.abort();
  }, [enabled, reload]);
  return { state, reload };
}
