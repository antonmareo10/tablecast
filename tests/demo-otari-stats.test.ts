import { describe, expect, it } from "vitest";
import { otariStats, type RecordedEvent } from "@/data/demos";

// The home page's "On Otari" line and "Measured on Otari" card read these from a recording: nothing is typed by hand.
const ev = (e: Record<string, unknown>, t = 0) => ({ ...e, t }) as unknown as RecordedEvent;

describe("otariStats", () => {
  it("reads roles, searches, MCP reads, guardrail checks and the bill from a recorded run", () => {
    const events = [
      ev({ type: "otari", run_id: "tablecast-x", api: "https://eu.api.otari.ai/api", routing: { research: "tablecast-research" }, end_user: "restaurant:a-b" }),
      ev({ type: "budget", stage: "start", end_user: "restaurant:a-b", spend: 0.2, limit: 1 }),
      ev({ type: "engine", call: { phase: "search", model: "otari_web_search", label: "Otari web search", ms: 0 } }),
      ev({ type: "engine", call: { phase: "search", model: "otari_web_search", label: "Otari web search", ms: 0 } }),
      ev({ type: "tool_start", id: "mcp-1", tool: "read_pages", label: "Reading a.com (Tablecast MCP, via Otari)", input: {} }),
      ev({ type: "tool_end", id: "mcp-1", tool: "read_pages", summary: "1 read", sources: ["S3"] }),
      ev({ type: "tool_start", id: "mcp-2", tool: "read_pages", label: "Reading b.com (Tablecast MCP, via Otari)", input: {} }),
      ev({ type: "tool_end", id: "mcp-2", tool: "read_pages", summary: "failed", error: true }),
      ev({ type: "tool_start", id: "menu", tool: "read_pages", label: "Reading the menu page: a.com/menu", input: {} }),
      ev({ type: "tool_end", id: "menu", tool: "read_pages", summary: "1 read (menu)", sources: ["S2"] }),
      ev({ type: "engine", call: { phase: "gather", model: "tablecast-research", label: "Qwen3 235B", ms: 900 } }),
      ev({ type: "guardrails", screening: { profile: "prompt-injection", available: true, screened: 3, passed: 3, unscreened: 0, flagged: [] } }),
      ev({ type: "engine", call: { phase: "synthesize", model: "tablecast-write", label: "Nemotron 3 Ultra", ms: 30000 } }),
      ev({ type: "engine", call: { phase: "code", model: "tablecast-quartermaster", label: "gpt-oss-120b", ms: 8000 } }),
      ev({ type: "quartermaster", report: {} }),
      ev({ type: "budget", stage: "end", end_user: "restaurant:a-b", spend: 0.3, limit: 1, before: 0.2 }),
    ];
    const s = otariStats(events)!;
    expect(s).toMatchObject({ researcher: "Qwen3 235B", writer: "Nemotron 3 Ultra", sandbox: "gpt-oss-120b", searches: 2, mcpReads: 1, screened: 3 });
    expect(s.billed).toBeCloseTo(0.1, 6);
  });

  it("says nothing for a run recorded before Otari, and leaves out what the run didn't do", () => {
    expect(otariStats([ev({ type: "engine", call: { phase: "synthesize", model: "nemotron", label: "Nemotron 3 Ultra", ms: 1 } })])).toBeUndefined();
    const s = otariStats([
      ev({ type: "otari", run_id: "tablecast-y", api: "x", routing: {} }),
      ev({ type: "engine", call: { phase: "code", model: "tablecast-quartermaster", label: "gpt-oss-120b", ms: 1 } }),
      ev({ type: "guardrails", screening: { profile: "prompt-injection", available: false, screened: 0, passed: 0, unscreened: 0, flagged: [] } }),
    ])!;
    expect(s.sandbox).toBeUndefined(); // no sandbox report: the program did not produce one
    expect(s.billed).toBeUndefined();
    expect(s).toMatchObject({ searches: 0, mcpReads: 0, screened: 0 });
  });
});
