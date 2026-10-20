import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extract, search, tavilyCountry, truncateText } from "../../src/lib/sources/tavily";
import { SourceError } from "../../src/lib/sources/http";
import { header, jsonResponse, mockFetch, silenceWarnings } from "./helpers";

beforeEach(() => {
  silenceWarnings();
  vi.stubEnv("TAVILY_API_KEY", "tvly-test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>;

const searchAnswer = {
  query: "q",
  answer: "  Madrid hosts the Coldplay tour this week.  ",
  images: [],
  results: [
    { title: "Coldplay in Madrid", url: "https://news.example/a", content: "Coldplay play  Madrid\non Friday.", score: 0.91, published_date: "Tue, 20 Oct 2026 08:00:00 GMT", raw_content: null },
    { title: "", url: "https://news.example/b", content: "x".repeat(5_000), score: 0.5 },
    { title: "No URL", content: "dropped" },
  ],
  response_time: 1.2,
  usage: { credits: 1 },
  request_id: "r1",
};

describe("search", () => {
  it("throws CONFIG without a key and makes no call", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const { calls } = mockFetch(() => jsonResponse(searchAnswer));
    const err = await search("anything").catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.code).toBe("CONFIG");
    await expect(extract(["https://a.example"])).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });

  it("POSTs the documented parameters with Bearer auth and include_usage", async () => {
    const { calls } = mockFetch(() => jsonResponse(searchAnswer));
    await search("events in Madrid this week", {
      timeRange: "week",
      country: "ES",
      maxResults: 8,
      depth: "advanced",
      includeDomains: ["esmadrid.com"],
      includeAnswer: true,
    });
    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect(calls[0].init?.method).toBe("POST");
    expect(header(calls[0].init, "authorization")).toBe("Bearer tvly-test");
    expect(header(calls[0].init, "content-type")).toBe("application/json");
    expect(bodyOf(calls[0].init)).toEqual({
      query: "events in Madrid this week",
      topic: "general",
      search_depth: "advanced",
      max_results: 8,
      include_answer: "basic",
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      time_range: "week",
      country: "spain",
      include_domains: ["esmadrid.com"],
    });
  });

  it("uses sane defaults and drops country for news", async () => {
    const { calls } = mockFetch(() => jsonResponse(searchAnswer));
    await search("restaurant openings", { topic: "news", country: "spain" });
    expect(bodyOf(calls[0].init)).toEqual({
      query: "restaurant openings",
      topic: "news",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
    });
  });

  it("parses results, answer and credits", async () => {
    mockFetch(() => jsonResponse(searchAnswer));
    const r = await search("q");
    expect(r.answer).toBe("Madrid hosts the Coldplay tour this week.");
    expect(r.credits).toBe(1);
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toEqual({
      title: "Coldplay in Madrid",
      url: "https://news.example/a",
      content: "Coldplay play Madrid on Friday.",
      score: 0.91,
      published_date: "Tue, 20 Oct 2026 08:00:00 GMT",
    });
    expect(r.results[1].title).toBe("https://news.example/b");
    expect(r.results[1].content.length).toBeLessThanOrEqual(2_000);
    expect(r.results[1]).not.toHaveProperty("published_date");
  });

  it("reports null credits and answer when absent", async () => {
    mockFetch(() => jsonResponse({ results: [], answer: null }));
    await expect(search("q")).resolves.toEqual({ answer: null, results: [], credits: null });
  });

  it("throws CONFIG for a rejected key or an exhausted plan", async () => {
    mockFetch(() => jsonResponse({ detail: { error: "Unauthorized: missing or invalid API key." } }, 401));
    await expect(search("q")).rejects.toMatchObject({ code: "CONFIG", status: 401 });
    mockFetch(() => jsonResponse({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432));
    await expect(search("q")).rejects.toMatchObject({ code: "CONFIG", status: 432 });
  });

  it("returns an empty result on upstream failure (after one retry)", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch(() => jsonResponse({ detail: { error: "Internal error" } }, 500));
    const pending = search("q");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ answer: null, results: [], credits: null });
    expect(calls).toHaveLength(2);
  });

  it("retries once without country when Tavily rejects the country name", async () => {
    const { calls } = mockFetch((_u, init) =>
      bodyOf(init).country ? jsonResponse({ detail: { error: "Invalid country" } }, 400) : jsonResponse(searchAnswer),
    );
    const r = await search("q", { country: "CZ" });
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0].init).country).toBe("czechia");
    expect(bodyOf(calls[1].init)).not.toHaveProperty("country");
    expect(r.results).toHaveLength(2);
  });
});

describe("extract", () => {
  it("POSTs urls with text format and usage, truncates to ~6,000 chars, and lists failures", async () => {
    const long = `${"word ".repeat(1_500)}END`;
    const { calls } = mockFetch(() =>
      jsonResponse({
        results: [
          { url: "https://a.example/menu", raw_content: "  Menu del día 14 €  " },
          { url: "https://b.example/long", raw_content: long },
        ],
        failed_results: [{ url: "https://c.example/404", error: "404" }],
        response_time: 2,
        usage: { credits: 1 },
      }),
    );
    const r = await extract(["https://a.example/menu", "https://b.example/long", "https://c.example/404", "not a url", "https://a.example/menu"], {
      query: "lunch menu price",
      chunksPerSource: 9,
    });
    expect(calls[0].url).toBe("https://api.tavily.com/extract");
    expect(header(calls[0].init, "authorization")).toBe("Bearer tvly-test");
    expect(bodyOf(calls[0].init)).toEqual({
      urls: ["https://a.example/menu", "https://b.example/long", "https://c.example/404"],
      extract_depth: "basic",
      format: "text",
      include_images: false,
      include_usage: true,
      query: "lunch menu price",
      chunks_per_source: 5,
    });
    expect(r.results[0]).toEqual({ url: "https://a.example/menu", content: "Menu del día 14 €" });
    expect(r.results[1].content.length).toBeLessThanOrEqual(6_000);
    expect(r.results[1].content.length).toBeGreaterThan(5_800);
    expect(r.results[1].content.endsWith("word")).toBe(true);
    expect(r.failed).toEqual(["not a url", "https://c.example/404"]);
    expect(r.credits).toBe(1);
  });

  it("omits chunks_per_source without a query", async () => {
    const { calls } = mockFetch(() => jsonResponse({ results: [], failed_results: [] }));
    const r = await extract(["https://a.example"], { chunksPerSource: 2, depth: "advanced" });
    expect(bodyOf(calls[0].init)).toEqual({
      urls: ["https://a.example"],
      extract_depth: "advanced",
      format: "text",
      include_images: false,
      include_usage: true,
    });
    expect(r).toEqual({ results: [], failed: [], credits: null });
  });

  it("batches more than 20 URLs and sums credits", async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://site.example/p${i}`);
    const { calls } = mockFetch((_u, init) => {
      const batch = bodyOf(init).urls as string[];
      return jsonResponse({ results: batch.map((url) => ({ url, raw_content: `content of ${url}` })), failed_results: [], usage: { credits: 1 } });
    });
    const r = await extract(urls);
    expect(calls.map((c) => (bodyOf(c.init).urls as string[]).length)).toEqual([20, 5]);
    expect(r.results).toHaveLength(25);
    expect(r.credits).toBe(2);
  });

  it("makes no call for an empty list", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(extract([])).resolves.toEqual({ results: [], failed: [], credits: null });
    expect(calls).toHaveLength(0);
  });

  it("marks a whole batch failed on upstream error", async () => {
    vi.useFakeTimers();
    mockFetch(() => jsonResponse("bad gateway", 502));
    const pending = extract(["https://a.example", "https://b.example"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ results: [], failed: ["https://a.example", "https://b.example"], credits: null });
  });
});

describe("helpers", () => {
  it("maps ISO codes to Tavily country names", () => {
    expect(tavilyCountry("ES")).toBe("spain");
    expect(tavilyCountry("us")).toBe("united states");
    expect(tavilyCountry("Spain")).toBe("spain");
    expect(tavilyCountry("")).toBeUndefined();
  });

  it("truncates at a word boundary", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("alpha beta gamma", 12)).toBe("alpha beta");
  });
});

describe("map", () => {
  it("maps a site on the same domain and reports credits", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ base_url: "https://casalucio.es", results: ["https://casalucio.es/carta", "https://casalucio.es/historia", "https://casalucio.es/carta", 42], usage: { credits: 1 } }),
    );
    const { map } = await import("../../src/lib/sources/tavily");
    const res = await map("casalucio.es", { limit: 20 });
    expect(res).toEqual({ urls: ["https://casalucio.es/carta", "https://casalucio.es/historia"], credits: 1 });
    expect(calls[0].url).toBe("https://api.tavily.com/map");
    const body = bodyOf(calls[0].init);
    expect(body).toMatchObject({ url: "https://casalucio.es/", limit: 20, max_depth: 1, allow_external: false, include_usage: true });
    expect(body.instructions).toBeUndefined();
  });

  it("returns an empty list on upstream failure and still throws on a bad key", async () => {
    mockFetch(() => jsonResponse({ detail: "boom" }, 500));
    const { map } = await import("../../src/lib/sources/tavily");
    expect(await map("https://example.com")).toEqual({ urls: [], credits: null });
    mockFetch(() => jsonResponse({ detail: "bad key" }, 401));
    await expect(map("https://example.com")).rejects.toMatchObject({ code: "CONFIG" });
  });
});
