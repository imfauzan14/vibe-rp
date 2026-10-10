// Theme control for both surfaces.
//
// Contract
//   - The theme is the `data-theme` attribute on <html>. `"marginalia"` is the
//     dark default and is expressed by *removing* the attribute; `"paper"` sets
//     `data-theme="paper"`. tokens.css owns every colour behind those hooks.
//   - The choice persists in localStorage under `vibe_rp_theme` and defaults to
//     the operating system preference when nothing is stored.
//   - Nothing here touches the DOM beyond documentElement, so the chat page can
//     import it unchanged.
//
// Exports
//   THEMES             the two valid theme names, dark first
//   THEME_STORAGE_KEY  the localStorage key (also read by the pre-paint script)
//   resolveSystemTheme() the OS preference as a theme name
//   getTheme()         the stored choice, else the OS preference
//   setTheme(name)     persist + apply + notify
//   toggleTheme()      swap to the other theme, returns the new name
//   initTheme()        apply the resolved theme now (idempotent)
//   onThemeChange(fn)  subscribe, returns an unsubscribe function

export const THEMES = ["marginalia", "paper"];

export const THEME_STORAGE_KEY = "vibe_rp_theme";

const PAPER_QUERY = "(prefers-color-scheme: light)";
const listeners = new Set();

/** True when `value` is one of the two theme names. */
export function isTheme(value) {
  return THEMES.includes(value);
}

/** The operating system preference as a theme name. Never throws. */
export function resolveSystemTheme() {
  try {
    return window.matchMedia?.(PAPER_QUERY)?.matches ? "paper" : "marginalia";
  } catch (_) {
    return "marginalia";
  }
}

/** The persisted choice when it is valid, otherwise the OS preference. */
export function getTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch (_) {
    /* storage blocked: fall through to the system preference */
  }
  return resolveSystemTheme();
}

/**
 * Applies a theme without persisting it. `"marginalia"` removes the attribute
 * so the `:root` token set in tokens.css takes over.
 */
export function applyTheme(name) {
  const theme = isTheme(name) ? name : "marginalia";
  const root = document.documentElement;
  if (theme === "marginalia") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  for (const fn of listeners) {
    try {
      fn(theme);
    } catch (_) {
      /* a broken subscriber must not stop the others */
    }
  }
  return theme;
}

/** Persists and applies a theme. Returns the name actually applied. */
export function setTheme(name) {
  const theme = isTheme(name) ? name : resolveSystemTheme();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {
    /* private mode: the theme still applies for this session */
  }
  return applyTheme(theme);
}

/** Swaps to the other theme and returns the new name. */
export function toggleTheme() {
  return setTheme(getTheme() === "paper" ? "marginalia" : "paper");
}

/** Applies the resolved theme. Safe to call more than once. */
export function initTheme() {
  return applyTheme(getTheme());
}

/** Subscribes to theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
