<script lang="ts">
  import { mapPool, withRetries } from "./lib/batch";
  import { chunkText } from "./lib/chunk";
  import { diffWords, countEdits, mergeSegs, type DiffSeg } from "./lib/diff";
  import { normalizeText } from "./lib/filetext";
  import { scanFlags, renderFlags, countOccurrences } from "./lib/highlight";
  import {
    fixText,
    suggestFixes,
    applyFixes,
    errorMessage,
    ApiError,
    MODELS,
    PROVIDERS,
    DEFAULT_PROVIDER,
    resolveProvider,
    type ProviderId,
    type Suggestion,
    type FixResult,
    type SuggestResult,
    resolveModel,
  } from "./lib/spellfix";
  import { currentTheme, setTheme, nextTheme, resolveTheme, type Theme } from "./theme";
  import { untrack } from "svelte";

  /** Per-request chunk size (chars) — must stay under fixText's 20,000-char
   *  cap. Total input length is NOT limited: long documents just produce
   *  more chunks, processed as concurrent batches (ebook-translator style).
   *  Sized in PAGES (1 မျက်နှာ ≈ 2,000 chars): နည်း = 2 pages, ပုံမှန် =
   *  5 pages, များ = 8 pages. Bigger chunks mean fewer requests — quota
   *  friendly — at the cost of the model handling more text per call. */
  const CHUNK_STEPS = [
    { size: 4_000, pages: "၂", label: "နည်း" },
    { size: 10_000, pages: "၅", label: "ပုံမှန်" },
    { size: 16_000, pages: "၈", label: "များ" },
  ] as const;
  const CHUNK_DEFAULT = 10_000;
  /** Concurrent chunk requests — enough to keep the pipe full at the
   *  free-tier Flash RPM limit, harmless at Flash-Lite's. */
  const POOL = 3;
  /** Total tries per chunk for transient errors (429 with Retry-After,
   *  capacity, network, timeout). Key/access errors are fatal instead. */
  const CHUNK_ATTEMPTS = 3;
  const RETRYABLE = new Set(["rate_limited", "capacity", "network", "timeout"]);

  /** Plain-text file opening: accepted picker types and a size guard far
   *  above any sensible document (length itself is not capped — batching
   *  handles long text; this only stops a giant read). */
  const FILE_ACCEPT = ".txt,.text,.md,text/plain";
  const MAX_FILE_BYTES = 2_000_000;

  /** localStorage key for the user's own Google AI Studio API key. The key
   *  is stored ONLY in the browser — it never goes anywhere except Google's
   *  API endpoint. */
  const KEY_STORAGE = "myan-spell-fix:gemini-key";

  /** Demo text with two deliberate, unmistakable typos (မြနာမာ → မြန်မာ,
   *  ဖစ် → ဖြစ်) so first-time visitors see the diff view do its job. */
  const SAMPLE =
    "မြနာမာနိုင်ငံသည် အရှေ့တောင်အာရှဒေသတွင် တည်ရှိသည်။ " +
    "နိုင်ငံ၏ မြို့တော်မှာ နေပြည်တော်ဖစ်သည်။ " +
    "လူမျိုးပေါင်းစုံ အတူတကွ နေထိုင်ကြသည်။";

  type Phase = "edit" | "fixing" | "suggest" | "review";
  type View = "diff" | "clean";
  /** Fix mode: "auto" = the model rewrites the whole text (review via
   *  diff); "manual" = the model suggests wrong→correct pairs and only
   *  user-approved fixes are applied — the hallucination guard. */
  type FixMode = "auto" | "manual";

  /** A reviewable suggestion row: the pair plus UI state. `found` is false
   *  when the wrong fragment does not occur in the input (hallucinated or
   *  consumed by an earlier fix) — such rows cannot be applied. */
  interface SugRow extends Suggestion {
    checked: boolean;
    /** Occurrences of `wrong` in the input text. */
    count: number;
    found: boolean;
  }

  function loadMode(): FixMode {
    try {
      const v = localStorage.getItem("myan-spell-fix:mode");
      if (v === "auto" || v === "manual") return v;
    } catch {
      /* default */
    }
    return "auto";
  }

  function loadKey(provider: ProviderId): string {
    try {
      let v = localStorage.getItem(`myan-spell-fix:key:${provider}`);
      // one-time migration: the pre-OpenRouter build stored the Google key
      // under a provider-less name
      if (provider === "google" && v === null) {
        v = localStorage.getItem(KEY_STORAGE);
        if (v !== null) localStorage.setItem("myan-spell-fix:key:google", v);
      }
      return v ?? "";
    } catch {
      return "";
    }
  }

  function saveKey(provider: ProviderId, key: string): string {
    try {
      if (key) localStorage.setItem(`myan-spell-fix:key:${provider}`, key);
      else localStorage.removeItem(`myan-spell-fix:key:${provider}`);
    } catch {
      /* private mode — key lives for this session only */
    }
    return key;
  }

  let input = $state("");
  let provider = $state<ProviderId>(loadProvider());
  // initial snapshots: provider changes later go through switchProvider(),
  // which reloads both — hence the deliberate untrack
  let model = $state<string>(untrack(() => loadModel(provider)));
  let mode = $state<FixMode>(loadMode());
  /** Selected per-request chunk size (chars) — drives BOTH the request
   *  estimate and the actual chunking of the next run. */
  let chunk = $state<number>(loadChunk());
  let apiKey = $state<string>(untrack(() => loadKey(provider)));
  /** Key-editing panel state: draft input + whether it's shown. Shown
   *  automatically when there's no key (until dismissed); reopened via the
   *  header button. */
  let keyDraft = $state("");
  let keyInput = $state<HTMLInputElement | undefined>(undefined);
  let editingKey = $state(false);
  /** Set when the user explicitly closes the auto-opened key panel —
   *  first-time visitors can decline to enter a key and still use the
   *  editor; the panel stops reopening until they ask for it. */
  let keyPanelDismissed = $state(false);
  /** About/shortcuts card, opened from the header info icon. */
  let showInfo = $state(false);
  /** Explanation bubble beside the chunk-size dropdown. */
  let chunkNote = $state(false);
  let phase = $state<Phase>("edit");
  let view = $state<View>("diff");
  let result = $state<string | null>(null);
  /** Auto mode: per-chunk diff segments, merged in document order. Diffing
   *  each ≤ chunk-size part against its own correction keeps every DP
   *  table tiny at any document size — one whole-document diff would
   *  exceed the DP cap (one coarse blob) once the edited middle grows
   *  past ~8k chars. Null in manual mode (applied fixes diff as a whole,
   *  localized by diffWords' own split-and-recurse). */
  let chunkSegs = $state<DiffSeg[] | null>(null);
  let suggestions = $state<SugRow[]>([]);
  /** Keyboard-cursor row in the suggest list (↑/↓). Its fragments carry
   *  the `cur` highlight in the text panel and the left indicator in the
   *  fix list. Always points at a FOUND row while one exists. */
  let cursor = $state(0);
  let error = $state<string | null>(null);
  let progress = $state({ done: 0, total: 1 });
  /** Pause note shown during the fixing phase — set when a chunk is
   *  backing off after a rate limit / transient failure. */
  let pauseNote = $state<string | null>(null);
  /** How many chunks of the last run failed (their original text was
   *  kept). Surfaced in the review header — a partial run, not a broken
   *  one. */
  let partial = $state(0);
  let elapsed = $state(0);
  let themePref = $state<Theme>(currentTheme());
  let toast = $state<string | null>(null);
  let ctrl: AbortController | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // open the key panel on first visit when no key is stored — until the
  // user explicitly dismisses it
  $effect(() => {
    if (!apiKey && !keyPanelDismissed) {
      keyDraft = "";
      editingKey = true;
      focusKeyDraft();
    }
  });

  const trimmed = $derived(input.trim());
  const canFix = $derived(
    phase === "edit" &&
      trimmed.length > 0 &&
      apiKey.trim().length > 0,
  );
  /** Models of the ACTIVE provider (both providers carry the same Gemini
   *  family; OpenRouter's are paid per token with no daily free quota). */
  const providerModels = $derived(PROVIDERS[provider].models);
  /** Free daily requests for the selected model — the estimate below is
   *  checked against it so users see quota trouble before spending any.
   *  Null on OpenRouter (credit-based): no quota warning there. */
  const modelQuota = $derived(
    providerModels.find((m) => m.key === model)?.freeRpd ?? null,
  );
  /** Exact number of requests the next run will make (same chunker the
   *  run uses). Debounced — chunking a whole book on every keystroke
   *  would jank the editor. */
  let estRequests = $state(0);
  $effect(() => {
    const t = input;
    const size = chunk;
    const id = setTimeout(() => {
      estRequests = t.trim() ? chunkText(t, size).length : 0;
    }, 250);
    return () => clearTimeout(id);
  });
  const overQuota = $derived(modelQuota !== null && estRequests > modelQuota);

  /** Count chip that pops over the editor when text ARRIVES (first typed
   *  or pasted character, an opened file) and fades 3 s later — a
   *  glanceable echo of the counter while the eye is still on the text. */
  let countPopup = $state(false);
  let countPopupTimer: ReturnType<typeof setTimeout> | null = null;
  function showCountPopup() {
    if (phase !== "edit") return;
    countPopup = true;
    if (countPopupTimer !== null) clearTimeout(countPopupTimer);
    countPopupTimer = setTimeout(() => (countPopup = false), 3000);
  }
  {
    let hadInput = false;
    $effect(() => {
      const has = input.trim().length > 0;
      const arrived = has && !hadInput;
      hadInput = has;
      if (arrived) showCountPopup();
    });
  }
  const diffSegs = $derived(
    chunkSegs !== null
      ? chunkSegs
      : result !== null
        ? diffWords(input, result)
        : [],
  );
  const editCount = $derived(countEdits(diffSegs));
  /** Fragment occurrences in the original text — the expensive scan (cost
   *  scales with text × rows), run once per suggestion set. Tracks only
   *  wrong/found, NOT checked/cursor: toggles and arrow keys must not
   *  rescan a whole document. */
  const flagScan = $derived(
    phase === "suggest"
      ? scanFlags(
          input,
          suggestions.map((s) => ({ wrong: s.wrong, found: s.found })),
        )
      : null,
  );
  /** Original text with flagged fragments highlighted — the LEFT panel of
   *  manual mode's review. Live-updates as rows are checked/unchecked and
   *  as the keyboard cursor moves; only the cheap render step re-runs. */
  const textSegs = $derived(
    flagScan !== null
      ? renderFlags(
          input,
          flagScan,
          suggestions.map((s, i) => ({
            checked: s.checked,
            current: i === cursor,
          })),
        )
      : [],
  );
  const progressPct = $derived(
    Math.round((progress.done / Math.max(progress.total, 1)) * 100),
  );

  function loadChunk(): number {
    try {
      const v = Number(localStorage.getItem("myan-spell-fix:chunk"));
      if (CHUNK_STEPS.some((s) => s.size === v)) return v;
    } catch {
      /* private mode — default */
    }
    return CHUNK_DEFAULT;
  }

  function loadProvider(): ProviderId {
    try {
      return resolveProvider(localStorage.getItem("myan-spell-fix:provider"));
    } catch {
      return DEFAULT_PROVIDER;
    }
  }

  function loadModel(prov: ProviderId): string {
    try {
      let v = localStorage.getItem(`myan-spell-fix:model:${prov}`);
      // migration from the provider-less key of single-provider builds
      if (prov === "google" && v === null) {
        v = localStorage.getItem("myan-spell-fix:model");
      }
      const models = PROVIDERS[prov].models;
      if (typeof v === "string" && models.some((m) => m.key === v)) return v;
    } catch {
      /* private mode — default */
    }
    return PROVIDERS[prov].models[0].key;
  }

  $effect(() => {
    try {
      localStorage.setItem("myan-spell-fix:provider", provider);
      localStorage.setItem(`myan-spell-fix:model:${provider}`, model);
      localStorage.setItem("myan-spell-fix:mode", mode);
      localStorage.setItem("myan-spell-fix:chunk", String(chunk));
    } catch {
      /* ignore */
    }
  });

  // Follow the OS theme live while the preference is "system".
  $effect(() => {
    if (themePref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () =>
      (document.documentElement.dataset.theme = resolveTheme("system"));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  // Keep the cursor's fragment (text panel) and row (fix list) visible.
  // Both panels scroll internally, so the page itself never jumps; the
  // rect-delta scroll targets each scroller explicitly. The queued frame
  // is cancelled on cleanup so rapid ↑/↓ don't stack smooth-scrolls.
  $effect(() => {
    if (phase !== "suggest") return;
    cursor; // track
    const raf = requestAnimationFrame(() => {
      const pre = document.querySelector<HTMLElement>(".panel-text");
      const frag = pre?.querySelector<HTMLElement>(".flag.cur");
      if (pre && frag) {
        const delta =
          frag.getBoundingClientRect().top -
          pre.getBoundingClientRect().top -
          (pre.clientHeight / 2 - frag.offsetHeight / 2);
        pre.scrollBy({ top: delta, behavior: "smooth" });
      }
      const row = document.querySelector<HTMLElement>(".sug.cursor");
      row?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  });

  function cycleTheme() {
    themePref = setTheme(nextTheme(themePref));
  }

  /** Human elapsed time for the result header ("1.6 s", not "1593 ms"). */
  function fmtMs(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  /** Swap provider: model AND api key are per-provider, so both reload
   *  (each keeps its own remembered pick). */
  function switchProvider(next: ProviderId) {
    provider = next;
    model = loadModel(next);
    apiKey = loadKey(next);
    // an open key panel edits the ACTIVE provider's key — refresh the
    // draft too, or the previous provider's key would be saved over the
    // new provider's on the next သိမ်းမည် click
    if (editingKey) keyDraft = apiKey;
  }

  /** Focus the key input and select its contents, so typing REPLACES a
   *  prefilled (masked) key instead of appending to it. */
  function focusKeyDraft() {
    requestAnimationFrame(() => {
      keyInput?.focus();
      keyInput?.select();
    });
  }

  function openKeyPanel() {
    keyDraft = apiKey;
    keyPanelDismissed = false;
    editingKey = true;
    showInfo = false;
    focusKeyDraft();
  }

  function closeKeyPanel() {
    keyPanelDismissed = true;
    editingKey = false;
  }

  function commitKey() {
    apiKey = saveKey(provider, keyDraft.trim());
    editingKey = false;
    if (apiKey) showToast("API key သိမ်းပြီးပါပြီ — Saved");
  }

  function showToast(msg: string) {
    toast = msg;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 1800);
  }

  async function runFix() {
    if (!canFix) return;
    const parts = chunkText(input, chunk);
    if (parts.length === 0) return;

    phase = "fixing";
    error = null;
    result = null;
    chunkSegs = null;
    suggestions = [];
    partial = 0;
    pauseNote = null;
    progress = { done: 0, total: parts.length };
    // This run's own controller: cancel() aborts it, and the pool below
    // reads `ac` — not the shared `ctrl` — so runs can never abort each
    // other. It also cuts backoff sleeps short on cancel.
    const ac = new AbortController();
    ctrl = ac;
    const t0 = performance.now();

    /** One chunk, retried on transient errors. Rate limits are EXPECTED
     *  on the free tier: honor Google's Retry-After when present, else
     *  back off 8s/16s; never let a 429 kill the run. */
    const runChunk = async (
      part: string,
    ): Promise<FixResult | SuggestResult> => {
      const call =
        mode === "auto"
          ? () => fixText(apiKey.trim(), part, provider, model, ac.signal)
          : () => suggestFixes(apiKey.trim(), part, provider, model, ac.signal);
      return withRetries<FixResult | SuggestResult>(call, {
        attempts: CHUNK_ATTEMPTS,
        retryIf: (err) => err instanceof ApiError && RETRYABLE.has(err.code),
        delayMs: (attempt, err) => {
          const e = err as ApiError;
          if (e.code === "rate_limited") {
            return Math.min(e.retryAfterSec ? e.retryAfterSec * 1000 : 8000 * attempt, 120_000);
          }
          return 2000 * attempt;
        },
        onRetry: (attempt, err, ms) => {
          pauseNote =
            err instanceof ApiError && err.code === "rate_limited"
              ? `quota ကန့်သတ်ချက် — ${Math.round(ms / 1000)} စက္ကန့် စောင့်ပြီး ထပ်စမ်းနေသည် (${attempt}/${CHUNK_ATTEMPTS - 1})…`
              : `အနည်းငယ် နှေးနေပါသည် — ထပ်စမ်းနေသည် (${attempt}/${CHUNK_ATTEMPTS - 1})…`;
        },
        signal: ac.signal,
      });
    };

    try {
      const outcome = await mapPool(
        parts,
        POOL,
        async (part) => {
          // A whitespace-only part (e.g. the trailing space after a final
          // chunk that filled exactly) has nothing to fix — pass it through
          // instead of letting generate()'s "empty" error mark the run
          // partial. Join-invariant assembly keeps the document identical.
          if (part.trim().length === 0) {
            progress = { done: progress.done + 1, total: parts.length };
            return mode === "auto"
              ? ({ corrected: part, model: resolveModel(provider, model), parseMode: "json", ms: 0 } as FixResult)
              : ({ fixes: [], ms: 0 } as SuggestResult);
          }
          const r = await runChunk(part);
          progress = { done: progress.done + 1, total: parts.length };
          return r;
        },
        // key/access/credit errors are futile to retry on the next chunk —
        // stop the whole run so the user can fix the cause first
        (err) =>
          err instanceof ApiError &&
          (err.code === "invalid_api_key" ||
            err.code === "forbidden" ||
            err.code === "insufficient_credits"),
      );
      pauseNote = null;

      const allFailed = outcome.failed.length === parts.length;
      if (allFailed) {
        // nothing succeeded — show the real error, keep the editor's text
        error = errorMessage(outcome.lastError);
        if (
          outcome.lastError instanceof ApiError &&
          outcome.lastError.code === "invalid_api_key"
        ) {
          openKeyPanel();
        }
        phase = "edit";
      } else {
        partial = outcome.failed.length;
        if (mode === "auto") {
          // failed chunks keep their original text — a partial fix, not a
          // broken one (failed spots stay visible in the diff view)
          const correctedParts = parts.map((p, i) => {
            const r = outcome.results[i];
            return r && "corrected" in r ? r.corrected : p;
          });
          result = correctedParts.join("");
          chunkSegs = mergeSegs(
            correctedParts.map((c, i) => diffWords(parts[i], c)),
          );
          view = "diff";
          phase = "review";
        } else {
          const all: Suggestion[] = [];
          for (const r of outcome.results) {
            if (r && "fixes" in r) all.push(...r.fixes);
          }
          suggestions = buildRows(all, input);
          cursor = Math.max(
            0,
            suggestions.findIndex((s) => s.found),
          );
          phase = "suggest";
        }
        if (partial > 0) {
          showToast(
            `${partial} ပိုင်း မအောင်မြင်ပါ — မူလစာသားအတိုင်း ထားခဲ့သည် (${partial} chunk(s) failed — original kept)`,
          );
        }
      }
      elapsed = Math.round(performance.now() - t0);
    } catch (err) {
      // fatal: a cancel returns to the editor quietly; a key/access error
      // explains itself and (for keys) reopens the panel in place.
      if (!(err instanceof Error && err.name === "AbortError")) {
        error = errorMessage(err);
        if (err instanceof ApiError && err.code === "invalid_api_key") {
          openKeyPanel();
        }
      }
      phase = "edit";
    } finally {
      ctrl = null;
    }
  }

  /** Dedupe suggestion pairs (chunks can repeat the same misspelling) and
   *  pre-compute each fragment's occurrence count in the FULL input — the
   *  count the apply step will really substitute. Fragments that don't
   *  occur at all are kept but marked un-found (hallucination guard). */
  function buildRows(pairs: Suggestion[], text: string): SugRow[] {
    const seen = new Set<string>();
    const rows: SugRow[] = [];
    for (const p of pairs) {
      const key = `${p.wrong}→${p.correct}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // indexOf counting, not split: split allocates every piece, which
      // explodes when a common fragment occurs often in a long document
      const count = countOccurrences(text, p.wrong);
      rows.push({ ...p, count, found: count > 0, checked: count > 0 });
    }
    return rows;
  }

  const checkedRows = $derived(
    suggestions.filter((s) => s.checked && s.found),
  );

  function applySuggestions() {
    const outcome = applyFixes(input, checkedRows);
    // Sequential application can consume a fragment an earlier fix rewrote;
    // those approved-but-skipped fixes must not vanish silently.
    if (outcome.notFound.length > 0) {
      showToast(
        `ရွေးထားသည် ${outcome.notFound.length} ခု မတွေ့တော့ပါ — ${outcome.notFound.length} checked fix(es) no longer matched and were skipped`,
      );
    }
    result = outcome.text;
    chunkSegs = null;
    view = "diff";
    phase = "review";
  }

  function toggleAllSuggestions() {
    const found = suggestions.filter((s) => s.found);
    const target = !found.every((s) => s.checked);
    for (const s of found) s.checked = target;
  }

  /** Move the keyboard cursor by ±1, landing only on applicable (found)
   *  rows — disabled hallucination rows are skipped, wrap-around. */
  function moveCursor(delta: number) {
    const n = suggestions.length;
    if (n === 0) return;
    let i = cursor;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (suggestions[i].found) break;
    }
    cursor = i;
  }

  function toggleCurrent() {
    const s = suggestions[cursor];
    if (s?.found) s.checked = !s.checked;
  }

  function cancel() {
    ctrl?.abort();
  }

  /** ── plain-text file input (button + drag-and-drop) ─────────────── */

  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  /** Editor drag-over highlight. dragenter/leave fire per child element,
   *  so a counter — not a boolean toggle — keeps the state stable. */
  let dragging = $state(false);
  let dragDepth = 0;

  function looksTextual(file: File): boolean {
    if (file.type === "" || file.type.startsWith("text/")) return true;
    return /\.(txt|text|md)$/i.test(file.name);
  }

  /** Read a .txt-style file into the editor: newline-normalized, capped at
   *  MAX_INPUT (surrogate-safe), with clear toasts for the awkward cases
   *  (non-UTF-8 bytes decode to U+FFFD and show as broken syllables). */
  async function loadTextFile(file: File) {
    if (!looksTextual(file)) {
      showToast("စာသားဖိုင်သာ ဖွင့်နိုင်ပါသည် (.txt) — Only plain-text files are supported");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast("ဖိုင် ကြီးလွန်းပါသည် — File too large");
      return;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      showToast("ဖိုင် ဖွင့်၍ မရပါ — Could not read the file");
      return;
    }
    input = normalizeText(raw);
    showCountPopup();
    if (raw.includes("\uFFFD")) {
      showToast("UTF-8 မဟုတ်သော ဖိုင် ဖြစ်နိုင်သည် — စာလုံးပျက်နေနိုင်သည် (File may not be UTF-8)");
    } else {
      showToast(`ဖွင့်ပြီးပါပြီ — ${file.name}`);
    }
  }

  function onPickFile(e: Event) {
    const input_ = e.currentTarget as HTMLInputElement;
    const file = input_.files?.[0];
    if (file) void loadTextFile(file);
    input_.value = ""; // allow re-picking the same file
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    if (phase !== "edit") return; // don't swap the text mid-run
    dragDepth++;
    dragging = true;
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault(); // required to allow a drop
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth = 0;
    dragging = false;
    if (phase !== "edit") return; // don't swap the text mid-run
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadTextFile(file);
  }

  function backToEdit() {
    phase = "edit";
    result = null;
    chunkSegs = null;
    suggestions = [];
    partial = 0;
    pauseNote = null;
  }

  /** Feed the corrected text straight into another pass — users often run
   *  a second check to confirm the fix (or catch remaining issues with the
   *  other model). Returns to the edit phase first: runFix is guarded by
   *  canFix, which is only true there. */
  async function fixAgain() {
    if (result === null) return;
    input = result;
    result = null;
    chunkSegs = null;
    error = null;
    partial = 0;
    phase = "edit";
    await runFix();
  }

  async function copyResult() {
    if (result === null) return;
    try {
      await navigator.clipboard.writeText(result);
      showToast("ကူးယူပြီးပါပြီ — Copied");
    } catch {
      // fallback for browsers/contexts without the async clipboard API
      if (legacyCopy(result)) {
        showToast("ကူးယူပြီးပါပြီ — Copied");
      } else {
        showToast("ကူးယူမည် မအောင်မြင်ပါ — Copy failed");
      }
    }
  }

  /** Download the corrected text as a .txt file — the round trip back to
   *  the user's disk (cf. ဖိုင်ဖွင့်မည် in). Date-stamped so successive
   *  exports don't overwrite each other. */
  function exportResult() {
    if (result === null) return;
    const d = new Date();
    const stamp = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    const blob = new Blob([result], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `myan-spell-fix-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("ဖိုင် သိမ်းပြီးပါပြီ — Exported");
  }

  function legacyCopy(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** Arrow keys move between the result tabs (tabs-pattern keyboard
   *  support); focus follows the newly active tab. */
  function onTablistKey(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    view = view === "diff" ? "clean" : "diff";
    document
      .getElementById(view === "diff" ? "tab-diff" : "tab-clean")
      ?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    // popovers close first — they overlay whatever phase is active
    if (e.key === "Escape" && (showInfo || chunkNote)) {
      showInfo = false;
      chunkNote = false;
      return;
    }
    // Suggest-phase review shortcuts: ↑/↓ move the row cursor (its
    // fragments light up in the text panel), Space toggles, Enter applies.
    if (phase === "suggest") {
      if (e.key === "Escape") {
        backToEdit();
        return;
      }
      // Native keys win inside interactive controls: arrows for the
      // header selects, Space/Enter for a focused button or checkbox.
      // (After a run, focus is typically back on <body>, where the
      // shortcuts apply.)
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("button, select, input, textarea, a[href]")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(-1);
      } else if (e.key === " ") {
        e.preventDefault();
        toggleCurrent();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (checkedRows.length > 0) applySuggestions();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (phase === "edit") runFix();
    } else if (e.key === "Escape") {
      if (phase === "fixing") cancel();
      else if (phase === "review") backToEdit();
      else if (phase === "edit" && editingKey) closeKeyPanel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <header class="top">
    <div class="brand">
      <div class="logo" aria-hidden="true">စာ</div>
      <div>
        <h1>Myan Spell Fix</h1>
        <p class="tag">မြန်မာစာလုံးပြင် — AI ဖြင့် သတ်ပုံမှန်ကန်စေရန်</p>
      </div>
    </div>
    <div class="controls">
      <select
        bind:value={mode}
        title="ပြင်ဆင်မှုစနစ် — Auto: တစ်ချက်လုံး ပြင်ပြီး diff ဖြင့် စစ်ပါ · Manual: ထောက်ခံချက်တစ်ခုချင်း ရွေးပြီးမှ ပြင်ပါ"
        aria-label="Fix mode"
      >
        <option value="auto">အလိုအလျောက် (Auto)</option>
        <option value="manual">တစ်ခုချင်း (Manual)</option>
      </select>
      <select
        value={provider}
        onchange={(e) => switchProvider(e.currentTarget.value as ProviderId)}
        title="AI provider — Google AI Studio (အခမဲ့ quota) သို့မဟုတ် OpenRouter (credit ဖြင့် အသုံးပြု)"
        aria-label="AI provider"
      >
        {#each Object.values(PROVIDERS) as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
      <select
        bind:value={model}
        title="AI model — Gemini. Flash Lite အမြန်ဆုံး၊ Flash ပိုမှန်ကန်သည်"
        aria-label="AI model"
      >
        {#each providerModels as m (m.key)}
          <option value={m.key}>
            {m.label}{m.freeRpd !== undefined ? ` (${m.freeRpd}/day)` : ""}
          </option>
        {/each}
      </select>
      <button
        class="btn icon"
        class:attention={!apiKey}
        onclick={openKeyPanel}
        title={apiKey ? "API key settings" : "API key ထည့်ရန် — Add your API key"}
        aria-label="API key settings"
      >
        <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
          <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
        </svg>
      </button>
      <button class="btn icon" onclick={cycleTheme} title={themePref === "light" ? "Light" : themePref === "dark" ? "Dark" : "System"} aria-label={`Theme: ${themePref}`}>
        {#if themePref === "light"}
          <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        {:else if themePref === "dark"}
          <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        {:else}
          <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
          </svg>
        {/if}
      </button>
      <button
        class="btn icon"
        onclick={() => {
          showInfo = !showInfo;
          if (showInfo) editingKey = false;
        }}
        title="အချက်အလက် — About, quota & shortcuts"
        aria-label="အချက်အလက် — About, quota and shortcuts"
        aria-expanded={showInfo}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
    </div>
  </header>

  <main>
    {#if showInfo}
      <div class="card infocard">
        <div class="infohead">
          <span class="infotitle">မြန်မာစာလုံးပြင် — Myan Spell Fix</span>
          <button class="btn" onclick={() => (showInfo = false)} title="ပိတ်မည် — Close">✕</button>
        </div>
        <ul class="infolist">
          <li>
            Google Gemini ဖြင့် မြန်မာ စာလုံးပြင်ပေးသည့် ကိရိယာ — စာသားသည်
            သင့် browser မှ ရွေးထားသော provider သို့သာ တိုက်ရိုက်သွားပါသည်။
          </li>
          <li>
            provider နှစ်ခု — Google AI Studio (အခမဲ့ quota:
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">အခမဲ့ key</a>)
            သို့မဟုတ် OpenRouter (credit ဖြင့် အသုံးပြု:
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">key ယူပါ</a>)။
            key ကို browser ထဲတွင်သာ သိမ်းဆည်းပါသည်။
          </li>
          <li>
            Google AI Studio အခမဲ့ quota — Flash-Lite ~500 request/နေ့၊ Flash
            ~20 request/နေ့။ ခန့်မှန်း request အရေအတွက်ကို အောက်တွင် ပြသည်။
          </li>
          <li>
            chunk အရွယ်အစား — နည်း = request များသည်၊ များ = request နည်းသည်။
          </li>
          <li>
            shortcut — Ctrl/⌘ + Enter = စတင်၊ Esc = ပိတ်/နောက်သို့၊ manual mode
            တွင် ↑↓ · Space · Enter
          </li>
        </ul>
      </div>
    {/if}

    {#if editingKey && phase === "edit"}
      <div class="card keycard">
        <label class="keylabel" for="api-key-input">
          {PROVIDERS[provider].keyLabel}
          {#if apiKey}<span class="keyset">✓ သိမ်းထားပြီး — saved</span>{/if}
        </label>
        <div class="keyrow">
          <input
            id="api-key-input"
            type="password"
            bind:value={keyDraft}
            bind:this={keyInput}
            placeholder={PROVIDERS[provider].keyPlaceholder}
            spellcheck="false"
            autocomplete="off"
            onkeydown={(e) => e.key === "Enter" && commitKey()}
          />
          <button class="btn primary" onclick={commitKey} disabled={keyDraft.trim().length === 0}>
            <span class="mm">သိမ်းမည်</span>
          </button>
          {#if apiKey}
            <button
              class="btn"
              onclick={() => {
                apiKey = saveKey(provider, "");
                keyDraft = "";
              }}
              title="Remove the stored key"
            >
              <span class="mm">ဖျက်မည်</span>
            </button>
          {/if}
          <button class="btn" onclick={closeKeyPanel} title="Close">
            ✕
          </button>
        </div>
        <p class="keynote">
          Key ကို သင့် browser ထဲတွင်သာ သိမ်းဆည်းပါသည် — မည်သည့်ဆာဗာသို့မှ
          မပို့ပါ။ {PROVIDERS[provider].label} သို့သာ တိုက်ရိုက်ချိတ်ဆက်သည်။
          {#if provider === "google"}
            <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer">
              အခမဲ့ key ယူပါ — Get a free key
            </a>
          {:else}
            <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer">
              OpenRouter key ယူပါ — Get a key
            </a>
          {/if}
        </p>
      </div>
    {/if}

    {#if error !== null && phase === "edit"}
      <div class="error" role="alert">
        <span>{error}</span>
        <button onclick={() => (error = null)} aria-label="Dismiss">✕</button>
      </div>
    {/if}

    {#if phase === "edit" || phase === "fixing"}
      <div class="card">
        {#if phase === "fixing"}
          <div class="fixing">
            <div class="status">
              <span class="spinner" aria-hidden="true"></span>
              <span>
                စစ်ဆေးနေသည်… {progress.done} / {progress.total}
              </span>
              <span class="grow" style="flex:1"></span>
              <button class="btn" onclick={cancel}>
                <span class="mm">ရပ်မည်</span>
              </button>
            </div>
            {#if pauseNote}
              <div class="pause-note">{pauseNote}</div>
            {/if}
            <div class="progress" role="progressbar" aria-label="စစ်ဆေးမှု တိုးတက်မှု" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <i style="width: {progressPct}%"></i>
            </div>
          </div>
        {/if}
        <div class="editorwrap">
          <textarea
            class="editor"
            class:dragover={dragging}
            bind:value={input}
            disabled={phase === "fixing"}
            placeholder="မြန်မာစာ ရိုက်ထည့်ပါ၊ ကူးထည့်ပါ သို့မဟုတ် .txt ဖိုင်ကို ဤနေရာတွင် ချထားပါ…"
            spellcheck="false"
            aria-label="မြန်မာစာသား ထည့်ရန်"
            ondragenter={onDragEnter}
            ondragleave={onDragLeave}
            ondragover={onDragOver}
            ondrop={onDrop}
          ></textarea>
          {#if countPopup && phase === "edit"}
            <div class="count-pop" role="status">
              {input.length.toLocaleString("en-US")} လုံး · ≈{estRequests || 1} request
            </div>
          {/if}
        </div>
        {#if phase === "edit"}
          <div class="bar">
            <span
              class="count"
              class:warn={overQuota}
              title={overQuota
                ? `ရွေးထားသော model ၏ နေ့စဉ်အခမဲ့ quota (${modelQuota}) ထက် ပိုနိုင်သည် — အခြား model သို့ ပြောင်းကြည့်ပါ`
                : modelQuota !== null
                  ? `≈ ${estRequests} request — ${modelQuota}/day free on this model`
                  : `≈ ${estRequests} request — paid per token on OpenRouter`}
            >
              {input.length.toLocaleString("en-US")} လုံး · ≈{estRequests} request
            </span>
            <div class="chunkpick">
              <select
                onchange={(e) => (chunk = Number(e.currentTarget.value))}
                title="request တစ်ခုအတွက် ပို့မည့် စာမျက်နှာအရေအတွက် (စာမျက်နှာ တစ်မျက်နှာကို စာလုံးရေ ၂၀၀၀ ခန့်)"
                aria-label="တစ် request စာ အရွယ်အစား — chunk size per request"
              >
                {#each CHUNK_STEPS as s (s.size)}
                  <option value={s.size} selected={chunk === s.size}>{s.label} — {s.pages} မျက်နှာခန့်</option>
                {/each}
              </select>
              <button
                class="chunkinfo"
                onclick={() => (chunkNote = !chunkNote)}
                title="ဘာလဲ — what does this mean?"
                aria-label="chunk အရွယ်အစား ရှင်းလင်းချက် — chunk size explanation"
                aria-expanded={chunkNote}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </button>
              {#if chunkNote}
                <div class="chunk-note" role="note">
                  <b>request တစ်ခုအတွက် ပို့မည့် စာမျက်နှာအရေအတွက်</b>
                  (စာမျက်နှာ တစ်မျက်နှာကို စာလုံးရေ ၂၀၀၀ ခန့်)
                  စာမျက်နှာနည်းနည်းချင်းစီ request ပို့က request ပိုကုန်သော်လည်း
                  စာလုံးပေါင်း အမှား ပြင်ဆင်နိုင်စွမ်း ပိုကောင်းသည်။
                  စာမျက်နှာများများသုံးပြီး request ပို့က request ချွေတာနိုင်သော်လည်း
                  အမှားပြင်ဆင်နိုင်စွမ်း လျော့နိုင်သည်။ ချင့်ချိန်၍ သုံးပါ။
                </div>
              {/if}
            </div>
            {#if overQuota}
              <span
                class="badge warn"
                title={`ရွေးထားသော model ၏ နေ့စဉ်အခမဲ့ quota (${modelQuota}) ထက် ပိုနိုင်သည် — အခြား model သို့ ပြောင်းကြည့်ပါ`}
              >
                quota ပိုနိုင်သည်
              </span>
            {/if}
            <input
              type="file"
              accept={FILE_ACCEPT}
              hidden
              onchange={onPickFile}
              bind:this={fileInput}
            />
            <button
              class="btn"
              onclick={() => fileInput?.click()}
              title="Open a plain-text file (.txt)"
            >
              <span class="mm">ဖိုင်ဖွင့်မည်</span>
            </button>
            <button class="btn" onclick={() => { input = SAMPLE; }} title="Load sample text">
              <span class="mm">နမူနာ</span>
            </button>
            <button
              class="btn"
              onclick={() => (input = "")}
              disabled={input.length === 0}
              title="Clear the editor"
            >
              <span class="mm">ရှင်းမည်</span>
            </button>
            <span class="grow"></span>
            <button
              class="btn primary"
              onclick={runFix}
              disabled={!canFix}
              title={!apiKey.trim()
                ? "API key ထည့်ပြီးမှ စတင်နိုင်သည် — add your API key first"
                : "Ctrl/⌘ + Enter"}
            >
              <span class="mm">စာလုံးပြင်မည်</span>
            </button>
          </div>
        {/if}
      </div>
    {:else if phase === "suggest"}
      <div class="card">
        <div class="result-head">
          <div class="stats">
            {#if suggestions.length === 0}
              <span class="nochange">
                ✓ အမှားမတွေ့ပါ — စာလုံးအားလုံး မှန်ကန်ပါသည်
              </span>
            {:else}
              ထောက်ခံချက် <b>{suggestions.length}</b> ခု · ရွေးထားသည်
              <b>{checkedRows.length}</b> ခု
            {/if}
            {#if partial > 0}
              <span class="badge warn" title={`${partial} ပိုင်း စစ်ဆေး၍ မရပါ — မူလစာသားအတိုင်း ထားခဲ့သည်`}>
                {partial} ပိုင်း ကျန်
              </span>
            {/if}
            <span class="ms">{fmtMs(elapsed)}</span>
          </div>
          {#if suggestions.length > 0}
            <button class="btn" onclick={toggleAllSuggestions}>
              <span class="mm">အားလုံး ရွေး / ဖျက်</span>
            </button>
          {/if}
        </div>

        {#if suggestions.length > 0}
          <div class="panels">
            <section class="panel" aria-label="မူရင်းစာသား">
              <h3 class="panel-label">မူရင်းစာသား</h3>
              <!-- single line, like the diff <pre>: newlines inside <pre> render -->
              <pre class="panel-text">{#each textSegs as seg, i (i)}{#if seg.type === "plain"}{seg.text}{:else}<span class="flag {seg.type}" class:cur={seg.cur === true}>{seg.text}</span>{/if}{/each}</pre>
            </section>
            <section class="panel" aria-label="ပြင်ရန်စာလုံးများ">
              <h3 class="panel-label">ပြင်ရန်စာလုံးများ</h3>
              <ul class="suglist">
                {#each suggestions as s, i (i)}
                  <!-- no li-level click: the words are a <label> for the
                       checkbox (toggle + move cursor), keeping the row
                       keyboard-accessible through the checkbox itself -->
                  <li
                    class="sug"
                    class:dim={!s.found}
                    class:cursor={i === cursor}
                  >
                    <input
                      type="checkbox"
                      id="sug-{i}"
                      checked={s.checked}
                      disabled={!s.found}
                      onchange={() => {
                        cursor = i;
                        s.checked = !s.checked;
                      }}
                    />
                    <label class="sugwords" for="sug-{i}">
                      <span class="del">{s.wrong}</span>
                      <span class="arrow" aria-hidden="true">→</span>
                      <span class="add">{s.correct}</span>
                    </label>
                    {#if !s.found}
                      <span class="badge warn" title="ဤစာလုံး မူလစာသားတွင် မတွေ့ပါ — hallucination ဖြစ်နိုင်သည်">
                        မတွေ့ပါ
                      </span>
                    {:else if s.count > 1}
                      <span class="badge" title="ဤစာလုံး {s.count} နေရာတွင် ရှိသည်">×{s.count}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          </div>
          <div class="bar">
            <button class="btn primary" onclick={applySuggestions} disabled={checkedRows.length === 0}>
              <span class="mm">ရွေးထားသည်များ ပြင်ဆင်မည်</span>
            </button>
            <span class="hint">↑↓ · Space · Enter · Esc</span>
            <span class="grow"></span>
            <button class="btn" onclick={backToEdit}>
              <span class="mm">နောက်သို့</span>
            </button>
          </div>
        {:else}
          <div class="bar">
            <span class="grow"></span>
            <button class="btn" onclick={backToEdit}>
              <span class="mm">နောက်သို့</span>
            </button>
          </div>
        {/if}
      </div>
    {:else if phase === "review" && result !== null}
      <div class="card">
        <div class="result-head">
          <div class="stats">
            {#if editCount === 0}
              <span class="nochange">
                ✓ အမှားမတွေ့ပါ — စာလုံးအားလုံး မှန်ကန်ပါသည်
              </span>
            {:else}
              ပြင်ဆင်ချက် <b>{editCount}</b> ခု
            {/if}
            {#if partial > 0}
              <span class="badge warn" title={`${partial} ပိုင်း စစ်ဆေး၍ မရပါ — မူလစာသားအတိုင်း ထားခဲ့သည် (failed chunks kept their original text)`}>
                {partial} ပိုင်း ကျန်
              </span>
            {/if}
            <span class="ms">{fmtMs(elapsed)}</span>
          </div>
          <div class="tabs" role="tablist" tabindex="-1" onkeydown={onTablistKey}>
            <button
              class:active={view === "diff"}
              onclick={() => (view = "diff")}
              role="tab"
              id="tab-diff"
              aria-controls="result-panel"
              aria-selected={view === "diff"}
              tabindex={view === "diff" ? 0 : -1}
            >
              ကွာခြားချက်
            </button>
            <button
              class:active={view === "clean"}
              onclick={() => (view = "clean")}
              role="tab"
              id="tab-clean"
              aria-controls="result-panel"
              aria-selected={view === "clean"}
              tabindex={view === "clean" ? 0 : -1}
            >
              စာသား
            </button>
          </div>
        </div>

        <!-- The each/if must stay on one line: inside <pre>, Svelte preserves
             whitespace, so any formatting newline would render as a gap. -->
        <div
          class="panelwrap"
          id="result-panel"
          role="tabpanel"
          aria-labelledby={view === "diff" ? "tab-diff" : "tab-clean"}
        ><!--
          --><pre class="out">{#if view === "diff"}{#each diffSegs as seg, i (i)}{#if seg.type === "same"}{seg.text}{:else if seg.type === "del"}<span class="del">{seg.text}</span>{:else}<span class="add">{seg.text}</span>{/if}{/each}{:else}{result}{/if}</pre>
        </div>

        <div class="bar">
          <button class="btn primary" onclick={copyResult}>
            <span class="mm">ကူးယူမည်</span>
          </button>
          <button class="btn" onclick={exportResult} title="ချိန်းပြီးသည့် စာသားကို .txt ဖိုင်အဖြစ် သိမ်းမည် — Export as .txt">
            <span class="mm">ဖိုင်သိမ်းမည်</span>
          </button>
          <button class="btn" onclick={fixAgain} title="Run another pass on the corrected text">
            <span class="mm">ထပ်စစ်မည်</span>
          </button>
          <span class="grow"></span>
          <button class="btn" onclick={backToEdit}>
            <span class="mm">နောက်သို့</span>
          </button>
        </div>
      </div>
    {/if}
  </main>

  <footer>
    Gemini ဖြင့် လည်ပတ်ပြီး Cloudflare တွင် host ပြုထားသည် ·
    သင့် API key နှင့် စာသားသည် သင့် browser မှ ရွေးထားသော provider
    (Google AI Studio / OpenRouter) သို့သာ သွားပါသည် —
    မည်သည့်ဆာဗာတွင်မှ သိမ်းဆည်းခြင်း မပြုပါ။
    <a
      class="gh"
      href="https://github.com/pndaza/myan-spell-fix"
      target="_blank"
      rel="noreferrer"
      title="GitHub repository"
      aria-label="GitHub repository"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span>GitHub</span>
    </a>
  </footer>
</div>

<div class="toast" class:show={toast !== null} role="status" aria-live="polite">
  {toast ?? ""}
</div>
