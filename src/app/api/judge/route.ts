import { clientIp } from "@/lib/limits";
import { judgeAccess, judgeBudget, judgeEndUser, judgeRunEstimateUsd } from "@/lib/judge";
import { inferenceConfigured } from "@/lib/model-runtime";
import { endUsersEnabled, endUserStatus } from "@/lib/otari-budget";

// Where the judges' link stands, for the note the page shows them: their own Otari end user, its budget and what is left.
// Free on Otari (two reads). Answers only with the judges' token; anyone else gets a 404 and no Otari call.

export const maxDuration = 15;

const recent = new Map<string, number[]>();
const PER_HOUR = 60;
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const access = judgeAccess(request);
  if (access.kind === "none") return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  if (access.kind === "refused") return Response.json({ error: access.error }, { status: access.status, headers: noStore });
  const ip = clientIp(request);
  const now = Date.now();
  const mine = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (mine.length >= PER_HOUR) return Response.json({ error: "Too many checks this hour." }, { status: 429, headers: noStore });
  recent.set(ip, [...mine, now]);
  if (!inferenceConfigured()) return Response.json({ error: "Live mode is not configured on this server." }, { status: 503, headers: noStore });
  const svc = await endUsersEnabled(request.signal).catch(() => ({ enabled: false, budgets: [] }));
  const status = svc.enabled ? await endUserStatus(judgeEndUser(), request.signal).catch(() => null) : null;
  const check = judgeBudget(status, svc.budgets, 0);
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status, headers: noStore });
  const expires = Date.parse(process.env.JUDGE_LINK_EXPIRES?.trim() ?? "");
  return Response.json(
    {
      end_user: judgeEndUser(),
      ...check.line,
      run_estimate_usd: judgeRunEstimateUsd(),
      runs_per_hour: Number(process.env.JUDGE_RUNS_PER_HOUR || 3),
      ...(Number.isFinite(expires) ? { expires: new Date(expires).toISOString() } : {}),
    },
    { headers: noStore },
  );
}
