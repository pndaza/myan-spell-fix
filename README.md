# Myan Spell Fix

> **မြန်မာစာလုံးပြင်** — Burmese spelling correction, powered by
> Google AI Studio (Gemini), hosted free on Cloudflare Workers.

Paste Burmese text, let Gemini fix the spelling, review every change in an
inline diff, copy the clean result.

## What it does

- Fixes spelling and typographical errors in Burmese text (wrong vowel
  signs, medials, stacked consonants, asat, ၊/။ punctuation)
- Shows **exactly what changed** — a syllable-cluster-level diff highlights
  only the changed syllables (Myanmar script has no spaces between words, so
  a plain word-diff would flag whole phrases)
- Handles long documents: input is split at sentence (။) and clause (၊)
  boundaries into AI-sized chunks, fixed sequentially with live progress
- Three Gemini models via Google AI Studio's free tier — **Flash Lite
  (latest)** is the default (~500 free requests/day), **Flash (latest)** and
  **Gemini 3.8 Flash** are stronger proofreaders (~20 free requests/day)
- Light / dark / system theme, Padauk webfont (self-hosted), bilingual
  Burmese-first UI, keyboard shortcuts (⌘/Ctrl+Enter to fix, Esc to
  cancel/back)

Your text is sent only to the Gemini API for correction — nothing is stored.

## Stack

- **Cloudflare Worker** (free tier) serving both the static frontend
  (assets, `run_worker_first: ["/api/*"]`) and the `/api/fix` endpoint
- **Google AI Studio (Gemini)** `generateContent` API called server-side —
  the `GEMINI_API_KEY` Worker secret never reaches the browser
- **Svelte 5 + TypeScript + Vite** via `@cloudflare/vite-plugin`
- **Vitest** for unit tests (diff engine, chunker, worker handlers with a
  mocked Gemini API)

Free-tier friendly: Workers free tier needs no AI binding at all; Google AI
Studio's free quota is per API key (the owner's key, shared by visitors).
The worker caps input length and rate-limits hammering IPs (best-effort,
per-isolate) to protect that quota.

## Develop

```sh
npm install
npm run dev        # vite dev server — uses .dev.vars for the API key
```

Create a `.dev.vars` file (git-ignored) with your key:

```
GEMINI_API_KEY=your-key-from-aistudio.google.com
```

## Test

```sh
npm test           # vitest — no key or network needed (Gemini is mocked)
```

## Build & deploy

```sh
npx wrangler login                # one-time
npx wrangler secret put GEMINI_API_KEY   # paste your Google AI Studio key
npm run deploy                    # vite build + wrangler deploy
```

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
Deployed to `https://myan-spell-fix.<your-subdomain>.workers.dev`. The first
deploy creates the Worker; assets routing comes from `wrangler.jsonc`.

To validate a deploy without pushing: `npx wrangler deploy --dry-run`.

## Layout

```
wrangler.jsonc         worker config: assets routing (no AI binding)
worker/index.ts        /api/fix + /api/health, validation, rate limit
worker/spellfix.ts     Gemini prompt, generateContent call, error mapping,
                       defensive JSON parsing of the model's reply
src/App.svelte         the whole UI (edit → fixing → review states)
src/lib/diff.ts        Myanmar cluster-aware LCS diff (from just-ocr)
src/lib/chunk.ts       sentence-boundary chunker (၊ ၊ \n, rejoin-exact)
src/lib/api.ts         typed /api client + friendly error mapping
src/theme.ts           light/dark/system preference (from just-ocr)
```

## Credits

- The diff engine and theme system are adapted from
  [just-ocr](https://github.com/pndaza/just-ocr) (same author), including
  its finding that flash-lite's free quota (~500/day) outlasts flash's
  (~20/day) for proofreading workloads.
- [Padauk](https://software.sil.org/padauk/) typeface by SIL International,
  self-hosted via Fontsource.
