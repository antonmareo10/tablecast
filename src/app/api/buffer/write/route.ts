import { errorResponse, sameOrigin } from "@/lib/buffer/http";
import { asDays, asEvents, asPlaybook, asSources, LivePlanSchema } from "@/lib/buffer/schemas";
import { replayPosts } from "@/lib/demo-plans";
import { imageSecret, signedImagePath } from "@/lib/post-image";
import { checkPostTimes, writePosts, type PostSpec } from "@/lib/post-writer";

// The writer as a route: a recorded plan ({ plan: slug }) or the plan of a live run ({ live }) in, posts out.
// No model call and no Buffer call; it needs no connection, so the board works before anyone signs in.

const MAX_BODY = 600_000;

function imagePaths(posts: PostSpec[]): Record<string, string> {
  try {
    const secret = imageSecret();
    return Object.fromEntries(posts.map((p) => [p.id, signedImagePath(p.image, secret)]));
  } catch {
    return {}; // no signing secret configured: the screens simply show no thumbnails
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
    let body: { plan?: unknown; live?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return Response.json({ error: "bad_request", message: "Send JSON." }, { status: 400 });
    }
    const now = new Date();

    if (typeof body.plan === "string") {
      const r = replayPosts(body.plan, now);
      if (!r) return Response.json({ error: "unknown_plan" }, { status: 404 });
      return Response.json({
        source: { kind: "replay", slug: body.plan, restaurant: r.restaurant, recordedAt: r.recordedAt, timezone: r.timezone },
        posts: r.posts, skipped: r.skipped, shiftDays: r.shiftDays, today: r.today,
        problems: checkPostTimes(r.posts, now), snapshot: r.snapshot, location: r.location ? { ...r.location, timezone: r.timezone } : null,
        images: imagePaths(r.posts),
      });
    }

    const live = LivePlanSchema.safeParse(body.live);
    if (!live.success) {
      return Response.json({ error: "bad_plan", message: "That plan is missing something the writer needs.", issues: live.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    }
    const v = live.data;
    const r = writePosts({ playbook: asPlaybook(v.playbook), days: asDays(v.days), events: asEvents(v.events), sources: asSources(v.sources), timezone: v.timezone, now });
    return Response.json({
      source: { kind: "live", restaurant: v.playbook.restaurant.name, timezone: v.timezone },
      posts: r.posts, skipped: r.skipped, shiftDays: 0, today: r.today,
      problems: checkPostTimes(r.posts, now), snapshot: { days: v.days, events: v.events }, location: { ...v.location, timezone: v.timezone },
      images: imagePaths(r.posts),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
