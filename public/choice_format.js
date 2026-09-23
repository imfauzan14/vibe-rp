// Choice Mode: the choice-generation instruction and its resilient parser.
//
// Pure and dependency-free. No DOM, no network, no engine import: this module
// answers exactly two questions, "what do we ask the model for?" and "what did
// the model actually give us?". Keeping the parser here means the untrusted
// model output is normalised in one testable place, before any UI code sees it.
//
// Choice Mode changes how the reader picks the next turn. It never changes how
// the conversation is stored: a selected choice is an ordinary user message.

// A choice is one line the reader can scan. Beyond this it stops being a menu
// item and becomes a paragraph, so the parser rejects rather than truncates.
export const CHOICE_TEXT_MAX_CHARS = 160;
export const CHOICE_TEXT_MIN_CHARS = 2;
export const CHOICE_COUNT_MIN = 3;
export const CHOICE_COUNT_MAX = 5;
export const CHOICE_COUNT_DEFAULT = 4;

// Control, zero-width and bidi-override characters. They render as nothing, so
// they can hide text from a reader while the model still "sees" it, and bidi
// overrides can reverse the displayed order of a choice. Stripped, not escaped:
// a choice has no legitimate use for them.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// A leading list marker the model may add despite being told not to: "- ", "* ",
// "1. ", "1) ", "[1] ", "(1) ", "• ". The bracketed and punctuated forms are
// separate alternatives so "2 apples" is left alone (no bare-number marker).
const LEADING_MARKER_RE = /^\s*(?:[-*\u2022\u2013\u2014]|\[\d{1,2}\]|\(\d{1,2}\)|\d{1,2}[.)])\s+/;
const WRAPPING_QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

export const CHOICE_SYSTEM_PROMPT =
  "You propose the next moves available to the player in an ongoing roleplay scene.\n\n" +
  "The player is the human. You write ONLY the menu of actions they may take next. " +
  "You are not the narrator here and you are not the character.\n\n" +
  "Rules:\n" +
  "- Write each choice as something the player can do or say in the next beat.\n" +
  "- Never speak, act, think, or decide for the player, and never narrate the result of a choice.\n" +
  "- Do not continue the story, and do not write the character's reply.\n" +
  "- Never reveal, hint at, or promise what will happen. A choice states the attempt, never the outcome.\n" +
  "- Use only what the player already knows. Never invent secret knowledge, off-screen facts, or hidden items.\n" +
  "- Make the choices genuinely different in approach, intent, emotional stance, or risk. " +
  "Never offer the same action in different words.\n" +
  "- Preserve the established situation, tone, and register.\n" +
  "- Return ONLY the JSON described below, with no commentary, no code fences, and no extra text.";

/**
 * The task line for one choice request. The target count is interpolated rather
 * than left as a placeholder token, so nothing in the prompt can be mistaken for
 * a card placeholder (`{{char}}` / `{{user}}`) and rewritten by substitution.
 */
export function choicePrompt(count = CHOICE_COUNT_DEFAULT, { charName = "the character", playerName = "the player" } = {}) {
  const target = Math.max(CHOICE_COUNT_MIN, Math.min(CHOICE_COUNT_MAX, Math.floor(Number(count) || CHOICE_COUNT_DEFAULT)));
  return (
    `Propose the next moves for ${playerName} in the scene above, opposite ${charName}.\n\n` +
    "Return exactly one JSON object and nothing else, in this shape:\n" +
    '{"choices":[{"text":"..."},{"text":"..."}]}\n\n' +
    `Provide ${target} choices. Each "text" is a single short line under ` +
    `${CHOICE_TEXT_MAX_CHARS} characters, phrased as ${playerName}'s own action or line of dialogue.`
  );
}

/** Collapses one model-supplied string into a single clean menu line. */
export function normalizeChoiceText(value) {
  if (value === null || value === undefined) return "";
  let text = String(value).replace(INVISIBLE_RE, "");
  // A choice is one line: any newline, tab or run of whitespace becomes a space.
  text = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  text = text.replace(LEADING_MARKER_RE, "").trim();
  // A model sometimes wraps the whole line in quotes; the quotes are the
  // model's punctuation, not part of the action.
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length);
      break;
    }
  }
  return text.trim();
}

/** Word-boundary clamp. Only used when a whole set would otherwise be lost. */
function clampText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf(","), slice.lastIndexOf(";"));
  const kept = boundary > maxChars * 0.6 ? slice.slice(0, boundary) : slice;
  return kept.replace(/[\s,;:]+$/, "").trim();
}

/** Case- and punctuation-insensitive identity, so near-duplicates collapse. */
function dedupeKey(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * Returns the first balanced JSON object or array in `text`, respecting string
 * literals and escapes so a brace inside a quoted choice cannot close it early.
 * Returns null when there is no complete slice.
 */
function firstJsonSlice(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pulls the text of one parsed entry, whatever shape the model chose. */
function entryText(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return entry.text ?? entry.label ?? entry.choice ?? entry.action ?? entry.value ?? "";
}

/**
 * Candidate choice strings from a raw model reply. Tries JSON first (the
 * instructed shape), then falls back to a line list, because a model that
 * ignores the JSON instruction still usually returns a usable menu.
 */
function extractItems(raw) {
  const slice = firstJsonSlice(raw);
  if (slice) {
    let parsed = null;
    try {
      parsed = JSON.parse(slice);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.choices) ? parsed.choices : null;
      if (list) return list.map(entryText);
    }
  }
  // Fallback: one candidate per non-empty line, fences and headings skipped.
  // Only used when it yields an actual list: a single line is far more likely
  // to be prose or an error message than a menu of one, and a one-item menu is
  // not a choice anyway.
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line) && !/^[a-zA-Z ]{0,20}:$/.test(line))
    .map((line) => line.replace(LEADING_MARKER_RE, "").trim())
    .filter(Boolean);
  return lines.length >= 2 ? lines : [];
}

/**
 * Validates and normalises a raw model reply into the choice list.
 *
 * Returns `{ choices: [{ id, text }] }`. The list may be empty: a reply with no
 * usable choice is a normal outcome the caller reports, never a crash. Every
 * `text` is a plain string that the UI renders as a text node, so nothing here
 * can become markup.
 */
export function parseChoices(raw, { max = CHOICE_COUNT_MAX, maxChars = CHOICE_TEXT_MAX_CHARS } = {}) {
  const seen = new Set();
  const unique = [];
  for (const item of extractItems(typeof raw === "string" ? raw : String(raw ?? ""))) {
    const text = normalizeChoiceText(item);
    if (text.length < CHOICE_TEXT_MIN_CHARS) continue;
    const key = dedupeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }

  // Prefer choices that already fit. Only when that would leave a useless menu
  // (fewer than two) do we clamp, so a verbose model degrades instead of failing.
  const withinLimit = unique.filter((text) => text.length <= maxChars);
  let chosen = withinLimit.length >= 2 ? withinLimit : unique.map((text) => clampText(text, maxChars));

  // Clamping can collapse two entries onto the same string; dedupe once more.
  const finalSeen = new Set();
  chosen = chosen.filter((text) => {
    const key = dedupeKey(text);
    if (!key || finalSeen.has(key)) return false;
    finalSeen.add(key);
    return true;
  });

  return { choices: chosen.slice(0, max).map((text, index) => ({ id: `c${index + 1}`, text })) };
}
