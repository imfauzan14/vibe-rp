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
export const CHOICE_LABEL_MAX_CHARS = 60;
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
  "You generate the next moves available to the player in an ongoing roleplay scene.\n\n" +
  "You write exclusively from the player's perspective, proposing a menu of distinct actions they may take next.\n\n" +
  "Core Process & Adaptive Principles:\n" +
  "- Persona & Narrative Perspective: Deeply align choices with the User Persona (background, traits, worldview, flaws, and voice). Match the player's established narrative point of view (1st person 'I' vs 3rd person) and speech cadence. If the persona specifies anxiety, hesitation, timidity, awkwardness, or specific insecurities, choices MUST realistically embody those emotional barriers and speech quirks (e.g., nervous pauses, averted eyes, awkward hesitation, or second-guessing). Never make the player artificially confident, fearless, or articulate when their persona dictates otherwise.\n" +
  "- Language Lock & Register Adaptation: The User Persona, System Directives, and ongoing player dialogue are the active operational authority. If the imported character preset or scene context is in a different language than the user persona or dialogue, you MUST generate all choices strictly in the player's active language, dialect, and register. Never default to the preset's source language or drift into an unrequested language.\n" +
  "- Dramatic Variety: Offer genuinely distinct dramatic archetypes across the choices, always filtered through the player's persona and psychological state:\n" +
  "  1. Direct / Assertive (stepping forward or speaking up, expressed through the player's authentic confidence or nervousness)\n" +
  "  2. Inquisitive / Diplomatic (probing questions or conversation, shaped by the player's true speech habits)\n" +
  "  3. Cautious / Observant (tactical awareness, guarded retreat, hesitant pause, or keeping safe distance)\n" +
  "  4. Unconventional / Intuitive (creative alternative, emotional vulnerability, awkward attempt, or unexpected pivot)\n" +
  "- Scene Beats & Physical Grounding: Ground choices in concrete physical actions, posture, movement, and sensory details rather than disembodied dialogue. Weave gestures, expressions, or physical beats with spoken words to drive scene momentum.\n" +
  "- Subtext over Exposition: Prioritize subtext, tension, and unsaid motives over literal explanations. Avoid on-the-nose exposition and polite conversational filler.\n" +
  "- Anti-Echo Rule: Never echo, mirror, or repeat the other character's previous words. Every choice must respond with fresh momentum and an asymmetric viewpoint.\n" +
  "- Strict Agency: Express each choice strictly as what the player says or attempts in the immediate beat. Never godmode character reactions, never dictate other characters' thoughts or answers, and never narrate future outcomes.\n" +
  "- Information Boundary: Restrict choices to what the player already perceives in the current scene; never invent off-screen facts.\n" +
  "- Register & Tone: Preserve the established atmospheric tone, genre boundaries, and scene tension.\n" +
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
    "Adaptive Guidance:\n" +
    `- Embody ${playerName}'s persona, speech habits, and narrative perspective. Reflect their psychological traits, insecurities, or awkwardness rather than making them artificially confident.\n` +
    "- Seamlessly match the active language, dialect, and tone established in the scene and directives.\n" +
    `- Operational Precedence: If the character preset was created in a different language, override it to match ${playerName}'s active language, persona, and directives.\n` +
    "- Propel the scene with physically grounded actions and distinct dramatic intentions.\n\n" +
    "Return exactly one JSON object and nothing else, in this shape:\n" +
    '{"choices":[{"label":"Short main point","text":"Full roleplay dialogue or action."}]}\n\n' +
    `Provide ${target} choices. For each choice:\n` +
    `- "label": A brief, punchy summary of the intent or main point (3 to 6 words, under ${CHOICE_LABEL_MAX_CHARS} characters) displayed in the menu, in ${playerName}'s active language.\n` +
    `- "text": The complete, immersive roleplay action or spoken dialogue to send when chosen (under ${CHOICE_TEXT_MAX_CHARS} characters), in ${playerName}'s active language.\n` +
    `Phrased from ${playerName}'s perspective.`
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

function entryItem(entry) {
  if (typeof entry === "string") return { text: entry };
  if (!entry || typeof entry !== "object") return null;
  const hasText = entry.text !== undefined || entry.action !== undefined || entry.detail !== undefined || entry.value !== undefined || entry.choice !== undefined;
  const rawText = hasText
    ? (entry.text ?? entry.action ?? entry.detail ?? entry.value ?? entry.choice ?? "")
    : (entry.label ?? entry.title ?? entry.summary ?? entry.tldr ?? "");
  const rawLabel = hasText ? (entry.label ?? entry.title ?? entry.summary ?? entry.tldr ?? "") : "";
  const text = typeof rawText === "string" ? rawText : String(rawText || "");
  const label = typeof rawLabel === "string" ? rawLabel : String(rawLabel || "");
  if (!text && !label) return null;
  return { label, text: text || label };
}

/**
 * Candidate choice items from a raw model reply. Tries JSON first (the
 * instructed shape), then falls back to a line list, because a model that
 * ignores the JSON instruction still usually returns a usable menu.
 */
function extractItems(raw) {
  // Strip internal <thought>, <think>, and <reasoning> scratchpad blocks before extracting choices
  const clean = typeof raw === "string"
    ? raw.replace(/<(thought|think|reasoning)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<(thought|think|reasoning)[^>]*>[\s\S]*$/gi, "").trim()
    : "";
  const slice = firstJsonSlice(clean);
  if (slice) {
    let parsed = null;
    try {
      parsed = JSON.parse(slice);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.choices) ? parsed.choices : null;
      if (list) return list.map(entryItem).filter(Boolean);
    }
  }
  // Fallback: one candidate per non-empty line, fences and headings skipped.
  // Only used when it yields an actual list: a single line is far more likely
  // to be prose or an error message than a menu of one, and a one-item menu is
  // not a choice anyway.
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line) && !/^[a-zA-Z ]{0,20}:$/.test(line))
    .map((line) => line.replace(LEADING_MARKER_RE, "").trim())
    .filter(Boolean);
  return lines.length >= 2 ? lines.map((l) => ({ text: l })) : [];
}

/**
 * Validates and normalises a raw model reply into the choice list.
 *
 * Returns `{ choices: [{ id, text, label? }] }`. The list may be empty: a reply with no
 * usable choice is a normal outcome the caller reports, never a crash. Every
 * `text` and `label` is a plain string that the UI renders as a text node, so nothing here
 * can become markup.
 */
export function parseChoices(raw, { max = CHOICE_COUNT_MAX, maxChars = CHOICE_TEXT_MAX_CHARS } = {}) {
  const seen = new Set();
  const unique = [];
  for (const item of extractItems(typeof raw === "string" ? raw : String(raw ?? ""))) {
    const text = normalizeChoiceText(item?.text);
    if (text.length < CHOICE_TEXT_MIN_CHARS) continue;
    const rawLabel = item?.label ? normalizeChoiceText(item.label) : "";
    const key = dedupeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ label: rawLabel, text });
  }

  // Prefer choices that already fit. Only when that would leave a useless menu
  // (fewer than two) do we clamp, so a verbose model degrades instead of failing.
  const withinLimit = unique.filter((c) => c.text.length <= maxChars);
  let chosen = withinLimit.length >= 2
    ? withinLimit
    : unique.map((c) => ({ label: c.label, text: clampText(c.text, maxChars) }));

  // Clamping can collapse two entries onto the same string; dedupe once more.
  const finalSeen = new Set();
  chosen = chosen.filter((c) => {
    const key = dedupeKey(c.text);
    if (!key || finalSeen.has(key)) return false;
    finalSeen.add(key);
    return true;
  });

  return {
    choices: chosen.slice(0, max).map((c, index) => {
      const res = { id: `c${index + 1}`, text: c.text };
      if (c.label && c.label !== c.text) {
        res.label = c.label.length > CHOICE_LABEL_MAX_CHARS ? clampText(c.label, CHOICE_LABEL_MAX_CHARS) : c.label;
      }
      return res;
    }),
  };
}
