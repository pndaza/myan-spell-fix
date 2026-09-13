<script lang="ts">
  import { chunkText } from "./lib/chunk";
  import { diffWords, countEdits } from "./lib/diff";
  import {
    fixText,
    errorMessage,
    ApiError,
    MODELS,
    DEFAULT_MODEL,
    type ModelKey,
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

  type Phase = "edit" | "fixing" | "review";
  type View = "diff" | "clean";

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
  let apiKey = $state<string>(loadKey());
  /** Key-editing panel state: draft input + whether it's shown. Shown
   *  automatically when there's no key; reopened via the header button. */
  let keyDraft = $state("");
  let editingKey = $state(false);
  let phase = $state<Phase>("edit");
  let view = $state<View>("diff");
  let result = $state<string | null>(null);
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
    progress = { done: 0, total: parts.length };
    ctrl = new AbortController();
    const fixed: string[] = [];
    const t0 = performance.now();

    try {
      // Sequential on purpose: keeps order trivially correct, reads as
      // steady progress, and stays inside Google's free-tier RPM limits.
      for (const part of parts) {
        const r = await fixText(apiKey.trim(), part, model, ctrl!.signal);
        fixed.push(r.corrected);
        progress = { done: progress.done + 1, total: parts.length };
      }
      result = fixed.join("");
      elapsed = Math.round(performance.now() - t0);
      view = "diff";
      phase = "review";
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

  function cancel() {
    ctrl?.abort();
  }

  function backToEdit() {
    phase = "edit";
    result = null;
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
