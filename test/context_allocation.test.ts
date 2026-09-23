// Full-flow context allocation tests.
//
// Every case drives the REAL `streamTurn` seam against a deterministic fake
// fetch and asserts on the ACTUAL outgoing `/chat/completions` body. The
// defects locked down here were all measured on the real pipeline:
//
//  1. A large user output ceiling made `planContext` report a FALSE overflow
//     ("exceed the configured prompt budget") for a request that physically
//     fits, because `overflow` compared the prefix against `promptBudget`, a
//     planner-internal number that already reserves the *desired* output.
//  2. The final assembled request was never measured, so a ledger larger than
//     the window could be sent over-window with no notice.
//  3. A single oversized current user turn was sent over-window silently.
//  4. `mes_example` was permanent, so a preset that fits once examples are
//     pruned was reported impossible.
//  5. A provider context-overflow error was flattened to "HTTP 400", losing
//     the one piece of information that explains the failure.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine, estimateTokens, countMessages } from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';
const words = (n) => "word ".repeat(n).trim();

const CHUNK =
  "## Character Sheet\n\nElena Voss is a cartographer of dead cities. " +
  "```json\n{\"name\":\"Elena Voss\",\"notes\":\"Härte über alles.\"}\n```\n" +
  "| stat | value |\n|---|---|\n| resolve | 8/10 |\n";
const presetOfTokens = (t) => CHUNK.repeat(Math.max(1, Math.ceil(t / estimateTokens(CHUNK))));

afterEach(() => {
  globalThis.fetch = undefined;
});

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
  const card = {
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
  };
}

const OVERFLOW_NOTICE = /exceed the configured prompt budget/i;

describe("Context allocation - no false overflow", () => {
  test("a large output ceiling never reports an overflow for a request that fits", async () => {
    // `maxTokens` close to the window used to drive `promptBudget` to its 512
    // floor, so any non-trivial prefix tripped the overflow warning even though
    // the assembled request fit the window comfortably.
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
    // The headline case: 20K preset, 64K window, a reply ceiling that leaves
    // plenty of room. History must fold, the reply must survive, and no
    // overflow may be reported because the request is valid.
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
    // A derived ledger must never make the assembled request invalid. The
    // canonical transcript and the stored ledger are untouched; only the bytes
    // sent are condensed, and the user is told.
    const r = await turn({ window: 8192, maxTokens: 1200, ledgerTokens: 15000, historyTurns: 6 });
    expect(r.session.ledger.length).toBeGreaterThan(0); // stored ledger preserved
    expect(r.total).toBeLessThanOrEqual(8192);
    expect(r.notice).toMatch(/ledger/i);
  });

  test("an oversized current user turn is reported, never silently over-window", async () => {
    // No budgeting can fit a single turn larger than the window. The engine
    // still sends it (the user's message is required), but must say why.
    const r = await turn({ window: 4096, maxTokens: 1200, userWords: 30000 });
    expect(r.notice).toMatch(/message|turn|input/i);
  });

  test("required content that cannot fit names the offending component", async () => {
    // 70K preset on a 64K window: impossible. The notice must be explicit.
    const r = await turn({ window: 65536, maxTokens: 1200, desc: 70000, historyTurns: 10 });
    expect(r.notice).toMatch(OVERFLOW_NOTICE);
  });
});

describe("Context allocation - static degradation", () => {
  test("examples are dropped before required content when the preset would not otherwise fit", async () => {
    // 10K description + 55K examples on a 64K window with a 4K reply. Without
    // degradation the request is over-window; pruning the examples (the
    // conventional prunable static section) makes it fit with room to spare.
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
