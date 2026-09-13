import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiError,
  MODEL_IDS,
  DEFAULT_MODEL,
  fixSpelling,
  parseCorrected,
  resolveModel,
} from "./spellfix";

/** Gemini replies carry the text in candidates[0].content.parts[].text. */
function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
  vi.restoreAllMocks();
});

describe("parseCorrected", () => {
  const original = "မြနာမာ နိုင်ငံ";

  it("parses a plain JSON object reply", () => {
    const r = parseCorrected('{"corrected": "မြန်မာ နိုင်ငံ"}');
    expect(r).toEqual({
      corrected: "မြန်မာ နိုင်ငံ",
      parseMode: "json",
    });
  });

  it("strips markdown fences around JSON", () => {
    const raw = '```json\n{"corrected": "အစား"}\n```';
    expect(parseCorrected(raw).corrected).toBe("အစား");
  });

  it("fishes JSON out of stray prose around it", () => {
    const raw = 'Here you go: {"corrected": "အစား"} hope that helps';
    const r = parseCorrected(raw);
    expect(r.corrected).toBe("အစား");
    expect(r.parseMode).toBe("json");
  });

  it("falls back to raw text when the reply is not JSON", () => {
    const r = parseCorrected("  အမှန်တွင် ဤအသုံးအနှုန်းများ...\n");
    expect(r).toEqual({
      corrected: "အမှန်တွင် ဤအသုံးအနှုန်းများ...",
      parseMode: "raw",
    });
  });

  it("ignores JSON objects without a string corrected field", () => {
    const r = parseCorrected('{"text": "x"}');
    expect(r.parseMode).toBe("raw");
  });
});

describe("fixSpelling", () => {
  it("calls the Gemini endpoint with system instruction, user text, and the API-key header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return geminiOk('{"corrected": "ပြင်ပြီး"}');
    }) as typeof fetch;

    const r = await fixSpelling("test-key", "မူလ", DEFAULT_MODEL);
    expect(r.corrected).toBe("ပြင်ပြီး");
    expect(r.model).toBe("gemini-flash-lite-latest");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    );
    // key travels in the header, never the URL
    expect(calls[0].url).not.toContain("test-key");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-key");

    const body = JSON.parse(String(calls[0].init.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }> };
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
    const r = await fixSpelling("k", "x", DEFAULT_MODEL);
    expect(r.corrected).toBe("အစား");
    expect(r.parseMode).toBe("json");
  });

  it("maps unknown model keys to the default", () => {
    expect(resolveModel("nope")).toBe(MODEL_IDS[DEFAULT_MODEL]);
    expect(resolveModel(undefined)).toBe(MODEL_IDS[DEFAULT_MODEL]);
    expect(resolveModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  it("maps 429 to rate_limited", async () => {
    globalThis.fetch = (async () =>
      geminiErr(429, "Resource has been exhausted")) as typeof fetch;
    await expect(fixSpelling("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps an invalid API key to invalid_api_key", async () => {
    globalThis.fetch = (async () =>
      geminiErr(400, "API key not valid. Please pass a valid API key.")) as typeof fetch;
    await expect(fixSpelling("bad", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });

  it("maps 5xx to capacity", async () => {
    globalThis.fetch = (async () =>
      geminiErr(503, "The model is overloaded")) as typeof fetch;
    await expect(fixSpelling("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "capacity",
    });
  });

  it("throws AiError when the model returns no text (safety block)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
        { status: 200 },
      )) as typeof fetch;
    await expect(fixSpelling("k", "x", DEFAULT_MODEL)).rejects.toThrow(AiError);
  });

  it("throws network error when fetch fails outright", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fixSpelling("k", "x", DEFAULT_MODEL)).rejects.toMatchObject({
      code: "network",
    });
  });
});
