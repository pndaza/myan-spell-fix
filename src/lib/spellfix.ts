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

/** Prompt for MANUAL mode: the model reports errors as wrong→correct
 *  pairs instead of rewriting the text. The user then approves each fix
 *  individually — the guard against hallucinated rewrites. */
const SUGGEST_SYSTEM_PROMPT = `You are a meticulous Burmese (Myanmar language) proofreader.

Find spelling and typographical errors in the user's Burmese text, including:
- wrong or missing vowel signs, medials, and the asat (်)
- wrong stacked consonants or wrongly split/merged syllables
- incorrect use of က်/က််-style endings and similar letter confusions
- punctuation errors in Burmese marks (၊ ၊)

Strict rules:
- Report ACTUAL errors only. Do not suggest style, wording, or translation changes. Do not invent words that are not in the text.
- Each "wrong" value MUST be an exact substring copied character-for-character from the input, spanning the minimal complete word or syllable-cluster that contains the error.
- Each "correct" value must be the corrected spelling of that same fragment, changing as little as possible.

Respond with ONLY a JSON object of the form {"fixes": [{"wrong": "<exact fragment from the input>", "correct": "<corrected fragment>"}, ...]}. If the text has no errors, respond {"fixes": []}. No markdown fences, no explanation.`;

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
 * from the browser with the user's key — AUTO mode: the model returns the
 * corrected text.
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
  const { raw, ms } = await generate(apiKey, text, modelKey, SYSTEM_PROMPT, signal);
  const { corrected, parseMode } = parseCorrected(raw);
  return { corrected, model: resolveModel(modelKey), parseMode, ms };
}

/** One wrong→correct suggestion from MANUAL mode. */
export interface Suggestion {
  /** Exact fragment as it appears (misspelled) in the input. */
  wrong: string;
  /** Its corrected spelling. */
  correct: string;
}

/** MANUAL-mode result: the model's suggestions for one chunk. */
export interface SuggestResult {
  fixes: Suggestion[];
  ms: number;
}

/**
 * Ask the model to REPORT errors as wrong→correct pairs instead of
 * rewriting the text (MANUAL mode). Suggestions are applied only after the
 * user approves them — and `applyFixes` only substitutes exact-substring
 * matches, so a hallucinated fragment cannot silently change the text.
 */
export async function suggestFixes(
  apiKey: string,
  text: string,
  modelKey: string,
  signal?: AbortSignal,
): Promise<SuggestResult> {
  const { raw, ms } = await generate(apiKey, text, modelKey, SUGGEST_SYSTEM_PROMPT, signal);
  return { fixes: parseFixes(raw), ms };
}

/** Shared Gemini generateContent round-trip: validates input size, then
 *  returns the raw reply text. */
async function generate(
  apiKey: string,
  text: string,
  modelKey: string,
  system: string,
  signal?: AbortSignal,
): Promise<{ raw: string; ms: number }> {
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
        systemInstruction: { parts: [{ text: system }] },
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
  return { raw, ms: Math.round(performance.now() - t0) };
}

/** Parse a MANUAL-mode reply into validated suggestions.
 *
 *  Same defense layers as `parseCorrected` (whole JSON → fished {...}),
 *  plus per-entry validation: strings only, non-empty, wrong ≠ correct.
 *  Duplicates (wrong+correct) collapse; entries are capped at 200 so a
 *  runaway reply cannot flood the review list. A reply that yields no
 *  valid entries reads as "no errors found" — not an error. */
export function parseFixes(raw: string): Suggestion[] {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let list: unknown = null;
  const whole = tryParseJson(unfenced);
  if (whole !== null) {
    list = (whole as { fixes?: unknown }).fixes ?? whole;
  } else {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const fished = tryParseJson(unfenced.slice(start, end + 1));
      if (fished !== null) list = (fished as { fixes?: unknown }).fixes ?? null;
    }
  }
  // Some models return a bare array despite the instructions.
  const trimmedLeft = unfenced.trimStart();
  if (list === null && trimmedLeft.startsWith("[")) {
    list = tryParseJson(unfenced);
  }
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const item of list) {
    if (out.length >= 200) break;
    if (item === null || typeof item !== "object") continue;
    const { wrong, correct } = item as { wrong?: unknown; correct?: unknown };
    if (typeof wrong !== "string" || typeof correct !== "string") continue;
    if (wrong.length === 0 || wrong === correct) continue;
    const key = `${wrong}→${correct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ wrong, correct });
  }
  return out;
}

/** JSON.parse helper: null on failure (defense-layer fallthrough). */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** Outcome of applying approved suggestions. */
export interface ApplyOutcome {
  /** The text with all applicable fixes substituted. */
  text: string;
  /** How many fixes were actually substituted. */
  applied: number;
  /** Fixes whose `wrong` fragment no longer occurs in the text — skipped,
   *  never force-applied. (Sequential application can consume a fragment;
   *  conflicts surface here too.) */
  notFound: Suggestion[];
}

/** Substitute each suggestion's `wrong` with `correct`, everywhere it
 *  occurs. MANUAL mode's safety net: only exact-substring matches change —
 *  the user saw exactly these fragments in the review list. */
export function applyFixes(text: string, fixes: Suggestion[]): ApplyOutcome {
  let out = text;
  let applied = 0;
  const notFound: Suggestion[] = [];
  for (const f of fixes) {
    if (!out.includes(f.wrong)) {
      notFound.push(f);
      continue;
    }
    out = out.replaceAll(f.wrong, f.correct);
    applied += 1;
  }
  return { text: out, applied, notFound };
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
