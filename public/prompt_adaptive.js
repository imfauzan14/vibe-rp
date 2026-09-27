// Adaptive steering: the per-turn instruction layer derived from the session.
//
// Why this module exists
// ---------------------
// Two measured facts decide the whole design:
//
//   1. Persona and instruction adherence decay over a long conversation, and
//      the decay is *specific*: the model does not forget who it is in general,
//      it starts doing particular things (ending every reply on a question,
//      shrinking to one paragraph, letting the narrator explain a beat it just
//      showed, reusing one construction). Leins et al., "Prompting Against
//      Persona Drift" (arXiv:2609.24532, 2026) compared five prompt-level
//      interventions across 1,200 dialogues: re-injecting the persona cut drift
//      35-38%, a generic reflective reminder 22-27%, and a *behavior-specific*
//      instruction produced by a monitor 87%. None eliminated it. The monitor —
//      deciding *what* to correct — is where the gain lives; their results also
//      found no benefit from adaptive *timing* over a fixed schedule.
//
//   2. The static instruction layer cannot be the whole answer. Anthropic's
//      context-engineering guidance (context rot: recall degrades as the window
//      fills) and Luz de Araujo et al., EACL 2026 ("Persistent Personas?") both
//      point the same way: instruction-following and persona fidelity trade off
//      against each other as the prompt grows, so a longer prefix is not a
//      better one, and the lines nearest the generation head weigh most.
//
// So the prefix holds *craft* (how this story is written) and this module holds
// *state* (what this session is doing right now). Everything here is derived
// deterministically from the transcript — no extra request — and it is emitted
// at the tail, immediately before the reply, so it corrects behavior at the
// recency position without invalidating the cached prefix.
//
// Zero cost when the session is healthy: the scope and lock lines are always
// present (the measured re-injection tier, ~40 tokens), while every
// behavior-specific correction is gated on a repeated, measured pattern in the
// model's own recent output. A single stray tic is not a correction; a streak
// is. The phrase lexicon is skipped entirely when the story is not in English,
// because an English ban list cannot describe a Japanese sentence.
//
// Pure and DOM-free: the result depends only on the arguments, so the same
// session yields the same guidance in the tests, in the context inspector, and
// on the wire.
//
// Exports
//   analyzeTurnState     the session signals (what is drifting, if anything)
//   buildSceneGuidance   those signals as a compact instruction block
//   detectNarration      POV/tense reading of the newest replies
//   PROSE_TICS           the named, checkable defect detectors
//   SLOP_LEXICON         overused phrases (English, cluster-gated)
//   GUIDANCE_MAX_TOKENS  the ceiling the block is clamped to

import { stripThoughtBlocks, renderInlineField } from "./text.js";
import { estimateTokens } from "./context_plan.js";

/** Hard ceiling for the whole block. It is a correction, not a second preset. */
export const GUIDANCE_MAX_TOKENS = 320;
/** Assistant turns between persona re-injections (the measured reinjection tier). */
export const REINJECT_EVERY_TURNS = 8;
/** Replies inspected when looking for a repeated defect. */
export const ANALYSIS_WINDOW = 6;

const countMatches = (text, re) => (text.match(re) || []).length;

/**
 * Quoted spans carry the *character's* voice, not the narration's, so they are
 * removed before any narrator-level measurement (POV, tense, paragraph shape).
 * Straight and typographic quotes are both handled; an unterminated quote runs
 * to the end of the text, which is the conservative reading.
 */
export function narrationOnly(text) {
  return String(text || "")
    .replace(/"[^"]*"/g, " ")
    .replace(/\u201C[^\u201D]*\u201D/g, " ")
    .replace(/\u00AB[^\u00BB]*\u00BB/g, " ");
}

/** Latin-letter share of a text's letters; 0 when it holds no letters at all. */
export function latinShare(text) {
  const letters = String(text || "").match(/\p{L}/gu) || [];
  if (letters.length === 0) return 0;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length;
}

/** Word count, script-agnostic, so length signals work in any language. */
export function countWords(text) {
  return (String(text || "").match(/[\p{L}\p{N}'\u2019-]+/gu) || []).length;
}

/**
 * The named prose defects worth correcting, each with the smallest reliable
 * signature and the threshold at which a signature stops being style and starts
 * being a tic. Sources: NousResearch's anti-pattern reference (structural tics,
 * which word lists cannot see), the community slop lexicons, and EQ-Bench's
 * finding that the "not X, but Y" contrast is the single most-cited marker.
 *
 * These are *constructions*, not adjectives. A model cannot act on "write with
 * more tension", but it can stop opening a beat with "not because X, but
 * because Y" — and the fix is checkable on read-through.
 */
export const PROSE_TICS = [
  {
    id: "contrast",
    priority: 70,
    threshold: 2,
    note: 'Cut the "not X, but Y" contrast construction; the last replies lean on it. Say the true thing once, directly.',
    count: (text) => countMatches(text, /\bnot\s+(?:just\s+|only\s+|merely\s+|because\s+)?[^.!?\n]{2,60}?[,\u2014\u2013-]\s*(?:but|it'?s|they'?re|he'?s|she'?s|that'?s)\b/gi),
  },
  {
    id: "emotionMix",
    priority: 66,
    threshold: 1,
    note: 'No emotional cocktails ("a mix of dread and relief"). Name the one feeling and let the body carry it.',
    count: (text) => countMatches(text, /\b(?:a|the)\s+(?:mix|mixture|blend|combination|flood|wave)\s+of\s+\w+(\s+\w+)?\s+and\s+\w+/gi),
  },
  {
    id: "askedThePlayer",
    priority: 68,
    threshold: 3,
    note: "The last replies each ended by handing the scene back. Land on a line, an action, or a silence instead of a question to the player.",
    count: (_text, replies) => replies.filter((r) => /\?\s*$/.test(r.trim())).length,
  },
  {
    id: "shrank",
    priority: 60,
    threshold: 3,
    // A reply that is short is a choice. Three short replies in a row while the
    // player is still writing paragraphs is a decay: the scene stops building.
    // Growth from the session's own earlier replies counts as decay too, which
    // catches a session that opened long and tapered off.
    note: "Calibrate response depth to match the scene's dramatic momentum. Expand into physical presence, dialogue nuance, and immediate consequence rather than collapsing into brief exchanges.",
    count: (_text, replies, context = {}) => {
      const short = replies.filter((r) => countWords(r) < 70);
      if (short.length < 3) return 0;
      const tapered = replies.length >= 3 && countWords(replies[0]) >= countWords(replies[replies.length - 1]) * 1.5;
      const outwritten = (context.playerWords || 0) >= Math.max(40, (context.medianReplyWords || 0) * 1.5);
      return tapered || outwritten ? short.length : 0;
    },
  },
  {
    id: "triads",
    priority: 52,
    threshold: 2,
    note: "Vary syntactic structure. Favor one striking, concrete detail over predictable three-item series.",
    count: (text) => countMatches(text, /\b[\w'-]+,\s+[\w'-]+,\s+and\s+[\w'-]+/gi),
  },
  {
    id: "simileTic",
    priority: 44,
    threshold: 4,
    note: 'Drop the "the way ..." similes. Trust the image already on the page.',
    count: (text) => countMatches(text, /\bthe way\b/gi),
  },
  {
    id: "negatedAction",
    priority: 48,
    threshold: 5,
    note: 'Too many "did not / would not" negations. Show the action that did happen.',
    count: (text) => countMatches(text, /\b(?:did not|didn'?t|does not|doesn'?t|had not|hadn'?t|would not|wouldn'?t|will not|won'?t)\b/gi),
  },
  {
    id: "explainedTheBeat",
    priority: 56,
    threshold: 3,
    note: "The narration is explaining what the scene already showed. Let the gesture, the silence, and the consequence land uninterpreted.",
    count: (text) => countMatches(text, /\b(?:seemed to|felt a (?:pulse|twinge|chill|surge|wave)|sensed (?:a|the)|was (?:afraid|terrified|furious|relieved|overwhelmed)|a flicker of|something in (?:his|her|their) (?:eyes|voice|chest))\b/gi),
  },
  {
    id: "uniformBlocks",
    priority: 42,
    threshold: 1,
    note: "Vary paragraph lengths to match dramatic pacing: sharp single lines for pivotal beats and expansive passages for atmospheric immersion.",
    count: (_text, replies) => {
      for (const reply of replies.slice(0, 3)) {
        const lengths = reply.split(/\n{2,}/).map((p) => countWords(p)).filter((n) => n > 0);
        if (lengths.length < 3) continue;
        const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        if (mean <= 0) continue;
        const spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length) / mean;
        if (spread < 0.3) return 1;
      }
      return 0;
    },
  },
];

/**
 * Overused phrases ("slop"), matched case-insensitively as whole words.
 * Confidence comes from clustering, never from a single hit: the community
 * measurement is explicit that one "murmured" is prose and five in a scene is a
 * fingerprint, and that a clean single reply is not evidence of anything.
 * The threshold is per analysis window, across every inspected reply.
 */
export const SLOP_LEXICON = [
  "shiver", "shivers", "shudder", "swallowed hard", "breath hitched", "breath caught",
  "barely above a whisper", "barely a whisper", "husky", "purr", "purred", "chuckled darkly",
  "sparkling with mischief", "half-lidded", "smirk", "smirked", "knuckles", "adam's apple",
  "ministrations", "a testament to", "testament to", "little did", "unbeknownst",
  "predatory", "down her spine", "down his spine", "heart hammered", "eyes never leaving",
  "voice thick with", "dripping with", "a dance of", "chaos of emotions",
];
/** Hits per window before the lexicon contributes a correction. */
export const SLOP_CLUSTER_THRESHOLD = 4;
const SLOP_RE = new RegExp(
  `\\b(?:${SLOP_LEXICON.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi"
);

/**
 * Point of view and tense, read from the narration of the newest replies.
 *
 * Deliberately conservative. Quoted speech is stripped first (it carries the
 * character's voice, not the narrator's), a claim needs several hits *and* a
 * clear margin over the runner-up, the newest replies must agree in the
 * majority, and a non-Latin story yields no reading at all. When the call is
 * ambiguous nothing is emitted: a wrong narrative lock is worse than none,
 * because the model obeys it.
 */
export function detectNarration(messages, { window = 3 } = {}) {
  const replies = (messages || [])
    .filter((m) => m && m.role !== "user" && m.content)
    .slice(-window)
    .map((m) => narrationOnly(stripThoughtBlocks(String(m.content))));
  const joined = replies.join("\n");
  if (!joined.trim() || latinShare(joined) < 0.6) return { pov: null, tense: null };

  const votes = [];
  for (const text of replies) {
    const first = countMatches(text, /\b(?:I|I'm|I've|I'd|I'll|my|mine|myself|we|our|ours)\b/gi);
    const second = countMatches(text, /\b(?:you|your|yours|yourself)\b/gi);
    const third = countMatches(text, /\b(?:he|she|they|him|her|his|hers|their|them)\b/gi);
    const ranked = [first, second, third].sort((a, b) => b - a);
    if (ranked[0] < 2 || ranked[0] < ranked[1] * 1.5) continue;
    votes.push(ranked[0] === first ? "first" : ranked[0] === second ? "second" : "third");
  }
  const pov = majorityOf(votes, votes.length >= 2);

  const past = countMatches(
    joined,
    /\b(?:was|were|had|did|could|would|said|took|felt|went|came|saw|knew|thought|turned|looked|\w{4,}ed)\b/gi
  );
  const present = countMatches(
    joined,
    /\b(?:is|are|has|does|am|looks|feels|says|takes|goes|comes|sees|knows|turns|\w{4,}s)\b/gi
  );
  let tense = null;
  if (Math.max(past, present) >= 4) {
    if (past >= present * 1.3) tense = "past";
    else if (present >= past * 1.3) tense = "present";
  }
  return { pov, tense };
}

/** Majority vote, or null when it is required but absent or tied. */
function majorityOf(votes, required) {
  if (!required) return null;
  const tally = new Map();
  for (const vote of votes) tally.set(vote, (tally.get(vote) || 0) + 1);
  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [key, count] of tally) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}



/**
 * Everything the guidance layer needs to know about the session's current
 * behavior, measured from the transcript alone.
 *
 * Never mutates its input and never throws on a malformed session: a missing
 * field yields an empty signal, never a broken turn.
 */
export function analyzeTurnState({
  messages = [],
  charName = "",
  playerName = "",
  castNames = [],
  folded = false,
} = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.content);
  const assistant = list.filter((m) => m.role !== "user");
  const replies = assistant
    .slice(-ANALYSIS_WINDOW)
    .map((m) => stripThoughtBlocks(String(m.content)).trim())
    .filter(Boolean);
  const recent = replies.slice(-3).join("\n");
  const player = renderInlineField(playerName, 60);

  // Player-voice bleed: an assistant turn that opens a line with the player's
  // own name as a dialogue tag is speaking for the reader. It is the one defect
  // the transcript teaches the model to repeat, so it is always named.
  const puppetPattern = player
    ? new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${player.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\*\\*)?\\s*:`, "i")
    : null;
  const puppetBleed = puppetPattern ? replies.filter((r) => puppetPattern.test(r)).length : 0;

  const present = new Set();
  if (castNames.length > 0 && recent) {
    const lower = recent.toLowerCase();
    for (const name of castNames) {
      const clean = String(name || "").trim().toLowerCase();
      if (clean && lower.includes(clean)) present.add(clean);
    }
  }
  const absentCast = castNames
    .map((name) => String(name || "").trim())
    .filter((name) => name && !present.has(name.toLowerCase()))
    .slice(0, 4);

  const english = latinShare(recent) >= 0.6;
  const userTurns = list.filter((m) => m.role === "user");
  const replyWords = replies.map(countWords);
  const sortedWords = replyWords.slice().sort((a, b) => a - b);
  const playerWords = countWords(userTurns.length ? userTurns[userTurns.length - 1].content : "");
  const ticContext = {
    playerWords,
    medianReplyWords: sortedWords.length ? sortedWords[Math.floor(sortedWords.length / 2)] : 0,
  };
  const tics = [];
  if (english) {
    for (const tic of PROSE_TICS) {
      const hits = tic.count(recent, replies, ticContext);
      if (hits >= tic.threshold) tics.push({ id: tic.id, priority: tic.priority, note: tic.note, hits });
    }
  }

  return {
    assistantTurns: assistant.length,
    analyzed: replies.length,
    replyWords,
    latestReplyWords: replyWords.length ? replyWords[replyWords.length - 1] : 0,
    english,
    slopHits: english ? countMatches(recent, SLOP_RE) : 0,
    tics,
    narration: detectNarration(list),
    puppetBleed,
    absentCast,
    folded: Boolean(folded),
    playerWords,
    playerTurns: userTurns.length,
    charName: renderInlineField(charName, 60),
    playerName: player,
  };
}

/**
 * The instruction block for one turn, or an empty string when there is nothing
 * worth saying beyond the always-on scope line.
 *
 * Order is deliberate. The unconditional lines (canon, scope, re-injection,
 * narrative lock) come first; the behavior-specific corrections follow in
 * ascending priority, so the most urgent one sits last — nearest the generation
 * head, where recency weight is greatest. When the allowance is tight the
 * lowest-priority entry is dropped first, which is why the measured
 * behavior-specific corrections outlive the generic lines.
 *
 * `identity` is a compact restatement of who the character is, built by the
 * engine from the card (this module never reads a card). `notes` lists every
 * rule that fired, so the context inspector can show *why* the block exists.
 */
export function buildSceneGuidance(signals, { maxTokens = GUIDANCE_MAX_TOKENS, identity = "" } = {}) {
  const s = signals || {};
  const who = s.charName || "the character";
  const player = s.playerName || "the player";
  const entries = [];
  // `priority` orders the text (ascending, so the last line sits nearest the
  // generation head and carries the most recency weight). `keep` decides what
  // survives a tight allowance (higher survives): a functional failure of agency
  // outranks prose polish, and the lane statement outranks everything but the
  // correction that rescues it.
  const add = (id, keep, text) => entries.push({ id, keep, text });

  // Canon declaration. Measured effect: labeling prior turns as settled canon,
  // rather than as text to draw style from, took one model from restarting
  // 20 rounds out of 20 to none.
  if (s.folded) {
    add(
      "canon",
      92,
      "- The ledger and transcript above are settled canon: they already happened. Continue from the last line of the transcript, and never rewind, restart, or re-narrate an earlier beat."
    );
  }

  // Turn scope as a lane rather than a prohibition: the model is told what to
  // write, not only what to avoid, which is the difference between scope
  // control and hoping.
  add(
    "scope",
    96,
    `- Turn scope: Write ${who} and immediate environmental consequence. Perceive ${player} strictly through observable physical cues, and stop cleanly where ${player} must act or speak.`
  );

  // Prose corrections, least urgent first. They are the measured
  // behavior-specific tier: the correction names what the model is doing, so it
  // can stop doing it.
  const corrections = (s.tics || []).slice().sort((a, b) => a.priority - b.priority);
  if ((s.absentCast || []).length >= 2 && !s.folded) {
    corrections.push({
      id: "silentCast",
      priority: 30,
      keep: 30,
      note: `- ${s.absentCast.join(", ")} ${s.absentCast.length === 1 ? "is" : "are"} present but silent. Give the scene their reaction, or let them leave the room.`,
    });
  }
  // The lexicon is a cluster, never a word: a correction that recited the
  // phrases would teach them as much as it forbade them.
  if (s.slopHits >= SLOP_CLUSTER_THRESHOLD) {
    corrections.push({
      id: "slopLexicon",
      priority: 62,
      keep: 62,
      note: "- Stock phrasing is clustering in the recent replies. Reach past it: the specific object, the specific gesture, the word this character would actually use.",
    });
  }
  corrections.sort((a, b) => a.priority - b.priority);
  for (const correction of corrections) {
    add(correction.id, correction.keep ?? correction.priority, `- ${correction.note.replace(/^\s*-\s*/, "")}`);
  }

  // The drift anchors sit closest to the head: re-injection is the measured
  // generic-reminder tier (35-38%), the lock keeps the narrative register from
  // sliding, and the lane statement is the last thing the model reads.
  const dueForReinject = s.assistantTurns > 0 && s.assistantTurns % REINJECT_EVERY_TURNS === 0;
  if (identity && (dueForReinject || s.folded)) add("reinject", 83, `- Persona anchor: Ground ${who}'s responses in their core psychological drivers, distinctive vocabulary, and established friction (${identity}). Never soften into bland compliance.`);

  const { pov, tense } = s.narration || {};
  if ((pov || tense) && s.assistantTurns >= 2) {
    const bits = [
      pov === "first" ? "first-person" : pov === "second" ? "second-person" : pov === "third" ? "third-person" : "",
      tense ? `${tense} tense` : "",
    ].filter(Boolean);
    add(
      "lock",
      85,
      `- Narrative lock: the scene has been running in ${bits.join(", ")}. Keep it, and keep the same separation between narration and speech.`
    );
  }

  if (s.puppetBleed > 0) {
    add(
      "puppet",
      100,
      `- Hard agency boundary: An earlier turn spoke for ${player}. Never write dialogue, thoughts, sensations, or actions for ${player}; end cleanly where their turn begins.`
    );
  }

  let kept = entries.slice().sort((a, b) => a.priority - b.priority);
  let text = kept.map((entry) => entry.text).join("\n");
  while (estimateTokens(text) > maxTokens && kept.length > 0) {
    // Lowest survival rank loses first; an empty block beats an oversized one.
    let victim = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].keep < kept[victim].keep) victim = i;
    }
    kept.splice(victim, 1);
    text = kept.map((entry) => entry.text).join("\n");
  }
  const trimmed = text.trim();
  return {
    text: trimmed,
    // Reported in text order, so the inspector reads the same way the model does.
    notes: trimmed ? kept.map((entry) => entry.id) : [],
    tokens: trimmed ? estimateTokens(trimmed) + 4 : 0,
  };
}
