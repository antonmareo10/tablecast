import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, SourceError, USER_AGENT } from "../../src/lib/sources/http";
import { hang, header, jsonResponse, mockFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fast = { backoffMs: 0 };

describe("fetchJson", () => {
  it("sends the Tastecraft User-Agent and parses JSON", async () => {
    const { calls } = mockFetch(() => jsonResponse({ ok: 1 }));
    await expect(fetchJson<{ ok: number }>("https://api.example.com/x")).resolves.toEqual({ ok: 1 });
    expect(header(calls[0].init, "user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("Tastecraft/1.0 (hackathon demo; contact antonmareo@gmail.com)");
    expect(header(calls[0].init, "accept")).toBe("application/json");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps caller headers and method", async () => {
    const { calls } = mockFetch(() => jsonResponse([]));
    await fetchJson("https://api.example.com/x", { method: "POST", headers: { authorization: "Bearer k" }, body: "{}" });
    expect(calls[0].init?.method).toBe("POST");
    expect(header(calls[0].init, "authorization")).toBe("Bearer k");
    expect(header(calls[0].init, "user-agent")).toBe(USER_AGENT);
  });

  it("retries once on 5xx, then succeeds", async () => {
    const { calls } = mockFetch((_u, _i, n) => (n === 0 ? jsonResponse("busy", 503) : jsonResponse({ ok: true })));
    await expect(fetchJson("https://api.example.com/x", {}, fast)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up after one retry with an UPSTREAM error carrying the status", async () => {
    const { calls } = mockFetch(() => jsonResponse("boom", 500));
    const err = await fetchJson("https://api.example.com/x", {}, fast).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ code: "UPSTREAM", status: 500 });
    expect(calls).toHaveLength(2);
  });

  it("does not retry 4xx", async () => {
    const { calls } = mockFetch(() => jsonResponse({ message: "nope" }, 404));
    await expect(fetchJson("https://api.example.com/x", {}, fast)).rejects.toMatchObject({ code: "UPSTREAM", status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 once and then reports RATE_LIMIT", async () => {
    const { calls } = mockFetch(() => jsonResponse("slow down", 429, { "retry-after": "0" }));
    await expect(fetchJson("https://api.example.com/x", {}, fast)).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429 });
    expect(calls).toHaveLength(2);
  });

  it("does not wait out a long Retry-After", async () => {
    const { calls } = mockFetch(() => jsonResponse("slow down", 429, { "retry-after": "120" }));
    await expect(fetchJson("https://api.example.com/x", {}, fast)).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(calls).toHaveLength(1);
  });

  it("retries a network error", async () => {
    const { calls } = mockFetch((_u, _i, n) => {
      if (n === 0) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    });
    await expect(fetchJson("https://api.example.com/x", {}, fast)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("times out with TIMEOUT and does not retry", async () => {
    const { calls } = mockFetch((_u, init) => hang(init));
    await expect(fetchJson("https://api.example.com/x", {}, { timeoutMs: 30, backoffMs: 0 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toHaveLength(1);
  });

  it("respects retries: 0", async () => {
    const { calls } = mockFetch(() => jsonResponse("x", 502));
    await expect(fetchJson("https://api.example.com/x", {}, { retries: 0 })).rejects.toMatchObject({ code: "UPSTREAM", status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("returns null for an empty body (204)", async () => {
    mockFetch(() => jsonResponse(null, 204));
    await expect(fetchJson("https://api.example.com/x")).resolves.toBeNull();
  });

  it("rejects invalid JSON as UPSTREAM", async () => {
    mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(fetchJson("https://api.example.com/x")).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("never leaks query-string secrets into error messages", async () => {
    mockFetch(() => jsonResponse("bad", 400));
    const err = (await fetchJson("https://api.example.com/x?apikey=SECRET123").catch((e) => e)) as SourceError;
    expect(err.message).not.toContain("SECRET123");
    expect(err.url).not.toContain("SECRET123");
  });

  it("runs beforeAttempt before every attempt", async () => {
    const before = vi.fn(async () => undefined);
    mockFetch((_u, _i, n) => (n === 0 ? jsonResponse("x", 500) : jsonResponse({})));
    await fetchJson("https://api.example.com/x", {}, { ...fast, beforeAttempt: before });
    expect(before).toHaveBeenCalledTimes(2);
  });
});
