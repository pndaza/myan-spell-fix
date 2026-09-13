//! HTTP layer: routes /api/* requests. Static assets never reach this
//! worker (asset-first routing); the worker runs first only for /api/*
//! (see wrangler.jsonc `run_worker_first`).
//!
//! The Gemini API key is a Worker secret (`wrangler secret put
//! GEMINI_API_KEY`) — held server-side, never sent to the browser.

import {
  AiError,
  MODEL_IDS,
  DEFAULT_MODEL,
  MAX_TEXT_LEN,
  fixSpelling,
} from "./spellfix";

export interface Env {
  GEMINI_API_KEY: string;
}

/** Best-effort per-IP rate limit. Module scope persists per isolate, so
 *  this is a soft guard against a single client hammering the endpoint and
 *  exhausting the shared Google AI Studio quota — not a hard guarantee. */
const LIMIT = 30;
const WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.resetAt <= now) {
    hits.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  h.n += 1;
  return h.n > LIMIT;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorBody(code: string, message: string) {
  return { error: message, code };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        defaultModel: DEFAULT_MODEL,
        models: Object.keys(MODEL_IDS),
        configured: Boolean(env.GEMINI_API_KEY),
      });
    }

    if (url.pathname === "/api/fix" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json(
          errorBody(
            "not_configured",
            "GEMINI_API_KEY is not set — run `wrangler secret put GEMINI_API_KEY`.",
          ),
          503,
        );
      }

      const ip =
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for") ??
        "unknown";
      if (rateLimited(ip)) {
        return json(errorBody("rate_limited", "Too many requests — try again in a minute."), 429);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(errorBody("invalid_json", "Request body must be JSON."), 400);
      }
      const { text, model } = (body ?? {}) as { text?: unknown; model?: unknown };
      if (typeof text !== "string" || text.trim().length === 0) {
        return json(errorBody("empty", "No text to fix."), 400);
      }
      if (text.length > MAX_TEXT_LEN) {
        return json(
          errorBody("too_long", `Text too long (max ${MAX_TEXT_LEN} characters per request).`),
          413,
        );
      }

      const started = Date.now();
      try {
        const result = await fixSpelling(
          env.GEMINI_API_KEY,
          text,
          typeof model === "string" ? model : "",
        );
        return json({
          corrected: result.corrected,
          model: result.model,
          parseMode: result.parseMode,
          ms: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof AiError) {
          const status =
            err.code === "rate_limited"
              ? 429
              : err.code === "capacity"
                ? 503
                : err.code === "not_configured"
                  ? 503
                  : err.code === "invalid_api_key"
                    ? 500
                    : 502;
          return json(errorBody(err.code, err.message), status);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error("spellfix failed:", msg);
        return json(errorBody("ai_error", "The spelling fix failed — try again."), 500);
      }
    }

    return json(errorBody("not_found", "Not found."), 404);
  },
};
