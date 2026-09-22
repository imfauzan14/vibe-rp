// Pre-paint theme boot.
//
// Applied before first paint so there is no flash of the wrong ground. Kept as
// a separate same-origin file (not an inline block) so the CSP needs no script
// hash for it: the hash only covered the exact bytes of the inline element and
// had to be regenerated on every edit. Loaded as a classic, blocking script in
// the document head, so it still runs before the first paint.
//
// Mirrors ui/theme.js: "paper" sets the attribute, and the dark default removes
// it. The storage key is the same one ui/theme.js reads (THEME_STORAGE_KEY).
(function () {
  try {
    var stored = localStorage.getItem("vibe_rp_theme");
    var theme = stored === "paper" || stored === "marginalia"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "marginalia");
    if (theme === "paper") document.documentElement.setAttribute("data-theme", "paper");
  } catch (e) { /* storage blocked: keep the dark default */ }
})();
