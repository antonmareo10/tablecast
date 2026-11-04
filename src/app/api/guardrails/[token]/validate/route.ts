import { validateResponse } from "@/lib/guardrail-service";

// Tablecast's guardrails service, POST <url>/validate in Otari's guardrails contract. Otari calls it for every request
// whose guardrail entry names this URL, and enforces the verdict (block mode: 403 guardrail_violation).
export const maxDuration = 30;

export async function POST(request: Request, ctx: RouteContext<"/api/guardrails/[token]/validate">) {
  const { token } = await ctx.params;
  return validateResponse(request, token);
}
