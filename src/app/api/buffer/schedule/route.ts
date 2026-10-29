import { bufferContext, NoOrganization, selectedChannels } from "@/lib/buffer/context";
import { errorResponse, publicOrigin, sameOrigin } from "@/lib/buffer/http";
import { asPosts, PostsSchema } from "@/lib/buffer/schemas";
import { replayPosts } from "@/lib/demo-plans";
import { checkPostTimes, LIMITS, type PostSpec } from "@/lib/post-writer";
import { imageSecret } from "@/lib/post-image";
import { networkOf } from "@/lib/week";
import { schedulePlan, textFor } from "@/lib/schedule";

// GET previews a recorded plan's written posts (no Buffer call).
// POST creates the posts in the owner's Buffer, as drafts unless { draft: false } is sent. It takes either
// { plan } (a recorded plan, written here) or { posts, targets } (the posts as the owner edited them, with the
// channels each one goes to). Edited posts are validated and re-checked by code before anything is sent.

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("plan") ?? "";
  const r = replayPosts(slug);
  if (!r) return Response.json({ error: "unknown_plan" }, { status: 404 });
  return Response.json({ ...r, problems: checkPostTimes(r.posts, new Date()) });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = (await request.json().catch(() => ({}))) as { plan?: string; posts?: unknown; targets?: Record<string, string[]>; organizationId?: string; channelIds?: string[]; draft?: boolean };
    if (!Array.isArray(body.channelIds) || body.channelIds.length === 0 || body.channelIds.length > 5 || !body.channelIds.every((c) => typeof c === "string")) {
      return Response.json({ error: "bad_request", message: "Send 1 to 5 channelIds." }, { status: 400 });
    }

    let specs: PostSpec[];
    let skipped: { id: string; title: string; reason: string }[] = [];
    if (body.posts !== undefined) {
      const parsed = PostsSchema.safeParse(body.posts);
      if (!parsed.success) return Response.json({ error: "bad_request", message: "A post is malformed.", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
      specs = asPosts(parsed.data);
    } else if (typeof body.plan === "string") {
      const written = replayPosts(body.plan);
      if (!written) return Response.json({ error: "unknown_plan" }, { status: 404 });
      specs = written.posts;
      skipped = written.skipped;
    } else {
      return Response.json({ error: "bad_request", message: "Send plan or posts." }, { status: 400 });
    }
    const problems = checkPostTimes(specs, new Date());
    if (problems.length) return Response.json({ error: "bad_times", problems }, { status: 422 });

    const { client, organizationId } = await bufferContext(body.organizationId);
    const channels = await selectedChannels(client, organizationId, body.channelIds);
    if (channels.length === 0) return Response.json({ error: "no_channel", message: "None of those channels belongs to your Buffer organization." }, { status: 409 });

    // Targets: only channels that were selected; a post with no channel left is not sent.
    const chosen = new Set(channels.map((c) => c.id));
    const targets = body.targets
      ? Object.fromEntries(specs.map((s) => [s.id, (body.targets![s.id] ?? []).filter((id) => chosen.has(id))]))
      : undefined;
    const sending = targets ? specs.filter((s) => targets[s.id].length > 0) : specs;
    if (sending.length === 0) return Response.json({ error: "nothing_to_send", message: "Every post was removed or has no channel." }, { status: 422 });

    // The text each network gets must fit that network.
    const over: string[] = [];
    for (const s of sending) {
      for (const c of channels) {
        if (targets && !targets[s.id].includes(c.id)) continue;
        const n = [...textFor(s, c.service)].length;
        const limit = LIMITS[networkOf(c.service)];
        if (n > limit) over.push(`${s.title} on ${c.displayName ?? c.name}: ${n} of ${limit} characters`);
        if (n === 0) over.push(`${s.title} on ${c.displayName ?? c.name}: the text is empty`);
      }
    }
    if (over.length) return Response.json({ error: "text_limit", message: "Some posts do not fit their network.", problems: over }, { status: 422 });

    const result = await schedulePlan({
      client, organizationId, channels, specs: sending,
      origin: publicOrigin(request), imageSecret: imageSecret(), draft: body.draft !== false, ...(targets ? { targets } : {}),
    });
    return Response.json({ ...result, skippedByWriter: skipped, draft: body.draft !== false, rate: client.rate });
  } catch (err) {
    if (err instanceof NoOrganization) return Response.json({ error: "no_organization", message: err.message }, { status: 409 });
    return errorResponse(err);
  }
}
