// Longitudinal story-development evaluation.
//
// prompt_eval.mjs measures a prompt's *surface* (cost, density, conflicts). This
// measures its *outcome over time*: does a character change when the story gives
// them a reason, and do they stay recognisably themselves while changing?
//
// The failure modes it looks for are the two named in the roleplay research:
//
//   emotional rigidity   the character is pinned to their opening state and the
//                        ordeal leaves no mark on them
//   persona drift        the character dissolves into a compliant, generic
//                        assistant who agrees with everything
//
// ── READ THIS BEFORE TRUSTING A NUMBER ──────────────────────────────────────
// The metrics are lexical proxies over ONE sample per arm per turn, and in use
// the run-to-run variance was as large as the difference between arms: an
// 8-turn run showed the predicted pattern, a 10-turn run of the same scenario
// showed near-parity. Treat the numbers as a prompt to read the transcript, not
// as a result. The transcript is printed in full for exactly that reason, and
// it is where every real conclusion in this repo's notes came from.
//
// The one thing the numbers DO establish reliably: sycophancy and register
// ballooning, which are the drift signals. Zero on both is meaningful.
// ────────────────────────────────────────────────────────────────────────────
//
// Usage
//   bun run tools/story_eval.mjs --endpoint ... --model ... [--old <path>]
//
// With --old pointing at a pre-change checkout (`git archive HEAD public | tar -x
// -C <path>`), the same ordeal runs through both prompt stacks and the two
// trajectories are printed side by side.
import { DEFAULT_SETTINGS as NEW_SETTINGS, DEFAULT_AGENTS_CONTRACT as NEW_CONTRACT } from "../public/local_db.js";
import { BrowserChatEngine as NewEngine } from "../public/browser_engine.js";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const endpoint = opt("endpoint", process.env.VIBE_RP_ENDPOINT || "");
const key = opt("key", process.env.VIBE_RP_API_KEY || "");
const model = opt("model", process.env.VIBE_RP_MODEL || "");
const oldRoot = opt("old");

if (!endpoint || !model) {
  console.error("\n  needs --endpoint and --model (or VIBE_RP_ENDPOINT / VIBE_RP_MODEL).\n");
  process.exit(1);
}

// ───────────────────────── the scenario ─────────────────────────
// A deliberately stern, guarded character. The player's own register is terse
// and unchanging throughout, so any softening has to come from what happens,
// not from the player mirroring warmth back at her.

const CARD = {
  id: "dev-card",
  data: {
    name: "Elena Voss",
    description:
      "A cartographer of dead cities. Curt, exacting, unsentimental. Speaks in short declaratives and does not explain herself. Contemptuous of sloppy work and of being fussed over.",
    personality:
      "Stern, guarded, precise. Offers nothing she has not been asked for. Slow to trust, slower to admit she has.",
    scenario: "A flooded undercroft beneath a collapsed archive. Two people, one lamp, rising water.",
  },
};
const PERSONA = { name: "Rowan", description: "A field engineer with a bad shoulder and a worse temper." };

// Ten turns, not eight: the reinject anchor fires at assistantTurns % 8 === 0,
// which is the ninth request. A shorter ordeal never sends it, so a shorter test
// would silently measure the contract alone and report it as the whole change.
const ORDEAL = [
  "Which way? Your call.",
  "The stair gave. I'm under it.",
  "My leg's pinned. Get the maps out first.",
  "Leave me. Take the lamp and go.",
  "You came back.",
  "I can't walk. You'll have to carry the lamp and me both.",
  "It's fine. Just get the survey out.",
  "Why did you come back?",
  "You don't have to carry me the whole way.",
  "Say it plainly. Once.",
];

// ───────────────────────── metrics ─────────────────────────

// Lexical warmth is a weak proxy: "careful" is as likely to be a warning as
// tenderness. These two sets measure *relational behaviour* instead, which is
// what "softening" actually means for a guarded character:
//
//   selfDisclosure  she says something about her own state or judgement
//                   (admission, apology, doubt) rather than only issuing orders
//   offer           she gives something — help, a hand, a choice, her own coat
const SELF_DISCLOSURE = [
  "i thought", "i was wrong", "i'm sorry", "i am sorry", "sorry", "i didn't", "i did not",
  "i should", "i couldn't", "i could not", "i can't", "i cannot", "i don't know", "i do not know",
  "i was afraid", "i was scared", "my fault", "i admit", "i'll admit", "i owe", "i misjudged",
  "i wasn't", "i was not", "forgive me", "i know", "i've been", "i have been",
  "because i", "i chose", "i would rather", "i wanted", "i needed",
];
const OFFER = [
  "let me", "i'll help", "i will help", "take my", "here,", "hold on to", "lean on",
  "give me your", "let me see", "let me look", "we'll", "we will", "together", "stay with",
  "i'll carry", "i will carry", "you can", "do you want", "would you",
];
const HARDNESS = [
  "don't", "do not", "stop", "enough", "move", "keep", "give me", "shut", "leave it",
  "fine.", "now.", "no.", "quiet.", "your call",
];
const SYCOPHANCY = [
  "of course", "absolutely", "certainly", "you're right", "you are right", "happy to",
  "gladly", "i'd love", "great idea", "wonderful", "amazing", "that's a great", "you're so",
];
// Events the story established, so a later reply can be checked for carrying them.
const ORDEAL_TOKENS = ["shoulder", "leg", "water", "lamp", "map", "maps", "stair", "beam", "blood", "pinned"];

const count = (text, list) => {
  const lower = ` ${String(text).toLowerCase()} `;
  return list.reduce((n, w) => n + (lower.split(w).length - 1), 0);
};
const sentences = (text) => String(text).split(/[.!?]+\s|\n+/).map((s) => s.trim()).filter((s) => s.length > 1);
const words = (text) => String(text).split(/\s+/).filter(Boolean).length;

function measure(reply, priorText) {
  const sents = sentences(reply);
  const w = words(reply);
  const lower = String(reply).toLowerCase();
  const carried = ORDEAL_TOKENS.filter((t) => lower.includes(t)).length;
  return {
    words: w,
    sentences: sents.length,
    avgSentence: sents.length ? +(w / sents.length).toFixed(1) : 0,
    disclosure: count(reply, SELF_DISCLOSURE),
    offer: count(reply, OFFER),
    hardness: count(reply, HARDNESS),
    sycophancy: count(reply, SYCOPHANCY),
    questions: (String(reply).match(/\?/g) || []).length,
    exclamations: (String(reply).match(/!/g) || []).length,
    adverbLy: (String(reply).match(/\b\w+ly\b/g) || []).length,
    carriedEvents: carried,
    // Does the reply reach back into what already happened, rather than sitting
    // in the present moment only?
    backReference: priorText ? ORDEAL_TOKENS.filter((t) => lower.includes(t) && priorText.toLowerCase().includes(t)).length : 0,
  };
}

// ───────────────────────── one run ─────────────────────────

async function runOrdeal({ label, engine, settings, contract }) {
  const messages = [];
  const rows = [];
  const transcript = [];
  let allText = "";
  for (let i = 0; i < ORDEAL.length; i++) {
    messages.push({ role: "user", content: ORDEAL[i] });
    const session = { id: "s", cardId: CARD.id, messages: structuredClone(messages), ledger: "", consumed: 1 };
    let reply = "";
    try {
      const out = await engine.streamTurn({
        card: CARD, session, settings, persona: PERSONA, agentsContract: contract,
        onChunk: (c) => { reply += c; }, onNotice: () => {},
      });
      reply = typeof out === "string" ? out : reply;
    } catch (err) {
      console.log(`  [${label}] turn ${i + 1} failed: ${String(err?.message || err).slice(0, 140)}`);
      reply = "";
    }
    const m = measure(reply, allText);
    rows.push({ turn: i + 1, ...m });
    transcript.push({ turn: i + 1, player: ORDEAL[i], reply });
    messages.push({ role: "assistant", content: reply });
    allText += "\n" + reply;
  }
  return { label, rows, transcript };
}

function report(runs) {
  for (const run of runs) {
    console.log(`\n${"=".repeat(78)}\n${run.label}\n${"=".repeat(78)}`);
    console.log("  turn  words  avgSent  disclos  offer  hard  syco   ?   !   -ly  carried  backRef");
    for (const r of run.rows) {
      console.log(
        `  ${String(r.turn).padStart(4)} ${String(r.words).padStart(6)} ${String(r.avgSentence).padStart(8)} ` +
        `${String(r.disclosure).padStart(7)} ${String(r.offer).padStart(6)} ${String(r.hardness).padStart(5)} ${String(r.sycophancy).padStart(5)} ` +
        `${String(r.questions).padStart(3)} ${String(r.exclamations).padStart(3)} ${String(r.adverbLy).padStart(5)} ` +
        `${String(r.carriedEvents).padStart(8)} ${String(r.backReference).padStart(8)}`,
      );
    }
    const half = Math.floor(run.rows.length / 2);
    const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
    const early = run.rows.slice(0, half);
    const late = run.rows.slice(half);
    console.log(`\n  early half vs late half`);
    console.log(`    self-disclosure ${sum(early, "disclosure")} -> ${sum(late, "disclosure")}   (lawful arc: rises)`);
    console.log(`    offers          ${sum(early, "offer")} -> ${sum(late, "offer")}   (lawful arc: rises)`);
    console.log(`    hardness        ${sum(early, "hardness")} -> ${sum(late, "hardness")}   (drift trap: collapses to zero)`);
    console.log(`    sycophancy      ${sum(early, "sycophancy")} -> ${sum(late, "sycophancy")}   (drift trap: rises)`);
    console.log(`    avgSentence     ${(sum(early, "avgSentence") / early.length).toFixed(1)} -> ${(sum(late, "avgSentence") / late.length).toFixed(1)}   (drift trap: balloons)`);
    console.log(`    backRef         ${sum(early, "backReference")} -> ${sum(late, "backReference")}   (story carrying its own weight)`);
  }

  if (runs.length === 2) {
    const [a, b] = runs;
    const half = Math.floor(a.rows.length / 2);
    const sum = (rows, k) => rows.reduce((x, y) => x + y[k], 0);
    const delta = (run) => ({
      disclosure: sum(run.rows.slice(half), "disclosure") - sum(run.rows.slice(0, half), "disclosure"),
      offer: sum(run.rows.slice(half), "offer") - sum(run.rows.slice(0, half), "offer"),
      hardness: sum(run.rows.slice(half), "hardness") - sum(run.rows.slice(0, half), "hardness"),
      syco: sum(run.rows.slice(half), "sycophancy") - sum(run.rows.slice(0, half), "sycophancy"),
    });
    const da = delta(a), db = delta(b);
    console.log(`\n${"=".repeat(78)}\nA/B — change in the late half vs the early half\n${"=".repeat(78)}`);
    console.log(`  ${"arm".padEnd(30)} disclos  offer  hard  syco`);
    console.log(`  ${a.label.padEnd(30)} ${String(da.disclosure).padStart(7)} ${String(da.offer).padStart(6)} ${String(da.hardness).padStart(5)} ${String(da.syco).padStart(5)}`);
    console.log(`  ${b.label.padEnd(30)} ${String(db.disclosure).padStart(7)} ${String(db.offer).padStart(6)} ${String(db.hardness).padStart(5)} ${String(db.syco).padStart(5)}`);
    console.log(`\n  A lawful arc: disclosure and offers rise, hardness does not collapse to zero,`);
    console.log(`  sycophancy stays at zero. Rigidity: everything flat. Drift: sycophancy rises.`);
  }
}

const newSettings = {
  ...NEW_SETTINGS, apiEndpoint: endpoint, apiKey: key, model, maxTokens: 900, maxContextTokens: 65536,
};
const runs = [];

runs.push(await runOrdeal({
  label: "NEW — development-aware prompts",
  engine: NewEngine, settings: newSettings, contract: NEW_CONTRACT,
}));

if (oldRoot) {
  const oldSettings = await import(`file:///${oldRoot.replace(/\\/g, "/")}/public/local_db.js`);
  const oldEngineMod = await import(`file:///${oldRoot.replace(/\\/g, "/")}/public/browser_engine.js`);
  runs.push(await runOrdeal({
    label: "OLD — pre-change prompts",
    engine: oldEngineMod.BrowserChatEngine,
    settings: { ...oldSettings.DEFAULT_SETTINGS, apiEndpoint: endpoint, apiKey: key, model, maxTokens: 900, maxContextTokens: 65536 },
    contract: oldSettings.DEFAULT_AGENTS_CONTRACT,
  }));
}

report(runs);

console.log(`\n${"=".repeat(78)}\nTRANSCRIPTS\n${"=".repeat(78)}`);
for (const run of runs) {
  console.log(`\n### ${run.label}`);
  for (const t of run.transcript) {
    console.log(`\n  [${t.turn}] PLAYER: ${t.player}`);
    console.log(`      ${String(t.reply).replace(/\s+/g, " ").slice(0, 700)}`);
  }
}
console.log("");
