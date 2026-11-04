import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/types";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// Research on Otari: web search through POST /v1/search (billed to the restaurant), and pages read by the Tablecast
// MCP server inside Otari's tool loop, whose exact text comes back in otari_tool_calls.
const { calls, script } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[], script: { turns: [] as unknown[] } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = recordCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/v1/search"))
      return otariJSONResponse({
        object: "search",
        search_tool: "exa-search",
        results: [
          { title: "Gjelina review", url: "https://la.eater.com/gjelina", snippet: "Gjelina on Abbot Kinney is loved for its pizzas.", date: "2026-10-30" },
          { title: "No text", url: "https://example.com/empty", snippet: "" },
          { title: "Bad url", url: "javascript:alert(1)", snippet: "x" },
        ],
      });
    return otariJSONResponse(script.turns.shift(), { headers: { "otari-provider": "deepinfra", "otari-model": "Qwen/Qwen3-235B-A22B-Instruct-2507" } });
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { gather, type Routing } from "@/lib/model-runtime";
import { withRun, type OtariToolCall } from "@/lib/otari";
import { otariSearch, recentEnough } from "@/lib/sources/otari-search";
import { formatReadPage } from "@/lib/mcp-server";

const routing: Routing = { fast: "tablecast-research", repair: "tablecast-check", reasoning: "tablecast-write", vision: "v", effort: "low" };

beforeEach(() => {
  calls.length = 0;
  script.turns = [];
});

describe("Otari web search", () => {
  it("sends the query billed to the restaurant and keeps only results with text and an http(s) URL", async () => {
    const r = await withRun({ id: "tablecast-t", endUser: "restaurant:gjelina-los-angeles" }, () => otariSearch("Gjelina reviews", { maxResults: 5, country: "us" }));
    expect(calls[0].url).toBe("https://eu.api.otari.ai/api/v1/search");
    expect(calls[0].body).toEqual({ query: "Gjelina reviews", max_results: 5, country: "US", max_tokens_per_page: 600, user: "restaurant:gjelina-los-angeles" });
    expect(calls[0].headers["otari-conversation-id"]).toBe("tablecast-t");
    expect(r.tool).toBe("exa-search");
    expect(r.results).toEqual([{ title: "Gjelina review", url: "https://la.eater.com/gjelina", content: "Gjelina on Abbot Kinney is loved for its pizzas.", published_date: "2026-10-30" }]);
  });

  it("treats news older than two weeks as not this week, and keeps undated results", () => {
    expect(recentEnough({ title: "", url: "", content: "", published_date: "2026-10-30" }, "2026-11-04")).toBe(true);
    expect(recentEnough({ title: "", url: "", content: "", published_date: "2026-09-01" }, "2026-11-04")).toBe(false);
    expect(recentEnough({ title: "", url: "", content: "" }, "2026-11-04")).toBe(true);
  });
});

describe("research that stops too early", () => {
  it("sends the model back once with what is missing, then accepts READY", async () => {
    script.turns = [{ choices: [{ message: { content: "READY", tool_calls: [] } }] }, { choices: [{ message: { content: "READY" } }] }];
    let asked = 0;
    await gather({
      routing,
      system: "s",
      user: "u",
      tools: [],
      maxTurns: 4,
      budgetMs: 10_000,
      emit: () => undefined,
      beforeReady: () => (++asked === 1 ? "Not ready yet: read a review." : undefined),
    });
    expect(calls).toHaveLength(2);
    const history = calls[1].body?.messages as { role: string; content: string; tool_calls?: unknown }[];
    expect(history.at(-1)).toEqual({ role: "user", content: "Not ready yet: read a review." });
    expect(history.at(-2)?.tool_calls).toBeUndefined(); // an empty tool_calls list is not sent back
  });
});

describe("research turns with the Tablecast MCP server inside Otari", () => {
  it("names the MCP server on every turn, hands Otari's MCP outputs to the app and tells the model what became a source", async () => {
    const output = formatReadPage({ url: "https://www.gjelina.com/los-angeles-menus", title: "Menus", text: "Pomodoro 22", chars: 11, truncated: false, kind: "menu" });
    const mcpCall: OtariToolCall = { id: "otari_mcp_1", type: "mcp", status: "completed", server: "tablecast", name: "read_page", output };
    script.turns = [
      {
        choices: [{ message: { content: "Reading the menu.", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] } }],
        otari_tool_calls: [mcpCall],
      },
      { choices: [{ message: { content: "READY" } }] },
    ];
    const seen: OtariToolCall[][] = [];
    const events: AgentEvent[] = [];
    const mcp = { name: "tablecast", url: "https://tablecast.example/api/mcp", authorization_token: "t", purpose_hint: "p", allowed_tools: ["read_page"] };
    await gather({
      routing,
      system: "s",
      user: "u",
      tools: [{ name: "noop", description: "n", schema: (await import("zod")).z.object({}), run: async () => "ok" }],
      maxTurns: 3,
      budgetMs: 10_000,
      emit: (e) => events.push(e),
      extra: { mcp_servers: [mcp], max_tool_iterations: 4 },
      onGatewayCalls: (c) => {
        seen.push(c);
        return "Pages read with read_page in that step: - S9: https://www.gjelina.com/los-angeles-menus (menu)";
      },
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.body?.mcp_servers).toEqual([mcp]);
      expect(c.body?.max_tool_iterations).toBe(4);
    }
    expect(seen).toEqual([[mcpCall]]);
    // The second turn's history carries the tool result and, after it, the note about the pages read inside Otari.
    const history = calls[1].body?.messages as { role: string; content: string }[];
    expect(history.slice(-2).map((m) => m.role)).toEqual(["tool", "user"]);
    expect(history.at(-1)?.content).toMatch(/S9: https:\/\/www.gjelina.com\/los-angeles-menus/);
    const engine = events.find((e) => e.type === "engine");
    expect(engine?.type === "engine" && engine.call.note).toMatch(/1 tool call run inside Otari \(MCP read_page\)/);
  });
});
