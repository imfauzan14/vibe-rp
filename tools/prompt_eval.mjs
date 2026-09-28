// Prompt evaluation harness.
//
// The repo tests plumbing thoroughly and prompt *quality* not at all, so no
// prompt change can be shown to help. This closes that loop.
//
// Two modes, and the first one always runs:
//
//   structural (offline, no endpoint)  — measures the assembled payloads:
//     instruction cost, the instruction-to-content ratio, prohibition density,
//     which degradable sections survive, and instruction pairs that co-occur.
//     This is deterministic, so it is a real regression gate.
//
//   live (--live, needs an endpoint)   — generates against the configured
//     endpoint and scores the output with deterministic detectors reused from
//     the app itself (PROSE_TICS, SLOP_LEXICON, detectNarration), plus agency
//     and handoff checks. Use --baseline/--compare to diff two runs.
//
// Usage
//   bun run tools/prompt_eval.mjs                      # structural only
//   bun run tools/prompt_eval.mjs --json report.json    # save a run
//   bun run tools/prompt_eval.mjs --compare old.json    # diff against a run
//   bun run tools/prompt_eval.mjs --live --runs 3       # score real output
//
// Live configuration (never read from the app's localStorage — this is a
// separate process): --endpoint, --key, --model, or the env vars
// VIBE_RP_ENDPOINT / VIBE_RP_API_KEY / VIBE_RP_MODEL.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BrowserChatEngine, estimateTokens,
  SUMMARY_PROMPT, SUMMARY_UPDATE_PROMPT, SUMMARY_SYSTEM_PROMPT, LEDGER_COMPRESS_PROMPT,
} from "../public/browser_engine.js";
import { DEFAULT_SETTINGS, DEFAULT_AGENTS_CONTRACT, DEFAULT_AGENTS_CONTRACT_ID } from "../public/local_db.js";
import { CHOICE_SYSTEM_PROMPT, choicePrompt } from "../public/choice_format.js";
import { PROSE_TICS, SLOP_LEXICON, detectNarration } from "../public/prompt_adaptive.js";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const filler = (n) => ("The cartographer traced the dead city's spine. ".repeat(Math.ceil(n / 10) + 1)).slice(0, n * 6);

// The built-in persona, read from the app rather than retyped here: a change to
// the default must show up in this harness without an edit. The store seeds
// from its factory, so the factory is the source of truth.
const DEFAULT_PERSONA_RESOLVED = (() => {
  const raw = globalThis.localStorage?.getItem("vibe_rp_personas");
  if (raw) {
    try {
      const list = JSON.parse(raw);
      const found = list.find((p) => p?.id === "persona_default");
      if (found?.description) return found.description;
    } catch {}
  }
  // No localStorage in this process: fall back to the shipped default text.
  return (
    "The viewpoint protagonist: the reader's own character, present in the scene and " +
    "perceiving it from their own point of view. Their turn is written from that " +
    'perspective — first person ("I") unless their turn establishes otherwise.'
  );
})();

// ───────────────────────── scenarios ─────────────────────────
// One fixed set, so a before/after diff compares like with like.

const PERSONA = { name: "Rowan", description: "A field engineer with a bad shoulder and a worse temper." };

function card({ preset = 300, examples = true, lore = true, roster = false } = {}) {
  return {
    id: "eval-card",
    data: {
      name: "Elena Voss",
      description: filler(preset),
      personality: filler(Math.round(preset / 3)),
      scenario: filler(Math.round(preset / 3)),
      system_prompt: filler(Math.round(preset / 4)),
      mes_example: examples ? "<START>\n{{user}}: hello\n{{char}}: " + filler(200) : "",
      character_book: lore
        ? { entries: [{ keys: [], content: "CONSTANT LORE " + filler(250), constant: true, enabled: true, insertion_order: 100 }] }
        : undefined,
      extensions: roster ? { group: { members: [{ name: "Marek Idris", description: filler(40) }] } } : undefined,
    },
  };
}

function session({ turns = 6, folded = false, reply = "normal" } = {}) {
  const messages = [{ role: "user", content: "I step into the archive and wait." }];
  const replies = {
    normal: () => "She did not look up from the ledger. The lamp guttered, and somewhere below a door closed on its own.",
    tics: () => "The silence was a mix of dread and relief. She did not answer, did not move, and did not look at him. He seemed to feel a pulse of something.",
    triads: () => "She set the lamp, the ledger, and the key down. Outside, the wind, the rain, and the cold pressed at the glass.",
    short: () => "She looked away.",
    uniform: () => [
      "The archive breathed around them, dust turning slowly in the grey light that fell from the high windows above the reading desks.",
      "She moved between the shelves with the practised quiet of someone who had spent a decade learning where the floorboards complained.",
      "He waited by the door and listened to the building settle, the timbers ticking as the last of the day's warmth left the stone walls.",
    ].join("\n\n"),
  };
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: filler(70) });
    messages.push({ role: "assistant", content: replies[reply]() });
  }
  messages.push({ role: "user", content: "I set my hand flat on the desk and wait for her to look up." });
  return {
    id: "eval-session",
    cardId: "eval-card",
    messages,
    ledger: folded ? filler(400) : "",
    consumed: folded ? 4 : 1,
  };
}

const SCENARIOS = [
  { name: "rp/small-preset", card: card({ preset: 150 }), session: session({ turns: 3 }), persona: PERSONA },
  { name: "rp/medium-preset", card: card({ preset: 600 }), session: session({ turns: 8 }), persona: PERSONA },
  { name: "rp/large-preset", card: card({ preset: 3000 }), session: session({ turns: 20 }), persona: PERSONA },
  { name: "rp/no-degradables", card: card({ preset: 400, examples: false, lore: false }), session: session({ turns: 5 }), persona: PERSONA },
  { name: "rp/ensemble-cast", card: card({ preset: 400, roster: true }), session: session({ turns: 5 }), persona: PERSONA },
  { name: "rp/folded-ledger", card: card({ preset: 400 }), session: session({ turns: 10, folded: true }), persona: PERSONA },
  { name: "rp/no-persona", card: card({ preset: 400 }), session: session({ turns: 5 }), persona: null },
  // The shipped default: an unnamed persona whose whole job is role and
  // perspective. This is the scenario the default-system-prompt work is
  // measured against, so it is its own row rather than folded into PERSONA.
  { name: "rp/default-persona", card: card({ preset: 400 }), session: session({ turns: 5 }), persona: null, defaultPersona: true },
  { name: "rp/tics-clustering", card: card({ preset: 400 }), session: session({ turns: 6, reply: "tics" }), persona: PERSONA },
  { name: "rp/triads", card: card({ preset: 400 }), session: session({ turns: 6, reply: "triads" }), persona: PERSONA },
  { name: "rp/short-replies", card: card({ preset: 400 }), session: session({ turns: 6, reply: "short" }), persona: PERSONA },
  { name: "rp/uniform-blocks", card: card({ preset: 400 }), session: session({ turns: 6, reply: "uniform" }), persona: PERSONA },
  { name: "rp/window-8192", card: card({ preset: 400 }), session: session({ turns: 6 }), persona: PERSONA, window: 8192 },
  { name: "rp/window-2048", card: card({ preset: 400 }), session: session({ turns: 6 }), persona: PERSONA, window: 2048 },
  // The Indonesian built-in directive. Same craft, Indonesian instruction text,
  // so it is a different contract rather than a different scenario shape.
  { name: "rp/contract-id", card: card({ preset: 400 }), session: session({ turns: 5 }), persona: PERSONA, contract: "id" },
];

const contractFor = (s) => (s?.contract === "id" ? DEFAULT_AGENTS_CONTRACT_ID : DEFAULT_AGENTS_CONTRACT);

const settingsFor = (s) => ({
  ...DEFAULT_SETTINGS,
  apiEndpoint: opt("endpoint", process.env.VIBE_RP_ENDPOINT || ""),
  apiKey: opt("key", process.env.VIBE_RP_API_KEY || ""),
  model: opt("model", process.env.VIBE_RP_MODEL || ""),
  maxTokens: 1200,
  agentsContract: contractFor(s),
  ...(s.window ? { maxContextTokens: s.window } : {}),
});

// ───────────────────────── structural metrics ─────────────────────────

const NEGATIVE_RE = /\b(?:never|do not|don't|must not|avoid|refrain|without|no )\b/gi;
const ABSOLUTIST_RE = /\b(?:never|strict|non-negotiable|unyielding|mandatory|invariant|must|always|immediately)\b/gi;

function instructionDensity(text) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const neg = (String(text).match(NEGATIVE_RE) || []).length;
  const abs = (String(text).match(ABSOLUTIST_RE) || []).length;
  return {
    words: String(text).split(/\s+/).filter(Boolean).length,
    lines: lines.length,
    negativeMarkers: neg,
    absolutistMarkers: abs,
    negativePerLine: lines.length ? +(neg / lines.length).toFixed(3) : 0,
  };
}

// Instruction pairs that must not both appear in one request. A pair is only
// reported when BOTH sides are found in the same assembled payload.
//
// The regexes track the current wording. When a prompt is reworded these must be
// updated in the same change, or the gate silently stops checking anything.
const CONFLICT_PAIRS = [
  { id: "name-known-vs-unknown", kind: "reconciled-by-design",
    a: /\[User Persona: Rowan\]/, b: /must NOT know or call them by their persona name/ },
  { id: "mirror-vs-expand", kind: "competing calibration",
    a: /match the reader's density, sentence length, and register/,
    b: /Write into the scene's momentum/ },
  { id: "density-vs-momentum", kind: "competing calibration",
    a: /scale description to the world the reader built/,
    b: /Write into the scene's momentum/ },
  { id: "handoff-duplicated", kind: "redundancy",
    a: /on the beat — not on a question to the reader/, b: /handing the scene back with a question/ },
  // The authority rule has one home: the contract. The engine's fixed sections
  // used to restate it ("the User Persona and System Directives are the active
  // authority..."), so both sides of this pair could appear in one request.
  // The restatement was removed entirely rather than translated, so the rule now
  // appears once, in the contract, and never in an engine-authored section.
  //
  // The pair matches the *rule*, not one section's old heading: the previous
  // pattern keyed on "[Operational Precedence" and went inert the moment that
  // section was renamed. Naming a heading in a gate is how a gate stops working.
  { id: "authority-stated-twice", kind: "redundancy",
    a: /are the active authority/, b: /govern language, register, and medium/ },
  // NOTE: an earlier version of this list paired the contract's "don't restate
  // the player's own input" with the guidance's "don't rewind the story". Those
  // are different failure modes — restating the player's words vs rewinding the
  // narrative — so they are complementary rather than duplicated, and the pair
  // was mis-specified. Removed rather than left to report a false positive.
];

// A rule that was previously stated in two places with different wording is a
// single-definition failure: the payload carries two versions and the model has
// to reconcile them. Each entry asserts a phrase is present exactly N times.
//
// Patterns must be placeholder-free: {{user}}/{{char}} are substituted with real
// names before the payload exists, so a pattern containing one can never match.
const SINGLE_DEFINITION = [
  { id: "interiority-boundary-in-contract", re: /inner life are theirs/g, expect: 1 },
  { id: "no-duplicate-agency-prohibition", re: /physical sensations, or inner thoughts/g, expect: 0 },
  { id: "no-duplicate-observable-rule", re: /DO realistically perceive and react/g, expect: 0 },
  { id: "turn-boundary-stated-once", re: /stop cleanly where .* must act or speak/g, expect: 0 },
  // The persona's identity claim moved to the contract. Keeping the old
  // phrasing here would let it return unnoticed.
  { id: "persona-no-identity-restatement", re: /Operates with distinct agency, physical presence/g, expect: 0 },
];
// The Indonesian contract carries the same obligation in Indonesian, so the
// one English-literal check above cannot be applied to it. Keyed by contract,
// not by scenario: what varies is which contract is loaded, and the check is a
// property of that text.
const SINGLE_DEFINITION_ID = [
  { id: "interiority-boundary-in-contract", re: /batin .{0,12}sepenuhnya miliknya/g, expect: 1 },
];
const singleDefFor = (s) => (s?.contract === "id" ? SINGLE_DEFINITION_ID : SINGLE_DEFINITION);
// Checking that a rule left the *contract* cannot be done against the assembled
// payload, because the persona slot is allowed to say it and the payload cannot
// tell the two apart. `reader-identity-not-in-contract` therefore asserts on the
// contract text itself, once, rather than per scenario — the distinction the
// whole layer split turns on is *which slot* a rule lives in.
const CONTRACT_SINGLE_DEFINITION = [
  { id: "reader-identity-not-in-contract", re: /viewpoint protagonist|distinct agency/g, expect: 0 },
  { id: "authority-in-contract", re: /govern language, register, and medium/g, expect: 1 },
];

// The two built-in contracts are alternatives, never a stack, so the risk is
// not duplication but *divergence*: the Indonesian one drifting into a lesser
// prompt as the English one gains rules. Each entry names one obligation and
// the phrase that carries it in each language. A missing phrase is a rule that
// did not survive translation; that is the failure this catches.
//
// Matching on a phrase rather than on meaning is deliberate and is the same
// trade every pattern in this file makes: it is checkable. When a rule is
// legitimately reworded, both patterns move together in the same commit.
const BILINGUAL_PARITY = [
  { id: "agency", en: /actions, dialogue, and inner life are theirs/i, id_re: /tindakan, dialog, dan batin/i },
  { id: "turn-shape", en: /stop on the beat/i, id_re: /berhenti tepat di babak itu/i },
  { id: "medium", en: /set the medium/i, id_re: /menentukan medium/i },
  { id: "authority", en: /govern language, register, and medium/i, id_re: /memegang kendali atas bahasa, register, dan medium/i },
  { id: "closed-fiction", en: /the fiction stays closed/i, id_re: /Dunia cerita itu tertutup/i },
  { id: "core-holds-state-moves", en: /core holds under pressure/i, id_re: /bertahan saat ditekan/i },
  { id: "voice-matching", en: /match the reader's density/i, id_re: /ikuti kerapatan/i },
  { id: "tension", en: /follow the stakes/i, id_re: /ikuti taruhan/i },
  { id: "subtext", en: /Dialogue carries subtext/i, id_re: /maksud tersembunyi/i },
  { id: "actions-persist", en: /Actions persist/i, id_re: /Tindakan menetap/i },
  { id: "relationships-earned", en: /Relationships are earned/i, id_re: /Hubungan diperoleh/i },
  { id: "story-moves", en: /The story moves/i, id_re: /Cerita bergerak/i },
  { id: "knowledge-bounded", en: /Knowledge is bounded/i, id_re: /Pengetahuan terbatas/i },
  { id: "prefer-specific", en: /Prefer the specific/i, id_re: /Pilih yang spesifik/i },
];

function checkBilingualParity() {
  const missing = [];
  for (const row of BILINGUAL_PARITY) {
    const inEn = row.en.test(DEFAULT_AGENTS_CONTRACT);
    const inId = row.id_re.test(DEFAULT_AGENTS_CONTRACT_ID);
    // A rule present in one and not the other is divergence, in either
    // direction — including a rule the Indonesian contract carries alone.
    if (inEn !== inId) missing.push({ rule: row.id, inEn, inId });
  }
  return missing;
}

function structural() {
  const rows = [];
  for (const s of SCENARIOS) {
    const settings = settingsFor(s);
    const persona = s.defaultPersona
      ? { id: "persona_default", name: "", description: DEFAULT_PERSONA_RESOLVED, isDefault: true }
      : s.persona;
    const plan = BrowserChatEngine.planRequest({
      card: s.card, session: s.session, settings, persona,
      agentsContract: contractFor(s), window: s.window || null,
    });
    const payloadText = JSON.stringify(plan.payload);
    const guidance = plan.postHistory || "";
    const instructionText = [plan.systemPrompt, guidance].join("\n");
    const conflicts = CONFLICT_PAIRS.filter((p) => p.a.test(payloadText) && p.b.test(payloadText)).map((p) => ({ id: p.id, kind: p.kind }));
    const singleDef = singleDefFor(s)
      .map((c) => ({ id: c.id, count: (payloadText.match(c.re) || []).length, expect: c.expect }))
      .filter((c) => c.count !== c.expect)
      .map((c) => ({ id: c.id, count: c.count, expect: c.expect }));
    rows.push({
      scenario: s.name,
      inputTokens: plan.inputTokens,
      outputTokens: plan.outputTokens,
      systemPromptTokens: estimateTokens(plan.systemPrompt),
      guidanceTokens: estimateTokens(guidance),
      historyTokens: plan.breakdown.history,
      // Per-slot attribution of the stable prefix. The three identity slots are
      // reported apart because the point of the layer split is which slot a
      // rule lives in, and a combined total cannot show a rule migrating.
      contractTokens: plan.includedSections.includes("contract") ? estimateTokens(contractFor(s)) : 0,
      characterTokens: plan.breakdown.requiredStatic - (plan.includedSections.includes("contract") ? estimateTokens(contractFor(s)) : 0),
      personaSlotTokens: plan.breakdown.persona,
      instructionDensity: instructionDensity(instructionText),
      sections: plan.includedSections,
      excluded: plan.excludedSections,
      adaptiveNotes: plan.adaptiveNotes,
      conflicts,
      singleDef,
      fits: plan.totalTokens <= plan.contextWindow,
    });
  }

  const choice = BrowserChatEngine.planChoiceRequest({
    card: card({ preset: 400 }), session: session({ turns: 8 }),
    settings: settingsFor({}), persona: PERSONA, count: 4,
  });

  // Contract-level checks: which layer a rule lives in is a property of the
  // authored text, not of any one assembled payload.
  const contractChecks = CONTRACT_SINGLE_DEFINITION
    .map((c) => ({ id: c.id, count: (DEFAULT_AGENTS_CONTRACT.match(c.re) || []).length, expect: c.expect }))
    .filter((c) => c.count !== c.expect);
  const parityGaps = checkBilingualParity();

  const prompts = {
    agentsContract: instructionDensity(DEFAULT_AGENTS_CONTRACT),
    choiceSystem: instructionDensity(CHOICE_SYSTEM_PROMPT),
    summary: instructionDensity(SUMMARY_PROMPT),
    summaryUpdate: instructionDensity(SUMMARY_UPDATE_PROMPT),
    summarySystem: instructionDensity(SUMMARY_SYSTEM_PROMPT),
    ledgerCompress: instructionDensity(LEDGER_COMPRESS_PROMPT),
  };

  const tokenCosts = {
    agentsContract: estimateTokens(DEFAULT_AGENTS_CONTRACT),
    agentsContractId: estimateTokens(DEFAULT_AGENTS_CONTRACT_ID),
    // The three identity slots, measured apart so a rule migrating between them
    // shows up as a delta rather than hiding inside a total.
    defaultPersona: estimateTokens(DEFAULT_PERSONA_RESOLVED),
    defaultPersonaSlot: estimateTokens(`[User Persona]\n${DEFAULT_PERSONA_RESOLVED}`) + 4,
    choiceSystem: estimateTokens(CHOICE_SYSTEM_PROMPT),
    choiceTask: estimateTokens(choicePrompt(4, { charName: "Elena Voss", playerName: "Rowan" })),
    choiceRequest: choice.inputTokens,
    choiceOutput: choice.outputTokens,
    compactionTotal: estimateTokens(SUMMARY_SYSTEM_PROMPT) + estimateTokens(SUMMARY_PROMPT) + estimateTokens(SUMMARY_UPDATE_PROMPT) + estimateTokens(LEDGER_COMPRESS_PROMPT),
  };

  return { rows, prompts, tokenCosts, contractChecks, parityGaps, parityTotal: BILINGUAL_PARITY.length };
}

// One generation against the real engine.
//
// The session is CLONED per sample: `streamTurn` writes to it (lastUsage, the
// overflow latches, and a fold's ledger/consumed), so sharing one object across
// arms or runs would let the first sample change the second one's prompt.
// `streamTurn` returns the reply text and reports usage by writing
// `session.lastUsage`, so the billed counts are read back from the clone.
async function generateOnce({ scenario, settings, agentsContract }) {
  const session = structuredClone(scenario.session);
  const started = Date.now();
  let text = "";
  const notices = [];
  try {
    const out = await BrowserChatEngine.streamTurn({
      card: scenario.card, session, settings, persona: scenario.persona,
      agentsContract,
      onChunk: (c) => { text += c; },
      onNotice: (n) => notices.push(String(n)),
    });
    return {
      ms: Date.now() - started,
      usage: session.lastUsage ?? null,
      text: typeof out === "string" ? out : text,
      notices,
      planInputTokens: null,
      ...scoreOutput(typeof out === "string" ? out : text, { charName: "Elena Voss" }),
    };
  } catch (err) {
    return { ms: Date.now() - started, error: String(err?.message || err).slice(0, 200), notices };
  }
}

// ───────────────────────── live scoring ─────────────────────────

const PLAYER = "Rowan";
const AGENCY_RE = new RegExp(`\\b${PLAYER}\\b[^.?!\\n]{0,40}\\b(?:said|says|stepped|turned|nodded|felt|thought|reached|decided|knew)\\b`, "i");

function scoreOutput(text, { charName = "Elena Voss" } = {}) {
  const t = String(text || "");
  const words = t.split(/\s+/).filter(Boolean).length;
  const slop = (t.match(new RegExp(`\\b(?:${SLOP_LEXICON.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi")) || []).length;
  const tics = PROSE_TICS.map((tic) => ({ id: tic.id, hits: tic.count(t, [t], {}) })).filter((x) => x.hits > 0);
  const narration = detectNarration([{ role: "assistant", content: t }], { window: 1 });
  return {
    words,
    slopHits: slop,
    agencyViolation: AGENCY_RE.test(t),
    endsWithQuestion: /\?\s*$/.test(t.trim()),
    namesCharacter: t.toLowerCase().includes(String(charName).toLowerCase()),
    tics: tics.map((x) => x.id),
    pov: narration.pov,
    tense: narration.tense,
  };
}

async function live(runs) {
  const endpoint = opt("endpoint", process.env.VIBE_RP_ENDPOINT || "");
  const key = opt("key", process.env.VIBE_RP_API_KEY || "");
  const model = opt("model", process.env.VIBE_RP_MODEL || "");
  if (!endpoint || !model) {
    console.error("\n  --live needs an endpoint and a model. Set --endpoint/--model or");
    console.error("  VIBE_RP_ENDPOINT / VIBE_RP_MODEL. Nothing was sent.\n");
    return null;
  }
  const out = [];
  for (const s of SCENARIOS.filter((x) => x.name.startsWith("rp/") && !x.name.includes("window-"))) {
    const settings = { ...settingsFor(s), apiEndpoint: endpoint, apiKey: key, model };
    const samples = [];
    for (let i = 0; i < runs; i++) {
      samples.push(await generateOnce({ scenario: s, settings, agentsContract: DEFAULT_AGENTS_CONTRACT }));
    }
    out.push({ scenario: s.name, samples });
  }
  return out;
}

// ───────────────────────── live A/B on the craft contract ─────────────────────────
//
// The contract is injectable through `settings.agentsContract`, so an A/B needs
// no duplicated code: same scenarios, same model, same everything, one variable.
// The baseline text is read from a file (git show the previous revision into it).

async function abContract(runs, baselinePath) {
  const endpoint = opt("endpoint", process.env.VIBE_RP_ENDPOINT || "");
  const key = opt("key", process.env.VIBE_RP_API_KEY || "");
  const model = opt("model", process.env.VIBE_RP_MODEL || "");
  if (!endpoint || !model) {
    console.error("\n  --ab-contract needs --endpoint and --model. Nothing was sent.\n");
    return;
  }
  let baselineContract;
  try {
    baselineContract = readFileSync(baselinePath, "utf8").trim();
  } catch (err) {
    console.error(`\n  could not read baseline contract ${baselinePath}: ${err.message}\n`);
    return;
  }

  const only = opt("only");
  const scenarios = SCENARIOS.filter((s) =>
    s.name.startsWith("rp/") && !s.name.includes("window-") && (!only || s.name.includes(only)));

  console.log(`\nLIVE A/B — craft contract, ${scenarios.length} scenario(s) x ${runs} run(s) x 2 arms`);
  console.log(`  arms: new=${estimateTokens(DEFAULT_AGENTS_CONTRACT)} tok, old=${estimateTokens(baselineContract)} tok`);

  const arms = [
    { name: "new", contract: DEFAULT_AGENTS_CONTRACT },
    { name: "old", contract: baselineContract },
  ];
  const rows = [];

  for (const s of scenarios) {
    const per = {};
    for (const arm of arms) {
      const samples = [];
      for (let i = 0; i < runs; i++) {
        const settings = { ...settingsFor(s), apiEndpoint: endpoint, apiKey: key, model, agentsContract: arm.contract };
        samples.push(await generateOnce({ scenario: s, settings, agentsContract: arm.contract }));
      }
      per[arm.name] = samples;
    }
    rows.push({ scenario: s.name, ...per });
    const ok = (arr) => arr.filter((x) => !x.error);
    const fmt = (arr) => {
      const good = ok(arr);
      if (!good.length) return `FAILED (${arr[0]?.error})`;
      const avg = (k) => (good.reduce((a, x) => a + (x[k] || 0), 0) / good.length).toFixed(0);
      const pct = (k) => `${Math.round(100 * good.filter((x) => x[k]).length / good.length)}%`;
      // Provider-reported counts, not estimates: this is what the endpoint
      // actually billed, including anything it adds outside the payload.
      const billed = (get) => {
        const vals = good.map(get).filter((n) => typeof n === "number" && n > 0);
        return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0) : "-";
      };
      return `words=${avg("words").padStart(4)} slop=${avg("slopHits")} agency=${pct("agencyViolation")} ` +
        `handoff=${pct("endsWithQuestion")} ms=${avg("ms").padStart(5)} ` +
        `promptTok=${billed((x) => x.usage?.prompt_tokens)} reasonTok=${billed((x) => x.usage?.completion_tokens_details?.reasoning_tokens)}`;
    };
    console.log(`\n  ${s.name}`);
    console.log(`    new  ${fmt(per.new)}`);
    console.log(`    old  ${fmt(per.old)}`);
    const first = (arr) => (ok(arr)[0]?.text || "").replace(/\s+/g, " ").slice(0, 400);
    console.log(`    new text: ${first(per.new)}`);
    console.log(`    old text: ${first(per.old)}`);
  }

  // Aggregate verdict across scenarios, plus the estimate-vs-billed gap.
  const agg = (arm, key) => {
    const good = rows.flatMap((r) => r[arm]).filter((x) => !x.error);
    if (!good.length) return null;
    const sum = (f) => good.reduce((a, x) => a + (f(x) || 0), 0);
    return {
      n: good.length,
      agency: sum((x) => (x.agencyViolation ? 1 : 0)),
      handoff: sum((x) => (x.endsWithQuestion ? 1 : 0)),
      slop: sum((x) => x.slopHits),
      words: sum((x) => x.words),
      ms: Math.round(sum((x) => x.ms) / good.length),
      promptBilled: sum((x) => x.usage?.prompt_tokens || 0),
      reason: sum((x) => x.usage?.completion_tokens_details?.reasoning_tokens || 0),
    };
  };
  const nw = agg("new"), od = agg("old");
  console.log("\n  AGGREGATE");
  for (const [label, a] of [["new", nw], ["old", od]]) {
    if (!a) { console.log(`    ${label}: all runs failed`); continue; }
    console.log(`    ${label}: n=${a.n} agencyViolations=${a.agency} handoffQuestions=${a.handoff} slopHits=${a.slop} ` +
      `totalWords=${a.words} avgMs=${a.ms} billedPromptTok=${a.promptBilled} reasoningTok=${a.reason}`);
  }

  // The app estimates its own input; the endpoint bills what it actually read.
  // The gap is whatever the provider adds outside the payload — an aggregator's
  // hidden preamble, for instance — and the app's window accounting cannot see it.
  const estimates = scenarios.map((s) => {
    const plan = BrowserChatEngine.planRequest({
      card: s.card, session: structuredClone(s.session), settings: settingsFor(s),
      persona: s.persona, agentsContract: DEFAULT_AGENTS_CONTRACT, window: s.window || null,
    });
    return { scenario: s.name, estimated: plan.inputTokens };
  });
  const billedByScenario = rows.map((r) => {
    const good = r.new.filter((x) => !x.error && x.usage?.prompt_tokens);
    return { scenario: r.scenario, billed: good.length ? Math.round(good.reduce((a, x) => a + x.usage.prompt_tokens, 0) / good.length) : null };
  });
  console.log("\n  ESTIMATE vs BILLED INPUT (app's own count vs what the endpoint charged)");
  console.log("    scenario                  estimated   billed   delta");
  let estSum = 0, billSum = 0;
  for (const e of estimates) {
    const b = billedByScenario.find((x) => x.scenario === e.scenario);
    if (!b || b.billed === null) { console.log(`    ${e.scenario.padEnd(24)} ${String(e.estimated).padStart(9)}   (no usage reported)`); continue; }
    estSum += e.estimated; billSum += b.billed;
    console.log(`    ${e.scenario.padEnd(24)} ${String(e.estimated).padStart(9)} ${String(b.billed).padStart(8)} ${String(b.billed - e.estimated).padStart(7)}`);
  }
  if (estSum && billSum) {
    console.log(`    ${"TOTAL".padEnd(24)} ${String(estSum).padStart(9)} ${String(billSum).padStart(8)} ${String(billSum - estSum).padStart(7)}`);
    console.log(`\n    The provider charged ${billSum - estSum} tokens more than the app estimated (${(100 * (billSum - estSum) / estSum).toFixed(1)}% of the estimate).`);
    console.log(`    Anything the endpoint adds outside the payload is invisible to the app's window accounting.`);
  }
  return rows;
}

// ───────────────────────── report ─────────────────────────

function printStructural(r) {
  console.log("\nSTRUCTURAL — assembled payloads");
  console.log("  scenario                  in    out  sys  guid  hist   neg/line  conflicts  fits");
  for (const row of r.rows) {
    const c = row.conflicts.length ? row.conflicts.map((x) => x.id).join(",") : "-";
    console.log(
      `  ${row.scenario.padEnd(22)} ${String(row.inputTokens).padStart(5)} ${String(row.outputTokens).padStart(5)} ` +
      `${String(row.systemPromptTokens).padStart(4)} ${String(row.guidanceTokens).padStart(5)} ${String(row.historyTokens).padStart(5)} ` +
      `${String(row.instructionDensity.negativePerLine).padStart(9)}  ${c.slice(0, 26).padEnd(26)} ${row.fits ? "yes" : "NO"}`,
    );
  }

  console.log("\nSLOT ATTRIBUTION — where the stable prefix's tokens go");
  console.log("  scenario              contract  character  persona   (persona slot = persona + label)");
  for (const row of r.rows) {
    console.log(
      `  ${row.scenario.padEnd(22)} ${String(row.contractTokens).padStart(6)} ${String(row.characterTokens).padStart(11)} ${String(row.personaSlotTokens).padStart(8)}`,
    );
  }

  console.log("\nINSTRUCTION DENSITY — authored prompt text");
  console.log("  prompt            words  lines   neg  absol   neg/line");
  for (const [name, d] of Object.entries(r.prompts)) {
    console.log(`  ${name.padEnd(16)} ${String(d.words).padStart(5)} ${String(d.lines).padStart(5)} ${String(d.negativeMarkers).padStart(5)} ${String(d.absolutistMarkers).padStart(6)} ${String(d.negativePerLine).padStart(10)}`);
  }

  console.log("\nTOKEN COST");
  for (const [k, v] of Object.entries(r.tokenCosts)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}`);

  const totals = r.rows.reduce((a, x) => ({ instr: a.instr + x.systemPromptTokens + x.guidanceTokens, input: a.input + x.inputTokens }), { instr: 0, input: 0 });
  console.log(`\n  instruction share of the system prompt + guidance, across all scenarios: ${(100 * totals.instr / Math.max(1, totals.input)).toFixed(1)}%`);

  const allConflicts = new Map();
  for (const row of r.rows) for (const c of row.conflicts) allConflicts.set(c.id, (allConflicts.get(c.id) || 0) + 1);
  console.log("\n  co-occurring instruction pairs (scenarios / total):");
  if (!allConflicts.size) console.log("    (none)");
  for (const [id, n] of allConflicts) console.log(`    ${id.padEnd(26)} ${n}/${r.rows.length}`);

  const bad = r.rows.filter((row) => row.singleDef.length);
  console.log("\n  single-definition violations (a rule stated more than once, or missing):");
  if (!bad.length) {
    console.log("    (none) — each checked rule appears exactly once");
  } else {
    for (const row of bad) {
      for (const c of row.singleDef) console.log(`    ${row.scenario.padEnd(22)} ${c.id}: found ${c.count}, expected ${c.expect}`);
    }
  }

  console.log("\n  contract-layer checks (which slot a rule lives in):");
  if (!(r.contractChecks || []).length) {
    console.log("    (none) — the contract holds the authority rule and no reader-identity claim");
  } else {
    for (const c of r.contractChecks) console.log(`    ${c.id}: found ${c.count}, expected ${c.expect}`);
  }

  // The two built-in contracts are alternatives, so the risk is divergence
  // rather than duplication: a rule the English contract gained and the
  // Indonesian one did not.
  console.log("\n  bilingual parity (EN vs ID built-in contract):");
  if (!(r.parityGaps || []).length) {
    console.log(`    (none) — all ${r.parityTotal} tracked obligations present in both`);
  } else {
    for (const g of r.parityGaps) {
      console.log(`    ${g.rule}: EN=${g.inEn} ID=${g.inId}`);
    }
  }
}

function printLive(rows) {
  if (!rows) return;
  console.log("\nLIVE — generated output scored");
  for (const s of rows) {
    const ok = s.samples.filter((x) => !x.error);
    if (!ok.length) { console.log(`  ${s.scenario.padEnd(22)} all runs failed: ${s.samples[0]?.error}`); continue; }
    const avg = (k) => +(ok.reduce((a, x) => a + (x[k] || 0), 0) / ok.length).toFixed(2);
    const rate = (k) => `${ok.filter((x) => x[k]).length}/${ok.length}`;
    console.log(
      `  ${s.scenario.padEnd(22)} words=${String(avg("words")).padStart(6)} slop=${String(avg("slopHits")).padStart(4)} ` +
      `agency=${rate("agencyViolation")} handoff=${rate("endsWithQuestion")} ms=${String(avg("ms")).padStart(6)}`,
    );
  }
}

function compare(current, baseline) {
  console.log("\nCOMPARISON vs baseline");
  const before = new Map(baseline.rows.map((r) => [r.scenario, r]));
  for (const row of current.rows) {
    const b = before.get(row.scenario);
    if (!b) continue;
    const dIn = row.inputTokens - b.inputTokens;
    const dNeg = row.instructionDensity.negativeMarkers - b.instructionDensity.negativeMarkers;
    const dConflict = row.conflicts.length - (b.conflicts?.length ?? 0);
    const dSingle = row.singleDef.length - (b.singleDef?.length ?? 0);
    console.log(`  ${row.scenario.padEnd(22)} input ${dIn >= 0 ? "+" : ""}${dIn}  negMarkers ${dNeg >= 0 ? "+" : ""}${dNeg}  conflicts ${dConflict >= 0 ? "+" : ""}${dConflict}  singleDef ${dSingle >= 0 ? "+" : ""}${dSingle}`);
  }
  const sum = (r, f) => r.rows.reduce((a, x) => a + f(x), 0);
  console.log(`\n  TOTAL input tokens  : ${sum(baseline, (x) => x.inputTokens)} -> ${sum(current, (x) => x.inputTokens)}`);
  console.log(`  TOTAL negMarkers    : ${sum(baseline, (x) => x.instructionDensity.negativeMarkers)} -> ${sum(current, (x) => x.instructionDensity.negativeMarkers)}`);
  console.log(`  TOTAL conflicts     : ${sum(baseline, (x) => x.conflicts.length)} -> ${sum(current, (x) => x.conflicts.length)}`);
  console.log(`  TOTAL singleDef     : ${sum(baseline, (x) => (x.singleDef?.length ?? 0))} -> ${sum(current, (x) => x.singleDef.length)}`);
  console.log(`  contract tokens     : ${baseline.tokenCosts.agentsContract} -> ${current.tokenCosts.agentsContract}`);
  console.log(`  choice system tokens: ${baseline.tokenCosts.choiceSystem} -> ${current.tokenCosts.choiceSystem}`);
  console.log(`  compaction tokens   : ${baseline.tokenCosts.compactionTotal} -> ${current.tokenCosts.compactionTotal}`);
}

const structuralReport = structural();
printStructural(structuralReport);

const liveRows = flag("live") ? await live(Number(opt("runs", "3"))) : null;
printLive(liveRows);

const abPath = opt("ab-contract");
if (abPath) await abContract(Number(opt("runs", "1")), abPath);

const baselinePath = opt("compare");
if (baselinePath) {
  try {
    compare(structuralReport, JSON.parse(readFileSync(baselinePath, "utf8")));
  } catch (err) {
    console.error(`\n  could not read baseline ${baselinePath}: ${err.message}`);
  }
}

const outPath = opt("json");
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ ...structuralReport, live: liveRows, at: new Date().toISOString() }, null, 2));
  console.log(`\n  report written to ${outPath}`);
}

console.log("");
