import { beforeEach, describe, expect, it, vi } from "vitest";

// Before a live run, one tiny Nebius call checks that inference works. A rejected key or an empty
// account stops the run at once with a plain "paused" message, and nothing else is called.
const { create, behaviour } = vi.hoisted(() => {
  process.env.NEBIUS_API_KEY = "test-key";
  process.env.TAVILY_API_KEY = "test-key";
  return { create: [] as string[], behaviour: { fail: null as null | (() => Error) } };
});

vi.mock("openai", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (opts: Record<string, unknown>) => object };
  class FakeOpenAI extends actual.default {
    chat = {
      completions: {
        create: (body: { model: string }) => {
          create.push(body.model);
          return behaviour.fail ? Promise.reject(behaviour.fail()) : Promise.resolve({ choices: [{ message: { content: "OK" } }] });
        },
      },
    };
  }
  return { ...actual, default: FakeOpenAI };
});

import OpenAI from "openai";

const post = async () => {
  vi.resetModules();
  const { POST } = await import("@/app/api/agent/route");
  const limits = await import("@/lib/limits");
  const res = await POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify({ restaurant: "Gjelina", city: "Los Angeles" }),
    }),
  );
  return { res, limits };
};

beforeEach(() => {
  create.length = 0;
  behaviour.fail = null;
});

describe("live-run preflight", () => {
  it("stops before any research when Nebius is out of credit, and pauses live runs", async () => {
    behaviour.fail = () => OpenAI.APIError.generate(402, { message: "Insufficient balance" }, "402 Insufficient balance", new Headers());
    const { res, limits } = await post();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Live runs are paused: this demo's inference budget is used up/);
    expect(create).toHaveLength(1); // only the one-token check, no research or writing
    expect(limits.liveRunsDisabled()).toMatch(/paused/);
  });

  it("stops the same way when the key is rejected", async () => {
    behaviour.fail = () => OpenAI.APIError.generate(401, { message: "Incorrect API key provided" }, "401 Incorrect API key provided", new Headers());
    const { res } = await post();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/rejected this demo's API key/);
  });

  it("treats a slow model or a server error as temporary (the run's own fallbacks handle it)", async () => {
    const { isAccountError } = await import("@/lib/limits");
    expect(isAccountError(OpenAI.APIError.generate(503, { message: "Service unavailable" }, "503", new Headers()))).toBe(false);
    expect(isAccountError(OpenAI.APIError.generate(429, { message: "Too many requests" }, "429", new Headers()))).toBe(false);
    expect(isAccountError(new OpenAI.APIConnectionTimeoutError())).toBe(false);
    expect(isAccountError(OpenAI.APIError.generate(429, { message: "You exceeded your current quota" }, "429 quota", new Headers()))).toBe(true);
  });
});
