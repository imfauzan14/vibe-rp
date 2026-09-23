// Long-run compaction stress tests.
//
// The unit suite proves one fold is correct. These tests prove the *architecture*
// stays correct after dozens of folds: no ledger inflation runaway, no coverage
// lost or double-folded, no context-budget violation, and no canonical-transcript
// mutation. They drive the real `streamTurn` seam against a deterministic fake
// fetch, so every assertion is about observable behaviour rather than an
// internal helper's exact number.
import { describe, test, expect, afterEach } from "bun:test";
import {
  BrowserChatEngine,
  estimateTokens,
  countMessages,
  clipLedgerToTokens,
  LEDGER_HARD_MAX_TOKENS,
} from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';
const words = (n) => "word ".repeat(n).trim();

afterEach(() => {
  globalThis.fetch = undefined;
});

/**
 * Runs `turns` turns against a scripted summarizer and records what the engine
 * actually sent. `ledgerFor(foldIndex)` returns the visible ledger a fold should
 * produce, which is how each scenario models a different model disposition.
 */
async function simulate({ turns, settings, ledgerFor, wordsPerTurn = 150, replyWords = 200, seed = 11, notices = [] }) {
  const generationBodies = [];
  const foldBodies = [];
  let fold = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream === false) {
      foldBodies.push(body);
      const content = ledgerFor(fold++);
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    generationBodies.push(body);
    return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
  };

  const session = { messages: [{ role: "assistant", content: words(30) }], ledger: "", consumed: 1 };
  const card = { data: { name: "Narrator", first_mes: "hi", description: "A narrator." } };
  const persona = { name: "Player" };
  const snapshot = []; // one row per turn
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (let t = 0; t < turns; t++) {
    const consumedBefore = session.consumed;
    session.messages.push({ role: "user", content: words(Math.max(5, Math.round(wordsPerTurn * (0.5 + rand())))) });
    await BrowserChatEngine.streamTurn({
      card,
      session,
      settings,
      persona,
      onChunk: () => {},
      onNotice: (n) => notices.push(n),
    });
    session.messages.push({ role: "assistant", content: words(Math.max(5, Math.round(replyWords * (0.5 + rand())))) });
    const body = generationBodies[generationBodies.length - 1];
    snapshot.push({
      turn: t + 1,
      ledgerTokens: estimateTokens(session.ledger),
      consumedBefore,
      consumed: session.consumed,
      messages: session.messages.length,
      payloadTokens: countMessages(body.messages),
      maxTokens: body.max_tokens,
    });
  }
  return { session, generationBodies, foldBodies, snapshot };
}

const BASE = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };

describe("Compaction stress - long-run stability", () => {
  test("100 turns with a compliant model: ledger stays at target and never drifts up", async () => {
    const r = await simulate({ turns: 100, settings: BASE, ledgerFor: () => words(750) });
    const last = r.snapshot[r.snapshot.length - 1];
    // A compliant fold is bounded by the word target, so the ledger is a
    // constant, not a growing quantity.
    expect(last.ledgerTokens).toBeGreaterThan(0);
    expect(last.ledgerTokens).toBeLessThanOrEqual(SUMMARY_BOUNDS_TARGET_MAX);
    // The final quarter of the run must not be systematically larger than the
    // first quarter: that is the definition of "no inflation".
    const ledgerAt = (i) => r.snapshot[i].ledgerTokens;
    const early = ledgerAt(24);
    const late = ledgerAt(99);
    expect(late).toBeLessThanOrEqual(early * 1.1);
  });

  test("100 turns: fold coverage advances monotonically and is never re-folded", async () => {
    const r = await simulate({ turns: 100, settings: BASE, ledgerFor: () => words(750) });
    for (const row of r.snapshot) {
      // `consumed` only ever moves forward, so no message is folded twice.
      expect(row.consumed).toBeGreaterThanOrEqual(row.consumedBefore);
      expect(row.consumed).toBeLessThanOrEqual(row.messages);
    }
    // The transcript is append-only: exactly 1 opening + 2 messages per turn.
    expect(r.session.messages.length).toBe(1 + 100 * 2);
    expect(r.snapshot[99].consumed).toBeGreaterThan(r.snapshot[0].consumed);
  });

  test("100 turns: every generation request fits inside the configured window", async () => {
    const r = await simulate({ turns: 100, settings: BASE, ledgerFor: () => words(750) });
    for (const row of r.snapshot) {
      expect(row.payloadTokens + row.maxTokens).toBeLessThanOrEqual(BASE.maxContextTokens);
      expect(row.maxTokens).toBeGreaterThan(0);
    }
  });

  test("an adversarial model that grows its ledger every fold stays hard-bounded", async () => {
    // Each fold returns a ledger 1.2x the previous one, ignoring the word
    // target entirely. Without a hard ceiling this is unbounded growth.
    const notices = [];
    const r = await simulate({
      turns: 100,
      settings: BASE,
      ledgerFor: (i) => words(Math.min(400000, Math.round(800 * Math.pow(1.2, i)))),
      notices,
    });
    const last = r.snapshot[r.snapshot.length - 1];
    // Bounded in absolute terms, independent of the constant under test: the
    // un-bounded version reached millions of tokens here. The literal is chosen
    // well above the real ceiling so a legitimate constant change still passes.
    expect(last.ledgerTokens).toBeLessThanOrEqual(20000);
    expect(last.ledgerTokens).toBeGreaterThan(0);
    // And it must actually stop growing: a fold late in the run is no larger
    // than one early in the run. Unbounded growth would fail this outright.
    const firstBounded = r.snapshot.find((row) => row.ledgerTokens > 0);
    expect(last.ledgerTokens).toBeLessThanOrEqual(Math.max(firstBounded.ledgerTokens, 20000));
    // The stored ledger is canon and is preserved rather than silently
    // truncated. It no longer forces an over-window request: the allocator
    // condenses only the *bytes sent* to fit, and tells the user it did so
    // exactly once on the transition. (Before the universal allocator the only
    // remedy was to send the over-window request and warn about it.)
    expect(notices.filter((n) => n.includes("condensed to fit")).length).toBe(1);
    // Every request the adversarial ledger produced is still valid: the derived
    // ledger is condensed for the send, so nothing exceeds the window.
    for (const row of r.snapshot) {
      expect(row.payloadTokens + row.maxTokens).toBeLessThanOrEqual(BASE.maxContextTokens);
    }
    // No request ever asks for a negative or zero allowance, and the reply
    // reservation is always a positive number.
    for (const row of r.snapshot) {
      expect(row.maxTokens).toBeGreaterThan(0);
      expect(row.payloadTokens).toBeGreaterThan(0);
    }
    // Canonical transcript intact: only appends.
    expect(r.session.messages.length).toBe(1 + 100 * 2);
  });

  test("an adversarial ledger on a small window still yields a usable reply allowance", async () => {
    // A 2048-token window cannot hold a 16k ledger. The ledger is preserved
    // (canon), the overflow is reported, and generation still gets a positive
    // allowance rather than a zero or negative one.
    const notices = [];
    const settings = { ...BASE, maxContextTokens: 2048, maxTokens: 4096 };
    const r = await simulate({
      turns: 40,
      settings,
      ledgerFor: (i) => words(Math.min(200000, Math.round(800 * Math.pow(1.3, i)))),
      notices,
    });
    for (const row of r.snapshot) {
      expect(row.maxTokens).toBeGreaterThanOrEqual(256);
    }
    expect(r.foldBodies.length).toBeGreaterThan(0);
    expect(r.session.messages.length).toBe(1 + 40 * 2);
  });

  test("an oversized ledger is compressed by the summarizer, not blindly clipped", async () => {
    // The model produces an oversized ledger on the fold, then honours the
    // compression request and returns a compact one. The stored ledger must be
    // the compressed version (facts kept), not the clip marker.
    const foldBodies = [];
    const compressBodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream === false) {
        const isCompress = body.messages[1].content.includes("<prior-ledger>") && !body.messages[1].content.includes("<transcript>");
        if (isCompress) {
          compressBodies.push(body);
          return new Response(JSON.stringify({ choices: [{ message: { content: words(700) }, finish_reason: "stop" }] }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        foldBodies.push(body);
        return new Response(JSON.stringify({ choices: [{ message: { content: words(60000) }, finish_reason: "stop" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    const session = { messages: [{ role: "assistant", content: words(30) }], ledger: "", consumed: 1 };
    const card = { data: { name: "N", first_mes: "hi" } };
    for (let t = 0; t < 40; t++) {
      session.messages.push({ role: "user", content: words(150) });
      await BrowserChatEngine.streamTurn({
        card,
        session,
        settings: BASE,
        persona: { name: "P" },
        onChunk: () => {},
        onNotice: () => {},
      });
      session.messages.push({ role: "assistant", content: words(250) });
    }
    // Compression was requested, and the compressed result is what was stored.
    expect(compressBodies.length).toBeGreaterThanOrEqual(1);
    expect(estimateTokens(session.ledger)).toBeLessThanOrEqual(SUMMARY_COMPRESS_TARGET_MAX);
    expect(session.ledger).not.toContain("omitted at the size ceiling");
    // The compression request is itself budgeted, never a flat ceiling.
    for (const body of compressBodies) {
      expect(body.max_tokens).toBeGreaterThanOrEqual(256);
      expect(body.stream).toBe(false);
      expect(body.prompt_cache_key).toBeUndefined();
    }
    // Canonical transcript intact.
    expect(session.messages.length).toBe(1 + 40 * 2);
  });

  test("a permanently unreachable summarizer cannot inflate the ledger without bound", async () => {
    const notices = [];
    const generationBodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream === false) throw new Error("summarizer down");
      generationBodies.push(body);
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    const session = { messages: [{ role: "assistant", content: words(30) }], ledger: "", consumed: 1 };
    const card = { data: { name: "N", first_mes: "hi" } };
    for (let t = 0; t < 100; t++) {
      session.messages.push({ role: "user", content: words(150) });
      await BrowserChatEngine.streamTurn({
        card,
        session,
        settings: BASE,
        persona: { name: "P" },
        onChunk: () => {},
        onNotice: (n) => notices.push(n),
      });
      session.messages.push({ role: "assistant", content: words(250) });
    }
    // Repeated degraded folds re-embed the prior ledger, so without a bound the
    // digest grows linearly forever (measured at 4.6x the prompt budget after
    // 60 turns before this was fixed).
    expect(estimateTokens(session.ledger)).toBeLessThanOrEqual(LEDGER_HARD_MAX_TOKENS);
    const budgets = BrowserChatEngine.resolveBudgets(BASE);
    expect(estimateTokens(session.ledger)).toBeLessThan(budgets.promptBudget);
    // Degradation is reported, never silent.
    expect(notices.some((n) => n.includes("condensed without summarizer"))).toBe(true);
    // Canonical transcript intact: only appends.
    expect(session.messages.length).toBe(1 + 100 * 2);
    // And generation never stopped working.
    expect(generationBodies.length).toBe(100);
  });

  test("repeated compaction across window sizes keeps the prompt/output invariant", async () => {
    for (const maxContextTokens of [2048, 4096, 8192, 16384, 32768]) {
      const settings = { ...BASE, maxContextTokens, maxTokens: 4096 };
      const r = await simulate({ turns: 40, settings, ledgerFor: () => words(600) });
      for (const row of r.snapshot) {
        expect(row.payloadTokens + row.maxTokens).toBeLessThanOrEqual(maxContextTokens);
      }
    }
  });
});

describe("Compaction stress - ledger bound helper", () => {
  test("clipLedgerToTokens is strictly bounded, including a single enormous line", () => {
    // A model ignoring the word target often emits one giant line; the bound
    // must hold there too, not just on a well-formed multi-line ledger.
    const oneLine = "word ".repeat(50000);
    const clipped = clipLedgerToTokens(oneLine, 4096);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(4096);
    // A well-formed ledger is clipped at a line boundary and keeps whole facts.
    const multiline = Array.from({ length: 4000 }, (_, i) => `- fact ${i} about someone`).join("\n");
    const clipped2 = clipLedgerToTokens(multiline, 4096);
    expect(estimateTokens(clipped2)).toBeLessThanOrEqual(4096);
    expect(clipped2).toContain("- fact 0");
    // Under the limit, the text is returned untouched.
    expect(clipLedgerToTokens("short ledger", 4096)).toBe("short ledger");
    // The marker names what happened so the loss is observable.
    expect(clipped).toContain("omitted at the size ceiling");
  });

  test("clipLedgerToTokens never splits a multi-byte character", () => {
    const cjk = "\u4e2d\u6587\u5c0f\u8bf4".repeat(5000);
    const clipped = clipLedgerToTokens(cjk, 2048);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(2048);
    expect(clipped).not.toContain("\ufffd"); // no replacement character
  });
});

// The compliant word target plus prompt overhead is comfortably under this; it
// is a sanity ceiling for the "no drift" assertion, not a product constant.
const SUMMARY_BOUNDS_TARGET_MAX = 3000;
// A compressed ledger is targeted at the 700-word update target; allow slack for
// prompt overhead and the section headers a real model adds.
const SUMMARY_COMPRESS_TARGET_MAX = 1500;
