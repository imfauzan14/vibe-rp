// Evaluation Assertions for Vibe RP Prompt Harness (Promptfoo / Bun compatible)
//
// Pure JavaScript functions evaluating prompt outputs against narrative craft,
// token limits, language lock, anti-repetition, and structural integrity.

import { parseChoices } from "../public/choice_format.js";



/**
 * Validates Choice Mode JSON output format, choice count, label length, and text bounds.
 */
export function validateChoiceJson(output) {
  let rawChoices = null;
  try {
    const rawClean = typeof output === "string" ? output.replace(/```json\s*|\s*```/g, "").trim() : "";
    const obj = JSON.parse(rawClean);
    if (Array.isArray(obj.choices)) rawChoices = obj.choices;
    else if (Array.isArray(obj)) rawChoices = obj;
  } catch (e) {
    // Not valid raw JSON; parseChoices will handle fallback
  }

  if (rawChoices) {
    for (let i = 0; i < rawChoices.length; i++) {
      const c = rawChoices[i];
      const text = typeof c === "string" ? c : c?.text || c?.action || c?.choice || "";
      const label = typeof c === "object" ? c?.label || "" : "";
      if (text.length > 160) {
        return { pass: false, score: 0.5, reason: `Choice at index ${i} exceeds 160 chars (${text.length})` };
      }
      if (label.length > 60) {
        return { pass: false, score: 0.5, reason: `Choice at index ${i} label exceeds 60 chars (${label.length})` };
      }
    }
  }

  const parsed = parseChoices(output);
  const choices = parsed.choices;

  if (!Array.isArray(choices) || choices.length < 3 || choices.length > 5) {
    return {
      pass: false,
      score: 0,
      reason: `Expected 3 to 5 choices, received ${choices?.length || 0}`,
      choices: [],
    };
  }

  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    if (!c.text || typeof c.text !== "string") {
      return { pass: false, score: 0, reason: `Choice at index ${i} missing valid text`, choices };
    }
    if (c.text.length > 160) {
      return { pass: false, score: 0.5, reason: `Choice at index ${i} exceeds 160 chars (${c.text.length})`, choices };
    }
    if (c.label && c.label.length > 60) {
      return { pass: false, score: 0.5, reason: `Choice at index ${i} label exceeds 60 chars (${c.label.length})`, choices };
    }
  }

  return {
    pass: true,
    score: 1.0,
    reason: `Valid choice JSON with ${choices.length} well-formed choices`,
    choices,
  };
}

/**
 * Verifies that choices do not parrot or repeat the other character's previous turn.
 * Evaluates word n-gram overlap between generated choices and previous assistant/user turn.
 */
export function checkRepetition(output, previousTurn) {
  if (!previousTurn || typeof previousTurn !== "string") {
    return { pass: true, score: 1.0, reason: "No previous turn provided for comparison" };
  }

  const parsed = parseChoices(output);
  if (!parsed.choices.length) {
    return { pass: false, score: 0, reason: "No choices to evaluate" };
  }

  const cleanWords = (str) =>
    str
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);

  const prevWords = new Set(cleanWords(previousTurn));
  if (prevWords.size === 0) {
    return { pass: true, score: 1.0, reason: "Previous turn contained no evaluable words" };
  }

  let totalChoiceWords = 0;
  let overlappingWords = 0;

  for (const choice of parsed.choices) {
    const words = cleanWords(choice.text);
    for (const w of words) {
      totalChoiceWords++;
      if (prevWords.has(w)) overlappingWords++;
    }
  }

  const overlapRatio = totalChoiceWords > 0 ? overlappingWords / totalChoiceWords : 0;
  const passed = overlapRatio < 0.35; // less than 35% word overlap allowed

  return {
    pass: passed,
    score: Math.max(0, 1 - overlapRatio),
    reason: `Word overlap with previous turn is ${(overlapRatio * 100).toFixed(1)}% (max allowed 35%)`,
    named_scores: {
      overlapRatio,
      prevWordCount: prevWords.size,
      totalChoiceWords,
    },
  };
}

/**
 * Verifies that choices adhere to the target language and avoid foreign preset language leakage.
 */
export function checkLanguage(output, expectedLanguage) {
  if (!expectedLanguage) {
    return { pass: true, score: 1.0, reason: "No language constraint specified" };
  }

  const parsed = parseChoices(output);
  if (!parsed.choices.length) {
    return { pass: false, score: 0, reason: "No choices to evaluate" };
  }

  const allChoiceText = parsed.choices.map((c) => `${c.label || ""} ${c.text}`).join(" ");

  // If a non-English target language was requested, verify choices didn't leak English preset tokens
  if (expectedLanguage.toLowerCase() !== "english") {
    const hasPresetLeakage = /\b(the|and|with|that|this|you|will|have|from|about)\b/i.test(allChoiceText);
    const pass = !hasPresetLeakage && allChoiceText.length > 0;
    return {
      pass,
      score: pass ? 1.0 : 0.0,
      reason: pass
        ? `Choices adhere to target language (${expectedLanguage}) without foreign preset leakage`
        : `Language check failed: choices leaked foreign preset tokens into ${expectedLanguage}`,
    };
  }

  return { pass: true, score: 1.0, reason: `Choices evaluated for ${expectedLanguage}` };
}

/**
 * Verifies that continuity ledger compression preserves facts and obeys word bounds.
 */
export function checkLedgerCompliance(summaryOutput, requiredEntities = []) {
  if (typeof summaryOutput !== "string" || !summaryOutput.trim()) {
    return { pass: false, score: 0, reason: "Empty summary output" };
  }

  const words = summaryOutput.trim().split(/\s+/).length;
  const underLimit = words <= 700;

  // Check entity retention
  const missing = [];
  for (const entity of requiredEntities) {
    if (!summaryOutput.toLowerCase().includes(entity.toLowerCase())) {
      missing.push(entity);
    }
  }

  const entityScore = requiredEntities.length > 0 ? (requiredEntities.length - missing.length) / requiredEntities.length : 1.0;
  const pass = underLimit && missing.length === 0;

  return {
    pass,
    score: pass ? 1.0 : entityScore * 0.7,
    reason: `Summary: ${words} words (limit 700). Missing entities: ${missing.length ? missing.join(", ") : "none"}`,
    named_scores: {
      wordCount: words,
      entityRetention: entityScore,
    },
  };
}
