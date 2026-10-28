import { bufferConfig } from "@/lib/buffer/config";
import { errorResponse, publicOrigin, sameOrigin } from "@/lib/buffer/http";
import { ReconnectRequired } from "@/lib/buffer/oauth";
import { CookieTokenStore, requestClient } from "@/lib/buffer/session";
import { replayPosts } from "@/lib/demo-plans";
import { checkPostTimes } from "@/lib/post-writer";
import { imageSecret } from "@/lib/post-image";
import { schedulePlan } from "@/lib/schedule";

// Replay a recorded plan: the posts are written with no model call, then created in the owner's Buffer.
// GET previews the written posts (no Buffer call). POST creates them: drafts unless { draft: false } is sent.

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("plan") ?? "";
  const r = replayPosts(slug);
  if (!r) return Response.json({ error: "unknown_plan" }, { status: 404 });
  return Response.json({ ...r, problems: checkPostTimes(r.posts, new Date()) });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = (await request.json().catch(() => ({}))) as { plan?: string; organizationId?: string; channelIds?: string[]; draft?: boolean };
    if (typeof body.plan !== "string" || !Array.isArray(body.channelIds) || body.channelIds.length === 0 || body.channelIds.length > 5 || !body.channelIds.every((c) => typeof c === "string")) {
      return Response.json({ error: "bad_request", message: "Send plan and 1 to 5 channelIds." }, { status: 400 });
    }
    const written = replayPosts(body.plan);
    if (!written) return Response.json({ error: "unknown_plan" }, { status: 404 });
    const problems = checkPostTimes(written.posts, new Date());
    if (problems.length) return Response.json({ error: "bad_times", problems }, { status: 422 });

    const cfg = bufferConfig();
    const tokens = await new CookieTokenStore(cfg).get();
    if (!tokens) throw new ReconnectRequired("Not connected to Buffer.");
    const { client } = requestClient(cfg, tokens.accountId);
    const orgs = await client.organizations();
    const organizationId = orgs.find((o) => o.id === body.organizationId)?.id ?? orgs[0]?.id;
    if (!organizationId) return Response.json({ error: "no_organization" }, { status: 409 });
    const channels = (await client.channels(organizationId)).filter((c) => body.channelIds!.includes(c.id));
    if (channels.length === 0) return Response.json({ error: "no_channel", message: "None of those channels belongs to your Buffer organization." }, { status: 409 });

    const result = await schedulePlan({
      client, organizationId, channels, specs: written.posts,
      origin: publicOrigin(request), imageSecret: imageSecret(), draft: body.draft !== false,
    });
    return Response.json({ ...result, skippedByWriter: written.skipped, rate: client.rate });
  } catch (err) {
    return errorResponse(err);
  }
}
