//! Client-side spell-fix engine: prompt construction, Google AI Studio
//! (Gemini) invocation, and defensive parsing of the model's reply.
//!
//! The API key is the USER'S OWN, stored only in their browser
//! (localStorage) — it is never sent to any server except Google's API
//! endpoint itself. Requests go browser → generativelanguage.googleapis.com
//! directly; the Cloudflare Worker only serves static files.
//!
//! Design notes:
//! - The model is asked to return JSON `{"corrected": "..."}` rather than
//!   bare text. Bare text is ambiguous to validate (a chatty model can
//!   prefix "Here is the corrected text:"), while JSON survives our
//!   `parseCorrected` fallbacks cleanly.
//! - Model default mirrors just-ocr's tuning: Flash-Lite is the default
//!   because Google's free tier allows ~500 requests/day for flash-lite vs
//!   ~20/day for flash models.

/** Google AI Studio endpoint (v1beta generateContent). */
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Models offered in the UI. Free-tier daily REQUEST limits on Google AI
 *  Studio (per key) favor flash-lite heavily; see
 *  https://ai.google.dev/gemini-api/docs/rate-limits */
export const MODELS = [
  {
    key: "gemini-flash-lite-latest",
    label: "Flash Lite (latest)",
    hint: "Fast · ~500/day free",
  },
  {
    key: "gemini-flash-latest",
    label: "Flash (latest)",
    hint: "Better proofreader · ~20/day free",
  },
  {
    key: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    hint: "Best · ~20/day free",
  },
] as const;

export type ModelKey = (typeof MODELS)[number]["key"];

export const DEFAULT_MODEL: ModelKey = "gemini-flash-lite-latest";

export function resolveModel(key: unknown): string {
  return (
    (typeof key === "string" && MODELS.some((m) => m.key === key)
      ? key
      : undefined) ?? DEFAULT_MODEL
  );
}

/** Per-request input cap. The client chunks long text into ≤ ~1200-char
 *  requests; this is the last-resort guard against a runaway loop spending
 *  the user's own quota in one call. */
export const MAX_TEXT_LEN = 4000;

const SYSTEM_PROMPT = `You are a meticulous Burmese (Myanmar language) proofreader.

Fix ONLY spelling and typographical errors in the user's Burmese text, including:
- wrong or missing vowel signs, medials, and the asat (်)
- wrong stacked consonants or wrongly split/merged syllables
- incorrect use of က်/က််-style endings and similar letter confusions
- punctuation errors in Burmese marks (၊ ၊) and stray Latin punctuation between Burmese words

Strict rules:
- Preserve the original meaning, wording, and tone. Do NOT paraphrase, rewrite, translate, summarize, or "improve" the style.
- Do NOT add or remove content. Fix errors only.
- Keep non-Burmese fragments (English, digits, URLs, markdown) exactly as written unless they contain obvious Burmese-context typos in Burmese script.
- Keep the original line breaks and paragraph structure exactly.
- If the text is already correct, return it unchanged.

Respond with ONLY a JSON object of the form {"corrected": "<the corrected text>"} — no markdown fences, no explanation.`;

/** What the model returned for one chunk, after parsing. */
export interface FixResult {
  corrected: string;
  model: string;
  /** Rough sense of what happened, surfaced in logs as needed. */
  parseMode: "json" | "raw";
  /** Round-trip time of this chunk's request, ms. */
  ms: number;
}

/** Minimal shape of the generateContent reply we consume. */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

/** Error with a machine-readable code the UI maps to a friendly message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fix one chunk (≤ MAX_TEXT_LEN chars) through Google AI Studio, straight
 * from the browser with the user's key.
 *
 * `temperature` is deliberately low (0.1): the task is transcription-grade
 * correction, not generation — faithfulness beats creativity, and a low
 * temperature keeps the model from "helpfully" rewording sentences.
 */
export async function fixText(
  apiKey: string,
  text: string,
  modelKey: string,
  signal?: AbortSignal,
): Promise<FixResult> {
  if (text.trim().length === 0) {
    throw new ApiError("No text to fix.", "empty");
  }
  if (text.length > MAX_TEXT_LEN) {
    throw new ApiError(`Text too long (max ${MAX_TEXT_LEN} characters per request).`, "too_long");
  }

  const model = resolveModel(modelKey);
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    // fetch itself failed — network or CORS territory
    throw new ApiError("Could not reach Google AI Studio.", "network");
  }

  let body: GeminiResponse;
  try {
    body = (await res.json()) as GeminiResponse;
  } catch {
    throw new ApiError("Unreadable response from Google AI Studio.", "ai_error", res.status);
  }

  if (!res.ok) {
    throw mapGoogleError(res.status, body);
  }

  const cand = body.candidates?.[0];
  const raw = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (raw === "") {
    // Empty candidate: safety block, or a finishReason that produced nothing
    const why =
      body.promptFeedback?.blockReason ??
      cand?.finishReason ??
      "no content returned";
    throw new ApiError(
      `The model returned no text (${why}). Try rephrasing the input.`,
      "ai_error",
    );
  }

  const { corrected, parseMode } = parseCorrected(raw);
  return { corrected, model, parseMode, ms: Math.round(performance.now() - t0) };
}

/** Map a non-2xx Gemini reply onto our error codes. */
function mapGoogleError(status: number, body: GeminiResponse): ApiError {
  const msg = body.error?.message ?? `HTTP ${status}`;
  if (status === 429) {
    return new ApiError("Google AI Studio quota/rate limit reached.", "rate_limited", status);
  }
  if (status === 400 || status === 401 || status === 403) {
    // 400 with "API key not valid" / 403 PERMISSION_DENIED — key problems
    if (/api key|permission/i.test(msg) || status !== 400) {
      return new ApiError("The API key is invalid or lacks permission.", "invalid_api_key", status);
    }
    return new ApiError(`Gemini rejected the request: ${msg}`, "bad_request", status);
  }
  if (status >= 500) {
    return new ApiError("Google AI Studio is busy — retry shortly.", "capacity", status);
  }
  return new ApiError(msg, "ai_error", status);
}

/** Extract the corrected text from the model's raw reply.
 *
 *  Layers of defense, in order:
 *  1. direct JSON.parse of the whole (fence-stripped) reply → `.corrected`
 *  2. fish the outermost {...} block and parse that
 *  3. fall back to the raw text (model ignored the JSON instruction)
 *
 *  On the fallback route the parseMode says "raw" so logs can reveal
 *  prompt-compliance drift; the diff view lets a human judge the actual
 *  output either way.
 */
export function parseCorrected(raw: string): { corrected: string; parseMode: "json" | "raw" } {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  // 1. whole reply is the JSON object
  const whole = tryCorrectedFromJson(unfenced);
  if (whole !== null) return { corrected: whole, parseMode: "json" };

  // 2. embedded JSON object (model added stray prose around it)
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const embedded = tryCorrectedFromJson(unfenced.slice(start, end + 1));
    if (embedded !== null) return { corrected: embedded, parseMode: "json" };
  }

  // 3. plain text — use as-is
  return { corrected: unfenced, parseMode: "raw" };
}

/** Parse `s` as JSON and pull out a string `.corrected`; null on any
 *  mismatch so callers can try the next defense layer. */
function tryCorrectedFromJson(s: string): string | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (
      v !== null &&
      typeof v === "object" &&
      typeof (v as { corrected?: unknown }).corrected === "string"
    ) {
      return (v as { corrected: string }).corrected;
    }
  } catch {
    /* next layer */
  }
  return null;
}

/** Friendly Burmese-first message per error code, with English fallback. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "rate_limited":
        return "Google ၏ အခမဲ့ quota ကုန်သွားပါပြီ — နောက်တစ်ရက် ပြန်စမ်းပါ သို့မဟုတ် အခြား model ရွေးပါ။ (Free-tier quota reached — try tomorrow or another model.)";
      case "capacity":
      case "network":
        return "Google AI Studio သို့ မချိတ်ဆက်နိုင်ပါ — ခဏနေပြီး ထပ်စမ်းပါ။ (Could not reach Google AI Studio — retry shortly.)";
      case "too_long":
        return "စာသား ရှည်လွန်းပါသည်။ (Text too long.)";
      case "empty":
        return "စာသား မရှိပါ။ (No text.)";
      case "invalid_api_key":
        return "API key မှားယွင်းနေပါသည် — Settings တွင် ပြင်ပါ။ (Invalid API key — fix it in Settings.)";
      default:
        return err.message;
    }
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "ရပ်တန့်လိုက်ပါသည်။ (Cancelled.)";
  }
  return "အမှားတစ်ခု ဖြစ်ပွားသည် — ထပ်စမ်းပါ။ (Something went wrong — try again.)";
}
