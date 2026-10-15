// public/context_plan.js
// Universal token estimation, context budget allocation, and language-preserving rolling ledger framing.

import { utf8Decoder } from "./text.js";

const utf8Encoder = new TextEncoder();

/**
 * Script-aware token estimator across Latin, Cyrillic, Arabic, Indic, and CJK scripts.
 * Avoids the 30-55% underestimation of raw (utf8Bytes / 4) on non-ASCII scripts while
 * remaining fast, synchronous, and zero-dependency in the browser.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === "string" ? text : String(text);
  const len = str.length;
  if (len === 0) return 0;

  let asciiChars = 0;
  let cjkChars = 0;
  let otherMultiByteChars = 0;

  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      asciiChars++;
    } else if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjkChars++;
    } else {
      otherMultiByteChars++;
    }
  }

  // Fast path for pure ASCII / Latin text: preserve exact byte-quarter ceiling behavior
  if (cjkChars === 0 && otherMultiByteChars === 0) {
    return (asciiChars + 3) >> 2;
  }

  // Multi-script weighting calibrated against o200k_base / Claude / Llama 3 BPE tokenizers:
  // - ASCII/Latin: ~0.25 tokens/char (4 chars per token)
  // - CJK ideographs/kana/hangul: ~0.95 tokens/char
  // - Cyrillic/Arabic/Indic/extended Latin: ~0.55 tokens/char
  const estimated =
    asciiChars * 0.25 + cjkChars * 0.95 + otherMultiByteChars * 0.55;
  return Math.max(1, Math.ceil(estimated));
}

export function countMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let total = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    total += estimateTokens(content) + 4;
  }
  return total;
}

export function cleanPromptText(text) {
  if (text === null || text === undefined) return "";
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const SUMMARY_MIN_TOKENS = 1536;
export const SUMMARY_DEFAULT_TOKENS = 2048;
export const SUMMARY_MAX_TOKENS = 4096;
export const SUMMARY_REASONING_HEADROOM = 512;
export const SUMMARY_FLOOR_TOKENS = 512;
export const TOKEN_SAFETY_MARGIN = 512;
export const MIN_INPUT_HEADROOM = 512;
export const MIN_OUTPUT_TOKENS = 256;

export function resolveSafetyMargin(contextWindow) {
  const cw = Number(contextWindow) || 0;
  if (cw <= 0) return TOKEN_SAFETY_MARGIN;
  return Math.max(
    256,
    Math.min(TOKEN_SAFETY_MARGIN, Math.floor(cw * 0.05))
  );
}

export const SUMMARY_TARGET_WORDS = 700;
export const SUMMARY_UPDATE_TARGET_WORDS = 900;

export const LEDGER_OPEN =
  "The story so far, in ledger form. This is settled continuity: build on it and never contradict it. " +
  "Each character's knowledge is scoped to what they have witnessed or been told — consult each character's Cast entry if you are unsure. " +
  "Maintain the active narrative language established by the player, even if older ledger notes differ.\n<ledger>\n";

export const LEDGER_CLOSE = "\n</ledger>";
export const LEDGER_HARD_MAX_TOKENS = 16384;

export const SUMMARY_SYSTEM_PROMPT =
  "You are an objective narrative continuity scribe. Compress story events into a dense, factual continuity ledger inside <ledger>...</ledger> tags.\n\n" +
  "Core Rules:\n" +
  "1. LANGUAGE PRESERVATION: Write the ledger in the EXACT same primary language and script used in the <transcript>. Never translate non-English transcripts into English, and preserve all proper nouns, honorifics, and in-world terms verbatim.\n" +
  "2. DENSE TELEGRAPHIC FACTS: Write concise, objective bullet points—never story prose, dialogue quotes, or literary metaphors.\n" +
  "3. BOUNDED KNOWLEDGE: Explicitly tag asymmetric or secret facts (e.g., `[Known only to X]`) so characters do not gain omniscient awareness.\n" +
  "4. CONTINUITY KEYS: Track (a) Cast & Epistemic State, (b) Physical Location, Time, Injuries & Inventory, (c) Relationship & Trust Shifts, and (d) Irreversible Plot Events & Open Threads.";

export const SUMMARY_PROMPT =
  `Summarize the <transcript> into a structured continuity ledger of roughly ${SUMMARY_TARGET_WORDS} words or fewer. ` +
  "Preserve the transcript's active language, physical states, relationship shifts, and unresolved threads. " +
  "Return the ledger content wrapped inside a single `<ledger>...</ledger>` block.";

export const SUMMARY_UPDATE_PROMPT =
  `Integrate the new events from <transcript> into the existing <prior-ledger>, keeping total length within roughly ${SUMMARY_UPDATE_TARGET_WORDS} words. ` +
  "Retain all unresolved threads, permanent consequences, and character knowledge boundaries from <prior-ledger>, update changed physical or emotional states, and write in the active language of <transcript>. " +
  "Return the updated ledger wrapped inside a single `<ledger>...</ledger>` block.";

/**
 * Neutralizes any embedded opening or closing XML fence matching `tag` (case-insensitive,
 * tolerant of whitespace, attributes, or self-closing slashes) so untrusted content cannot
 * break out of `<ledger>`, `<transcript>`, or `<prior-ledger>` containers.
 */
export function neutralizeFence(text, tag = "ledger") {
  const cleaned = cleanPromptText(text);
  if (!cleaned) return "";
  const safeTag = String(tag || "ledger").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeTag) return cleaned;
  const fenceRe = new RegExp(
    `<\\s*\\/?\\s*${safeTag}(?:\\s[^>]*)?\\s*\\/?>`,
    "gi"
  );
  return cleaned.replace(fenceRe, (match) => {
    const isClosing = /^<\s*\//.test(match);
    return isClosing ? `[/${safeTag}]` : `[${safeTag}]`;
  });
}

export function frameLedger(ledger) {
  const body = neutralizeFence(ledger, "ledger");
  return body ? `${LEDGER_OPEN}${body}${LEDGER_CLOSE}` : "";
}

export function ledgerFramingTokens() {
  return estimateTokens(LEDGER_OPEN + LEDGER_CLOSE);
}

/**
 * Clips ledger text to fit within `maxTokens` without splitting UTF-8 multi-byte codepoints
 * or cutting mid-line when line boundaries are available.
 */
export function clipLedgerToTokens(
  text,
  maxTokens,
  marker = "\n- [older ledger material omitted at the size ceiling]\n"
) {
  const cleaned = cleanPromptText(text);
  if (!cleaned) return "";
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (budget <= 0) return "";
  if (estimateTokens(cleaned) <= budget) return cleaned;

  const markerTokens = estimateTokens(marker);
  const targetTokens = Math.max(16, budget - markerTokens);

  const lines = cleaned.split("\n");
  if (lines.length > 2) {
    const head = lines[0];
    const headTokens = estimateTokens(head + "\n");
    const keptTail = [];
    let runningTokens = headTokens + markerTokens;

    for (let i = lines.length - 1; i >= 1; i--) {
      const lineTokens = estimateTokens(lines[i] + "\n");
      if (runningTokens + lineTokens > budget && keptTail.length > 0) {
        break;
      }
      keptTail.unshift(lines[i]);
      runningTokens += lineTokens;
    }

    const candidate = `${head}${marker}${keptTail.join("\n")}`.trim();
    if (estimateTokens(candidate) <= budget) {
      return candidate;
    }
  }

  // Fallback byte-safe slice via UTF-8 stream decoder
  const bytes = utf8Encoder.encode(cleaned);
  const maxBytes = Math.max(32, Math.min(bytes.length, targetTokens * 2));
  const sliceStart = Math.max(0, bytes.length - maxBytes);
  let alignedStart = sliceStart;
  while (alignedStart < bytes.length && (bytes[alignedStart] & 0xc0) === 0x80) {
    alignedStart++;
  }
  const decodedTail = utf8Decoder.decode(bytes.subarray(alignedStart)).trim();
  return `${marker.trim()}\n${decodedTail}`.trim();
}

export function resolveSummaryBudget({
  transcriptTokens = 0,
  ledgerTokens = 0,
  promptTokens = 0,
  contextWindow = 0,
  hasPriorLedger = false,
  extraTokens = 0,
} = {}) {
  const cw = Math.max(0, Number(contextWindow) || 0);
  const inputUsed =
    Math.max(0, Number(transcriptTokens) || 0) +
    Math.max(0, Number(ledgerTokens) || 0) +
    Math.max(0, Number(promptTokens) || 0) +
    Math.max(0, Number(extraTokens) || 0);

  const baseTarget = hasPriorLedger
    ? Math.max(SUMMARY_DEFAULT_TOKENS, Math.ceil(ledgerTokens * 1.15))
    : SUMMARY_DEFAULT_TOKENS;

  const desired = Math.min(
    SUMMARY_MAX_TOKENS,
    Math.max(SUMMARY_MIN_TOKENS, baseTarget)
  );

  if (cw <= 0) {
    return desired + SUMMARY_REASONING_HEADROOM;
  }

  const safety = resolveSafetyMargin(cw);
  const available = cw - inputUsed - safety;
  if (available < SUMMARY_FLOOR_TOKENS) {
    return Math.max(MIN_OUTPUT_TOKENS, available);
  }
  return Math.min(desired + SUMMARY_REASONING_HEADROOM, available);
}

export function fitFoldLedgerTokens({
  contextWindow = 0,
  promptTokens = 0,
  transcriptTokens = 0,
  ledgerTokens = 0,
} = {}) {
  const cw = Math.max(0, Number(contextWindow) || 0);
  const rawCap = Math.min(
    LEDGER_HARD_MAX_TOKENS,
    Math.max(SUMMARY_MIN_TOKENS, Number(ledgerTokens) || SUMMARY_DEFAULT_TOKENS)
  );
  if (cw <= 0) return rawCap;

  const safety = resolveSafetyMargin(cw);
  const reserved =
    Math.max(0, Number(promptTokens) || 0) +
    Math.max(0, Number(transcriptTokens) || 0) +
    SUMMARY_MIN_TOKENS +
    safety;
  const maxAllowed = Math.max(SUMMARY_FLOOR_TOKENS, cw - reserved);
  return Math.min(rawCap, maxAllowed);
}

export function resolveContextBudgets(settings = {}) {
  const contextWindow = Math.max(
    2048,
    Number(settings?.maxContextTokens) || 65536
  );
  const maxOutputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(
      Math.floor(contextWindow * 0.25),
      Number(settings?.maxTokens) || 1200
    )
  );
  const safetyMargin = resolveSafetyMargin(contextWindow);
  const inputBudget = Math.max(
    MIN_INPUT_HEADROOM,
    contextWindow - maxOutputTokens - safetyMargin
  );
  return {
    contextWindow,
    maxOutputTokens,
    safetyMargin,
    inputBudget,
  };
}

export function allocateContext({
  contextWindow = 0,
  desiredOutput = MIN_OUTPUT_TOKENS,
  safetyMargin = 0,
  minOutput = MIN_OUTPUT_TOKENS,
  requiredTokens = 0,
  optionalItems = [],
  optionalBudgetTokens = null,
} = {}) {
  const cw = Math.max(0, Number(contextWindow) || 0);
  const safety =
    safetyMargin > 0 ? safetyMargin : cw > 0 ? resolveSafetyMargin(cw) : 0;
  const req = Math.max(0, Number(requiredTokens) || 0);
  const floorOut = Math.max(1, Number(minOutput) || MIN_OUTPUT_TOKENS);
  const wantOut = Math.max(floorOut, Number(desiredOutput) || floorOut);

  const totalAvailableForInputAndOut = Math.max(0, cw - safety);
  const impossible = cw > 0 && req + floorOut > totalAvailableForInputAndOut;

  const outputBudget =
    cw > 0
      ? Math.max(
          floorOut,
          Math.min(wantOut, totalAvailableForInputAndOut - req)
        )
      : wantOut;

  const remainingForOptional =
    cw > 0
      ? Math.max(0, totalAvailableForInputAndOut - req - outputBudget)
      : Number.MAX_SAFE_INTEGER;

  const optionalCap =
    optionalBudgetTokens !== null && optionalBudgetTokens !== undefined
      ? Math.min(remainingForOptional, Math.max(0, Number(optionalBudgetTokens)))
      : remainingForOptional;

  const acceptedIds = [];
  const droppedIds = [];
  let usedOptionalTokens = 0;

  const sorted = [...(Array.isArray(optionalItems) ? optionalItems : [])].sort(
    (a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0)
  );

  for (const item of sorted) {
    if (!item || typeof item !== "object") continue;
    const cost = Math.max(0, Number(item.tokens) || 0);
    if (usedOptionalTokens + cost <= optionalCap) {
      acceptedIds.push(item.id);
      usedOptionalTokens += cost;
    } else {
      droppedIds.push(item.id);
    }
  }

  return {
    impossible,
    outputBudget,
    requiredTokens: req,
    optionalBudget: optionalCap,
    usedOptionalTokens,
    totalInputTokens: req + usedOptionalTokens,
    acceptedIds,
    droppedIds,
  };
}
