import { bufferContext, NoOrganization } from "@/lib/buffer/context";
import { errorResponse } from "@/lib/buffer/http";

// What Buffer already holds for this owner (drafts, scheduled, waiting for approval, errors), read with `posts`,
// plus each channel's daily posting limit when asked (?limits=1). Two API calls at most.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { client, organizationId } = await bufferContext(url.searchParams.get("organizationId") ?? undefined);
    const channels = await client.channels(organizationId);
    const channelIds = (url.searchParams.get("channelIds") ?? "").split(",").filter((id) => channels.some((c) => c.id === id));
    const page = await client.posts(organizationId, { status: ["draft", "scheduled", "needs_approval", "error"], ...(channelIds.length ? { channelIds } : {}) }, { first: 100 });
    const limitIds = (channelIds.length ? channelIds : channels.map((c) => c.id)).slice(0, 10);
    const limits = url.searchParams.get("limits") && limitIds.length ? await client.dailyPostingLimits(limitIds) : [];
    return Response.json({ posts: page.posts, hasNextPage: page.hasNextPage, limits, channels, rate: client.rate });
  } catch (err) {
    if (err instanceof NoOrganization) return Response.json({ error: "no_organization", message: err.message }, { status: 409 });
    return errorResponse(err);
  }
}
