// Fake Otari answers for unit tests: JSON responses with Otari's serving headers, and SSE streams.

export type Recorded = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };

export function otariJSONResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "otari-request-id": "req-test", ...init.headers },
  });
}

/** A text/event-stream body that sends `events` (objects become `data: <json>`), then optionally fails. */
export function otariSSEResponse(events: (unknown | "[DONE]")[], opts: { failWith?: Error; headers?: Record<string, string> } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${e === "[DONE]" ? "[DONE]" : JSON.stringify(e)}\n\n`));
      if (opts.failWith) controller.error(opts.failWith);
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "otari-request-id": "req-stream", ...opts.headers } });
}

/** Normalizes fetch's arguments into what the tests assert on. */
export function recordCall(input: unknown, init?: RequestInit): Recorded {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  let body: Record<string, unknown> | undefined;
  if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
  return { url: String(input), method: init?.method ?? "GET", headers, body };
}

/** A promise that only settles when the request is aborted (a provider that hangs). */
export function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
  });
}
