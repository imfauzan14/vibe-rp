// Canonical HTML escaping helpers. One module, one rule: escape every character
// that can terminate an attribute or open a tag. The page-local `escapeHtml`
// copies that previously lived in the HTML entry points escaped only `& < >`
// and were the root cause of a stored XSS (a quote in a card field could close
// an attribute and inject an event handler). Import these instead of copying.

const ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_RE = /[&<>"']/g;

function escape(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(ESCAPE_RE, (c) => ENTITIES[c]);
}

/**
 * Escapes text for HTML content position (`<p>${escapeHtml(x)}</p>`).
 * Escapes `& < > " '` — all five, so it is also safe inside quoted attributes.
 */
export function escapeHtml(value) {
  return escape(value);
}

/**
 * Escapes text for a quoted attribute position (`<img src="${escapeAttr(x)}">`).
 * Identical policy to `escapeHtml`; kept as a distinct name so call sites
 * document their intent and a future hardening pass has one place to change.
 */
export function escapeAttr(value) {
  return escape(value);
}
