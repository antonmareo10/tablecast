import { profilesResponse } from "@/lib/guardrail-service";

// GET <url>/profiles in Otari's guardrails contract: the profile this service offers.
export async function GET(_request: Request, ctx: RouteContext<"/api/guardrails/[token]/profiles">) {
  const { token } = await ctx.params;
  return profilesResponse(token);
}
