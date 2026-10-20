import { vi } from "vitest";

export type FetchCall = { url: string; init: RequestInit | undefined };
export type Handler = (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Stubs global fetch with `handler` and records every call. */
export function mockFetch(handler: Handler) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

/** A fetch that never answers until its signal aborts (simulates a hung server). */
export function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

export function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

export function silenceWarnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}
