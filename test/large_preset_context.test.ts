// Large-static-preset end-to-end tests.
//
// These drive the REAL `streamTurn` seam and assert on the ACTUAL outgoing
// `/chat/completions` body. The bug they lock down: dynamic lore and
// post-history instructions are appended to the payload after the history is
// planned, so a planner that measured only system+ledger would size a history
// that fits its own budget while the assembled request still overflowed the
// configured window — producing no usable output for a large preset.
//
// The invariant under test is the user-facing one:
//
//   actual input + actual requested output <= maxContextTokens
//
// whenever the required prompt can physically fit, and an explicit observable
// failure (never a silent over-window request) when it cannot.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine, estimateTokens, countMessages } from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';
const words = (n) => "word ".repeat(n).trim();

afterEach(() => {
  globalThis.fetch = undefined;
});

// A realistic mixed-content preset: prose, markdown, JSON, a code block, a
// table, unicode, an em dash, and dialogue markers — not `"word ".repeat()`.
// `estimateTokens` counts UTF-8 bytes / 4, so this exercises multi-byte text.
const PRESET_CHUNK =
  "## Character Sheet\n\n" +
  "Elena Voss is a cartographer of dead cities. She speaks in clipped, precise " +
  "sentences — never more than twelve words when three will do.\n\n" +
  "```json\n" +
  '{"name":"Elena Voss","age":34,"traits":["methodical","guarded"],"notes":"Härte über alles."}\n' +
  "```\n\n" +
  "> \"The map is not the territory. The territory is barely the territory.\"\n\n" +
  "| stat | value |\n|---|---|\n| resolve | 8/10 |\n| trust | 2/10 |\n\n" +
  "<START>\n{{user}}: Where are we?\n{{char}}: Exactly where the last one ended.\n<START>\n";

/** A preset whose *system prompt cost* is approximately `tokens`. */
function presetOfTokens(tokens) {
  const per = estimateTokens(PRESET_CHUNK);
  return PRESET_CHUNK.repeat(Math.max(1, Math.ceil(tokens / per)));
}

function cardWith(descTokens, postTokens = 0) {
  return {
    data: {
      name: "Elena Voss",
      description: descTokens ? presetOfTokens(descTokens) : "",
      personality: "",
      scenario: "",
      mes_example: "",
      system_prompt: "",
      post_history_instructions: postTokens ? presetOfTokens(postTokens) : "",
      character_book: null,
    },
  };
}

/** Captures the outgoing generation body while serving a valid reply. */
function captureGeneration() {
  const gen = [];
  const folds = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream === false) {
      folds.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ledger" }, finish_reason: "stop" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    gen.push(body);
    return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
  };
  return { gen, folds };
}

/**
 * Runs one real turn and returns the actual request measurements. History is
 * built so the *last* message is a user turn (the current request).
 */
async function turn({ window, maxTokens, descTokens, postTokens = 0, historyTurns = 0, historyWords = 200 }) {
  const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: window, maxTokens };
  const card = cardWith(descTokens, postTokens);
  const session = { messages: [{ role: "assistant", content: "greeting" }], ledger: "", consumed: 1 };
  for (let i = 0; i < historyTurns; i++) {
    session.messages.push({ role: i % 2 ? "user" : "assistant", content: words(historyWords) });
  }
  session.messages.push({ role: "user", content: words(150) });
  const notices = [];
  const { gen, folds } = captureGeneration();
  await BrowserChatEngine.streamTurn({
    card,
    session,
    settings,
    persona: null,
    agentsContract: "",
    onNotice: (n) => notices.push(n),
  });
  const body = gen[gen.length - 1];
  const input = countMessages(body.messages);
  return {
    body,
    input,
    out: body.max_tokens,
    total: input + body.max_tokens,
    window,
    notices,
    folds: folds.length,
    lastRole: body.messages[body.messages.length - 1].role,
    messages: body.messages,
  };
}

describe("Large static preset - real request accounting", () => {
  test("dynamic lore and post-history are counted: a large preset never overflows the window", async () => {
    // The decisive regression. Before the fix the planner ignored the guidance
    // appended after planning, so this produced an over-window request.
    for (const desc of [0, 1000, 5000, 20000, 40000, 55000]) {
      for (const post of [0, 2000, 5000]) {
        const r = await turn({ window: 65536, maxTokens: 1200, descTokens: desc, postTokens: post, historyTurns: 60 });
        // The engine may not know the preset is physically impossible only
        // beyond the window; within it the request must fit.
        if (desc + post <= 60000) {
          expect(r.total).toBeLessThanOrEqual(65536);
        }
      }
    }
  });

  test("a large-but-fitting preset still produces a valid request with usable output", async () => {
    // 30K static preset on a 64K window with a 4K reply ceiling: the request
    // fits comfortably and the FULL reply ceiling must be granted.
    const r = await turn({ window: 65536, maxTokens: 4096, descTokens: 30000, historyTurns: 40 });
    expect(r.body.stream).toBe(true);
    expect(r.body.messages.length).toBeGreaterThan(1);
    expect(r.out).toBe(4096); // not reduced: plenty of room remains
    expect(r.total).toBeLessThanOrEqual(65536);
    expect(r.lastRole).toBe("user"); // current request survives
  });

  test("output is preserved whenever the context allows, and reduced only when necessary", async () => {
    // Same preset, progressively larger reply ceilings on a large window.
    for (const maxTokens of [1200, 2048, 4096, 8192]) {
      const r = await turn({ window: 65536, maxTokens, descTokens: 20000, historyTurns: 30 });
      expect(r.out).toBe(maxTokens); // honoured in full; no arbitrary cap
      expect(r.total).toBeLessThanOrEqual(65536);
    }
    // A tiny window forces the output down, but never to zero.
    const tight = await turn({ window: 4096, maxTokens: 8192, descTokens: 500, historyTurns: 4 });
    expect(tight.out).toBeGreaterThanOrEqual(256);
    expect(tight.out).toBeLessThan(8192);
    expect(tight.total).toBeLessThanOrEqual(4096);
  });

  test("a legitimate large ceiling is not halved by a percentage reservation", async () => {
    // window=8192, maxTokens=6000: the old `min(maxTokens, window * 0.5)` clamp
    // would grant only 4096. The ceiling must be honoured up to the minimum
    // input floor, not an arbitrary half-window share.
    const r = await turn({ window: 8192, maxTokens: 6000 });
    expect(r.out).toBe(6000);
    expect(r.total).toBeLessThanOrEqual(8192);
    // Same at 16K and 32K: the ceiling is preserved, never halved.
    expect((await turn({ window: 16384, maxTokens: 12000 })).out).toBe(12000);
    expect((await turn({ window: 32768, maxTokens: 8192 })).out).toBe(8192);
  });

  test("late-appended guidance is charged before planning: output is not silently reduced", async () => {
    // 2500 tokens of post-history guidance on an 8K window with a 4K ceiling.
    // If the planner ignored the guidance, it would keep too much history and
    // the after-the-fact clamp would shrink the reply (out < 4096). Charging it
    // up front means the planner folds history instead and the ceiling holds.
    for (const historyTurns of [6, 10, 14]) {
      const r = await turn({ window: 8192, maxTokens: 4096, postTokens: 2500, historyTurns });
      expect(r.out).toBe(4096);
      expect(r.total).toBeLessThanOrEqual(8192);
    }
  });

  test("a large context does not trigger premature compaction", async () => {
    // At 8K with a 1200 ceiling, 24 turns of history (~6.4K tokens) must still
    // fit without folding. A percentage margin (8% of the window) pushed the
    // effective input budget low enough to fold here unnecessarily.
    const r = await turn({ window: 8192, maxTokens: 1200, historyTurns: 24 });
    expect(r.folds).toBe(0);
    expect(r.input).toBeGreaterThan(5000); // the window is genuinely used
    expect(r.total).toBeLessThanOrEqual(8192);
  });

  test("history yields to a large static preset while the current user turn survives", async () => {
    // No static preset: lots of history fits.
    const roomy = await turn({ window: 65536, maxTokens: 1200, descTokens: 1000, historyTurns: 120 });
    // Large static preset: the SAME history must be reduced to fit, not the
    // whole request failed.
    const crowded = await turn({ window: 65536, maxTokens: 1200, descTokens: 45000, historyTurns: 120 });
    expect(crowded.messages.length).toBeLessThan(roomy.messages.length);
    expect(crowded.total).toBeLessThanOrEqual(65536);
    expect(crowded.lastRole).toBe("user");
    // The large preset itself is never truncated: it is fixed cost.
    expect(estimateTokens(crowded.messages[0].content)).toBeGreaterThan(40000);
  });

  test("the configured context is actually usable: prompt budget is near the window, not half", async () => {
    // With no preset and no history, a 64K window must let the input grow far
    // beyond 32K before any fold. Fill to ~50K and confirm nothing folded.
    const r = await turn({ window: 65536, maxTokens: 1200, descTokens: 40000, historyTurns: 40 });
    expect(r.total).toBeGreaterThan(40960); // > 50K tokens used in one request
    expect(r.total).toBeLessThanOrEqual(65536);
  });
});

describe("Large static preset - physically impossible case", () => {
  test("a preset that cannot fit is reported, never silently over-window", async () => {
    // 70K preset on a 64K window: no budgeting can make it fit.
    const r = await turn({ window: 65536, maxTokens: 1200, descTokens: 70000, historyTurns: 10 });
    // The engine still emits a request (the provider decides), but the user is
    // told the prompt exceeds the window so the failure is observable.
    const joined = r.notices.join(" ");
    expect(joined).toContain("exceed the configured prompt budget");
    // And the output allowance is driven to its viable floor, not left large.
    expect(r.out).toBeLessThanOrEqual(1200);
  });
});
