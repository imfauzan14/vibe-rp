// public/choice_format.js
// Universal, language-locked player choice generation and resilient multi-format parser.

import {
  stripThoughtBlocks,
  renderInlineField,
  neutralizeDelimiters,
  substitutePlaceholders,
} from "./text.js";

export const CHOICE_TEXT_MAX_CHARS = 320;
export const CHOICE_LABEL_MAX_CHARS = 80;
export const CHOICE_TEXT_MIN_CHARS = 2;
export const CHOICE_COUNT_MIN = 3;
export const CHOICE_COUNT_MAX = 5;
export const CHOICE_COUNT_DEFAULT = 4;

export const CHOICE_SYSTEM_PROMPT =
  "You propose the player's next moves at the current beat of an ongoing roleplay scene.\n\n" +
  "Write from the player's perspective, or the narrator's when they cannot act. Each choice is something the player attempts or observes.\n" +
  "Condition Assessment\n" +
  "Read the player's physical state first: injury, consciousness, restraint, presence. What they can do follows from condition:\n" +
  "  * Player Agency vs. Story Continuation: while the player can act, propose player actions; while they cannot, propose narrative cutaways or internal focus.\n" +
  "  * Observational Perspective Shifts: when the dramatic rhythm benefits from shifting focus to another character or scene location, offer cutaways.\n" +
  "  * Limited Agency: when the player can barely act, draw on transition (stirring, steadying breath), internal (resolve, focus), or sensory observations.\n" +
  "  * Plausible Recovery: when a condition changes and action becomes possible again, return agency choices immediately.\n" +
  "  * Distinct NPC Agency: other characters keep their own reactions and answers; an NPC's move stays the NPC's move.\n" +
  "Agency\n" +
  "Each choice names what the player attempts in the immediate beat, not its outcome. Leave other characters' response to the main turn.\n" +
  "Four Dramatic Angles\n" +
  "Draw each set from distinct archetypes, so the options are different paths rather than variations on one:\n" +
  "  1. Direct / Assertive – commit to a clear physical action or direct statement.\n" +
  "  2. Inquisitive / Diplomatic – probe subtext, negotiate, or draw someone out.\n" +
  "  3. Cautious / Observant – watch, test the ground, hold position, or create distance.\n" +
  "  4. Unconventional / Intuitive – a lateral pivot, an unexpected honesty, or changing the subject's stakes.\n\n" +
  "Craft\n" +
  "  * Scene Beats & Physical Grounding: concrete action, posture, movement, sensory detail.\n" +
  "  * Subtext over Exposition: let tension and implication carry the line.\n" +
  "  * Anti-Echo Rule: each choice advances the scene rather than restating what the other character just said.\n" +
  "Narrative Perspective & Language Lock\n" +
  "The User Persona, the Directives, and the player's own turns are the active operational authority for language, script, POV, tense, and register. " +
  "Write every `label` and `text` strictly in the active language and grammatical POV established by the player and scene—never default to English or first-person if the scene uses another language or POV.\n" +
  "Output\n" +
  "Return only valid JSON matching this schema (no markdown commentary outside the JSON):\n" +
  '{"choices":[{"label":"<3-7 word intent in active language>","text":"<in-character action, dialogue, or cutaway beat in active language and POV>","type":"action","pov":"player"}]}\n' +
  '  * "label": the intent in 3 to 7 words, in the player\'s active language.\n' +
  '  * "text": the full in-character action, dialogue, or observed cutaway beat to send, in the player\'s active language.\n' +
  '  * "type": "action" (the player can act), "cutaway" (watching another character or location unfold), "continuation" (narrative beat when player cannot act).\n' +
  '  * "pov": perspective indicator ("player", the observed character\'s name, or "scene").';

export const CHOICE_DELIBERATION_HINT =
  "Briefly weigh the player's physical condition, immediate scene tension, and active language/POV before emitting the final JSON object.";

export const CHOICE_STEER_INSTRUCTION =
  "Player Steering Focus:\nAnchor all options to the requested direction:";

const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// Matches ASCII and fullwidth CJK/Arabic numbering, bullets, or "Option 1:" / "Choice A:" prefixes
const LEADING_MARKER_RE =
  /^\s*(?:[-*\u2022\u2013\u2014\u30FB]|\[\d{1,2}\]|\(\d{1,2}\)|\d{1,2}[.):\uFF0E\u3001]|[\uFF10-\uFF19]{1,2}[.):\uFF0E\u3001]|(?:Option|Choice|Pilihan|Opci[oó]n|Choix|選択肢|옵션|Вариант)\s+(?:\d{1,2}|[A-Za-z])[.:)]?|(?:[A-Da-d])[.):])\s+/iu;

const WRAPPING_QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
  ["\u201E", "\u201C"],
  ["\u300C", "\u300D"],
  ["\u300E", "\u300F"],
  ["\u300A", "\u300B"],
  ["\u00AB", "\u00BB"],
];

function clampCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return CHOICE_COUNT_DEFAULT;
  return Math.max(CHOICE_COUNT_MIN, Math.min(CHOICE_COUNT_MAX, Math.round(num)));
}

/**
 * Builds the task prompt for Choice Mode.
 * Supports both `(count, { charName, playerName, ... })` and `({ count, char, player, ... })` call signatures.
 */
export function choicePrompt(
  countOrOptions = CHOICE_COUNT_DEFAULT,
  optionsArg = {}
) {
  let rawCount = CHOICE_COUNT_DEFAULT;
  let opts = optionsArg || {};

  if (
    countOrOptions !== null &&
    typeof countOrOptions === "object" &&
    !Array.isArray(countOrOptions)
  ) {
    opts = countOrOptions;
    rawCount = opts.count ?? CHOICE_COUNT_DEFAULT;
  } else {
    rawCount = countOrOptions;
  }

  const count = clampCount(rawCount);
  const rawChar =
    opts.charName ?? opts.char ?? opts.characterName ?? "the character";
  const rawPlayer =
    opts.playerName ?? opts.player ?? opts.userName ?? "the protagonist";

  const charName =
    neutralizeDelimiters(renderInlineField(rawChar, 80), 80) || "the character";
  const playerName =
    neutralizeDelimiters(renderInlineField(rawPlayer, 80), 80) ||
    "the protagonist";

  const previousChoices = Array.isArray(opts.previousChoices)
    ? opts.previousChoices
    : Array.isArray(opts.recentLabels)
      ? opts.recentLabels
      : [];
  const deliberate = Boolean(opts.deliberate);
  const fresh = Boolean(opts.fresh);
  const steer = renderInlineField(opts.steer ?? opts.intent ?? "", 200);

  const lines = [
    `Generate exactly ${count} choices (${count} distinct next-turn options) for ${playerName} in the scene with ${charName}.`,
    "Keep every label and text strictly in the active language, script, POV, and tense of the scene.",
  ];

  if (fresh && previousChoices.length > 0) {
    const cleanedPrev = previousChoices
      .map((item) => renderInlineField(item, 80))
      .filter(Boolean)
      .slice(0, 8);
    if (cleanedPrev.length > 0) {
      lines.push(
        `Offer fresh directions distinct from previous options: ${cleanedPrev.join("; ")}.`
      );
    }
  }

  if (steer) {
    lines.push(`${CHOICE_STEER_INSTRUCTION} "${neutralizeDelimiters(steer, 200)}"`);
  }

  if (deliberate) {
    lines.push(CHOICE_DELIBERATION_HINT);
  }

  const joined = lines.join("\n");
  return substitutePlaceholders(joined, {
    user: playerName,
    char: charName,
  });
}

export function normalizeChoiceText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  let s = String(value)
    .replace(INVISIBLE_RE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!s) return "";

  s = s.replace(LEADING_MARKER_RE, "").trim();

  if (
    (s.startsWith("**") && s.endsWith("**") && s.length > 4) ||
    (s.startsWith("__") && s.endsWith("__") && s.length > 4)
  ) {
    s = s.slice(2, -2).trim();
  } else if (
    (s.startsWith("*") && s.endsWith("*") && !s.slice(1, -1).includes("*")) ||
    (s.startsWith("_") && s.endsWith("_") && !s.slice(1, -1).includes("_"))
  ) {
    s = s.slice(1, -1).trim();
  }

  for (const [openQ, closeQ] of WRAPPING_QUOTES) {
    if (s.startsWith(openQ) && s.endsWith(closeQ) && s.length > openQ.length + closeQ.length) {
      const inner = s.slice(openQ.length, s.length - closeQ.length);
      if (!inner.includes(closeQ) && !inner.includes(openQ)) {
        s = inner.trim();
        break;
      }
    }
  }

  return s.replace(/\s{2,}/g, " ").trim();
}

function clampChoiceField(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const boundaryChars = [". ", "! ", "? ", "。", "！", "？", "；", "; ", ", ", "、", " "];
  let bestCut = -1;
  for (const b of boundaryChars) {
    const idx = sliced.lastIndexOf(b);
    if (idx >= Math.floor(maxChars * 0.6)) {
      bestCut = idx + (b.trim() ? b.trim().length : 0);
      break;
    }
  }
  const cut = bestCut > 0 ? sliced.slice(0, bestCut) : sliced;
  return cut.replace(/[,;:\s]+$/, "").trim();
}

function dedupeKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBalancedJsonCandidates(str) {
  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(str)) !== null) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== "{" && ch !== "[") continue;
    const closeCh = ch === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < str.length; j++) {
      const c = str[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        if (inString) escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === ch) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          candidates.push(str.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return candidates;
}

function coerceItem(rawItem, index, maxChars) {
  if (rawItem === null || rawItem === undefined) return null;

  let rawText = "";
  let rawLabel = "";
  let rawType = "action";
  let rawPov = "player";

  if (typeof rawItem === "string" || typeof rawItem === "number") {
    rawText = String(rawItem);
  } else if (typeof rawItem === "object") {
    rawText =
      rawItem.text ??
      rawItem.choice ??
      rawItem.action ??
      rawItem.content ??
      rawItem.body ??
      rawItem.value ??
      rawItem.label ??
      rawItem.title ??
      "";
    rawLabel =
      rawItem.label ??
      rawItem.title ??
      rawItem.intent ??
      rawItem.summary ??
      "";
    if (typeof rawItem.type === "string") {
      const t = rawItem.type.trim().toLowerCase();
      if (t === "action" || t === "cutaway" || t === "continuation") {
        rawType = t;
      }
    }
    if (typeof rawItem.pov === "string" && rawItem.pov.trim()) {
      rawPov = renderInlineField(rawItem.pov.trim(), 40) || "player";
    }
  }

  const text = clampChoiceField(normalizeChoiceText(rawText), maxChars);
  if (!text || text.length < CHOICE_TEXT_MIN_CHARS) return null;

  let label = clampChoiceField(
    normalizeChoiceText(rawLabel),
    CHOICE_LABEL_MAX_CHARS
  );
  if (!label) {
    const firstClause = text.split(/[.!?。！？;；]/)[0] || text;
    label = clampChoiceField(firstClause.trim(), CHOICE_LABEL_MAX_CHARS);
  }

  return {
    id: `c${index + 1}`,
    label,
    text,
    type: rawType,
    pov: rawPov,
  };
}

export function parseChoices(
  raw,
  { max = CHOICE_COUNT_MAX, maxChars = CHOICE_TEXT_MAX_CHARS } = {}
) {
  const maxItems = Math.max(1, Math.min(CHOICE_COUNT_MAX, Number(max) || CHOICE_COUNT_MAX));
  const charCap = Math.max(16, Number(maxChars) || CHOICE_TEXT_MAX_CHARS);

  if (raw === null || raw === undefined) {
    return { choices: [], note: "", trailingText: "" };
  }

  if (Array.isArray(raw)) {
    const seen = new Set();
    const choices = [];
    for (const item of raw) {
      const coerced = coerceItem(item, choices.length, charCap);
      if (!coerced) continue;
      const key = dedupeKey(coerced.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push(coerced);
      if (choices.length >= maxItems) break;
    }
    return { choices, note: "", trailingText: "" };
  }

  const stripped = stripThoughtBlocks(typeof raw === "string" ? raw : String(raw)).trim();
  if (!stripped) {
    return { choices: [], note: "", trailingText: "" };
  }

  const candidates = extractBalancedJsonCandidates(stripped);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.choices)
          ? parsed.choices
          : Array.isArray(parsed?.options)
            ? parsed.options
            : Array.isArray(parsed?.items)
              ? parsed.items
              : null;

      if (Array.isArray(list) && list.length > 0) {
        const seen = new Set();
        const choices = [];
        for (const item of list) {
          const coerced = coerceItem(item, choices.length, charCap);
          if (!coerced) continue;
          const key = dedupeKey(coerced.text);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          choices.push(coerced);
          if (choices.length >= maxItems) break;
        }
        if (choices.length > 0) {
          return {
            choices,
            note: typeof parsed?.note === "string" ? parsed.note.trim() : "",
            trailingText: "",
          };
        }
      }
    } catch {
      // Continue to next candidate or fallback line parser
    }
  }

  const lines = stripped.split(/\r?\n/);
  const listLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (LEADING_MARKER_RE.test(trimmed)) {
      listLines.push(trimmed);
    }
  }

  if (listLines.length > 0) {
    const seen = new Set();
    const choices = [];
    for (const line of listLines) {
      let rawItem = line.replace(LEADING_MARKER_RE, "").trim();
      const boldSplit = rawItem.match(/^\*\*([^*]{2,60})\*\*\s*[:\-–—]\s*(.+)$/);
      if (boldSplit) {
        rawItem = { label: boldSplit[1], text: boldSplit[2] };
      }
      const coerced = coerceItem(rawItem, choices.length, charCap);
      if (!coerced) continue;
      const key = dedupeKey(coerced.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push(coerced);
      if (choices.length >= maxItems) break;
    }
    return { choices, note: "", trailingText: "" };
  }

  return { choices: [], note: "", trailingText: stripped };
}

export function formatChoiceBlock(choices = []) {
  if (!Array.isArray(choices) || choices.length === 0) return "";
  return choices
    .map((c, idx) => {
      const text = normalizeChoiceText(c?.text ?? c?.label ?? c);
      return text ? `${idx + 1}. ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export const formatChoicePrompt = choicePrompt;
export const parseChoiceResponse = parseChoices;
export const CHOICE_MAX_TOKENS = 512;
