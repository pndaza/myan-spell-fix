//! Typed client for the /api endpoints. The server replies
//! `{ corrected, model, parseMode, ms }` on success and `{ error, code }`
//! on failure — this module turns both into clean client-side values.

/** Model choices mirrored from worker/spellfix.ts MODEL_IDS. Free-tier
 *  daily limits on Google AI Studio: flash-lite ~500 req/day, flash ~20
 *  (shared across all visitors — hence flash-lite as the default). */
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

export interface FixResponse {
  corrected: string;
  model: string;
  parseMode: "json" | "raw";
  ms: number;
}

/** Error with the server's machine code attached, so the UI can special-
 *  case rate limits ("wait a minute") vs hard failures ("try again"). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Friendly Burmese-first message per error code, with English fallback. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "rate_limited":
        return "တောင်းဆိုမှု များနေပါသည် — တစ်မိနစ်ခန့် စောင့်ပြီး ထပ်စမ်းပါ။ (Too many requests — retry in a minute.)";
      case "capacity":
      case "network":
        return "AI ဝန်ဆောင်မှုသို့ မချိတ်ဆက်နိုင်ပါ — ခဏနေပြီး ထပ်စမ်းပါ။ (Service unavailable — retry shortly.)";
      case "too_long":
        return "စာသား ရှည်လွန်းပါသည်။ (Text too long.)";
      case "empty":
        return "စာသား မရှိပါ။ (No text.)";
      case "not_configured":
        return "ဆာဗာတွင် Gemini API key မထည့်ရှိသေးပါ။ (Server missing GEMINI_API_KEY.)";
      case "invalid_api_key":
        return "Gemini API key မှားယွင်းနေပါသည်။ (Invalid GEMINI_API_KEY.)";
      default:
        return err.message;
    }
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "ရပ်တန့်လိုက်ပါသည်။ (Cancelled.)";
  }
  return "အမှားတစ်ခု ဖြစ်ပွားသည် — ထပ်စမ်းပါ။ (Something went wrong — try again.)";
}

/**
 * Fix one chunk (≤ 4000 chars, enforced server-side too). `signal` lets the
 * UI cancel an in-flight run.
 */
export async function fixText(
  text: string,
  model: ModelKey,
  signal?: AbortSignal,
): Promise<FixResponse> {
  let res: Response;
  try {
    res = await fetch("/api/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, model }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ApiError("Network error — check your connection.", "network", 0);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("Server returned an unreadable response.", "bad_response", res.status);
  }

  if (!res.ok) {
    const { error, code } = (body ?? {}) as { error?: string; code?: string };
    throw new ApiError(error ?? `Request failed (${res.status}).`, code ?? "unknown", res.status);
  }
  const fix = body as Partial<FixResponse>;
  if (typeof fix.corrected !== "string") {
    throw new ApiError("Server returned no corrected text.", "bad_response", res.status);
  }
  return fix as FixResponse;
}
