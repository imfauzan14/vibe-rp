// Randomized property tests for the universal context allocator.
//
// Fixed examples prove the defects are gone; these prove the *invariants* hold
// across the whole configuration space the user can actually produce. Every
// case drives the real `streamTurn` seam and asserts on the actual outgoing
// body, then asserts the allocation properties directly.
//
// Invariants:
//   1. A request that is physically possible never overflows the window.
//   2. Required content is always preserved (the character and the current turn).
//   3. Lower-priority content yields before higher-priority content.
//   4. Effective output never exceeds the user's ceiling.
//   5. Effective output never exceeds remaining capacity.
//   6. No false impossibility notice is emitted for a request that fits.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine, allocateContext, countMessages, MIN_OUTPUT_TOKENS } from "../public/browser_engine.js";
import { words, presetOfTokens, captureGeneration, resetFetch } from "./helpers.js";

afterEach(() => {
  resetFetch();
});


/** A deterministic PRNG so a failing case is reproducible from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const WINDOWS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
const OUTS = [256, 512, 1200, 2048, 4096, 8192, 16000, 32000, 60000];

async function randomTurn(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const window = pick(WINDOWS);
  const maxTokens = pick(OUTS);
  const desc = Math.floor(rand() * 1.4 * window / 1000) * 1000;
  const ex = pick([0, 0, 5000, 20000, 40000]);
  const historyTurns = Math.floor(rand() * 60);
  const historyWords = pick([50, 200, 600]);
  const ledgerTokens = pick([0, 0, 2000, 8000]);
  const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: window, maxTokens };
  const card = {
    data: {
      name: "Elena Voss",
      description: desc ? presetOfTokens(desc) : "",
      personality: "",
      scenario: "",
      mes_example: ex ? presetOfTokens(ex) : "",
      system_prompt: "",
      post_history_instructions: "",
      character_book: null,
    },
  };
  const session = { messages: [{ role: "assistant", content: "greeting" }], ledger: ledgerTokens ? words(ledgerTokens) : "", consumed: 1 };
  for (let i = 0; i < historyTurns; i++) session.messages.push({ role: i % 2 ? "user" : "assistant", content: words(historyWords) });
  session.messages.push({ role: "user", content: words(150) });
  const notices = [];
  const { gen } = captureGeneration();
  await BrowserChatEngine.streamTurn({ card, session, settings, persona: null, agentsContract: "", onNotice: (n) => notices.push(n) });
  const body = gen[gen.length - 1];
  const input = countMessages(body.messages);
  return { body, input, out: body.max_tokens, total: input + body.max_tokens, window, maxTokens, notices: notices.join(" | "), card, settings, session };
}

describe("Allocator - randomized invariants through the real seam", () => {
  test("1-2. a possible request never overflows and always keeps required content", async () => {
    const rand = rng(0xC0FFEE);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const r = await randomTurn(rand);
      checked++;
      // Required content: the system prompt leads, the current user turn trails.
      expect(r.body.messages[0].role).toBe("system");
      expect(r.body.messages[r.body.messages.length - 1].role).toBe("user");
      // The current turn's text survives verbatim.
      expect(r.body.messages[r.body.messages.length - 1].content).toContain("word");
      // A request the engine did not flag as impossible must fit the window.
      const flagged = /exceed the configured prompt budget|do not fit the/i.test(r.notices);
      if (!flagged) {
        expect(r.total).toBeLessThanOrEqual(r.window);
      }
    }
    expect(checked).toBe(300);
  });

  test("3. examples yield before the character description", async () => {
    const rand = rng(0xBEEF);
    for (let i = 0; i < 60; i++) {
      // Force a preset large enough that something must degrade.
      const window = 8192 + Math.floor(rand() * 3) * 4096;
      const desc = Math.floor(window * 0.5);
      const ex = Math.floor(window * 0.7);
      const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: window, maxTokens: 1200 };
      const card = { data: { name: "Elena", description: presetOfTokens(desc), personality: "", scenario: "", mes_example: presetOfTokens(ex), system_prompt: "", post_history_instructions: "", character_book: null } };
      const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
      const { gen } = captureGeneration();
      await BrowserChatEngine.streamTurn({ card, session, settings, persona: null, agentsContract: "" });
      const system = gen[gen.length - 1].messages[0].content;
      // The description is required and survives; the examples are the first to
      // yield, so they must not be present when the request needed room.
      expect(system).toContain("[Description:");
      expect(system).not.toContain("[Dialogue Examples:");
    }
  });

  test("4-5. effective output never exceeds the ceiling or the remaining capacity", async () => {
    const rand = rng(0xFACE);
    for (let i = 0; i < 200; i++) {
      const r = await randomTurn(rand);
      expect(r.out).toBeLessThanOrEqual(Math.max(MIN_OUTPUT_TOKENS, r.maxTokens));
      expect(r.out).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      // Remaining capacity: output + input never exceeds the window for a
      // request that was not flagged impossible.
      const flagged = /exceed the configured prompt budget|do not fit the/i.test(r.notices);
      if (!flagged) expect(r.out).toBeLessThanOrEqual(r.window - r.input);
    }
  });

  test("6. no false impossibility notice for a request that fits", async () => {
    const rand = rng(0x1234);
    let flaggedButFits = 0;
    for (let i = 0; i < 300; i++) {
      const r = await randomTurn(rand);
      const flagged = /do not fit the/i.test(r.notices);
      if (flagged && r.total <= r.window) flaggedButFits++;
    }
    expect(flaggedButFits).toBe(0);
  });
});

describe("Allocator - pure helper properties", () => {
  test("output is granted in full when the window has room", () => {
    const a = allocateContext({ contextWindow: 65536, desiredOutput: 4096, safetyMargin: 1310, requiredTokens: 1000 });
    expect(a.output).toBe(4096);
    expect(a.feasible).toBe(true);
  });

  test("output is reduced only when required content crowds it out, never below the floor", () => {
    const a = allocateContext({ contextWindow: 8192, desiredOutput: 8000, safetyMargin: 256, requiredTokens: 5000 });
    expect(a.output).toBeLessThan(8000);
    expect(a.output).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
    expect(a.requiredTokens + a.output + 256).toBeLessThanOrEqual(8192);
  });

  test("optional items are fitted by descending priority", () => {
    const a = allocateContext({
      contextWindow: 4096,
      desiredOutput: 512,
      safetyMargin: 256,
      requiredTokens: 2000,
      optionalItems: [
        { id: "low", priority: 1, tokens: 500 },
        { id: "high", priority: 100, tokens: 500 },
        { id: "mid", priority: 50, tokens: 500 },
      ],
    });
    expect(a.included.map((i) => i.id)).toEqual(["high", "mid"]);
    expect(a.excluded.map((i) => i.id)).toEqual(["low"]);
  });

  test("feasible is false only when required content plus the minimum reply cannot fit", () => {
    expect(allocateContext({ contextWindow: 4096, requiredTokens: 3800, minOutput: 256, safetyMargin: 256 }).feasible).toBe(false);
    expect(allocateContext({ contextWindow: 4096, requiredTokens: 1000, minOutput: 256, safetyMargin: 256 }).feasible).toBe(true);
  });

  test("history budget is what remains after required, optional and output", () => {
    const a = allocateContext({
      contextWindow: 8192,
      desiredOutput: 1024,
      safetyMargin: 256,
      requiredTokens: 1000,
      optionalItems: [{ id: "x", priority: 1, tokens: 500 }],
    });
    expect(a.historyBudget).toBe(a.inputBudget - 1000 - 500);
    expect(a.output + a.inputBudget + 256).toBe(8192);
  });
});
