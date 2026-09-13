<script lang="ts">
  import { chunkText } from "./lib/chunk";
  import { diffWords, countEdits } from "./lib/diff";
  import { highlightText } from "./lib/highlight";
  import {
    fixText,
    suggestFixes,
    applyFixes,
    errorMessage,
    ApiError,
    MODELS,
    DEFAULT_MODEL,
    type ModelKey,
    type Suggestion,
  } from "./lib/spellfix";
  import { currentTheme, setTheme, nextTheme, resolveTheme, type Theme } from "./theme";

  /** Client-side total-input cap. Generous (≈ 7 chunked requests) while
   *  keeping one run well inside a flash-lite free-tier daily budget. */
  const MAX_INPUT = 8000;
  /** Per-request chunk size — must stay under fixText's 4000-char cap. */
  const CHUNK = 1200;

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

  function loadKey(): string {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  }

  function saveKey(key: string): string {
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* private mode — key lives for this session only */
    }
    return key;
  }

  let input = $state("");
  let model = $state<ModelKey>(loadModel());
  let mode = $state<FixMode>(loadMode());
  let apiKey = $state<string>(loadKey());
  /** Key-editing panel state: draft input + whether it's shown. Shown
   *  automatically when there's no key; reopened via the header button. */
  let keyDraft = $state("");
  let editingKey = $state(false);
  let phase = $state<Phase>("edit");
  let view = $state<View>("diff");
  let result = $state<string | null>(null);
  let suggestions = $state<SugRow[]>([]);
  /** Keyboard-cursor row in the suggest list (↑/↓). Its fragments carry
   *  the `cur` highlight in the text panel and the left indicator in the
   *  fix list. Always points at a FOUND row while one exists. */
  let cursor = $state(0);
  let error = $state<string | null>(null);
  let progress = $state({ done: 0, total: 1 });
  let elapsed = $state(0);
  let themePref = $state<Theme>(currentTheme());
  let toast = $state<string | null>(null);
  let ctrl: AbortController | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // open the key panel on first visit when no key is stored
  $effect(() => {
    if (!apiKey) {
      keyDraft = "";
      editingKey = true;
    }
  });

  const trimmed = $derived(input.trim());
  const canFix = $derived(
    phase === "edit" &&
      trimmed.length > 0 &&
      input.length <= MAX_INPUT &&
      apiKey.trim().length > 0,
  );
  const overLimit = $derived(input.length > MAX_INPUT);
  const nearLimit = $derived(input.length > MAX_INPUT * 0.9 && !overLimit);
  const diffSegs = $derived(
    result !== null ? diffWords(input, result) : [],
  );
  const editCount = $derived(countEdits(diffSegs));
  /** Original text with flagged fragments highlighted — the LEFT panel of
   *  manual mode's review. Live-updates as rows are checked/unchecked and
   *  as the keyboard cursor moves. */
  const textSegs = $derived(
    phase === "suggest"
      ? highlightText(
          input,
          suggestions.map((s, i) => ({
            wrong: s.wrong,
            checked: s.checked,
            found: s.found,
            current: i === cursor,
          })),
        )
      : [],
  );
  const progressPct = $derived(
    Math.round((progress.done / Math.max(progress.total, 1)) * 100),
  );

  function loadModel(): ModelKey {
    try {
      const v = localStorage.getItem("myan-spell-fix:model");
      if (MODELS.some((m) => m.key === v)) return v as ModelKey;
    } catch {
      /* private mode — default */
    }
    return DEFAULT_MODEL;
  }

  $effect(() => {
    try {
      localStorage.setItem("myan-spell-fix:model", model);
      localStorage.setItem("myan-spell-fix:mode", mode);
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
  // rect-delta scroll targets each scroller explicitly.
  $effect(() => {
    if (phase !== "suggest") return;
    cursor; // track
    requestAnimationFrame(() => {
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
  });

  function cycleTheme() {
    themePref = setTheme(nextTheme(themePref));
  }

  function openKeyPanel() {
    keyDraft = apiKey;
    editingKey = true;
  }

  function commitKey() {
    apiKey = saveKey(keyDraft.trim());
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
    const parts = chunkText(input, CHUNK);
    if (parts.length === 0) return;

    phase = "fixing";
    error = null;
    result = null;
    suggestions = [];
    progress = { done: 0, total: parts.length };
    ctrl = new AbortController();
    const t0 = performance.now();

    try {
      // Sequential on purpose: keeps order trivially correct, reads as
      // steady progress, and stays inside Google's free-tier RPM limits.
      if (mode === "auto") {
        const fixed: string[] = [];
        for (const part of parts) {
          const r = await fixText(apiKey.trim(), part, model, ctrl!.signal);
          fixed.push(r.corrected);
          progress = { done: progress.done + 1, total: parts.length };
        }
        result = fixed.join("");
        view = "diff";
        phase = "review";
      } else {
        const all: Suggestion[] = [];
        for (const part of parts) {
          const r = await suggestFixes(apiKey.trim(), part, model, ctrl!.signal);
          all.push(...r.fixes);
          progress = { done: progress.done + 1, total: parts.length };
        }
        suggestions = buildRows(all, input);
        cursor = Math.max(
          0,
          suggestions.findIndex((s) => s.found),
        );
        phase = "suggest";
      }
      elapsed = Math.round(performance.now() - t0);
    } catch (err) {
      // A cancel returns to the editor with whatever text was already
      // there; a real error keeps the original and explains itself. An
      // invalid key reopens the key panel so it can be fixed in place.
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
      const count = text.split(p.wrong).length - 1;
      rows.push({ ...p, count, found: count > 0, checked: count > 0 });
    }
    return rows;
  }

  const checkedRows = $derived(
    suggestions.filter((s) => s.checked && s.found),
  );

  function applySuggestions() {
    const outcome = applyFixes(input, checkedRows);
    result = outcome.text;
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

  function backToEdit() {
    phase = "edit";
    result = null;
    suggestions = [];
  }

  /** Feed the corrected text straight into another pass — users often run
   *  a second check to confirm the fix (or catch remaining issues with the
   *  other model). */
  async function fixAgain() {
    if (result === null) return;
    input = result;
    result = null;
    await runFix();
  }

  async function copyResult() {
    if (result === null) return;
    try {
      await navigator.clipboard.writeText(result);
      showToast("ကူးယူပြီးပါပြီ — Copied");
    } catch {
      showToast("ကူးယူမည် မအောင်မြင်ပါ — Copy failed");
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Suggest-phase review shortcuts: ↑/↓ move the row cursor (its
    // fragments light up in the text panel), Space toggles, Enter applies.
    if (phase === "suggest") {
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
      } else if (e.key === "Escape") {
        backToEdit();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (phase === "edit") runFix();
    } else if (e.key === "Escape") {
      if (phase === "fixing") cancel();
      else if (phase === "review") backToEdit();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <header class="top">
    <div class="brand">
      <div class="logo" aria-hidden="true">ဿ</div>
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
        bind:value={model}
        title="AI model — Gemini (Google AI Studio). Flash Lite အမြန်ဆုံး၊ Flash ပိုမှန်ကန်သည်"
        aria-label="AI model"
      >
        {#each MODELS as m (m.key)}
          <option value={m.key}>{m.label}</option>
        {/each}
      </select>
      <button
        class="btn icon"
        class:attention={!apiKey}
        onclick={openKeyPanel}
        title={apiKey ? "API key settings" : "API key ထည့်ရန် — Add your API key"}
        aria-label="API key settings"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m10.7 12.3 8.3-8.3m0 0h-4.5m4.5 0v4.5" />
        </svg>
      </button>
      <button class="btn icon" onclick={cycleTheme} title={themePref === "light" ? "Light" : themePref === "dark" ? "Dark" : "System"}>
        {#if themePref === "light"}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        {:else if themePref === "dark"}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        {:else}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
          </svg>
        {/if}
      </button>
    </div>
  </header>

  <main>
    {#if editingKey && phase === "edit"}
      <div class="card keycard">
        <label class="keylabel" for="api-key-input">
          Google AI Studio API key
          {#if apiKey}<span class="keyset">✓ သိမ်းထားပြီး — saved</span>{/if}
        </label>
        <div class="keyrow">
          <input
            id="api-key-input"
            type="password"
            bind:value={keyDraft}
            placeholder="AIza…"
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
                apiKey = saveKey("");
                keyDraft = "";
              }}
              title="Remove the stored key"
            >
              <span class="mm">ဖျက်မည်</span>
            </button>
          {/if}
          {#if apiKey}
            <button class="btn" onclick={() => (editingKey = false)} title="Close">
              ✕
            </button>
          {/if}
        </div>
        <p class="keynote">
          Key ကို သင့် browser ထဲတွင်သာ သိမ်းဆည်းပါသည် — မည်သည့်ဆာဗာသို့မှ
          မပို့ပါ။ Gemini သို့သာ တိုက်ရိုက်ချိတ်ဆက်သည်။
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            အခမဲ့ key ယူပါ — Get a free key
          </a>
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
        {#if phase === "edit"}
          <textarea
            class="editor"
            bind:value={input}
            placeholder="မြန်မာစာ ရိုက်ထည့်ပါ သို့မဟုတ် ကူးထည့်ပါ…"
            spellcheck="false"
            aria-label="မြန်မာစာသား ထည့်ရန်"
          ></textarea>
          <div class="bar">
            <span class="count" class:warn={nearLimit} class:over={overLimit}>
              {input.length} / {MAX_INPUT}
            </span>
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
              title="Ctrl/⌘ + Enter"
            >
              <span class="mm">စာလုံးပြင်မည်</span>
            </button>
          </div>
        {:else}
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
            <div class="progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <i style="width: {progressPct}%"></i>
            </div>
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
            <span class="ms">{elapsed} ms</span>
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
                  <li
                    class="sug"
                    class:dim={!s.found}
                    class:cursor={i === cursor}
                    onclick={() => (cursor = i)}
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
            <span class="ms">{elapsed} ms</span>
          </div>
          <div class="tabs" role="tablist">
            <button
              class:active={view === "diff"}
              onclick={() => (view = "diff")}
              role="tab"
              aria-selected={view === "diff"}
            >
              ကွာခြားချက်
            </button>
            <button
              class:active={view === "clean"}
              onclick={() => (view = "clean")}
              role="tab"
              aria-selected={view === "clean"}
            >
              စာသား
            </button>
          </div>
        </div>

        <!-- The each/if must stay on one line: inside <pre>, Svelte preserves
             whitespace, so any formatting newline would render as a gap. -->
        <pre class="out">{#if view === "diff"}{#each diffSegs as seg, i (i)}{#if seg.type === "same"}{seg.text}{:else if seg.type === "del"}<span class="del">{seg.text}</span>{:else}<span class="add">{seg.text}</span>{/if}{/each}{:else}{result}{/if}</pre>

        <div class="bar">
          <button class="btn primary" onclick={copyResult}>
            <span class="mm">ကူးယူမည်</span>
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
    Gemini (Google AI Studio) ဖြင့် လည်ပတ်ပြီး Cloudflare တွင် host ပြုထားသည် ·
    သင့် API key နှင့် စာသားသည် သင့် browser မှ Google သို့သာ သွားပါသည် —
    မည်သည့်ဆာဗာတွင်မှ သိမ်းဆည်းခြင်း မပြုပါ။
  </footer>
</div>

<div class="toast" class:show={toast !== null} role="status" aria-live="polite">
  {toast ?? ""}
</div>
