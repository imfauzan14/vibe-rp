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
  ["\u300C", "\u300D"], // 「 」
  ["\u300E", "\u300F"], // 『 』
  ["\u300A", "\u300B"], // 《 》
  ["\u00AB", "\u00BB"], // « »
];

// The choice contract is outcome-first: it describes what a good set of moves
// looks like and lets the model decide how to arrive at one.
//
// It deliberately does NOT mandate an emitted reasoning block. Reasoning is now
// the model's own business — OpenAI's GPT-5 guide controls it with
// `reasoning_effort` rather than prompt-instructed chain of thought, and
// Anthropic's guidance is that "extended thinking is generally preferable to
// manual chain of thought prompting". A mandated assessment object had to be
// billed and waited on in full, because the choice request does not stream, so
// it sat on the critical path to the menu.
//
// Models that cannot reason natively still get CHOICE_DELIBERATION_HINT, added
// by choicePrompt(), so the weak-model path is preserved without taxing the
// strong one.
export const CHOICE_SYSTEM_PROMPT =
  "You propose the player's next moves at the current beat of an ongoing roleplay scene.\n\n" +
  "Write from the player's perspective, or the narrator's when they cannot act. Each choice is something the player does or says next.\n\n" +
  "Condition Assessment\n" +
  "Read the player's physical state first: injury, consciousness, restraint, presence. What they can do follows from that state, and every condition takes time to change.\n" +
  "  * Player Agency vs. Story Continuation: while the player can act, propose player actions; while they cannot, propose the scene advancing around them — an environmental shift, the passage of time — and keep continuation distinct from action.\n" +
  "  * Limited Agency: when the player can barely act, draw on transition (stirring, coming round), internal (resolve, decision), endurance (holding on), or perception (watching, working something out) before reaching for an action the state does not permit.\n" +
  "  * Plausible Recovery: when a condition changes and action becomes possible again (waking, bonds cut), return to player actions. At a permanent end, acknowledge the conclusion instead of looping recoveries.\n" +
  "  * Distinct NPC Agency: other characters keep their own reactions and answers; an NPC's move stays the NPC's own.\n\n" +
  "Agency\n" +
  "Each choice names what the player attempts in the immediate beat, not its outcome. Leave other characters' responses and the consequences unwritten.\n\n" +
  "Four Dramatic Angles\n" +
  "Draw each set from distinct archetypes, so the options are different paths rather than variations on one:\n" +
  "  1. Direct / Assertive — step forward, speak plainly, commit.\n" +
  "  2. Inquisitive / Diplomatic — probe, negotiate, draw someone out.\n" +
  "  3. Cautious / Observant — watch, wait, test the ground, withdraw.\n" +
  "  4. Unconventional / Intuitive — a sudden pivot, a vulnerable admission, a lateral move.\n\n" +
  "Craft\n" +
  "  * Scene Beats & Physical Grounding: concrete action, posture, movement, sensory detail.\n" +
  "  * Subtext over Exposition: let tension and implication carry the line.\n" +
  "  * Anti-Echo Rule: each choice advances the scene rather than restating what the other character just said.\n\n" +
  "Narrative Perspective\n" +
  "Match the player's point of view (\"I\" or third person) and speech cadence; keep their persona's traits, voice, and hesitations. A guarded character stays guarded; an anxious one stays anxious.\n\n" +
  "Language Lock & Register Adaptation\n" +
  "The User Persona, the Directives, and the player's own dialogue are the active operational authority for language and register. Write every choice in the player's active language, following the language the scene is already using rather than the preset's source language.\n\n" +
  "Output\n" +
  "Return only this JSON.\n" +
  '  {"choices":[{"label":"Step forward","text":"I step into the firelight. \\"Who sent you?\\"","type":"action"},{"label":"Propose truce","text":"I lower my dagger. \\"We can talk this through.\\"","type":"action"}]}\n' +
  '  * "label": the intent in 3 to 7 words, in the player\'s active language.\n' +
  '  * "text": the full in-character action or dialogue to send, in the player\'s active language and established point of view.\n' +
  '  * "type": "action" (the player can act), "continuation" (the scene progresses around them), or "story" (an external beat). Omit when none applies.';

// Appended only when the model has no native reasoning step to lean on. Kept
// short and explicitly silent: it asks for the thinking to happen, not to be
// written down, so the response stays parseable and cheap.
export const CHOICE_DELIBERATION_HINT =
  "\n\nBefore you answer, work through the scene silently: the player's physical condition and what it permits, how much time has passed, who is present, and which moves follow causally from the last beat. Output only the JSON, with the reasoning kept internal.";

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
export function choicePrompt(count = CHOICE_COUNT_DEFAULT, { charName = "the character", playerName = "the protagonist", previousChoices = [], deliberate = false } = {}) {
  const target = Math.max(CHOICE_COUNT_MIN, Math.min(CHOICE_COUNT_MAX, Math.floor(Number(count) || CHOICE_COUNT_DEFAULT)));
  // One-line slots: injected card text must not be able to open a new prompt
  // line and impersonate a directive. The flatten rule lives in text.js.
  const safeChar = renderInlineField(charName);
  const safePlayer = renderInlineField(playerName);

  // The player's steer intent is deliberately absent here. It is one rule with
  // one home: the tail block `planChoiceRequest` appends after the instructions,
  // at the generation head, where recency weight is greatest. Carrying it here
  // as well put two copies of one instruction in one payload — the redundancy
  // this file warns about elsewhere — and the copy nearer the head then decided
  // the behaviour by accident rather than by design. `previousChoices` stays
  // because it is a different rule (what to avoid), not a second statement of
  // what to pursue.

  let freshVariationHint = "";
  if (Array.isArray(previousChoices) && previousChoices.length > 0) {
    const list = previousChoices
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return renderInlineField(c);
        const l = renderInlineField(c.label || "");
        const t = renderInlineField(c.text || "", 120);
        return l ? `${l}: ${t}` : t;
      })
      .filter(Boolean)
      .slice(0, 6);
    if (list.length > 0) {
      // Phrased as the lane to take rather than the one to avoid, matching the
      // convention the rest of the authored prompts follow: state what to write.
      // The avoided options are still listed, because knowing them is what makes
      // "fresh" checkable on read-through.
      freshVariationHint =
        `\n\nFresh Dramatic Angles Required:\n` +
        `The player requested fresh choices. Treat these previous options as spent, and build this set from different ground:\n` +
        list.map((item) => `- ${item}`).join("\n") +
        `\nExplore distinctly different dramatic archetypes, unexpected tactics, physical reactions, or emotional pivots.`;
    }
  }

  // The task line carries only what the task needs: who, how many, and the
  // field limits. Persona, language precedence, physical grounding and agency
  // are all stated in CHOICE_SYSTEM_PROMPT, which travels in the same request —
  // restating them here put two copies of each rule in one payload, which is the
  // redundancy the contract work removed everywhere else.
  return (
    `Propose the next moves for [${safePlayer}] in the scene above, opposite [${safeChar}].\n\n` +
    `Provide ${target} choices, phrased from [${safePlayer}]'s perspective (or the narrator's if they cannot act).\n\n` +
    `For each:\n` +
    `- "label": the intent in 3 to 7 words, under ${CHOICE_LABEL_MAX_CHARS} characters, in [${safePlayer}]'s active language.\n` +
    `- "text": the full in-character action or dialogue to send, under ${CHOICE_TEXT_MAX_CHARS} characters, in [${safePlayer}]'s active language and point of view.\n` +
    `- "type": "action", "continuation", or "story" — or omit the key.` +
    freshVariationHint +
    (deliberate ? CHOICE_DELIBERATION_HINT : "")
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

/** Word-boundary and punctuation-aware clamp across scripts. Only used when a whole set would otherwise be lost. */
function clampText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf(" "),
    slice.lastIndexOf(","),
    slice.lastIndexOf(";"),
    slice.lastIndexOf("，"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("、"),
    slice.lastIndexOf("；")
  );
  const kept = boundary > maxChars * 0.6 ? slice.slice(0, boundary) : slice;
  return kept.replace(/[\s,;:，。、；]+$/, "").trim();
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
