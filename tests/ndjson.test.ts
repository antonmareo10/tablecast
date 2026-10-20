import { describe, expect, it } from "vitest";
import { encodeLine, readNdjson } from "@/lib/ndjson";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("ndjson", () => {
  it("round-trips events split across arbitrary chunk boundaries", async () => {
    const lines = [{ type: "a", n: 1 }, { type: "b", text: "café ☕" }, { type: "c" }];
    const text = lines.map((l) => new TextDecoder().decode(encodeLine(l))).join("");
    const chunks = [text.slice(0, 7), text.slice(7, 20), text.slice(20)];
    const out: unknown[] = [];
    for await (const ev of readNdjson(streamOf(chunks))) out.push(ev);
    expect(out).toEqual(lines);
  });

  it("parses a final line without a trailing newline", async () => {
    const out: unknown[] = [];
    for await (const ev of readNdjson(streamOf(['{"x":1}\n{"y":2}']))) out.push(ev);
    expect(out).toEqual([{ x: 1 }, { y: 2 }]);
  });
});
