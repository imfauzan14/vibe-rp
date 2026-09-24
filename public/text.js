// Pure text utilities shared by the engine, the formatter, and the importers.
// Deliberately a leaf module: no imports, so everyone can depend on it and
// nothing can form an import cycle through it.
//
// Exports
//   utf8Decoder               the one shared UTF-8 TextDecoder instance
//   substitutePlaceholders     resolves {{user}}/{{char}} aliases
//   stripThoughtBlocks         removes reasoning/scratchpad blocks

/** Every byte-to-text path decodes UTF-8 the same way; one instance, reused. */
export const utf8Decoder = new TextDecoder();

/**
 * Resolves card placeholders in user-facing text. Pure: the result depends only
 * on the text and the two names, so it stays byte-stable for a given session.
 * Supports `{{user}}`/`{{char}}` case-insensitively plus the common
 * `{{user_name}}`/`{{UserName}}`/`{{char_name}}` aliases. Unknown placeholders
 * (`{{random}}`, `{{time}}`) and a placeholder with no replacement available are
 * left as literal text rather than deleted.
 */
export function substitutePlaceholders(text, { user, char } = {}) {
  if (!text) return "";
  let s = String(text);
  if (user) s = s.replace(/(?:\{\{|\{|<)\s*user(?:_?name)?\s*(?:\}\}|\}|>)/gi, () => user);
  if (char) s = s.replace(/(?:\{\{|\{|<)\s*(?:char|bot)(?:_?name)?\s*(?:\}\}|\}|>)/gi, () => char);
  return s;
}

/**
 * Strips internal thought/reasoning scratchpad blocks (`<thought>`, the
 * reasoning fence, and `<reasoning>`) from text, including an unclosed
 * trailing block. Reasoning models emit internal reasoning traces that are
 * irrelevant to Choice Mode, the visible feed, and subsequent turns.
 */
export function stripThoughtBlocks(text) {
  if (typeof text !== "string") return "";
  let clean = text.replace(/<(thought|think|reasoning)[^>]*>[\s\S]*?<\/\1>/gi, "");
  clean = clean.replace(/<(thought|think|reasoning)[^>]*>[\s\S]*$/gi,  "");
  return clean.trim();
}
