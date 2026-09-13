import { afterEach, describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

const realFetch = globalThis.fetch;

function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(path: string, body: unknown, ip = "1.2.3.4") {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

const env: Env = { GEMINI_API_KEY: "test-key" };
const okFetch = () => {
  globalThis.fetch = (async () => geminiOk('{"corrected": "ပြင်ပြီး"}')) as typeof fetch;
};

describe("worker routing", () => {
  it("health endpoint reports models and configuration state", async () => {
    okFetch();
    const res = await worker.fetch(new Request("https://app.test/api/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; models: string[]; configured: boolean };
    expect(body.ok).toBe(true);
    expect(body.models).toContain("gemini-flash-lite-latest");
    expect(body.configured).toBe(true);
  });

  it("fixes text end-to-end with a mocked Gemini API", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      seen.push(String(url));
      return geminiOk('{"corrected": "ပြင်ပြီး"}');
    }) as typeof fetch;

    const res = await worker.fetch(
      post("/api/fix", { text: "မြနာမာ", model: "gemini-flash-lite-latest" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { corrected: string; model: string; ms: number };
    expect(body.corrected).toBe("ပြင်ပြီး");
    expect(body.model).toBe("gemini-flash-lite-latest");
    expect(typeof body.ms).toBe("number");
    // the API key must never leak into the request URL
    expect(seen[0]).not.toContain("test-key");
  });

  it("reports 503 not_configured when the secret is missing", async () => {
    okFetch();
    const res = await worker.fetch(post("/api/fix", { text: "x" }), { GEMINI_API_KEY: "" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_configured");
  });

  it("rejects empty text with 400", async () => {
    okFetch();
    const res = await worker.fetch(post("/api/fix", { text: "   " }), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("empty");
  });

  it("rejects oversized text with 413", async () => {
    okFetch();
    const res = await worker.fetch(post("/api/fix", { text: "a".repeat(4001) }), env);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("too_long");
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const req = new Request("https://app.test/api/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("maps Gemini 429 to 429 rate_limited", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "exhausted" } }), { status: 429 })) as typeof fetch;
    const res = await worker.fetch(post("/api/fix", { text: "x" }), env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("rate_limited");
  });

  it("maps an invalid Gemini key to 500 invalid_api_key", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: "API key not valid." } }),
        { status: 400 },
      )) as typeof fetch;
    const res = await worker.fetch(post("/api/fix", { text: "x" }), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_api_key");
  });

  it("rate-limits a hammering IP", async () => {
    let n = 0;
    globalThis.fetch = (async () => geminiOk(`{"corrected": "t${n++}"}`)) as typeof fetch;
    let last = 0;
    for (let i = 0; i < 35; i++) {
      const res = await worker.fetch(post("/api/fix", { text: "x" }, "9.9.9.9"), env);
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("returns 404 for unknown API paths", async () => {
    okFetch();
    const res = await worker.fetch(new Request("https://app.test/api/nope"), env);
    expect(res.status).toBe(404);
  });
});
