import { runTablecast } from "@/lib/agent";
import { acquireLiveRun, clientIp, describeLiveFailure, isAccountError, liveRunsDisabled } from "@/lib/limits";
import { checkInference, defaultRouting, economyRouting, nebiusConfigured, type Routing } from "@/lib/nebius-agent";
import { encodeLine } from "@/lib/ndjson";
import type { AgentEvent, AgentRequest } from "@/lib/types";

export const maxDuration = 300;

const MAX_PHOTO_BYTES = 3_000_000; // ~2.2 MB image once base64-encoded

function clean(s: unknown, max = 80): string {
  return typeof s === "string"
    ? s
        .replace(/[\u0000-\u001f]/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

function cleanUrl(s: unknown): string | undefined {
  const v = clean(s, 300);
  if (!v) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanPhoto(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length > MAX_PHOTO_BYTES) return undefined;
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : undefined;
}

// Local evaluation only: lets scripts/eval.mjs pin the model routing per request.
function routingOverride(request: Request): Routing | undefined {
  if (process.env.TASTECRAFT_ALLOW_ROUTING_OVERRIDE !== "1") return undefined;
  const raw = request.headers.get("x-tablecast-routing");
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as Partial<Routing>;
    return { ...defaultRouting(), ...r };
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  let body: Partial<AgentRequest>;
  try {
    body = (await request.json()) as Partial<AgentRequest>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const req: AgentRequest = {
    restaurant: clean(body.restaurant),
    city: clean(body.city, 60),
    website: cleanUrl(body.website),
    goal: clean(body.goal, 120) || undefined,
    language: body.language === "Español" ? "Español" : "English",
    menu_photo: cleanPhoto(body.menu_photo),
    // "thorough" was the old name of the economy mode; old links keep working.
    mode: ["economy", "thorough"].includes(String(body.mode)) ? "economy" : "quick",
  };
  if (!req.restaurant || !req.city) {
    return Response.json({ error: "restaurant and city are required" }, { status: 400 });
  }
  if (body.menu_photo && !req.menu_photo) {
    return Response.json({ error: "The menu photo must be a JPEG, PNG or WebP under 2 MB." }, { status: 400 });
  }
  if (!nebiusConfigured() || !process.env.TAVILY_API_KEY) {
    return Response.json({ error: "Live mode is not configured on this server. Open one of the recorded real runs instead." }, { status: 503 });
  }
  const disabled = liveRunsDisabled();
  if (disabled) return Response.json({ error: disabled }, { status: 503 });
  const gate = acquireLiveRun(clientIp(request));
  if (!gate.ok) return Response.json({ error: gate.reason }, { status: 429 });

  const started = Date.now();
  const routing = routingOverride(request) ?? (req.mode === "economy" ? economyRouting() : undefined);
  // A rejected key or an empty account fails here in about a second, before any research is paid for.
  // Anything else (a slow model, a 5xx) is left to the run, which has its own fallbacks.
  try {
    await checkInference((routing ?? defaultRouting()).fast, request.signal);
  } catch (err) {
    if (isAccountError(err)) {
      gate.release();
      return Response.json({ error: describeLiveFailure(err) }, { status: 503 });
    }
  }
  // Publish before the platform's limit (maxDuration), leaving room to stream the end of the run.
  const deadline = Date.now() + (maxDuration - 15) * 1000;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeLine(e));
        } catch {
          closed = true;
        }
      };
      try {
        await runTablecast(req, emit, { routing, deadline, signal: request.signal });
      } catch (err) {
        emit({ type: "error", message: describeLiveFailure(err) });
      }
      emit({ type: "done", elapsed_ms: Date.now() - started });
      closed = true;
      gate.release();
      controller.close();
    },
    cancel() {
      gate.release();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
