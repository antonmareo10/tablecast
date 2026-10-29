import { bufferContext, NoOrganization, selectedChannels } from "@/lib/buffer/context";
import { errorResponse, sameOrigin } from "@/lib/buffer/http";
import { asPosts, LocationSchema, PostsSchema, SnapshotSchema } from "@/lib/buffer/schemas";
import { applyMoves, diffForecasts, proposeMoves, simulateUpdate, type Snapshot } from "@/lib/replan";
import { textFor } from "@/lib/schedule";
import { weekForecast } from "@/lib/sources/weather";
import { z } from "zod";

// "The queue follows the weather". POST without `approve` only computes proposals: the posts as written, the forecast
// they were written for, the queue read from Buffer and today's forecast. POST with `approve` computes them again
// (nothing the browser sends is ever turned into an edit) and applies only the proposals the owner approved, and
// only if the proposal is still the same (same post, same new time).

const Body = z.object({
  posts: PostsSchema,
  previous: SnapshotSchema,
  location: LocationSchema,
  organizationId: z.string().max(80).optional(),
  channelIds: z.array(z.string().max(80)).max(10).optional(),
  scenario: z.enum(["live", "simulated"]).default("live"),
  approve: z.array(z.object({ postId: z.string().max(120), dueAt: z.string().max(40) })).max(60).optional(),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "bad_request", message: "Send the posts, the forecast they were written for and the location." }, { status: 400 });
    const b = parsed.data;
    const specs = asPosts(b.posts);
    const previous = b.previous as unknown as Snapshot;

    const { client, organizationId } = await bufferContext(b.organizationId);
    const channels = await selectedChannels(client, organizationId, b.channelIds);
    const serviceOf = new Map(channels.map((c) => [c.id, c.service]));

    let next: Snapshot;
    if (b.scenario === "simulated") {
      next = simulateUpdate(previous, specs.filter((s) => s.image.tone === "rain").map((s) => s.post_at.date));
    } else {
      const days = await weekForecast(b.location.lat, b.location.lon, { days: 16, timezone: b.location.timezone });
      if (days.length === 0) return Response.json({ error: "forecast_unavailable", message: "The weather service did not answer. Nothing was changed." }, { status: 502 });
      next = { days, events: previous.events }; // listings are not re-read here: only the forecast is compared
    }

    const queue = (await client.posts(organizationId, { status: ["draft", "scheduled"], ...(b.channelIds?.length ? { channelIds: b.channelIds } : {}) }, { first: 100 })).posts;
    const proposals = proposeMoves({
      specs, previous, next, queue,
      textOf: (s, channelId) => textFor(s, serviceOf.get(channelId) ?? "bluesky"),
      now: new Date(),
    });
    const base = {
      scenario: b.scenario, proposals, diff: diffForecasts(previous.days, next.days), nextDays: next.days,
      eventsRechecked: false, queued: queue.length,
    };

    if (!b.approve?.length) return Response.json({ ...base, rate: client.rate });

    const approved = proposals.filter((p) => p.action === "move" && b.approve!.some((a) => a.postId === p.postId && a.dueAt === p.to?.utc));
    const stale = b.approve.filter((a) => !approved.some((p) => p.postId === a.postId)).map((a) => a.postId);
    const outcomes = await applyMoves(client, approved);
    return Response.json({ ...base, outcomes, stale, rate: client.rate });
  } catch (err) {
    if (err instanceof NoOrganization) return Response.json({ error: "no_organization", message: err.message }, { status: 409 });
    return errorResponse(err);
  }
}
