import { clientIp, describeLiveFailure } from "@/lib/limits";
import { inferenceConfigured, modelLabel } from "@/lib/model-runtime";
import { chatCompletion, isOtariError, newRunId, withRun } from "@/lib/otari";

// A failover drill anyone can run from the Otari panel: one tiny request to the tablecast-drill routing policy, whose
// first candidate (Mistral Large 3 on Mistral) refuses reasoning_effort with a 400, so Otari has to move to the next
// one (Nemotron 3 Ultra on Fireworks). The answer says which model served it, after how many attempts, and whether a
// fallback did, straight from Otari's response headers. A few per visitor per hour, a cap per day.

export const maxDuration = 30;

const DRILL = process.env.OTARI_DRILL_MODEL || "tablecast-drill";
const recent = new Map<string, number[]>();
const PER_HOUR = Number(process.env.DRILLS_PER_IP_PER_HOUR || 6);
const PER_DAY = Number(process.env.DRILLS_PER_DAY || 200);
let today = { day: new Date().toISOString().slice(0, 10), count: 0 };

export async function POST(request: Request) {
  if (!inferenceConfigured()) return Response.json({ error: "Otari is not configured on this server." }, { status: 503 });
  const ip = clientIp(request);
  const now = Date.now();
  const mine = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (mine.length >= PER_HOUR) return Response.json({ error: "That's enough drills for this hour." }, { status: 429 });
  const day = new Date().toISOString().slice(0, 10);
  if (today.day !== day) today = { day, count: 0 };
  if (today.count >= PER_DAY) return Response.json({ error: "Today's drills for this demo are used up." }, { status: 429 });
  today.count += 1;
  recent.set(ip, [...mine, now]);
  const t0 = Date.now();
  try {
    const { served } = await withRun({ id: newRunId() }, () =>
      chatCompletion(
        "drill",
        { model: DRILL, messages: [{ role: "user", content: "Reply with the single word OK." }], reasoning_effort: "low", max_tokens: 300, temperature: 0 },
        { signal: request.signal, timeoutMs: 25_000 },
      ),
    );
    return Response.json(
      {
        asked: DRILL,
        provider: served.provider ?? null,
        model: served.model ?? null,
        label: modelLabel(served.model),
        attempts: served.attempts ?? null,
        fallback: served.fallback ?? null,
        request_id: served.request_id ?? null,
        cost_usd: served.cost_usd ?? null,
        ms: Date.now() - t0,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (isOtariError(err) && (err.code === "invalid_model" || err.status === 404))
      return Response.json({ error: `This workspace has no ${DRILL} routing policy.` }, { status: 404 });
    return Response.json({ error: describeLiveFailure(err) }, { status: 502 });
  }
}
