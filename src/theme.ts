//! Theme helpers. The user's *preference* is one of `"light" | "dark" |
//! "system"` — `"system"` defers to the OS via `prefers-color-scheme` and is
//! tracked live (the app re-resolves if the OS theme changes at runtime).
//!
//! The CSS only knows `[data-theme="light"]` vs the `:root` (dark)
//! defaults, so `"system"` is always resolved to a concrete value before
//! writing to the DOM. An inline script in index.html mirrors this
//! resolution before paint to avoid a flash.
//!
//! Adapted from just-ocr's theme module (pndaza).

const KEY = "myan-spell-fix:theme";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function resolveTheme(t: Theme): ResolvedTheme {
  return t === "system" ? systemTheme() : t;
}

/** The stored preference; `"system"` when nothing valid is persisted. */
export function currentTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
  return "system";
}

/** Persist a preference and apply its resolved value to the document. */
export function setTheme(t: Theme): Theme {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = resolveTheme(t);
  return t;
}

/** Cycle light → dark → system → light (the toggle's order). */
export function nextTheme(t: Theme): Theme {
  return t === "light" ? "dark" : t === "dark" ? "system" : "light";
}
