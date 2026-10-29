// From written posts to Buffer: one createPost per post and channel, as a draft unless the owner turned
// "schedule for real" on. Reads what it needs once (tags, existing posts, daily limits), spends one call per write,
// and reports every post's outcome instead of stopping at the first problem.

import { signedImageUrl } from "./post-image";
import type { BufferClient, Channel, CreatePostInput, PostMetadataInput } from "./buffer/client";
import type { NetworkKey, PostSpec } from "./post-writer";

export const TAG_COLORS: Record<string, string> = {
  "Tablecast · rain": "#2F6FB5",
  "Tablecast · sun": "#DD9A2E",
  "Tablecast · event": "#6B3B5A",
  "Tablecast · dish": "#AD4823",
};

/** Metadata the schema marks required for a service (the rest need none), checked against the public reference. */
export function metadataFor(service: Channel["service"]): PostMetadataInput | undefined {
  switch (service) {
    case "instagram": return { instagram: { type: "post", shouldShareToFeed: true } };
    case "facebook": return { facebook: { type: "post" } };
    case "googlebusiness": return { google: { type: "whats_new" } };
    default: return undefined;
  }
}

const VARIANT_OF: Partial<Record<Channel["service"], NetworkKey>> = {
  instagram: "instagram", facebook: "facebook", linkedin: "linkedin", googlebusiness: "google",
  bluesky: "bluesky", threads: "threads", mastodon: "mastodon", twitter: "twitter",
};

export function textFor(spec: PostSpec, service: Channel["service"]): string {
  return spec.variants[VARIANT_OF[service] ?? "default"];
}

export function buildCreateInput(spec: PostSpec, channel: Channel, o: { imageUrl: string; tagId?: string; draft: boolean }): CreatePostInput {
  const metadata = metadataFor(channel.service);
  return {
    channelId: channel.id,
    text: textFor(spec, channel.service),
    assets: [{ image: { url: o.imageUrl } }],
    needsApproval: false,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: spec.post_at.utc,
    saveToDraft: o.draft,
    ...(o.tagId ? { tagIds: [o.tagId] } : {}),
    ...(metadata ? { metadata } : {}),
    aiAssisted: true,
    source: "tablecast",
  };
}

export type ScheduleOutcome = {
  specId: string;
  channelId: string;
  status: "created" | "exists" | "skipped" | "failed";
  postId?: string;
  reason?: string;
};

export type ScheduleResult = {
  outcomes: ScheduleOutcome[];
  /** Channels whose Buffer time zone differs from the restaurant's: dueAt is absolute so posts still go out on time. */
  timezoneNotes: string[];
  tagsCreated: string[];
  apiCalls: number;
};

export async function schedulePlan(o: {
  client: BufferClient;
  organizationId: string;
  channels: Channel[];
  specs: PostSpec[];
  origin: string;
  imageSecret: string;
  draft: boolean;
  /** Which channels each post goes to (post id -> channel ids). Absent: every post to every channel. */
  targets?: Record<string, string[]>;
}): Promise<ScheduleResult> {
  const { client, organizationId, specs } = o;
  const start = client.calls;
  const outcomes: ScheduleOutcome[] = [];
  const usable = o.channels.filter((c) => {
    const why = c.isDisconnected ? "the channel is disconnected in Buffer" : c.isLocked ? "the channel is locked by the Buffer plan" : null;
    if (why) for (const s of specs) outcomes.push({ specId: s.id, channelId: c.id, status: "skipped", reason: why });
    return !why;
  });
  if (usable.length === 0 || specs.length === 0) return { outcomes, timezoneNotes: [], tagsCreated: [], apiCalls: client.calls - start };

  // Tags, one per reason, reused every week.
  const wanted = [...new Set(specs.map((s) => s.tag))];
  const known = new Map((await client.tags(organizationId)).map((t) => [t.name, t.id]));
  const tagsCreated: string[] = [];
  for (const name of wanted) {
    if (known.has(name)) continue;
    const r = await client.createTag(organizationId, name, TAG_COLORS[name] ?? "#6F6759");
    if (r.ok) {
      known.set(name, r.value.id);
      tagsCreated.push(name);
    } // a refused tag (plan limit) only means those posts go out untagged
  }

  // What is already in Buffer, so running this twice does not post twice.
  const existing = (await client.posts(organizationId, { status: ["draft", "scheduled"], channelIds: usable.map((c) => c.id) }, { first: 100 })).posts;

  for (const ch of usable) {
    for (const spec of specs) {
      if (o.targets && !o.targets[spec.id]?.includes(ch.id)) continue;
      const text = textFor(spec, ch.service);
      const dup = existing.find((p) => p.channelId === ch.id && p.dueAt && Date.parse(p.dueAt) === Date.parse(spec.post_at.utc) && p.text === text);
      if (dup) {
        outcomes.push({ specId: spec.id, channelId: ch.id, status: "exists", postId: dup.id });
        continue;
      }
      if (!o.draft) {
        const [lim] = await client.dailyPostingLimits([ch.id], spec.post_at.utc);
        if (lim?.isAtLimit) {
          outcomes.push({ specId: spec.id, channelId: ch.id, status: "skipped", reason: `daily posting limit reached on this channel (${lim.scheduled} scheduled, ${lim.sent} sent, limit ${lim.limit})` });
          continue;
        }
      }
      const imageUrl = signedImageUrl(o.origin, spec.image, o.imageSecret);
      const res = await client.createPost(buildCreateInput(spec, ch, { imageUrl, tagId: known.get(spec.tag), draft: o.draft }));
      outcomes.push(res.ok
        ? { specId: spec.id, channelId: ch.id, status: "created", postId: res.value.id }
        : { specId: spec.id, channelId: ch.id, status: "failed", reason: res.error.message });
    }
  }

  const zone = specs[0].post_at.timezone;
  const timezoneNotes = usable.filter((c) => c.timezone !== zone).map((c) => `${c.displayName ?? c.name}: Buffer has ${c.timezone}, the restaurant is in ${zone}. Times are sent as exact UTC instants, so posts still go out at the restaurant's local time.`);
  return { outcomes, timezoneNotes, tagsCreated, apiCalls: client.calls - start };
}
