// public/prompt_adaptive.js
// Universal, script-agnostic turn state analyzer and adaptive scene guidance builder.

import {
  stripThoughtBlocks,
  renderInlineField,
  substitutePlaceholders as baseSubstitutePlaceholders,
} from "./text.js";
import { estimateTokens } from "./context_plan.js";

export const GUIDANCE_MAX_TOKENS = 320;
export const REINJECT_EVERY_TURNS = 8;
export const ANALYSIS_WINDOW = 6;
export const SLOP_CLUSTER_THRESHOLD = 4;

export { baseSubstitutePlaceholders as substitutePlaceholders };

/**
 * Strips spoken dialogue across global quotation conventions:
 * - Straight double quotes ("...")
 * - Curly double quotes (“...”) & Central/Eastern European low-high quotes („...“)
 * - Guillemets («...», ‹...›) used in French, Spanish, Russian, Italian, Arabic
 * - East Asian corner brackets (「...」, 『...』, 《...》)
 * - Romance/Slavic line-initial dialogue em-dashes (— ...)
 */
export function narrationOnly(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/"[^"\n]{1,600}"/g, " ")
    .replace(/[\u201C\u201E][^\u201D\u201C\n]{1,600}[\u201D\u201C]/g, " ")
    .replace(/\u00AB[^\u00BB\n]{1,600}\u00BB/g, " ")
    .replace(/\u2039[^\u203A\n]{1,600}\u203A/g, " ")
    .replace(/\u300C[^\u300D]{1,600}\u300D/g, " ")
    .replace(/\u300E[^\u300F]{1,600}\u300F/g, " ")
    .replace(/^\s*[\u2014\u2013―]\s+[^\n]+$/gm, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Computes ratio of Latin script letters to total Unicode letters (0.0 to 1.0).
 */
export function latinShare(text) {
  if (!text || typeof text !== "string") return 0;
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return 0;
  const latin = text.match(/\p{Script=Latin}/gu);
  return (latin ? latin.length : 0) / letters.length;
}

const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * Script-aware word/morpheme counter that works across Latin, Cyrillic, Arabic, and CJK.
 */
export function countWords(text) {
  if (!text || typeof text !== "string") return 0;
  const cleaned = text.trim();
  if (!cleaned) return 0;

  if (wordSegmenter) {
    let count = 0;
    for (const seg of wordSegmenter.segment(cleaned)) {
      if (seg.isWordLike) count++;
    }
    return count;
  }

  const cjkMatches = cleaned.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
  );
  const nonCjkWords = cleaned
    .replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      " "
    )
    .match(/[\p{L}\p{N}'\u2019-]+/gu);

  return (cjkMatches ? cjkMatches.length : 0) + (nonCjkWords ? nonCjkWords.length : 0);
}

/**
 * High-precision check for whether a Latin-script passage is English, preventing
 * English verb/pronoun regexes from misfiring on Indonesian, Spanish, French,
 * German, Portuguese, Turkish, Vietnamese, Tagalog, Polish, or Swahili.
 */
const EN_FUNCTION_WORDS_RE =
  /\b(the|and|that|with|from|into|through|their|would|could|should|about|before|after|between|without|against|toward|towards|around|behind|beneath|across)\b/gi;

const NON_EN_LATIN_MARKERS_RE =
  /\b(yang|dengan|tidak|untuk|dalam|adalah|sudah|karena|seperti|namun|bahwa|mereka|kita|kamu|aku|dia|dari|pada|atau|tapi|saja|bisa|akan|para|como|pero|más|esta|este|entre|hacia|desde|dans|avec|pour|mais|comme|cette|nicht|sich|auch|und|oder|durch|über|nach|değil|için|gibi|daha|những|trong|được|không)\b/gi;

export function isLikelyEnglish(text) {
  if (!text || typeof text !== "string") return false;
  if (latinShare(text) < 0.6) return false;
  const words = countWords(text);
  if (words < 8) return false;
  const enHits = (text.match(EN_FUNCTION_WORDS_RE) || []).length;
  const nonEnHits = (text.match(NON_EN_LATIN_MARKERS_RE) || []).length;
  if (nonEnHits > enHits) return false;
  return enHits / Math.max(1, words) >= 0.035;
}

export const SLOP_LEXICON = [
  "shiver",
  "shudders",
  "swallowed hard",
  "breath caught",
  "barely a whisper",
  "smirked",
  "adam's apple",
  "ministrations",
  "testament to",
  "down her spine",
  "down his spine",
  "heart hammered",
  "eyes never leaving",
  "a mixture of",
  "a blend of",
  "unspoken question",
  "let out a breath",
  "didn't realize",
  "seemed to shrink",
  "threads of fate",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SLOP_RE = new RegExp(
  `\\b(?:${SLOP_LEXICON.map(escapeRegex).join("|")})\\b`,
  "gi"
);

/**
 * Extracts normalized 4-word n-grams across any script (using Intl.Segmenter or Unicode words)
 * to detect cross-turn repetitive phrasing universally in any language.
 */
function countCrossTurnNgramEchoes(replies = []) {
  if (!Array.isArray(replies) || replies.length < 2) return 0;
  const phraseTurnCounts = new Map();

  for (const reply of replies) {
    const narr = narrationOnly(reply || "").toLowerCase();
    if (!narr) continue;
    const tokens = [];
    if (wordSegmenter) {
      for (const seg of wordSegmenter.segment(narr)) {
        if (seg.isWordLike) tokens.push(seg.segment);
      }
    } else {
      const m = narr.match(/[\p{L}\p{N}]+/gu);
      if (m) tokens.push(...m);
    }
    if (tokens.length < 5) continue;

    const seenInTurn = new Set();
    for (let i = 0; i <= tokens.length - 4; i++) {
      const gram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]} ${tokens[i + 3]}`;
      if (gram.length < 10) continue;
      seenInTurn.add(gram);
    }
    for (const gram of seenInTurn) {
      phraseTurnCounts.set(gram, (phraseTurnCounts.get(gram) || 0) + 1);
    }
  }

  let repeatedClusters = 0;
  for (const count of phraseTurnCounts.values()) {
    if (count >= 3) repeatedClusters++;
  }
  return repeatedClusters;
}

const CONTRAST_RE =
  /\bnot\s+(?:just\s+|only\s+|merely\s+|because\s+|with\s+)?[^.!?\n]{2,60}?[,\u2014—\-]\s*but\b/gi;
// Universal question mark check at end of turn (including inside closing quote/bracket across Latin, CJK, Arabic, Greek, Armenian)
const TRAILING_QUESTION_RE =
  /[?\uFF1F\u061F\u037E\u055E]\s*["'\u201D\u2019\u00BB\u300D\u300F）)\]]*\s*$/u;
const EMOTION_MIX_RE =
  /\b(?:a\s+)?(?:mixture|blend|cocktail|tangle|wash|surge)\s+of\s+[\w'-]+\s+and\s+[\w'-]+/gi;
const EXPLAINED_BEAT_RE =
  /\b(?:a\s+testament\s+to|as\s+if\s+to\s+say|seemed\s+to\s+say|reminder\s+that|realizing\s+that|knowing\s+full\s+well)\b/gi;
const TRIADS_RE =
  /\b[\w'-]+,\s+[\w'-]+,\s+and\s+[\w'-]+\b/gi;
const NEGATED_ACTION_RE =
  /\b(?:did\s+not|didn't|would\s+not|wouldn't|could\s+not|couldn't|refused\s+to)\s+(?:move|speak|answer|look|flinch|step|turn|blink|breathe|say)\b/gi;
const SIMILE_TIC_RE =
  /\b(?:like\s+a\s+|as\s+though\s+|as\s+if\s+|the\s+way\s+(?:a|an|water|light|shadow|wind|fire))\b/gi;

export const PROSE_TICS = [
  {
    id: "contrast",
    priority: 70,
    threshold: 2,
    message:
      "Avoid performative contrasts ('not with X, but with Y'). State actions directly.",
    test(replies, ctx) {
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        hits += (narrationOnly(r).match(CONTRAST_RE) || []).length;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "askedThePlayer",
    priority: 68,
    threshold: 3,
    message:
      "Stop ending turns with questions or prompting {{user}} for what to do next. End on an active beat.",
    test(replies) {
      let hits = 0;
      for (const r of replies) {
        if (TRAILING_QUESTION_RE.test(String(r || "").trim())) hits++;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "emotionMix",
    priority: 66,
    threshold: 1,
    message:
      "Avoid stacking contradictory emotional states in single compound sentences. Focus on physical reaction.",
    test(replies, ctx) {
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        hits += (narrationOnly(r).match(EMOTION_MIX_RE) || []).length;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "shrank",
    priority: 60,
    threshold: 3,
    message:
      "Avoid involuntary physical shrinking metaphors ('seemed to shrink', 'dwindled') or collapsing scene density. Ground posture in physical action.",
    test(replies, ctx) {
      const words = ctx?.replyWords || replies.map(countWords);
      if (words.length >= 3) {
        const earlier = words.slice(0, -2);
        const recent = words.slice(-2);
        const avgEarlier =
          earlier.reduce((a, b) => a + b, 0) / Math.max(1, earlier.length);
        const avgRecent =
          recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
        if (avgEarlier >= 90 && avgRecent < avgEarlier * 0.48) {
          return true;
        }
      }
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        if (/\b(?:seemed to shrink|shrank back|dwindled|curled inward)\b/i.test(r)) {
          hits++;
        }
      }
      return hits >= 1;
    },
  },
  {
    id: "explainedTheBeat",
    priority: 56,
    threshold: 3,
    message:
      "Show reactions through physical action and subtext rather than explaining emotional significance.",
    test(replies, ctx) {
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        hits += (narrationOnly(r).match(EXPLAINED_BEAT_RE) || []).length;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "triads",
    priority: 52,
    threshold: 2,
    message:
      "Vary sentence structures. Avoid pattern of three parallel adjectives/clauses.",
    test(replies, ctx) {
      if (ctx?.isEnglish) {
        let hits = 0;
        for (const r of replies) {
          hits += (narrationOnly(r).match(TRIADS_RE) || []).length;
        }
        if (hits >= this.threshold) return true;
      }
      return countCrossTurnNgramEchoes(replies) >= 2;
    },
  },
  {
    id: "negatedAction",
    priority: 48,
    threshold: 5,
    message:
      "State what characters do directly rather than describing actions they didn't take.",
    test(replies, ctx) {
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        hits += (narrationOnly(r).match(NEGATED_ACTION_RE) || []).length;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "simileTic",
    priority: 44,
    threshold: 4,
    message:
      "Reduce figurative similes ('like a...', 'as if...'). Ground description in direct sensory detail.",
    test(replies, ctx) {
      if (!ctx?.isEnglish) return false;
      let hits = 0;
      for (const r of replies) {
        hits += (narrationOnly(r).match(SIMILE_TIC_RE) || []).length;
      }
      return hits >= this.threshold;
    },
  },
  {
    id: "uniformBlocks",
    priority: 42,
    threshold: 1,
    message:
      "Vary paragraph lengths. Avoid uniform block structure across turns.",
    test(replies) {
      if (!Array.isArray(replies) || replies.length < 3) return false;
      const recent = replies.slice(-3);
      const paraCounts = recent.map(
        (r) =>
          String(r || "")
            .trim()
            .split(/\n\s*\n/)
            .filter(Boolean).length
      );
      if (paraCounts.every((c) => c >= 3 && c === paraCounts[0])) {
        const wordCounts = recent.map(countWords);
        const avg =
          wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
        const maxDev = Math.max(...wordCounts.map((w) => Math.abs(w - avg)));
        return avg > 60 && maxDev / avg < 0.12;
      }
      return false;
    },
  },
];

const FIRST_POV_RE = /\b(i|me|my|mine|myself)\b/gi;
const SECOND_POV_RE = /\b(you|your|yours|yourself|yourselves)\b/gi;
const THIRD_POV_RE =
  /\b(he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves)\b/gi;

const PAST_VERBS_RE =
  /\b(was|were|had|did|said|looked|turned|stepped|walked|felt|knew|took|gave|came|went|stood|sat|held|kept|watched|paused|nodded|pulled|pushed|reached)\b/gi;
const PRESENT_VERBS_RE =
  /\b(is|are|has|does|says|looks|turns|steps|walks|feels|knows|takes|gives|comes|goes|stands|sits|holds|keeps|watches|pauses|nods|pulls|pushes|reaches)\b/gi;

/**
 * Evaluates narrative POV and grammatical tense across recent turns.
 * Automatically disables English-specific pronoun/verb heuristics when the text is
 * non-Latin OR is a non-English Latin-script language (e.g. Indonesian, Spanish, French, German).
 */
export function detectNarration(messages = [], { window = 3 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { pov: null, tense: null };
  }

  const samples = messages
    .filter((m) => m && (typeof m === "string" || typeof m.content === "string"))
    .slice(-Math.max(1, window))
    .map((m) => narrationOnly(typeof m === "string" ? m : m.content))
    .filter(Boolean);

  if (samples.length === 0) {
    return { pov: null, tense: null };
  }

  const combined = samples.join("\n");
  if (!isLikelyEnglish(combined)) {
    return { pov: null, tense: null };
  }

  const povCounts = [
    { key: "first", count: (combined.match(FIRST_POV_RE) || []).length },
    { key: "second", count: (combined.match(SECOND_POV_RE) || []).length },
    { key: "third", count: (combined.match(THIRD_POV_RE) || []).length },
  ].sort((a, b) => b.count - a.count);

  const pov =
    povCounts[0].count >= 2 && povCounts[0].count - povCounts[1].count >= 2
      ? povCounts[0].key
      : null;

  const pastCount = (combined.match(PAST_VERBS_RE) || []).length;
  const presentCount = (combined.match(PRESENT_VERBS_RE) || []).length;
  const topTenseCount = Math.max(pastCount, presentCount);
  const tenseMargin = Math.abs(pastCount - presentCount);

  const tense =
    topTenseCount >= 2 && tenseMargin >= 2
      ? pastCount > presentCount
        ? "past"
        : "present"
      : null;

  return { pov, tense };
}

export function analyzeTurnState({
  messages = [],
  charName = "",
  playerName = "",
  castNames = [],
  folded = false,
} = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const assistantMessages = [];
  const userMessages = [];

  for (const msg of safeMessages) {
    if (!msg || typeof msg.content !== "string") continue;
    const cleaned = stripThoughtBlocks(msg.content).trim();
    if (!cleaned) continue;
    if (msg.role === "assistant") assistantMessages.push(cleaned);
    else if (msg.role === "user") userMessages.push(cleaned);
  }

  const recentAssistant = assistantMessages.slice(-ANALYSIS_WINDOW);
  const recentUser = userMessages.slice(-ANALYSIS_WINDOW);
  const replyWords = recentAssistant.map(countWords);
  const playerWords = recentUser.map(countWords);
  const latestReplyWords =
    replyWords.length > 0 ? replyWords[replyWords.length - 1] : 0;

  const combinedSample = [...recentAssistant, ...recentUser].join("\n");
  const latinScript = combinedSample ? latinShare(combinedSample) >= 0.6 : true;
  const isEnglish = isLikelyEnglish(combinedSample);

  let slopHits = 0;
  if (isEnglish) {
    for (const r of recentAssistant) {
      slopHits += (narrationOnly(r).match(SLOP_RE) || []).length;
    }
  } else {
    slopHits = countCrossTurnNgramEchoes(recentAssistant);
  }

  const ctx = {
    isEnglish,
    latinScript,
    replyWords,
    playerWords,
    charName,
    playerName,
  };

  const triggeredTics = [];
  for (const tic of PROSE_TICS) {
    if (typeof tic.test === "function" && tic.test(recentAssistant, ctx)) {
      triggeredTics.push(tic);
    }
  }
  triggeredTics.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const tics = triggeredTics.map((t) => t.id);

  const narration = detectNarration(
    recentAssistant.map((content) => ({ role: "assistant", content })),
    { window: 3 }
  );

  // Detect puppetBleed (assistant writing the player's actions/speech)
  let puppetBleed = false;
  const safePlayer = renderInlineField(playerName, 60);
  if (safePlayer && recentAssistant.length > 0) {
    const lastReply = recentAssistant[recentAssistant.length - 1];
    const escapedPlayer = escapeRegex(safePlayer);
    const puppetRe = new RegExp(
      `(?:^|\\n)\\s*${escapedPlayer}\\s*[:\\u2014\\-]|\\b${escapedPlayer}\\s+(?:says|said|asks|asked|thinks|thought|feels|felt|decides|decided|nods|nodded|steps|stepped)\\b`,
      "i"
    );
    puppetBleed = puppetRe.test(narrationOnly(lastReply));
  }

  // Detect absent ensemble cast members not mentioned in recent window
  const absentCast = [];
  if (Array.isArray(castNames) && castNames.length > 0 && recentAssistant.length >= 2) {
    const windowText = recentAssistant.join("\n").toLowerCase();
    for (const rawCast of castNames) {
      const name = renderInlineField(rawCast, 60);
      if (!name || name.toLowerCase() === String(charName || "").toLowerCase()) {
        continue;
      }
      if (!windowText.includes(name.toLowerCase())) {
        absentCast.push(name);
      }
    }
  }

  return {
    assistantTurns: assistantMessages.length,
    analyzed: recentAssistant.length,
    replyWords,
    latestReplyWords,
    latinScript,
    slopHits,
    tics,
    narration,
    puppetBleed,
    absentCast,
    folded: Boolean(folded),
    playerWords,
    playerTurns: userMessages.length,
    charName: renderInlineField(charName, 80),
    playerName: safePlayer,
  };
}

export function resolveGuidanceBudget(maxTokens = GUIDANCE_MAX_TOKENS) {
  const n = Number(maxTokens);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(GUIDANCE_MAX_TOKENS, Math.max(24, Math.floor(n)));
}

export function buildSceneGuidance(
  signals = {},
  { maxTokens = GUIDANCE_MAX_TOKENS, identity = "" } = {}
) {
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (budget <= 0 || !signals || typeof signals !== "object") {
    return { text: "", notes: [], tokens: 0 };
  }

  const charName = renderInlineField(signals.charName, 80) || "{{char}}";
  const playerName = renderInlineField(signals.playerName, 80) || "{{user}}";

  const candidateNotes = [];

  // 1. Highest priority: Player agency boundary if puppetBleed occurred
  if (signals.puppetBleed) {
    candidateNotes.push({
      priority: 95,
      text: `Agency boundary: write only ${charName} and the world; never narrate ${playerName}'s speech, actions, or internal thoughts.`,
    });
  }

  // 2. Periodic identity re-injection (only when identity is non-empty and turn interval hits)
  const cleanIdentity = renderInlineField(identity, 240);
  if (
    cleanIdentity &&
    signals.assistantTurns > 0 &&
    signals.assistantTurns % REINJECT_EVERY_TURNS === 0
  ) {
    candidateNotes.push({
      priority: 85,
      text: `Character anchor: ${cleanIdentity}`,
    });
  }

  // 3. Narrative POV & Tense lock (when reliably detected)
  if (signals.narration?.pov || signals.narration?.tense) {
    const parts = [];
    if (signals.narration.pov) parts.push(`${signals.narration.pov} person`);
    if (signals.narration.tense) parts.push(`${signals.narration.tense} tense`);
    candidateNotes.push({
      priority: 80,
      text: `Hold narrative stance: ${parts.join(", ")}.`,
    });
  }

  // 4. Triggered prose tic corrections
  if (Array.isArray(signals.tics) && signals.tics.length > 0) {
    const ticMap = new Map(PROSE_TICS.map((t) => [t.id, t]));
    for (const ticId of signals.tics) {
      const def = ticMap.get(ticId);
      if (!def) continue;
      const rendered = baseSubstitutePlaceholders(def.message, {
        user: playerName,
        char: charName,
      });
      candidateNotes.push({
        priority: def.priority || 50,
        text: rendered,
      });
    }
  }

  // 5. Slop cluster suppression
  if ((Number(signals.slopHits) || 0) >= SLOP_CLUSTER_THRESHOLD) {
    candidateNotes.push({
      priority: 54,
      text: "Drop stock melodrama clichés and repetitive bodily tropes; ground beats in fresh, specific physical detail.",
    });
  }

  // 6. Ensemble cast presence reminder
  if (Array.isArray(signals.absentCast) && signals.absentCast.length > 0) {
    const names = signals.absentCast.slice(0, 3).join(", ");
    candidateNotes.push({
      priority: 40,
      text: `Keep active secondary cast (${names}) present in the room when the scene includes them.`,
    });
  }

  candidateNotes.sort((a, b) => b.priority - a.priority);

  const selectedNotes = [];
  let currentText = "";

  for (const item of candidateNotes) {
    const nextNotes = [...selectedNotes, item.text];
    const nextText = nextNotes.join(" ");
    if (estimateTokens(nextText) <= budget) {
      selectedNotes.push(item.text);
      currentText = nextText;
    }
  }

  return {
    text: currentText,
    notes: selectedNotes,
    tokens: estimateTokens(currentText),
  };
}
