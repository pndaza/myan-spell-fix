//! Core spell-fix logic: prompt construction, Google AI Studio (Gemini)
//! invocation, and defensive parsing of the model's reply.
//!
//! Design notes:
//! - The Gemini API key lives server-side as the `GEMINI_API_KEY` Worker
//!   secret — visitors never see or provide a key, and the key never
//!   reaches the browser. Sent via the `x-goog-api-key` header (not a query
//!   param) so it stays out of any URL logging.
//! - The model is asked to return JSON `{"corrected": "..."}` rather than
//!   bare text. Bare text is ambiguous to validate (a chatty model can
//!   prefix "Here is the corrected text:"), while JSON survives our
//!   `parseCorrected` fallbacks cleanly.
//! - Model default mirrors just-ocr's tuning: Flash-Lite is the default
//!   because Google's free tier allows ~500 requests/day for flash-lite vs
//!   ~20/day for flash models — and the site shares one key across all
//!   visitors. Flash remains one click away for users who want the better
//!   proofreader.

/** Models offered in the UI. Free-tier daily REQUEST limits on Google AI
 *  Studio (per project+model) favor flash-lite heavily; see
 *  https://ai.google.dev/gemini-api/docs/rate-limits */
export const MODEL_IDS = {
  "gemini-flash-lite-latest": "gemini-flash-lite-latest",
  "gemini-flash-latest": "gemini-flash-latest",
  "gemini-3.8-flash": "gemini-3.8-flash",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

export const DEFAULT_MODEL: ModelKey = "gemini-flash-lite-latest";

export function resolveModel(key: unknown): string {
  return (
    (typeof key === "string" && key in MODEL_IDS
      ? MODEL_IDS[key as ModelKey]
      : undefined) ?? MODEL_IDS[DEFAULT_MODEL]
  );
}

/** Server-side per-request input cap. The client chunks long text into
 *  ≤ ~1200-char requests; this cap exists so a hand-crafted request cannot
 *  burn the API quota on one call. */
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

/** Google AI Studio endpoint (v1beta generateContent). */
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** What the model returned for one chunk, after parsing. */
export interface SpellFixResult {
  corrected: string;
  model: string;
  /** Rough sense of what happened, surfaced in logs/UI as needed. */
  parseMode: "json" | "raw";
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

/**
 * Run one spell-fix request through Google AI Studio.
 *
 * `temperature` is deliberately low (0.1): the task is transcription-grade
 * correction, not generation — faithfulness beats creativity, and a low
 * temperature keeps the model from "helpfully" rewording sentences.
 */
export async function fixSpelling(
  apiKey: string,
  text: string,
  modelKey: string,
): Promise<SpellFixResult> {
  const model = resolveModel(modelKey);
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
    });
  } catch {
    // fetch itself failed — network/timeout territory
    throw new AiError("Could not reach Google AI Studio.", "network");
  }

  let body: GeminiResponse;
  try {
    body = (await res.json()) as GeminiResponse;
  } catch {
    throw new AiError("Unreadable response from Google AI Studio.", "ai_error");
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
    throw new AiError(
      `The model returned no text (${why}). Try rephrasing the input.`,
      "ai_error",
    );
  }

  const { corrected, parseMode } = parseCorrected(raw);
  return { corrected, model, parseMode };
}

/** Map a non-2xx Gemini reply onto our error codes. */
function mapGoogleError(status: number, body: GeminiResponse): AiError {
  const msg = body.error?.message ?? `HTTP ${status}`;
  if (status === 429) {
    return new AiError("Google AI Studio quota/rate limit reached.", "rate_limited");
  }
  if (status === 400 || status === 401 || status === 403) {
    // 400 with "API key not valid" / 403 PERMISSION_DENIED — key problems
    if (/api key|permission/i.test(msg) || status !== 400) {
      return new AiError("GEMINI_API_KEY is invalid or lacks permission.", "invalid_api_key");
    }
    return new AiError(`Gemini rejected the request: ${msg}`, "bad_request");
  }
  if (status >= 500) {
    return new AiError("Google AI Studio is busy — retry shortly.", "capacity");
  }
  return new AiError(msg, "ai_error");
}

/** Error carrying a machine-readable code the API layer maps to HTTP. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: AiErrorCode,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type AiErrorCode =
  | "too_long"
  | "empty"
  | "invalid_json"
  | "not_configured"
  | "invalid_api_key"
  | "rate_limited"
  | "capacity"
  | "network"
  | "bad_request"
  | "ai_error";

/** Extract the corrected text from the model's raw reply.
 *
 *  Layers of defense, in order:
 *  1. direct JSON.parse of the whole (fence-stripped) reply → `.corrected`
 *  2. regex-fish the first balanced-looking {...} block and parse that
 *  3. fall back to the raw text (model ignored the JSON instruction)
 *
 *  On the fallback route the parseMode says "raw" so logs can reveal
 *  prompt-compliance drift; the client diff view lets a human judge the
 *  actual output either way.
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
