import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  DEFAULT_MODEL,
  MODELS,
  REQUEST_TIMEOUT_MS,
  errorMessage,
  fixText,
  parseCorrected,
  resolveModel,
  suggestFixes,
} from "./spellfix";

/** Gemini replies carry the text in candidates[0].content.parts[].text. */
function geminiOk(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
      ],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function geminiReply(candidate: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ candidates: [candidate] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function geminiErr(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message, status: "FAILED" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("parseCorrected", () => {
  it("parses a plain JSON object reply", () => {
    expect(parseCorrected('{"corrected": "မြန်မာ နိုင်ငံ"}')).toEqual({
      corrected: "မြန်မာ နိုင်ငံ",
      parseMode: "json",
    });
  });

  it("strips markdown fences around JSON", () => {
    expect(parseCorrected('```json\n{"corrected": "အစား"}\n```').corrected).toBe("အစား");
  });

  it("fishes JSON out of stray prose around it", () => {
    const r = parseCorrected('Here you go: {"corrected": "အစား"} hope that helps');
    expect(r).toEqual({ corrected: "အစား", parseMode: "json" });
  });

  it("falls back to raw text when the reply is not JSON", () => {
    expect(parseCorrected("  ဤအသုံးအနှုန်းများ...\n")).toEqual({
      corrected: "ဤအသုံးအနှုန်းများ...",
      parseMode: "raw",
    });
  });

  it("rejects JSON-shaped replies with no readable corrected field", () => {
    // returning the literal JSON source as the "correction" would dump it
    // into the user's text — a clear error is better
    expect(() => parseCorrected('{"text": "x"}')).toThrow(ApiError);
  });

  it("rejects an empty corrected value instead of deleting the chunk", () => {
    expect(() => parseCorrected('{"corrected": ""}')).toThrow(ApiError);
  });
});

describe("fixText", () => {
  it("calls the Gemini endpoint with system instruction, user text, and the key header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return geminiOk('{"corrected": "ပြင်ပြီး"}');
    }) as typeof fetch;

    const r = await fixText("user-key", "မူလ", DEFAULT_MODEL);
    expect(r.corrected).toBe("ပြင်ပြီး");
    expect(r.model).toBe("gemini-flash-lite-latest");
    expect(r.ms).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    );
    expect(calls[0].url).not.toContain("user-key");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("user-key");

    const body = JSON.parse(String(calls[0].init.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(body.systemInstruction.parts[0].text).toMatch(/proofreader/i);
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "မူလ" }] });
  });

  it("joins multi-part candidate text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"cor' }, { text: 'rected": "အစား"}' }] } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await fixText("k", "x", DEFAULT_MODEL);
    expect(r.corrected).toBe("အစား");
    expect(r.parseMode).toBe("json");
  });

  it("resolves unknown model keys to the default", () => {
    expect(resolveModel("nope")).toBe(DEFAULT_MODEL);
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  it("rejects empty and oversized text before any network call", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return geminiOk("{}");
    }) as typeof fetch;
    await expect(fixText("k", "  ", DEFAULT_MODEL)).rejects.toMatchObject({ code: "empty" });
    await expect(fixText("k", "a".repeat(4001), DEFAULT_MODEL)).rejects.toMatchObject({
      code: "too_long",
    });
    expect(called).toBe(0);
  });

  it("maps 429 to rate_limited", async () => {
    globalThis.fetch = (async () => geminiErr(429, "Resource has been exhausted")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps an invalid API key to invalid_api_key", async () => {
    globalThis.fetch = (async () =>
      geminiErr(400, "API key not valid. Please pass a valid API key.")) as typeof fetch;
    await expect(fixText("bad", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });

  it("maps 401 to invalid_api_key", async () => {
    globalThis.fetch = (async () => geminiErr(401, "Request had invalid authentication credentials")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });

  it("maps a 403 about key/permission wording to invalid_api_key", async () => {
    globalThis.fetch = (async () =>
      geminiErr(403, "Permission denied for API key")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });

  it("maps a 403 about region/access to forbidden, not a key problem", async () => {
    globalThis.fetch = (async () =>
      geminiErr(403, "User location is not supported for the API use")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("maps a plain 400 to bad_request", async () => {
    globalThis.fetch = (async () => geminiErr(400, "Invalid JSON payload received.")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("maps a non-JSON body to ai_error", async () => {
    globalThis.fetch = (async () => new Response("<html>gateway error</html>", { status: 200 })) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "ai_error",
    });
  });

  it("rejects a truncated reply (finishReason MAX_TOKENS), never half a correction", async () => {
    globalThis.fetch = (async () =>
      geminiReply({
        content: { parts: [{ text: '{"corrected": "အစား' }] },
        finishReason: "MAX_TOKENS",
      })) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toThrow(/cut off/);
  });

  it("times out a stalled request instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        })) as typeof fetch;
      const p = fixText("k", "x", DEFAULT_MODEL);
      const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows the raw AbortError when the caller cancels", async () => {
    const ac = new AbortController();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      })) as typeof fetch;
    const p = fixText("k", "x", DEFAULT_MODEL, ac.signal);
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    ac.abort();
    await assertion;
  });

  it("suggestFixes sends the suggest prompt and parses fixes", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return geminiOk('{"fixes": [{"wrong": "ဖစ်", "correct": "ဖြစ်"}]}');
    }) as typeof fetch;
    const r = await suggestFixes("k", "ဖစ်သည်", DEFAULT_MODEL);
    expect(r.fixes).toEqual([{ wrong: "ဖစ်", correct: "ဖြစ်" }]);
    const body = JSON.parse(bodies[0]) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.systemInstruction.parts[0].text).toMatch(/exact substring/);
    expect(body.systemInstruction.parts[0].text).toMatch(/Do not report overlapping fragments/);
    expect(body.contents[0].parts[0].text).toBe("ဖစ်သည်");
  });

  it("maps 5xx to capacity", async () => {
    globalThis.fetch = (async () => geminiErr(503, "The model is overloaded")) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({ code: "capacity" });
  });

  it("throws AiError when the model returns no text (safety block)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
        status: 200,
      })) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toThrow(ApiError);
  });

  it("throws network error when fetch fails outright", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fixText("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({ code: "network" });
  });

  it("offers only Google-AI-Studio models with flash-lite default", () => {
    expect(MODELS[0].key).toBe("gemini-flash-lite-latest");
    expect(MODELS.every((m) => m.key.startsWith("gemini-"))).toBe(true);
  });
});

describe("errorMessage", () => {
  it("has a friendly bilingual message for every user-facing code", () => {
    const codes = [
      "rate_limited",
      "capacity",
      "network",
      "timeout",
      "too_long",
      "empty",
      "invalid_api_key",
      "forbidden",
    ];
    for (const code of codes) {
      const msg = errorMessage(new ApiError("x", code));
      expect(msg).toMatch(/\(/); // carries the English fallback in (…)
      expect(msg.length).toBeGreaterThan(10);
    }
  });

  it("passes through ApiError messages for unmapped codes", () => {
    expect(errorMessage(new ApiError("The model's reply was cut off (MAX_TOKENS).", "ai_error"))).toContain("cut off");
  });

  it("recognizes cancellation", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(errorMessage(abort)).toContain("Cancelled");
  });
});
