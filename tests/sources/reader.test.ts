import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "./helpers";

// Every host resolves to a public address here, except the names a test makes private.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host.startsWith("intranet") ? "10.0.0.7" : "93.184.216.34", family: 4 }],
}));

import { decodeEntities, focusText, htmlToText, isPrivateAddress, readPage, ReaderError } from "@/lib/sources/reader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("htmlToText", () => {
  it("keeps the content, drops scripts, navigation and footers, and splits blocks into lines", () => {
    const { title, text } = htmlToText(`<html><head><title>Dishoom &amp; Co</title><style>p{}</style></head><body>
      <nav><a href="/">Home</a> <a href="/menu">Menu</a></nav>
      <h1>All Day Menu</h1><p>Bacon Naan Roll<br>£8.90</p>
      <table><tr><td>House Black Daal</td><td>£7.50</td></tr></table>
      <script>alert(1)</script><footer>© 2026 Dishoom</footer></body></html>`);
    expect(title).toBe("Dishoom & Co");
    expect(text.split("\n")).toEqual(["All Day Menu", "Bacon Naan Roll", "£8.90", "House Black Daal | £7.50"]);
  });

  it("prefers <main> when it holds the page's content", () => {
    const main = "Plato del día ".repeat(40);
    const { text } = htmlToText(`<body><div>Cookie banner text that is long enough to matter here</div><main><p>${main}</p></main></body>`);
    expect(text).toBe(main.trim());
  });

  it("decodes named and numeric entities", () => {
    expect(decodeEntities("Caf&eacute; &#8211; 12&nbsp;&euro; &#x2014; &quot;ok&quot; &bogus;")).toBe('Café – 12 € — "ok" &bogus;');
  });
});

describe("focusText", () => {
  it("returns a short page whole and cuts a long one to the windows that match the focus, in page order", () => {
    expect(focusText("a\nb", "menu", 100)).toBe("a\nb");
    const filler = Array.from({ length: 48 }, (_, i) => `About our story line ${i}`);
    const menu = ["Pizza Margherita 12.50", "Pizza Diavola 14.00", "Tiramisu 7.00"];
    const text = [...filler.slice(0, 24), ...menu, ...filler.slice(24)].join("\n");
    const out = focusText(text, "menu dishes and prices", 400);
    expect(out).toContain("Pizza Margherita 12.50");
    expect(out.length).toBeLessThanOrEqual(400 + 10);
  });
});

describe("address safety", () => {
  it("knows private and reserved addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses a private host, a non-http scheme and a redirect into the private network, without fetching it", async () => {
    const { calls } = mockFetch((url) =>
      url.includes("public.example") ? new Response(null, { status: 302, headers: { location: "http://intranet.example/admin" } }) : new Response("secret"),
    );
    await expect(readPage("http://localhost:3000/")).rejects.toBeInstanceOf(ReaderError);
    await expect(readPage("file:///etc/passwd")).rejects.toThrow(/only http/);
    await expect(readPage("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/);
    await expect(readPage("https://public.example/menu")).rejects.toThrow(/private/);
    expect(calls.map((c) => c.url)).toEqual(["https://public.example/menu"]); // the private hop was never requested
  });

  it("refuses PDFs and pages with no readable text", async () => {
    mockFetch((url) =>
      url.endsWith(".pdf")
        ? new Response("%PDF", { headers: { "content-type": "application/pdf" } })
        : new Response("<html><body><div id=app></div></body></html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(readPage("https://a.example/menu.pdf")).rejects.toThrow(/PDF/);
    await expect(readPage("https://a.example/")).rejects.toThrow(/almost no readable text/);
  });
});
