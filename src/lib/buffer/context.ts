// What every authenticated route needs: the app client config, the owner's tokens, a client, and the organization.

import { bufferConfig } from "./config";
import { ReconnectRequired } from "./oauth";
import { CookieTokenStore, requestClient } from "./session";
import type { Channel } from "./client";

export class NoOrganization extends Error {}

export async function bufferContext(wanted?: string) {
  const cfg = bufferConfig();
  const tokens = await new CookieTokenStore(cfg).get();
  if (!tokens) throw new ReconnectRequired("Not connected to Buffer.");
  const { client } = requestClient(cfg, tokens.accountId);
  const orgs = await client.organizations();
  const organizationId = orgs.find((o) => o.id === wanted)?.id ?? orgs[0]?.id;
  if (!organizationId) throw new NoOrganization("This Buffer account has no organization.");
  return { cfg, client, organizationId };
}

export async function selectedChannels(client: Awaited<ReturnType<typeof bufferContext>>["client"], organizationId: string, ids?: string[]): Promise<Channel[]> {
  const all = await client.channels(organizationId);
  return ids ? all.filter((c) => ids.includes(c.id)) : all;
}
