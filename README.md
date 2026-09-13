# Myan Spell Fix

> **မြန်မာစာလုံးပြင်** — Burmese spelling correction, powered by your own
> Google AI Studio (Gemini) key, hosted free on Cloudflare.

Paste Burmese text, let Gemini fix the spelling, review every change in an
inline diff, copy the clean result.

## Privacy first — your key never leaves your browser

- The app has **no server code**. Cloudflare serves static files; nothing
  else.
- You bring your own API key (get one free at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). It is
  stored only in your browser's localStorage.
- Requests go **directly from your browser to Google** — your key and your
  text never touch any other server, and nothing is stored anywhere.

## What it does

- Fixes spelling and typographical errors in Burmese text (wrong vowel
  signs, medials, stacked consonants, asat, ၊/။ punctuation)
- **Two fix modes** (dropdown in the header, beside the model selector):
  - **အလိုအလျောက် (Auto)** — the model returns the corrected text; you
    review every change in a syllable-cluster-level diff that highlights
    only the changed syllables (Myanmar script has no spaces between
    words, so a plain word-diff would flag whole phrases)
  - **တစ်ခုချင်း (Manual)** — a two-panel review (just-ocr style): the
    original text on the left with every flagged fragment highlighted
    (red = will fix, muted = unchecked), the wrong→correct checklist on
    the right. Only approved fixes apply. This is the hallucination
    guard: suggestions whose fragment doesn't actually occur in your text
    are flagged and can't apply
- Keyboard-driven review in manual mode: **↑/↓** move between suggestions
  (the row gets a left vertical indicator and its fragments get an amber
  outline in the text panel, auto-scrolled into view), **Space** toggles
  the row, **Enter** applies, **Esc** backs out; **⌘/Ctrl+Enter** runs a
  fix from the editor
- Handles long documents with **no input cap**: text is split at sentence
  (။) and clause (၊) boundaries into AI-sized chunks, processed as
  concurrent batches (3 at a time) with live progress. The editor shows
  the exact request estimate (≈ N requests) and warns when it exceeds the
  selected model's free daily quota
- Free-tier friendly by design: rate limits (429) are retried with
  Google's Retry-After hint and backoff — they never kill a run. A chunk
  that still fails keeps its original text; the review header shows how
  many were skipped ("N အပိုင်း ကျန်"). Cancel (Esc or ရပ်မည်) works
  mid-batch
- Opens plain-text files — **ဖိုင်ဖွင့်မည်** button or drag-and-drop onto
  the editor (.txt/.text/.md; newline-normalized, non-UTF-8 files warned
  about)
- Gemini models (Sept 2026 lineup) — **Flash Lite (latest)** is the
  default and **3.5 Flash-Lite** the pinned stable choice (~500 free
  requests/day per key); **3.8 Flash**, **3.7 Flash**, and **Flash
  (latest)** are stronger proofreaders (~20 free requests/day)
- Light / dark / system theme, Padauk webfont (self-hosted), bilingual
  Burmese-first UI

## Stack

- **Cloudflare Workers static assets** (free tier) — static hosting only,
  no server code, no bindings, no secrets
- **Google AI Studio (Gemini)** `generateContent` API called directly from
  the browser with the user's own key (sent via the `x-goog-api-key`
  header, only to `generativelanguage.googleapis.com`)
- **Svelte 5 + TypeScript + Vite** via `@cloudflare/vite-plugin`
- **Vitest** for unit tests (diff engine, chunker, Gemini call with mocked
  fetch)

## Develop

```sh
npm install
npm run dev        # vite dev server — paste your key in the app's UI
```

## Test & type-check

```sh
npm test           # vitest — no key or network needed (Gemini is mocked)
npm run check      # svelte-check — TypeScript + Svelte diagnostics
```

## Build & deploy

**Automatic:** every push to `main` deploys itself — GitHub Actions runs
the tests, builds, and runs `wrangler deploy` (`.github/workflows/deploy.yml`,
configured with the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo
secrets).

**Manual** (from this checkout):

```sh
npx wrangler login   # one-time
npm run deploy       # vite build + wrangler deploy
```

That's the whole setup — no secrets to configure on Cloudflare (users bring
their own keys). Deployed to `https://myan-spell-fix.<your-subdomain>.workers.dev`.

To validate a deploy without pushing: `npx wrangler deploy --dry-run`.

## Layout

```
wrangler.jsonc           static-assets config (no worker script)
src/App.svelte           the whole UI — editor, key panel, fix modes,
                         suggestion review, diff review
src/lib/spellfix.ts      Gemini prompts (auto rewrite + manual suggest),
                         direct browser→Google call, error mapping,
                         defensive JSON parsing, suggestion apply
src/lib/diff.ts          Myanmar cluster-aware LCS diff (from just-ocr)
src/lib/chunk.ts         sentence-boundary chunker (၊ ၊ \n, rejoin-exact)
src/lib/batch.ts         concurrent batch pool + retry/backoff helpers
src/lib/highlight.ts     flagged-fragment segments for manual mode's text
                         panel (overlap rules, cursor marking)
src/theme.ts             light/dark/system preference (from just-ocr)
src/lib/*.test.ts        unit tests (parsing, chunking, diff, highlight)
```

## Credits

- The diff engine and theme system are adapted from
  [just-ocr](https://github.com/pndaza/just-ocr) (same author), including
  its finding that flash-lite's free quota (~500/day) outlasts flash's
  (~20/day) for proofreading workloads.
- [Padauk](https://software.sil.org/padauk/) typeface by SIL International,
  self-hosted via Fontsource.
