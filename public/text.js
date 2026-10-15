// public/text.js
// Leaf module (zero imports) for placeholder substitution, delimiter neutralization,
// thought-block stripping, and multi-script impersonation pruning.

export const utf8Decoder = new TextDecoder();

/**
 * Replaces {{user}}, {{char}}, {{User}}, {{Char}}, ${user},${char}, <user>, <char>
 * placeholders safely without recursive re-expansion when replacement values contain braces.
 */
export function substitutePlaceholders(
  text,
  { user = "", char = "", playerName = "", charName = "" } = {}
) {
  if (text === null || text === undefined) return "";
  if (typeof text !== "string") return "";
  const u = renderInlineField(user || playerName, 120);
  const c = renderInlineField(char || charName, 120);

  return text.replace(
    /\{\{\s*(user|char)\s*\}\}|\$\{\s*(user|char)\s*\}|<\s*(user|char)\s*>/gi,
    (match, g1, g2, g3) => {
      const key = String(g1 || g2 || g3 || "").toLowerCase();
      if (key === "user") return u || "{{user}}";
      if (key === "char") return c || "{{char}}";
      return match;
    }
  );
}

/**
 * Strips reasoning / chain-of-thought blocks (<think>...</think>, <thought>...</thought>,
 * <reasoning>...</reasoning>) including unclosed trailing blocks during streaming.
 */
export function stripThoughtBlocks(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(
      /<\s*(?:think|thought|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think|thought|reasoning)\s*>/gi,
      ""
    )
    .replace(/<\s*(?:think|thought|reasoning)\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

/**
 * Renders scalar strings/numbers safely for inline prompt headers while rejecting
 * objects, arrays, NaN, null, undefined, and control characters.
 */
export function renderInlineField(value, maxChars = 80) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(value).slice(0, Math.max(1, maxChars));
  }
  if (typeof value !== "string") return "";

  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) return "";
  const cap = Math.max(1, Number(maxChars) || 80);
  return cleaned.length > cap ? cleaned.slice(0, cap).trim() : cleaned;
}

/**
 * Neutralizes structural markdown/XML/bracket delimiters inside user-supplied names
 * or inline fields so untrusted persona/card names cannot inject new prompt sections.
 */
export function neutralizeDelimiters(value, maxChars = 80) {
  const inline = renderInlineField(value, maxChars * 2);
  if (!inline) return "";
  const sanitized = inline
    .replace(/#{2,}/g, "")
    .replace(/[\[\]<>]/g, "")
    .replace(/\{\{|\}\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const cap = Math.max(1, Number(maxChars) || 80);
  return sanitized.length > cap ? sanitized.slice(0, cap).trim() : sanitized;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the index in `text` where the model begins impersonating the player (`user`),
 * returning -1 if no impersonation boundary is found.
 */
export function findImpersonationBoundary(text, { user = "", playerName = "" } = {}) {
  if (!text || typeof text !== "string") return -1;
  const u = renderInlineField(user || playerName, 80);
  if (!u) return -1;

  const escaped = escapeRegExp(u);
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:\\[?${escaped}\\]?)\\s*[:\\uFF1A\\u2014—]\\s*\\S`, "m"),
    new RegExp(
      `\\n\\s*\\n\\s*${escaped}\\s+(?:says|said|asks|asked|replies|replied|thinks|thought|steps|stepped|turns|turned|smiles|smiled|nods|nodded)\\b`,
      "i"
    ),
  ];

  let earliest = -1;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m.index > 0) {
      if (earliest === -1 || m.index < earliest) {
        earliest = m.index;
      }
    }
  }
  return earliest;
}

export function pruneImpersonation(text, options = {}) {
  if (!text || typeof text !== "string") return "";
  const idx = findImpersonationBoundary(text, options);
  if (idx <= 0) return text;
  return text.slice(0, idx).trimEnd();
}

export const REFUSAL_RE =
  /^(?:I(?:'m|\s+am)\s+sorry,\s+but\s+I\s+can(?:'t|not)|I\s+cannot\s+fulfill\s+this\s+request|As\s+an\s+AI(?:\s+language\s+model)?,\s+I\s+(?:can't|cannot|am\s+unable)|I\s+am\s+unable\s+to\s+(?:generate|continue|write))/i;

export function looksLikeModelRefusal(text) {
  if (!text || typeof text !== "string") return false;
  const cleaned = stripThoughtBlocks(text).trim();
  if (!cleaned || cleaned.length > 450) return false;
  return REFUSAL_RE.test(cleaned);
}
