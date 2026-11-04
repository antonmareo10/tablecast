import { afterAll, describe, expect, it, vi } from "vitest";
import { otariJSONResponse, recordCall, type Recorded } from "./helpers/otari-mock";

// Otari's web fetch on the Messages API returns the extracted page text in a web_fetch_tool_result block; the app keeps
// that text (the shape below is the one Otari answered on 4 Nov 2026) and ignores the model's own reply.
const { calls, mode } = vi.hoisted(() => {
  process.env.OTARI_API_KEY = "otk_test";
  return { calls: [] as Recorded[], mode: { value: "ok" as "ok" | "error" } };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push(recordCall(input, init));
    const result =
      mode.value === "ok"
        ? {
            type: "web_fetch_result",
            url: "https://casalucio.es/carta.pdf",
            retrieved_at: "2026-11-04T09:58:11Z",
            content: { type: "document", source: { type: "text", media_type: "text/plain", data: "CARTA\nHuevos estrellados 18 €\nCallos a la madrileña 21 €\nCordero asado 32 €" } },
          }
        : { type: "web_fetch_tool_error", error_code: "url_not_accessible" };
    return otariJSONResponse({
      content: [
        { type: "server_tool_use", id: "otari_srvtoolu_1", name: "web_fetch", input: { url: "https://casalucio.es/carta.pdf" } },
        { type: "web_fetch_tool_result", tool_use_id: "otari_srvtoolu_1", content: result },
        { type: "text", text: "OK" },
      ],
      usage: { input_tokens: 840, output_tokens: 5, cost_usd: "0.010727", pricing_source: "deployment" },
    });
  }),
);
afterAll(() => vi.unstubAllGlobals());

import { otariFetchPage } from "@/lib/sources/otari-fetch";
import { withRun } from "@/lib/otari";

describe("Otari web fetch", () => {
  it("asks for one gateway-run fetch on the Messages API and keeps the extracted text", async () => {
    const f = await withRun({ id: "tablecast-t", endUser: "restaurant:casa-lucio-madrid" }, () => otariFetchPage("https://casalucio.es/carta.pdf"));
    expect(f.url).toBe("https://casalucio.es/carta.pdf");
    expect(f.text).toContain("Callos a la madrileña 21 €");
    expect(f.served.cost_usd).toBeCloseTo(0.010727, 9);
    const c = calls[0];
    expect(c.url).toBe("https://eu.api.otari.ai/api/v1/messages");
    expect(c.headers["otari-web-fetch"]).toBe("otari");
    expect(c.body).toMatchObject({ tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }], metadata: { user_id: "restaurant:casa-lucio-madrid" } });
  });

  it("throws when Otari's fetcher could not read the page", async () => {
    mode.value = "error";
    await expect(otariFetchPage("https://example.com/gone")).rejects.toThrow(/url_not_accessible/);
  });
});
