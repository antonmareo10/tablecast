import { DEMOS } from "@/data/demos";
import { encodeLine } from "@/lib/ndjson";

// Replays a recorded real run with its original rhythm, compressed so it finishes in ~15 s
// (or in ?seconds=5-90, e.g. to follow it at a slower pace).
export async function GET(request: Request, ctx: RouteContext<"/api/demo/[slug]">) {
  const { slug } = await ctx.params;
  const demo = DEMOS.find((d) => d.slug === slug);
  if (!demo) return Response.json({ error: "Unknown demo" }, { status: 404 });

  const total = Math.max(1, demo.events.at(-1)?.t ?? 1);
  const seconds = Math.min(90, Math.max(5, Number(new URL(request.url).searchParams.get("seconds")) || 15));
  const scale = Math.min(1, (seconds * 1000) / total);
  const maxGap = 100 * seconds; // 1.5 s at the default pace
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = 0;
      for (const { t, ...event } of demo.events) {
        const wait = Math.min(maxGap, Math.max(0, (t - last) * scale));
        last = t;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        controller.enqueue(encodeLine(event.type === "done" ? { ...event, elapsed_ms: total } : event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
