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
 *  Studio (per key, Sept 2026) favor flash-lite heavily; `freeRpd` drives
 *  the pre-run request estimate warning. `latest` aliases hot-swap to the
 *  newest release of that variant; the pinned entries are predictable.
 *  See https://ai.google.dev/gemini-api/docs/rate-limits */
export const MODELS = [
  {
    key: "gemini-flash-lite-latest",
    label: "Flash Lite (latest)",
    hint: "Fast · ~500/day free",
    freeRpd: 500,
  },
  {
    key: "gemini-3.5-flash-lite",
    label: "3.5 Flash-Lite",
    hint: "Stable Lite · ~500/day free",
    freeRpd: 500,
  },
  {
    key: "gemini-3.8-flash",
    label: "3.8 Flash",
    hint: "Best · ~20/day free",
    freeRpd: 20,
  },
  {
    key: "gemini-3.7-flash",
    label: "3.7 Flash",
    hint: "~20/day free",
    freeRpd: 20,
  },
  {
    key: "gemini-flash-latest",
    label: "Flash (latest)",
    hint: "~20/day free",
    freeRpd: 20,
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
- Do not report overlapping fragments: when two candidate errors overlap, report the single larger fragment once. Each fragment must cover a distinct place in the text.

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
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown[];
  };
}

/** Error with a machine-readable code the UI maps to a friendly message.
 *  `retryAfterSec` carries Google's Retry-After hint on 429s (if present)
 *  so the batch runner can pace itself instead of guessing. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly retryAfterSec?: number,
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

/** Per-request timeout: a stalled connection must not hang the sequential
 *  chunk loop — a run ends on its own even if the user never cancels. */
export const REQUEST_TIMEOUT_MS = 60_000;

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

  // Compose the caller's cancel signal with a timeout. A manual controller
  // (rather than AbortSignal.any) keeps older browsers working; `timedOut`
  // distinguishes the two abort sources afterwards.
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, REQUEST_TIMEOUT_MS);
  const forward = () => ac.abort();
  signal?.addEventListener("abort", forward);

  try {
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
          generationConfig: { temperature: 0.1, maxOutputTokens: 16384 },
        }),
        signal: ac.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // user cancel — keep the raw AbortError
      if (timedOut) {
        throw new ApiError("Google AI Studio did not answer in time.", "timeout");
      }
      // fetch itself failed — network or CORS territory
      throw new ApiError("Could not reach Google AI Studio.", "network");
    }

    let body: GeminiResponse;
    try {
      body = (await res.json()) as GeminiResponse;
    } catch (err) {
      // the body stream can also abort mid-download (cancel or timeout)
      if (signal?.aborted && err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      if (timedOut) {
        throw new ApiError("Google AI Studio did not answer in time.", "timeout");
      }
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
    // A non-STOP finish means the reply was cut short (MAX_TOKENS, SAFETY…).
    // Half a correction is worse than a clear error: in AUTO mode a truncated
    // `{"corrected": "…` would fall through to raw-text parsing and the
    // chunk's tail would silently vanish; in MANUAL mode it would read as
    // "no errors found".
    const finish = cand?.finishReason;
    if (finish !== undefined && finish !== "STOP") {
      throw new ApiError(
        `The model's reply was cut off (${finish}). Try a shorter text or another model.`,
        "ai_error",
      );
    }
    return { raw, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/** Interpret a parsed reply as a fixes list: a bare array, a {"fixes": […]}
 *  object, or a single {wrong, correct} pair. Null when it is none of
 *  those, so callers fall through to the next defense layer. */
function asFixList(v: unknown): unknown {
  if (v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) return v;
  const fixes = (v as { fixes?: unknown }).fixes;
  if (Array.isArray(fixes)) return fixes;
  if ("wrong" in v && "correct" in v) return [v];
  return null;
}

/** Parse a MANUAL-mode reply into validated suggestions.
 *
 *  Same defense layers as `parseCorrected` (whole JSON → fished {…} →
 *  fished […]), plus per-entry validation: strings only, non-empty,
 *  wrong ≠ correct. Duplicates (wrong+correct) collapse; entries are
 *  capped at 200 so a runaway reply cannot flood the review list. A reply
 *  that yields no valid entries reads as "no errors found" — not an
 *  error. */
export function parseFixes(raw: string): Suggestion[] {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let list: unknown = null;
  const whole = tryParseJson(unfenced);
  if (whole !== null) {
    list = asFixList(whole);
  } else {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const fished = tryParseJson(unfenced.slice(start, end + 1));
      if (fished !== null) list = asFixList(fished);
    }
  }
  // Some models return a bare array despite the instructions — possibly
  // wrapped in stray prose. Fish the outermost [...] and parse that.
  if (list === null) {
    const arrStart = unfenced.indexOf("[");
    const arrEnd = unfenced.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd > arrStart) {
      list = tryParseJson(unfenced.slice(arrStart, arrEnd + 1));
    }
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
    // Total by contract, not by caller discipline: an empty `wrong` would
    // insert `correct` between every character, and wrong === correct is a
    // no-op — neither can be an approved, seen-in-the-text fix.
    if (
      f.wrong.length === 0 ||
      f.wrong === f.correct ||
      !out.includes(f.wrong)
    ) {
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
    return new ApiError(
      "Google AI Studio quota/rate limit reached.",
      "rate_limited",
      status,
      parseRetryAfterSec(body),
    );
  }
  if (status === 401) {
    return new ApiError("The API key is invalid or lacks permission.", "invalid_api_key", status);
  }
  if (status === 400 || status === 403) {
    if (/api key|permission/i.test(msg)) {
      return new ApiError("The API key is invalid or lacks permission.", "invalid_api_key", status);
    }
    // A 403 whose message isn't about the key — typically a region or
    // API-not-enabled restriction where the key itself is fine.
    if (status === 403) {
      return new ApiError("Google denied the request (region or API access restriction).", "forbidden", status);
    }
    return new ApiError(`Gemini rejected the request: ${msg}`, "bad_request", status);
  }
  if (status >= 500) {
    return new ApiError("Google AI Studio is busy — retry shortly.", "capacity", status);
  }
  return new ApiError(msg, "ai_error", status);
}

/** Google sends its Retry-After hint in error.details as a RetryInfo
 *  object with retryDelay: "42s". Returns undefined when absent — the
 *  caller falls back to its own backoff. */
function parseRetryAfterSec(body: GeminiResponse): number | undefined {
  const details = body.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (d !== null && typeof d === "object") {
      const delay = (d as { retryDelay?: unknown }).retryDelay;
      if (typeof delay === "string") {
        const m = /^([\d.]+)s$/.exec(delay);
        if (m) return Math.ceil(parseFloat(m[1]));
      }
    }
  }
  return undefined;
}

/** Extract the corrected text from the model's raw reply.
 *
 *  Layers of defense, in order:
 *  1. direct JSON.parse of the whole (fence-stripped) reply → `.corrected`
 *  2. fish the outermost {...} block and parse that
 *  3. fall back to the raw text (model ignored the JSON instruction)
 *
 *  Layer 3 only applies when the reply doesn't look like a JSON attempt: a
 *  JSON-shaped reply we still couldn't read (wrong shape, empty
 *  `corrected`) is a model error, and returning its literal source as the
 *  "correction" would dump `{"corrected": …}` into the user's text.
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

  // 3. plain text — use as-is, but only if it never looked like JSON
  if (unfenced.startsWith("{") || unfenced.startsWith("[")) {
    throw new ApiError(
      "The model's reply was not valid JSON — try running the fix again.",
      "ai_error",
    );
  }
  return { corrected: unfenced, parseMode: "raw" };
}

/** Parse `s` as JSON and pull out a NON-EMPTY string `.corrected`; null on
 *  any mismatch (an empty correction would silently delete the chunk) so
 *  callers can try the next defense layer. */
function tryCorrectedFromJson(s: string): string | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (
      v !== null &&
      typeof v === "object" &&
      typeof (v as { corrected?: unknown }).corrected === "string"
    ) {
      const corrected = (v as { corrected: string }).corrected;
      return corrected.length > 0 ? corrected : null;
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
        return "Google ၏ quota သို့မဟုတ် တစ်မိနစ်အတွင်း ကန့်သတ်ချက် ပြည့်သွားပါပြီ — ခဏစောင့်ပြီး ပြန်စမ်းပါ သို့မဟုတ် အခြား model ရွေးပါ။ (Quota or per-minute rate limit reached — wait a minute and retry, or try another model.)";
      case "capacity":
      case "network":
        return "Google AI Studio သို့ မချိတ်ဆက်နိုင်ပါ — ခဏနေပြီး ထပ်စမ်းပါ။ (Could not reach Google AI Studio — retry shortly.)";
      case "timeout":
        return "Google AI Studio မှ အချိန်အတွင်း အဖြေ မရရှိပါ — ထပ်စမ်းပါ။ (No reply in time — try again.)";
      case "too_long":
        return "စာသား ရှည်လွန်းပါသည်။ (Text too long.)";
      case "empty":
        return "စာသား မရှိပါ။ (No text.)";
      case "invalid_api_key":
        return "API key မှားယွင်းနေပါသည် — Settings တွင် ပြင်ပါ။ (Invalid API key — fix it in Settings.)";
      case "forbidden":
        return "Google မှ ခွင့်ပြုချက် ငြင်းပါသည် (ဒေသ ကန့်သတ်ချက် ဖြစ်နိုင်သည်) — အခြားကွန်ရက် သို့မဟုတ် key ဖြင့် စမ်းပါ။ (Google denied the request — possibly a region restriction; try another network or key.)";
      default:
        return err.message;
    }
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "ရပ်တန့်လိုက်ပါသည်။ (Cancelled.)";
  }
  return "အမှားတစ်ခု ဖြစ်ပွားသည် — ထပ်စမ်းပါ။ (Something went wrong — try again.)";
}
