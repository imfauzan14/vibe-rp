// Pure context planning, token budgeting, and allocation engine (zero DOM).

import { utf8Decoder } from "./text.js";

const byteLenCache = new Map();
const BYTE_CACHE_MAX = 4096;
const textEncoder = new TextEncoder();

/**
 * Token estimate: UTF-8 bytes / 4 with safe multilingual calibration.
 * Byte-based rather than `String.length`.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === "string" ? text : String(text);
  let bytes = byteLenCache.get(str);
  if (bytes === undefined) {
    bytes = textEncoder.encode(str).length;
    if (byteLenCache.size >= BYTE_CACHE_MAX) byteLenCache.clear();
    byteLenCache.set(str, bytes);
  }
  return (bytes + 3) >> 2;
}

/** Tokens for a message array, including per-message framing overhead. */
export function countMessages(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (!m || !m.content) continue;
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/** Trims zero-width characters, excessive blank lines, and invisible tokens (RTK). */
export function cleanPromptText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
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
  const window = Math.max(0, Number(contextWindow) || 0);
  if (window <= 0) return 256;
  return Math.max(256, Math.min(4096, Math.floor(window * 0.02)));
}

export const SUMMARY_TARGET_WORDS = 700;
export const SUMMARY_UPDATE_TARGET_WORDS = 900;
export const LEDGER_HARD_MAX_TOKENS = 16384;

export function clipLedgerToTokens(text, maxTokens, marker = "\n- [older ledger material omitted at the size ceiling; the full transcript is preserved]") {
  const str = typeof text === "string" ? text : String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!str) return "";
  if (limit <= 0) return marker.trim();
  if (estimateTokens(str) <= limit) return str;
  const markerTokens = estimateTokens(marker);
  const byteBudget = Math.max(0, (limit - markerTokens) * 4);
  const bytes = textEncoder.encode(str);
  let kept;
  if (bytes.length <= byteBudget) {
    kept = str;
  } else {
    kept = utf8Decoder.decode(bytes.subarray(0, byteBudget), { stream: true });
    const nl = kept.lastIndexOf("\n");
    const sp = kept.lastIndexOf(" ");
    const cut = nl > kept.length * 0.5 ? nl : sp > kept.length * 0.5 ? sp : -1;
    if (cut > 0) kept = kept.slice(0, cut);
  }
  return `${kept}${marker}`;
}

function scaleSummaryBudget(workload) {
  if (!(workload > 0)) return SUMMARY_MIN_TOKENS;
  if (workload < SUMMARY_DEFAULT_TOKENS) {
    const t = workload / SUMMARY_DEFAULT_TOKENS;
    return Math.round(SUMMARY_MIN_TOKENS + (SUMMARY_DEFAULT_TOKENS - SUMMARY_MIN_TOKENS) * t);
  }
  const t = Math.min(1, (workload - SUMMARY_DEFAULT_TOKENS) / SUMMARY_DEFAULT_TOKENS);
  return Math.round(SUMMARY_DEFAULT_TOKENS + (SUMMARY_MAX_TOKENS - SUMMARY_DEFAULT_TOKENS) * t);
}

export function resolveSummaryBudget({
  transcriptTokens = 0,
  ledgerTokens = 0,
  promptTokens = 0,
  contextWindow = 0,
  hasPriorLedger = false,
  extraTokens = 0,
} = {}) {
  const transcript = Math.max(0, Number(transcriptTokens) || 0);
  const ledger = Math.max(0, Number(ledgerTokens) || 0);
  const overhead = Math.max(0, Number(promptTokens) || 0);
  const workload = transcript + Math.floor(ledger * 0.5);
  let budget = scaleSummaryBudget(workload) + Math.max(0, Number(extraTokens) || 0);
  if (hasPriorLedger) budget = Math.min(SUMMARY_MAX_TOKENS, budget + SUMMARY_REASONING_HEADROOM);
  const window = Math.max(0, Number(contextWindow) || 0);
  if (window > 0) {
    const headroom = window - (overhead + transcript + ledger) - TOKEN_SAFETY_MARGIN;
    budget = Math.max(SUMMARY_FLOOR_TOKENS, Math.min(budget, headroom));
  }
  return Math.max(SUMMARY_FLOOR_TOKENS, Math.min(SUMMARY_MAX_TOKENS, budget));
}

export function fitFoldLedgerTokens({ contextWindow = 0, promptTokens = 0, transcriptTokens = 0, ledgerTokens = 0 } = {}) {
  const window = Math.max(0, Number(contextWindow) || 0);
  const ledger = Math.max(0, Number(ledgerTokens) || 0);
  if (window <= 0 || ledger <= 0) return ledger;
  const overhead = Math.max(0, Number(promptTokens) || 0);
  const transcript = Math.max(0, Number(transcriptTokens) || 0);
  const forLedger = window - overhead - transcript - SUMMARY_FLOOR_TOKENS - TOKEN_SAFETY_MARGIN;
  if (forLedger >= ledger) return ledger;
  return Math.max(0, forLedger);
}

export function resolveContextBudgets(settings = {}) {
  const contextWindow = Math.max(2048, Number(settings.maxContextTokens) || 16384);
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, Number(settings.maxTokens) || 1200);
  const safetyMargin = resolveSafetyMargin(contextWindow);
  const reservedOutput = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(maxOutput, contextWindow - safetyMargin - MIN_INPUT_HEADROOM)
  );
  const promptBudget = Math.max(512, contextWindow - reservedOutput - safetyMargin);
  const loreBudget = Math.min(4000, Math.max(512, Math.floor(promptBudget * 0.12)));
  const fallbackMaxChars = Math.min(16000, Math.max(1200, Math.floor(promptBudget * 3.5)));
  return {
    contextWindow,
    maxOutput,
    reservedOutput,
    safetyMargin,
    promptBudget,
    loreBudget,
    fallbackMaxChars,
  };
}

export function allocateContext({
  contextWindow = 0,
  desiredOutput = MIN_OUTPUT_TOKENS,
  safetyMargin = 0,
  minOutput = MIN_OUTPUT_TOKENS,
  requiredTokens = 0,
  optionalItems = [],
} = {}) {
  const window = Math.max(0, Number(contextWindow) || 0);
  const margin = Math.max(0, Number(safetyMargin) || 0);
  const floor = Math.max(1, Number(minOutput) || MIN_OUTPUT_TOKENS);
  const desired = Math.max(floor, Number(desiredOutput) || floor);
  const required = Math.max(0, Number(requiredTokens) || 0);

  const outputCeiling = window - margin - required;
  const output = Math.max(floor, Math.min(desired, outputCeiling));
  const inputBudget = Math.max(0, window - margin - output);
  const feasible = required + floor + margin <= window;

  let remaining = Math.max(0, inputBudget - required);
  const ordered = [...optionalItems].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const included = [];
  const excluded = [];
  for (const item of ordered) {
    const tokens = Math.max(0, Number(item.tokens) || 0);
    if (tokens <= remaining) {
      included.push(item);
      remaining -= tokens;
    } else {
      excluded.push(item);
    }
  }

  const optionalTokens = included.reduce((n, i) => n + Math.max(0, Number(i.tokens) || 0), 0);
  return {
    output,
    inputBudget,
    requiredTokens: required,
    optionalTokens,
    historyBudget: remaining,
    included,
    excluded,
    feasible,
  };
}
