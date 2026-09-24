// Unified context allocation suite.
//
// Merges test/context_allocation.test.ts (9), test/context_inspector.test.ts
// (5), test/large_preset_context.test.ts (9), test/seams.test.ts (2 of 3),
// the planContext/planRequest rows of test/browser_engine.test.ts (9, 10, 11),
// and the curated rows of test/context_longrun.test.ts (1 x 500-turn +
// provider-overflow adaptation). Every case drives the REAL `streamTurn` /
// `planContext` / `planRequest` / `describeRequest` seams against a
// deterministic fake fetch and asserts on the ACTUAL outgoing body.
//
// Dropped with named surviving counterparts (NOT re-asserted here):
//   - seams Seam 2 (buildRequestBody stream_options) -> engine_interface.test.ts
//     "buildRequestBody requests streaming with usage accounting".
//   - browser_engine 1 (formatSystemPrompt persona+contract) ->
//     engine_interface.test.ts "formatSystemPrompt includes contract and
//     character name".
//   - browser_engine 2 (assembleMessages Block 0, no mutate) ->
//     engine_interface.test.ts "assembleMessages keeps the system prompt as
//     payload head".
//   - browser_engine 3 (streamTurn is function) -> engine_interface.test.ts
//     "streamTurn and fetchAvailableModels exist as functions".
//   - browser_engine 5/6/7/8 (macro + constant-lorebook Block 0 rows) ->
//     re-homed to presets_resolution.test.ts (prompt-assembly suite).
//   - longrun 1000-turn duplicate -> the 500-turn row below (same invariant,
//     same harness, larger N adds no new assertion).
import { describe, test, expect, afterEach } from "bun:test";
import {
  BrowserChatEngine,
  estimateTokens,
  countMessages,
  LEDGER_HARD_MAX_TOKENS,
} from "../public/browser_engine.js";
import { words, SSE_OK, presetOfTokens, captureGeneration, resetFetch } from "./helpers.js";

afterEach(() => {
  resetFetch();
});

function cardWith(desc = 0, ex = 0, post = 0) {
  return {
    data: {
      name: "Elena Voss",
      description: desc ? presetOfTokens(desc) : "",
      personality: "",
      scenario: "",
      mes_example: ex ? presetOfTokens(ex) : "",
      system_prompt: "",
      post_history_instructions: post ? presetOfTokens(post) : "",
      character_book: null,
    },
  };
}

function inspectSession(turns = 0, ledgerTokens = 0) {
  const s = {
    messages: [{ role: "assistant", content: "greeting" }],
    ledger: ledgerTokens ? words(ledgerTokens) : "",
    consumed: 1,
  };
  for (let i = 0; i < turns; i++)
    s.messages.push({ role: i % 2 ? "user" : "assistant", content: words(200) });
  s.messages.push({ role: "user", content: words(150) });
  return s;
}

async function turn({
  window,
  maxTokens,
  desc = 0,
  ex = 0,
  post = 0,
  ledgerTokens = 0,
  historyTurns = 0,
  historyWords = 200,
  userWords = 150,
  persona = null,
}) {
  const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: window, maxTokens };
  const card = cardWith(desc, ex, post);
  const session = {
    messages: [{ role: "assistant", content: "greeting" }],
    ledger: ledgerTokens ? words(ledgerTokens) : "",
    consumed: 1,
  };
  for (let i = 0; i < historyTurns; i++) {
    session.messages.push({ role: i % 2 ? "user" : "assistant", content: words(historyWords) });
  }
  session.messages.push({ role: "user", content: words(userWords) });
  const notices = [];
  const { gen, folds } = captureGeneration();
  let threw = null;
  try {
    await BrowserChatEngine.streamTurn({
      card,
      session,
      settings,
      persona,
      agentsContract: "",
      onNotice: (n) => notices.push(n),
    });
  } catch (e) {
    threw = e.message;
  }
  const body = gen[gen.length - 1];
  const input = body ? countMessages(body.messages) : 0;
  return {
    body,
    session,
    input,
    out: body?.max_tokens,
    total: input + (body?.max_tokens || 0),
    window,
    notices,
    notice: notices.join(" | "),
    folds: folds.length,
    threw,
    system: body?.messages?.[0]?.content || "",
    lastRole: body?.messages?.[body.messages.length - 1]?.role,
    messages: body?.messages,
  };
}

const OVERFLOW_NOTICE = /exceed the configured prompt budget/i;
const BASE = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };

async function longRun({ turns, settings = BASE, ledgerWords = 750, seed = 7, wordsPerTurn = 150, replyWords = 200 }) {
  const generationBodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: words(ledgerWords) }, finish_reason: "stop" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    generationBodies.push(body);
    return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
  };
  const session = { messages: [{ role: "assistant", content: words(30) }], ledger: "", consumed: 1 };
  const card = { data: { name: "Narrator", first_mes: "hi", description: "A narrator." } };
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  for (let t = 0; t < turns; t++) {
    const consumedBefore = session.consumed;
    session.messages.push({ role: "user", content: words(Math.max(5, Math.round(wordsPerTurn * (0.5 + rand())))) });
    await BrowserChatEngine.streamTurn({ card, session, settings, persona: { name: "Player" }, onNotice: () => {} });
    session.messages.push({ role: "assistant", content: words(Math.max(5, Math.round(replyWords * (0.5 + rand())))) });
    const body = generationBodies[generationBodies.length - 1];
    rows.push({
      consumedBefore,
      consumed: session.consumed,
      ledgerTokens: estimateTokens(session.ledger),
      input: countMessages(body.messages),
      output: body.max_tokens,
    });
  }
  return { session, rows };
}

function overflowBody(limit) {
  return JSON.stringify({ error: { message: `This model's maximum context length is ${limit} tokens, however you requested more`, code: "context_length_exceeded" } });
}

describe("Context allocation - no false overflow", () => {
  test("a large output ceiling never reports an overflow for a request that fits", async () => {
    for (const [window, maxTokens] of [
      [8192, 8000],
      [16384, 15000],
      [32768, 31000],
      [65536, 63000],
    ]) {
      const r = await turn({ window, maxTokens, desc: 1000, historyTurns: 20 });
      expect(r.total).toBeLessThanOrEqual(window);
      expect(r.notice).not.toMatch(OVERFLOW_NOTICE);
    }
  });

  test("a large preset plus a large output ceiling still fits without a false warning", async () => {
    for (const maxTokens of [1200, 20000, 30000, 40000, 48000]) {
      const r = await turn({ window: 65536, maxTokens, desc: 20000, historyTurns: 40 });
      expect(r.total).toBeLessThanOrEqual(65536);
      expect(r.notice).not.toMatch(OVERFLOW_NOTICE);
      expect(r.out).toBeGreaterThanOrEqual(256);
    }
  });
});

describe("Context allocation - final request is measured", () => {
  test("a ledger larger than the window is condensed for the request, storage intact", async () => {
    const r = await turn({ window: 8192, maxTokens: 1200, ledgerTokens: 15000, historyTurns: 6 });
    expect(r.session.ledger.length).toBeGreaterThan(0);
    expect(r.total).toBeLessThanOrEqual(8192);
    expect(r.notice).toMatch(/ledger/i);
  });

  test("an oversized current user turn is reported, never silently over-window", async () => {
    const r = await turn({ window: 4096, maxTokens: 1200, userWords: 30000 });
    expect(r.notice).toMatch(/message|turn|input/i);
  });

  test("required content that cannot fit names the offending component", async () => {
    const r = await turn({ window: 65536, maxTokens: 1200, desc: 70000, historyTurns: 10 });
    expect(r.notice).toMatch(OVERFLOW_NOTICE);
  });

  test("an impossible request the provider REJECTS still explains itself", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const notices = [];
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 1200 };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    const card = { data: { name: "Elena", description: presetOfTokens(70000) } };
    let threw = null;
    try {
      await BrowserChatEngine.streamTurn({ card, session, settings, persona: null, agentsContract: "", onNotice: (n) => notices.push(n) });
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/maximum context|400/i);
    expect(notices.join(" | ")).toMatch(OVERFLOW_NOTICE);
    expect(notices.join(" | ")).toMatch(/static preset/i);
  });
});

describe("Context allocation - static degradation", () => {
  test("examples are dropped before required content when the preset would not otherwise fit", async () => {
    const r = await turn({ window: 65536, maxTokens: 4096, desc: 10000, ex: 55000 });
    expect(r.total).toBeLessThanOrEqual(65536);
    expect(r.system).toContain("CHARACTER IN SCENE");
    expect(r.system).toContain("[Description:");
    expect(r.system).not.toContain("[Dialogue Examples:");
  });

  test("examples are kept verbatim when there is room", async () => {
    const r = await turn({ window: 65536, maxTokens: 1200, desc: 2000, ex: 2000 });
    expect(r.system).toContain("[Dialogue Examples:");
    expect(r.notice).not.toMatch(OVERFLOW_NOTICE);
  });
});

describe("Context allocation - provider error detail", () => {
  test("a generation context-overflow error preserves the provider detail", async () => {
    const body = JSON.stringify({
      error: { message: "This model's maximum context length is 8192 tokens, however you requested 12000", code: "context_length_exceeded" },
    });
    globalThis.fetch = async () => new Response(body, { status: 400, headers: { "Content-Type": "application/json" } });
    const session = { messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "hello" }], ledger: "", consumed: 1 };
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 1200 };
    let message = "";
    try {
      await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain("400");
    expect(message.toLowerCase()).toContain("context");
  });
});

describe("Large static preset - real request accounting", () => {
  test("dynamic lore and post-history are counted: a large preset never overflows the window", async () => {
    for (const desc of [0, 1000, 5000, 20000, 40000, 55000]) {
      for (const post of [0, 2000, 5000]) {
        const r = await turn({ window: 65536, maxTokens: 1200, desc, post, historyTurns: 60 });
        if (desc + post <= 60000) {
          expect(r.total).toBeLessThanOrEqual(65536);
        }
      }
    }
  });

  test("a large-but-fitting preset still produces a valid request with usable output", async () => {
    const r = await turn({ window: 65536, maxTokens: 4096, desc: 30000, historyTurns: 40 });
    expect(r.body.stream).toBe(true);
    expect(r.body.messages.length).toBeGreaterThan(1);
    expect(r.out).toBe(4096);
    expect(r.total).toBeLessThanOrEqual(65536);
    expect(r.lastRole).toBe("user");
  });

  test("output is preserved whenever the context allows, and reduced only when necessary", async () => {
    for (const maxTokens of [1200, 2048, 4096, 8192]) {
      const r = await turn({ window: 65536, maxTokens, desc: 20000, historyTurns: 30 });
      expect(r.out).toBe(maxTokens);
      expect(r.total).toBeLessThanOrEqual(65536);
    }
    const tight = await turn({ window: 4096, maxTokens: 8192, desc: 500, historyTurns: 4 });
    expect(tight.out).toBeGreaterThanOrEqual(256);
    expect(tight.out).toBeLessThan(8192);
    expect(tight.total).toBeLessThanOrEqual(4096);
  });

  test("a legitimate large ceiling is not halved by a percentage reservation", async () => {
    const r = await turn({ window: 8192, maxTokens: 6000 });
    expect(r.out).toBe(6000);
    expect(r.total).toBeLessThanOrEqual(8192);
    expect((await turn({ window: 16384, maxTokens: 12000 })).out).toBe(12000);
    expect((await turn({ window: 32768, maxTokens: 8192 })).out).toBe(8192);
  });

  test("late-appended guidance is charged before planning: output is not silently reduced", async () => {
    for (const historyTurns of [6, 10, 14]) {
      const r = await turn({ window: 8192, maxTokens: 4096, post: 2500, historyTurns });
      expect(r.out).toBe(4096);
      expect(r.total).toBeLessThanOrEqual(8192);
    }
  });

  test("a large context does not trigger premature compaction", async () => {
    const r = await turn({ window: 8192, maxTokens: 1200, historyTurns: 24 });
    expect(r.folds).toBe(0);
    expect(r.input).toBeGreaterThan(5000);
    expect(r.total).toBeLessThanOrEqual(8192);
  });

  test("history yields to a large static preset while the current user turn survives", async () => {
    const roomy = await turn({ window: 65536, maxTokens: 1200, desc: 1000, historyTurns: 120 });
    const crowded = await turn({ window: 65536, maxTokens: 1200, desc: 45000, historyTurns: 120 });
    expect(crowded.messages.length).toBeLessThan(roomy.messages.length);
    expect(crowded.total).toBeLessThanOrEqual(65536);
    expect(crowded.lastRole).toBe("user");
    expect(estimateTokens(crowded.messages[0].content)).toBeGreaterThan(40000);
  });

  test("the configured context is actually usable: prompt budget is near the window, not half", async () => {
    const r = await turn({ window: 65536, maxTokens: 1200, desc: 40000, historyTurns: 40 });
    expect(r.total).toBeGreaterThan(40960);
    expect(r.total).toBeLessThanOrEqual(65536);
  });
});

describe("Large static preset - physically impossible case", () => {
  test("a preset that cannot fit is reported, never silently over-window", async () => {
    const r = await turn({ window: 65536, maxTokens: 1200, desc: 70000, historyTurns: 10 });
    expect(r.notices.join(" ")).toContain("exceed the configured prompt budget");
    expect(r.out).toBeLessThanOrEqual(1200);
  });
});

describe("Context inspector - the breakdown matches the request", () => {
  test("the breakdown sums to the measured input", () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 4096 };
    const r = BrowserChatEngine.describeRequest({ card: cardWith(30000), session: inspectSession(40), settings, persona: { name: "You" } });
    const b = r.breakdown;
    const sum = b.requiredStatic + b.optionalStatic + b.persona + b.lore + b.ledger + b.history + b.currentInput;
    expect(Math.abs(r.inputTokens - sum)).toBeLessThan(32);
  });

  test("describeRequest measures the exact payload streamTurn sends", async () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 4096 };
    const card = cardWith(20000);
    const sess = inspectSession(30);
    const described = BrowserChatEngine.describeRequest({ card, session: sess, settings, persona: { name: "You" } });
    const gen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream) gen.push(body);
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    await BrowserChatEngine.streamTurn({ card, session: sess, settings, persona: { name: "You" }, agentsContract: "" });
    const sent = gen[gen.length - 1];
    expect(described.payload.length).toBe(sent.messages.length);
    expect(countMessages(described.payload)).toBe(countMessages(sent.messages));
    expect(described.outputTokens).toBe(sent.max_tokens);
  });

  test("a crowded window reports the same reduced ceiling it sends", async () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 8192 };
    const card = cardWith(6000);
    const sess = inspectSession(0);
    const described = BrowserChatEngine.describeRequest({ card, session: sess, settings, persona: { name: "You" } });
    expect(described.plan.compacted).toBe(false);
    const gen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream) gen.push(body);
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    await BrowserChatEngine.streamTurn({ card, session: sess, settings, persona: { name: "You" }, agentsContract: "" });
    const sent = gen[gen.length - 1];
    expect(described.outputTokens).toBe(sent.max_tokens);
    expect(described.outputTokens).toBeLessThan(8192);
    expect(countMessages(sent.messages) + sent.max_tokens).toBeLessThanOrEqual(8192);
  });

  test("a degraded section is named, and required content is not", () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 4096 };
    const r = BrowserChatEngine.describeRequest({ card: cardWith(10000, 55000), session: inspectSession(2), settings, persona: { name: "You" } });
    expect(r.excludedSections).toContain("examples");
    expect(r.includedSections).toContain("description");
    expect(r.includedSections).not.toContain("examples");
  });

  test("a condensed ledger is flagged in the breakdown", () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };
    const r = BrowserChatEngine.describeRequest({ card: null, session: inspectSession(4, 15000), settings, persona: { name: "You" } });
    expect(r.ledgerCondensed).toBe(true);
    expect(r.breakdown.ledger).toBeLessThan(estimateTokens(words(15000)));
    expect(r.totalTokens).toBeLessThanOrEqual(8192);
  });
});

describe("Context seams - planner overflow guards", () => {
  test("planContext warns or handles oversized system prompt gracefully", () => {
    const hugeSystemPrompt = "System directive. ".repeat(600);
    const messages = [
      { role: "assistant", content: "Opening line." },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Response." },
    ];
    const settings = { maxContextTokens: 2048, maxTokens: 512 };
    const plan = BrowserChatEngine.planContext({
      systemPrompt: hugeSystemPrompt,
      messages,
      ledger: "",
      consumed: 1,
      settings,
    });
    expect(plan).toMatchObject({ overflow: true });
    expect(typeof plan.overflowWarning).toBe("string");
  });

  test("planContext caps fallback ledger so it cannot cause endless prompt overflow", () => {
    const hugeLedger = "Extracted facts. ".repeat(500);
    const messages = [
      { role: "assistant", content: "Initial greeting." },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Turn 2" },
      { role: "user", content: "Turn 3" },
    ];
    const settings = { maxContextTokens: 4096, maxTokens: 1000 };
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages,
      ledger: hugeLedger,
      consumed: 1,
      settings,
    });
    expect(plan.budget).toBeGreaterThanOrEqual(256);
  });
});

describe("Context planners - history hygiene and lore selection", () => {
  test("planContext shakes both <thought> and <think> tags in older history", () => {
    const systemPrompt = "Stable prefix";
    const messages = [
      { role: "assistant", content: "Opening greeting." },
      { role: "user", content: "What is your plan?" },
      { role: "assistant", content: "<think>I need to deceive them.</think>We head north." },
      { role: "user", content: "Are you sure?" },
      { role: "assistant", content: '<thought character="Elena">Suspicion is high.</thought>Positive.' },
      { role: "user", content: "Lead the way." },
    ];
    const plan = BrowserChatEngine.planContext({ systemPrompt, messages, ledger: "", consumed: 1, settings: { maxContextTokens: 16384 } });
    const oldAssistant = plan.history.find(m => m.content && m.content.includes("We head north."));
    expect(oldAssistant.content).toBe("We head north.");
    expect(oldAssistant.content).not.toContain("<think>");
  });

  test("selectLorebookEntries uses word-boundary matching to prevent substring false-positives", () => {
    const card = {
      data: {
        name: "Elena",
        character_book: {
          entries: [
            { keys: ["sword"], content: "Blade entry.", constant: false, enabled: true },
            { keys: ["royal archivist"], content: "Archivist entry.", constant: false, enabled: true },
          ],
        },
      },
    };
    const planNoMatch = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "He is a swordsman." }] },
      settings: {},
    });
    expect(planNoMatch.postHistory).not.toContain("Blade entry.");
    const planMatchPunctuation = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "Draw your sword!" }] },
      settings: {},
    });
    expect(planMatchPunctuation.postHistory).toContain("Blade entry.");
    const planMultiWord = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "Where is the Royal Archivist today?" }] },
      settings: {},
    });
    expect(planMultiWord.postHistory).toContain("Archivist entry.");
  });

  test("operationalPrecedence enforces epistemic knowledge boundaries and anti-omniscience for user personas", () => {
    const card = {
      data: {
        name: "Elena",
        description: "A mysterious alchemist living in an isolated tower.",
        scenario: "A stranger arrives at the tower door seeking shelter from a storm.",
      },
    };
    const persona = {
      name: "Fauzan",
      description: "An engineer from a distant high-tech land with secret cybernetic implants.",
    };
    const plan = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "I knock on the wooden door, shivering in the rain." }] },
      persona,
      settings: {},
    });
    const sys = plan.systemPrompt;
    expect(sys).toContain("[User Persona: Fauzan]");
    expect(sys).toContain("Operational Precedence:");
    expect(sys).toContain("Epistemic Boundary (Anti-Omniscience)");
    expect(sys).toContain("must NOT know or call them by their persona name");
  });
});

describe("Long-run allocation - 500 turns", () => {
  test("500 turns: every request fits, coverage is monotonic, ledger stays bounded", async () => {
    const r = await longRun({ turns: 500 });
    for (const row of r.rows) {
      expect(row.input + row.output).toBeLessThanOrEqual(BASE.maxContextTokens);
      expect(row.output).toBeGreaterThan(0);
      expect(row.consumed).toBeGreaterThanOrEqual(row.consumedBefore);
    }
    expect(r.session.messages.length).toBe(1 + 500 * 2);
    expect(estimateTokens(r.session.ledger)).toBeLessThanOrEqual(LEDGER_HARD_MAX_TOKENS);
    expect(r.rows[r.rows.length - 1].consumed).toBeGreaterThan(r.rows[0].consumed);
  }, 60000);
});

describe("Provider context-overflow adaptation", () => {
  test("a smaller-than-configured provider window triggers exactly one bounded re-fit", async () => {
    const gen = [];
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls++;
      if (calls === 1) return new Response(overflowBody(4096), { status: 400, headers: { "Content-Type": "application/json" } });
      gen.push(body);
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    const notices = [];
    const settings = { ...BASE, maxContextTokens: 65536, maxTokens: 1200 };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "", onNotice: (n) => notices.push(n) });
    expect(gen.length).toBe(1);
    const input = countMessages(gen[0].messages);
    expect(input + gen[0].max_tokens).toBeLessThanOrEqual(4096);
    expect(notices.join(" ")).toContain("4096");
  });

  test("a second overflow propagates and never loops", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(overflowBody(2048), { status: 400, headers: { "Content-Type": "application/json" } });
    };
    const settings = { ...BASE, maxContextTokens: 65536, maxTokens: 1200 };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    let threw = null;
    try {
      await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toContain("400");
    expect(calls).toBe(2);
  });

  test("an unrelated 400 is not retried", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Invalid model name" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    await expect(
      BrowserChatEngine.streamTurn({ card: null, session, settings: BASE, persona: null, agentsContract: "" })
    ).rejects.toThrow(/Invalid model name/);
    expect(calls).toBe(1);
  });

  test("the provider's real window is recovered from the common error shapes", async () => {
    const shapes = [
      ["This model's maximum context length is 4096 tokens, however you requested 12000", true],
      ["the request exceeds the available context size of 4096", true],
      ["prompt is too long: 250000 tokens > 4096 maximum", true],
      ["prompt is too long: 250000 tokens > 200000 maximum", false],
      ["Invalid API key", false],
      ["Rate limit exceeded", false],
    ];
    for (const [message, shouldAdapt] of shapes) {
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls++;
        if (body.stream) return new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ledger" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
      };
      const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
      await BrowserChatEngine.streamTurn({ card: null, session, settings: BASE, persona: null, agentsContract: "" }).catch(() => {});
      expect(calls).toBe(shouldAdapt ? 2 : 1);
    }
  });

  test("a cancellation is never adapted into a retry", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const controller = new AbortController();
    controller.abort();
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    await expect(
      BrowserChatEngine.streamTurn({ card: null, session, settings: BASE, persona: null, agentsContract: "", signal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });

  test("content already streamed is never duplicated by an overflow retry", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      let read = 0;
      const body = {
        getReader: () => ({
          read: async () => {
            if (read++ === 0) return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n') };
            throw new Error("This model's maximum context length is 2048 tokens, however you requested more");
          },
        }),
      };
      return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body };
    };
    const chunks = [];
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    let threw = null;
    try {
      await BrowserChatEngine.streamTurn({ card: null, session, settings: BASE, persona: null, agentsContract: "", onChunk: (c) => chunks.push(c) });
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/maximum context|400/i);
    expect(chunks.join("")).toBe("partial");
    expect(calls).toBe(1);
  });
});

describe("Context prompt assembly - macros and constant lore", () => {
  const mockPersona = { name: "Rowan", description: "A wandering scholar." };

  test("formatSystemPrompt resolves {{user}}/{{char}} in every embedded card field", () => {
    const card = {
      data: {
        name: "Aria",
        description: "{{char}} guards {{user}}'s road.",
        personality: "Loyal to {{user}}.",
        scenario: "{{user}} arrives at {{char}}'s post.",
        mes_example: "<START>\n{{user}}: hi\n{{char}}: hello",
        system_prompt: "Address {{user}} as captain.",
      },
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("[Description: Aria guards Rowan's road.]");
    expect(prompt).toContain("[Personality: Loyal to Rowan.]");
    expect(prompt).toContain("[Scenario: Rowan arrives at Aria's post.]");
    expect(prompt).toContain("[Dialogue Examples:\n<START>\nRowan: hi\nAria: hello]");
    expect(prompt).toContain("[Character Core Directives:\nAddress Rowan as captain.]");
    expect(prompt).not.toContain("{{user}}");
    expect(prompt).not.toContain("{{char}}");
  });

  test("formatSystemPrompt leaves unknown placeholders literal and keeps prompt structure", () => {
    const card = { data: { name: "Aria", description: "{{random}} and {{time}} and {{user}}" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("{{random}} and {{time}} and Rowan");
    expect(prompt).toContain("### CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Rowan]");
    expect(BrowserChatEngine.formatSystemPrompt(card, mockPersona, {}))
      .toBe(BrowserChatEngine.formatSystemPrompt(card, mockPersona, {}));
  });

  test("formatSystemPrompt resolves universal macros in agentsContract and persona", () => {
    const card = { data: { name: "Elena" } };
    const persona = { name: "Iqbal", description: "{user} is traveling with {char}.", template: "Call {user} boss." };
    const settings = { agentsContract: "RULE: Always refer to {user} and {char} respectfully." };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, persona, settings);
    expect(prompt).toContain("RULE: Always refer to Iqbal and Elena respectfully.");
    expect(prompt).toContain("Iqbal is traveling with Elena.");
    expect(prompt).toContain("Call Iqbal boss.");
    expect(prompt).not.toContain("{user}");
    expect(prompt).not.toContain("{char}");
  });

  test("formatSystemPrompt injects constant lorebook entries atomically into Block 0", () => {
    const card = {
      data: {
        name: "Elena",
        character_book: {
          entries: [
            { keys: [], content: "The kingdom has been at war for ten years.", constant: true, enabled: true, priority: 10 },
            { keys: ["sword"], content: "The Sunblade glows near danger.", constant: false, enabled: true },
          ],
        },
      },
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("### CONSTANT WORLD LORE");
    expect(prompt).toContain("The kingdom has been at war for ten years.");
    expect(prompt).not.toContain("The Sunblade glows near danger.");
  });
});
