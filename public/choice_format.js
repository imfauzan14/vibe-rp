// Choice Mode: the choice-generation instruction and its resilient parser.
//
// Pure and DOM-free. No network, no engine import: this module
// answers exactly two questions, "what do we ask the model for?" and "what did
// the model actually give us?". Keeping the parser here means the untrusted
// model output is normalised in one testable place, before any UI code sees it.
//
// Choice Mode changes how the reader picks the next turn. It never changes how
// the conversation is stored: a selected choice is an ordinary user message.

import { stripThoughtBlocks, renderInlineField } from "./text.js";

// A choice is one line the reader can scan. Beyond this it stops being a menu
// item and becomes a paragraph, so the parser rejects rather than truncates.
export const CHOICE_TEXT_MAX_CHARS = 320;
export const CHOICE_LABEL_MAX_CHARS = 80;
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
const LEADING_MARKER_RE = /^\s*(?:[-*\u2022\u2013\u2014]|\[\d{1,2}\]|\(\d{1,2}\)|\d{1,2}[.)]|(?:Option|Choice)\s+(?:\d{1,2}|[A-Za-z])[.:)]|(?:Option|Choice|\b[A-Za-z]\b)[.:)]|[A-Za-z]\))\s+/i;
const WRAPPING_QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

export const CHOICE_SYSTEM_PROMPT =
  "You generate the next moves available to the player in an ongoing roleplay scene.\n\n" +
  "You write from the player's perspective (or narrative continuation perspective if incapacitated), proposing distinct next moves.\n\n" +
  "Core Process & Adaptive Principles:\n" +
  "- Persona & Narrative Perspective: Align choices with User Persona (traits, voice, flaws). Match the player's established point of view ('I' vs 3rd person) and speech cadence. If the scene or persona is in 3rd person, write choices in 3rd person; if in 1st person, write choices in 1st person. If the persona specifies anxiety, hesitation, or timidity, embody those emotional barriers and speech quirks. Never make the player artificially fearless or articulate when their persona dictates otherwise.\n" +
  "- Language Lock & Register Adaptation: User Persona, Directives, and player dialogue are the active operational authority. If the imported character preset is in a different language than the user persona or dialogue, generate choices strictly in the player's active language and register. Never default to the preset's source language or drift into an unrequested language.\n" +
  "- Dramatic Variety: Offer distinct dramatic archetypes filtered through the player's persona:\n" +
  "  1. Direct / Assertive (stepping forward or speaking up)\n" +
  "  2. Inquisitive / Diplomatic (probing questions or conversation)\n" +
  "  3. Cautious / Observant (tactical awareness, guarded retreat, hesitant pause)\n" +
  "  4. Unconventional / Intuitive (creative alternative, emotional vulnerability, unexpected pivot)\n" +
  "- Scene Beats & Physical Grounding: Ground choices in concrete physical actions, posture, movement, and sensory details rather than disembodied dialogue.\n" +
  "- Subtext over Exposition: Prioritize subtext, tension, and unsaid motives over literal explanations. Avoid conversational holding patterns.\n" +
  "- Anti-Echo Rule: Never echo or repeat the other character's previous words. Every choice responds with fresh momentum.\n" +
  "- Strict Agency: Express each choice as what the player says or attempts in the immediate beat. Never godmode character reactions, never dictate other characters' thoughts or answers, and never narrate future outcomes.\n" +
  "- Player Agency vs. Story Continuation:\n" +
  "  * Condition Assessment: Do NOT offer player-action choices that contradict physical condition. If dead, unconscious, bound, or asleep, do NOT offer choices where they speak or act as if unaffected.\n" +
  "  * Story Continuation: If the player cannot act, offer story-continuation choices (external scene progression, environmental shifts, or passage of time). Clearly distinguish continuation from player action.\n" +
  "  * No Disguised NPC Control: Never present an NPC's autonomous actions or decisions as though they are the player's action. Choices must not puppeteer NPCs.\n" +
  "  * Plausible Recovery: When condition changes allow action (waking, bonds cut), return to player-action choices. If death is permanent, acknowledge the conclusion rather than looping fake recoveries.\n" +
  "- Information Boundary: Restrict choices to what the player perceives in the current scene; never invent off-screen facts.\n" +
  "- Register & Tone: Preserve the established atmospheric tone, genre boundaries, and scene tension.\n" +
  "- Internal Ranking (self-consistency): Before emitting JSON, mentally generate more candidates than needed, then select only the most distinct and scene-appropriate ones. Every emitted choice must differ in dramatic archetype, not just wording.\n" +
  "- Action Labels: Each \"label\" must be an unambiguous, evocative title (3 to 7 words) that clearly defines the character's immediate intent or move (e.g. \"Approach the door cautiously\", \"Hold ground and demand answers\", \"Offer a quiet truce\"). Never use vague, ambiguous labels like \"Respond\", \"Look\", or \"Step closer\" alone.\n" +
  "- Roleplay Craft & Formatting: Each choice \"text\" must be an authentic, fully formed roleplay response combining physical action, dialogue, or reaction. Match the scene's established narrative point of view (1st person 'I' vs 3rd person) and style. Quoted dialogue and descriptive action are encouraged. Never include code fences, meta-commentary, or nested JSON.\n" +
  "- Output format example (do not copy these choices — generate fresh ones for the actual scene):\n" +
  '  {"choices":[\n' +
  '    {"label":"Step into the light and demand answers","text":"I step into the firelight, resting my hand near the pommel of my blade. \\"Who sent you here?\\"","type":"action"},\n' +
  '    {"label":"Remain hidden in shadows and observe","text":"I press my back flat against the cold stone, holding my breath as I watch their silhouette in the doorway.","type":"action"},\n' +
  '    {"label":"Lower weapon and propose a truce","text":"I carefully lower my dagger and keep both hands open and visible. \\"We do not have to do this. Put the steel away.\\"","type":"action"}\n' +
  '  ]}\n' +
  // Q11: Enum pinned in system prompt alongside the schema, not buried in the task line.
  '  "type" must be exactly one of: "action" (player can act), "continuation" (scene progresses without player action), "story" (external narrative beat). Omit the key if none applies.\n' +
  "- Return ONLY the JSON described above, with no commentary, no code fences, and no extra text.";

/**
 * The task line for one choice request. The target count is interpolated rather
 * than left as a placeholder token, so nothing in the prompt can be mistaken for
 * a card placeholder (`{{char}}` / `{{user}}`) and rewritten by substitution.
 *
 * charName and playerName come from user-controlled card fields. They are
 * bracket-wrapped and length-clamped before interpolation (Q17: injection
 * hardening) — a model that receives instructions inside those fields cannot
 * escape the bracketed scope into the instruction text.
 */
export function choicePrompt(count = CHOICE_COUNT_DEFAULT, { charName = "the character", playerName = "the protagonist" } = {}) {
  const target = Math.max(CHOICE_COUNT_MIN, Math.min(CHOICE_COUNT_MAX, Math.floor(Number(count) || CHOICE_COUNT_DEFAULT)));
  // One-line slots: injected card text must not be able to open a new prompt
  // line and impersonate a directive. The flatten rule lives in text.js.
  const safeChar = renderInlineField(charName);
  const safePlayer = renderInlineField(playerName);
  return (
    `Propose the next moves for [${safePlayer}] in the scene above, opposite [${safeChar}].\n\n` +
    "Adaptive Guidance:\n" +
    `- Embody [${safePlayer}]'s persona, speech habits, and narrative perspective.\n` +
    "- Seamlessly match the active language, dialect, and tone established in the scene and directives.\n" +
    `- Operational Precedence: If the character preset was created in a different language, override it to match [${safePlayer}]'s active language, persona, and directives.\n` +
    "- Propel the scene with physically grounded actions and distinct dramatic intentions.\n" +
    `- Agency & Scene State: Respect [${safePlayer}]'s condition. Propose player actions if able to act; propose scene continuation beats if incapacitated or deceased rather than impossible actions or disguised NPC puppeteering.\n\n` +
    `Provide ${target} choices. For each choice:\n` +
    `- "label": An unambiguous, clear title of intent (3 to 7 words, under ${CHOICE_LABEL_MAX_CHARS} characters) in [${safePlayer}]'s active language.\n` +
    `- "text": Full in-character roleplay action or dialogue to send (under ${CHOICE_TEXT_MAX_CHARS} characters), in [${safePlayer}]'s active language and established narrative POV.\n` +
    `- "type": one of "action", "continuation", "story" — or omit the key.\n` +
    `Phrased from [${safePlayer}]'s perspective (or narrative continuation perspective if [${safePlayer}] cannot act).`
  );
}

/** Collapses one model-supplied string into a single clean menu line. */
export function normalizeChoiceText(value) {
  if (value === null || value === undefined) return "";
  let text = String(value).replace(INVISIBLE_RE, "");
  // A choice is one line: any newline, tab or run of whitespace becomes a space.
  text = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  text = text.replace(LEADING_MARKER_RE, "").trim();
  // A model sometimes wraps the whole line in quotes or markdown asterisks;
  // these are punctuation, not part of the action.
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length);
      break;
    }
  }
  if (text.length > 4 && text.startsWith("**") && text.endsWith("**")) {
    text = text.slice(2, -2).trim();
  } else if (text.length > 2 && text.startsWith("*") && text.endsWith("*")) {
    text = text.slice(1, -1).trim();
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
 * Searches for valid choice arrays inside JSON blocks, checking markdown code
 * blocks first and scanning balanced JSON slices so preliminary metadata
 * or thought objects (e.g. {"thought": "..."}) do not preempt the real choices.
 */
function findValidChoiceList(text) {
  const blockMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of blockMatches) {
    const inner = m[1].trim();
    try {
      const parsed = JSON.parse(inner);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.choices) ? parsed.choices : null;
      if (list && list.length > 0) return list;
    } catch {}
  }

  let i = 0;
  while (i < text.length) {
    const nextStart = text.slice(i).search(/[[{]/);
    if (nextStart === -1) break;
    const start = i + nextStart;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let matched = false;

    for (let j = start; j < text.length; j += 1) {
      const ch = text[j];
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
        if (depth === 0) {
          const slice = text.slice(start, j + 1);
          try {
            const parsed = JSON.parse(slice);
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.choices) ? parsed.choices : null;
            if (list && list.length > 0) return list;
          } catch {}
          i = j + 1;
          matched = true;
          break;
        }
      }
    }
    if (!matched) i = start + 1;
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
  const rawType = entry.type ?? entry.kind ?? entry.category ?? "";
  const text = typeof rawText === "string" ? rawText : String(rawText || "");
  const label = typeof rawLabel === "string" ? rawLabel : String(rawLabel || "");
  const type = typeof rawType === "string" ? rawType.toLowerCase().trim() : "";
  if (!text && !label) return null;
  return { label, text: text || label, type };
}

/**
 * Candidate choice items from a raw model reply. Tries JSON first (the
 * instructed shape), then falls back to a line list, because a model that
 * ignores the JSON instruction still usually returns a usable menu.
 */
function extractItems(raw) {
  // Strip internal <thought>, <think>, and <reasoning> scratchpad blocks before extracting choices
  const clean = typeof raw === "string" ? stripThoughtBlocks(raw) : "";
  const list = findValidChoiceList(clean);
  if (list && list.length > 0) {
    return list.map(entryItem).filter(Boolean);
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
    unique.push({ label: rawLabel, text, type: item?.type || "" });
  }

  // Prefer choices that already fit. Only when that would leave a useless menu
  // (fewer than two) do we clamp, so a verbose model degrades instead of failing.
  const withinLimit = unique.filter((c) => c.text.length <= maxChars);
  let chosen = withinLimit.length >= 2
    ? withinLimit
    : unique.map((c) => ({ label: c.label, text: clampText(c.text, maxChars), type: c.type }));

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
      if (c.type && ["action", "continuation", "story"].includes(c.type)) res.type = c.type;
      return res;
    }),
  };
}
