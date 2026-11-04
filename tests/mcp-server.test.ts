import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "./sources/helpers";

// The route must speak real MCP (streamable HTTP, JSON answers): initialize, tools/list, tools/call, notifications,
// errors in JSON-RPC form, and a bearer token on every request.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { inlineMcpServer, parseReadPageOutput } from "@/lib/mcp-server";

const TOKEN = "test-token-0123456789";
let id = 0;
const rpc = (method: string, params?: Record<string, unknown>, opts: { token?: string | null; notification?: boolean; origin?: string } = {}) =>
  POST(
    new Request("https://tablecast.example/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(opts.token !== null ? { authorization: `Bearer ${opts.token ?? TOKEN}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(opts.notification ? {} : { id: ++id }), ...(params ? { params } : {}) }),
    }),
  );

beforeEach(() => {
  process.env.TABLECAST_MCP_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.TABLECAST_MCP_TOKEN;
  delete process.env.TABLECAST_MCP_URL;
  vi.unstubAllGlobals();
});

describe("Tablecast MCP server", () => {
  it("initializes like an MCP server, negotiating the protocol version", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "otari", version: "1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("tablecast-sources");
    const unknown = (await (await rpc("initialize", { protocolVersion: "1999-01-01" })).json()) as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const res = await rpc("notifications/initialized", undefined, { notification: true });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists its two read-only tools with JSON schemas", async () => {
    const body = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string; inputSchema: { type: string; required: string[] }; annotations: { readOnlyHint: boolean } }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["read_page", "find_menu_pages"]);
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  it("runs read_page and returns the page text in a form the app parses back exactly", async () => {
    mockFetch(() => new Response("<html><head><title>Carta</title></head><body><main><p>Huevos estrellados 18 €</p><p>Callos 21 €</p><p>Abierto todos los días de 13:00 a 16:00 y de 20:30 a 24:00.</p></main></body></html>", { headers: { "content-type": "text/html" } }));
    const body = (await (await rpc("tools/call", { name: "read_page", arguments: { url: "https://casalucio.es/carta", focus: "menu" } })).json()) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    const parsed = parseReadPageOutput(body.result.content[0].text);
    expect(parsed).toEqual({ url: "https://casalucio.es/carta", title: "Carta", text: "Huevos estrellados 18 €\nCallos 21 €\nAbierto todos los días de 13:00 a 16:00 y de 20:30 a 24:00." });
  });

  it("reports a page it cannot read as a tool error, not a transport error", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    const res = await rpc("tools/call", { name: "read_page", arguments: { url: "https://example.com/gone" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/404/);
  });

  it("runs find_menu_pages for a branch", async () => {
    mockFetch((url) =>
      url.endsWith("/sitemap.xml")
        ? new Response("not found", { status: 404 })
        : new Response('<a href="/los-angeles-menus">Menus</a><a href="/new-york-menus">NY</a>', { headers: { "content-type": "text/html" } }),
    );
    const body = (await (await rpc("tools/call", { name: "find_menu_pages", arguments: { website: "https://www.gjelina.com", city: "Los Angeles" } })).json()) as {
      result: { structuredContent: { pages: string[]; other_branches: string[] } };
    };
    expect(body.result.structuredContent.pages).toEqual(["https://www.gjelina.com/los-angeles-menus"]);
    expect(body.result.structuredContent.other_branches).toEqual(["https://www.gjelina.com/new-york-menus"]);
  });

  it("answers JSON-RPC errors for unknown methods and tools", async () => {
    const a = (await (await rpc("resources/list")).json()) as { error: { code: number } };
    expect(a.error.code).toBe(-32601);
    const b = (await (await rpc("tools/call", { name: "rm_rf", arguments: {} })).json()) as { error: { code: number } };
    expect(b.error.code).toBe(-32602);
  });

  it("refuses requests without the token, from a browser Origin, or when no token is configured", async () => {
    expect((await rpc("tools/list", undefined, { token: null })).status).toBe(401);
    expect((await rpc("tools/list", undefined, { token: "wrong-token-0123456789" })).status).toBe(401);
    expect((await rpc("tools/list", undefined, { origin: "https://evil.example" })).status).toBe(403);
    delete process.env.TABLECAST_MCP_TOKEN;
    expect((await rpc("tools/list")).status).toBe(503);
  });

  it("opens no stream: GET and DELETE are 405", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });

  it("is offered to Otari inline only with an https URL and a token", () => {
    process.env.TABLECAST_MCP_URL = "http://localhost:3000/api/mcp";
    expect(inlineMcpServer()).toBeNull();
    process.env.TABLECAST_MCP_URL = "https://tablecast.example/api/mcp";
    expect(inlineMcpServer()).toMatchObject({ name: "tablecast", url: "https://tablecast.example/api/mcp", authorization_token: TOKEN, allowed_tools: ["read_page", "find_menu_pages"] });
  });
});
