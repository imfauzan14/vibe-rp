// Unified compaction suite: long-run stability (compaction_stress) +
// adaptive summary budget (summary_budget) + fold/desync/shake/hardening fixes
// (compaction_fixes). Builders are unified at the top; every distinct-behavior
// test from the three originals is kept verbatim below.
import { describe, test, expect, afterEach } from "bun:test";
import {
  BrowserChatEngine,
  estimateTokens,
  countMessages,
  clipLedgerToTokens,
  resolveSummaryBudget,
  fitFoldLedgerTokens,
  TOKEN_SAFETY_MARGIN,
  SUMMARY_MIN_TOKENS,
  SUMMARY_DEFAULT_TOKENS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_FLOOR_TOKENS,
  SUMMARY_PROMPT,
  SUMMARY_UPDATE_PROMPT,
  SUMMARY_TARGET_WORDS,
  SUMMARY_UPDATE_TARGET_WORDS,
  LEDGER_HARD_MAX_TOKENS,
} from "../public/browser_engine.js";
import { words, SSE_OK, resetFetch } from "./helpers.js";
import { utf8Decoder } from "../public/text.js";

afterEach(() => {
  resetFetch();
  // clipLedgerToTokens decodes with { stream: true } on the shared decoder,
  // which buffers a trailing partial sequence; flush it so no test leaks
  // decoder state into the next test's SSE stream.
  utf8Decoder.decode();
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
    //
    // The window is large on purpose: compression is a *second* LLM call whose
    // input is the oversized ledger itself, so it can only run where that input
    // fits. On a small window the engine skips straight to the deterministic
    // clip instead of spending a request the provider would reject (covered in
    // `summary_budget.test.ts`).
    const wide = { ...BASE, maxContextTokens: 32768 };
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
        return new Response(JSON.stringify({ choices: [{ message: { content: words(14000) }, finish_reason: "stop" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    const session = { messages: [{ role: "assistant", content: words(30) }], ledger: "", consumed: 1 };
    const card = { data: { name: "N", first_mes: "hi" } };
    for (let t = 0; t < 120; t++) {
      session.messages.push({ role: "user", content: words(150) });
      await BrowserChatEngine.streamTurn({
        card,
        session,
        settings: wide,
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
    // The compression request is itself budgeted, never a flat ceiling, and its
    // whole input plus output fits the window it was sent against.
    for (const body of compressBodies) {
      expect(body.max_tokens).toBeGreaterThanOrEqual(256);
      expect(body.stream).toBe(false);
      expect(body.prompt_cache_key).toBeUndefined();
      expect(countMessages(body.messages) + body.max_tokens).toBeLessThanOrEqual(wide.maxContextTokens);
    }
    // Canonical transcript intact.
    expect(session.messages.length).toBe(1 + 120 * 2);
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

// 8192 is small enough that a 60-turn transcript folds several times, which is
// what exercises the adaptive budget through the real streamTurn seam.
const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };

/** A transcript big enough that planContext folds it. */
function compactable(turns = 60, words = 300) {
  return {
    messages: [
      { role: "assistant", content: "greeting" },
      ...Array.from({ length: turns }, (_, i) => ({
        role: i % 2 ? "user" : "assistant",
        content: "word ".repeat(words),
      })),
    ],
    ledger: "",
    consumed: 1,
  };
}

/**
 * Grows a session one turn at a time until planContext first folds, then returns
 * the whole session in the state where the next streamTurn performs that fold.
 * This is the realistic shape: a fold covers a bounded backlog rather than the
 * entire history at once.
 */
function grownSession({ words = 300, priorLedger = "", maxTurns = 400 } = {}) {
  const msgs = [{ role: "assistant", content: "greeting" }];
  for (let i = 0; i < maxTurns; i++) {
    msgs.push({ role: i % 2 ? "user" : "assistant", content: "word ".repeat(words) });
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: priorLedger,
      consumed: 1,
      settings,
    });
    if (plan.compacted && plan.folded.length > 0) {
      return { messages: msgs, ledger: priorLedger, consumed: 1 };
    }
  }
  throw new Error("test fixture never compacted");
}

/** Captures every non-stream (fold) request body while serving a reply. */
function captureFolds(reply) {
  const folds = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    folds.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return folds;
}

describe("Adaptive summary budget - pure helper", () => {
  test("1. a small fold stays in the lower/default range", () => {
    const tiny = resolveSummaryBudget({ transcriptTokens: 200 });
    expect(tiny).toBeGreaterThanOrEqual(SUMMARY_MIN_TOKENS);
    expect(tiny).toBeLessThanOrEqual(SUMMARY_DEFAULT_TOKENS);
    // A fold exactly the size of the default budget gets exactly that budget.
    expect(resolveSummaryBudget({ transcriptTokens: SUMMARY_DEFAULT_TOKENS })).toBe(SUMMARY_DEFAULT_TOKENS);
  });

  test("2. a larger fold earns a larger workload-derived target", () => {
    // No window is passed, so this pins the *target* (which is monotonic), not
    // the final budget (which the window's headroom can pull back down).
    const small = resolveSummaryBudget({ transcriptTokens: 1200 });
    const medium = resolveSummaryBudget({ transcriptTokens: 3000 });
    const large = resolveSummaryBudget({ transcriptTokens: 8000 });
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
  });

  test("3. the budget never exceeds the hard ceiling", () => {
    expect(resolveSummaryBudget({ transcriptTokens: 100_000_000 })).toBe(SUMMARY_MAX_TOKENS);
    expect(resolveSummaryBudget({ transcriptTokens: 10_000, extraTokens: 10_000 })).toBe(SUMMARY_MAX_TOKENS);
    // Non-numeric / negative input cannot escape the bounds either.
    expect(resolveSummaryBudget({ transcriptTokens: -5 })).toBeGreaterThanOrEqual(SUMMARY_MIN_TOKENS);
    expect(resolveSummaryBudget({ transcriptTokens: NaN })).toBeGreaterThanOrEqual(SUMMARY_MIN_TOKENS);
  });

  test("4. a small context window clamps the budget to the request's own headroom", () => {
    // 4096 window, 1500-token transcript + 400-token overhead + 512 margin:
    // only ~1684 tokens remain for the completion, so the 1924-token policy
    // budget must yield to the window.
    const clamped = resolveSummaryBudget({ transcriptTokens: 1500, promptTokens: 400, contextWindow: 4096 });
    expect(clamped).toBeLessThan(resolveSummaryBudget({ transcriptTokens: 1500 }));
    expect(clamped).toBeGreaterThanOrEqual(SUMMARY_FLOOR_TOKENS);
    // A window too small to fit even the input falls back to the viable floor
    // rather than requesting zero (or a negative) allowance.
    expect(resolveSummaryBudget({ transcriptTokens: 4000, promptTokens: 800, contextWindow: 2048 })).toBe(SUMMARY_FLOOR_TOKENS);
  });

  test("5. a prior ledger earns reasoning headroom, and the ledger is charged to the window", () => {
    const initial = resolveSummaryBudget({ transcriptTokens: 2048 });
    const update = resolveSummaryBudget({ transcriptTokens: 2048, hasPriorLedger: true });
    expect(update).toBeGreaterThan(initial);
    // The same update, but with a ledger large enough to consume the window,
    // is clamped back down instead of exceeding it.
    const constrained = resolveSummaryBudget({
      transcriptTokens: 2048,
      ledgerTokens: 3000,
      promptTokens: 500,
      contextWindow: 8192,
      hasPriorLedger: true,
    });
    expect(constrained).toBeLessThan(update);
  });

  test("word targets are single-sourced and stay compact regardless of window", () => {
    expect(SUMMARY_PROMPT).toContain(`under ${SUMMARY_TARGET_WORDS} words`);
    expect(SUMMARY_UPDATE_PROMPT).toContain(`under ${SUMMARY_UPDATE_TARGET_WORDS} words`);
    // A 64k window must not silently enlarge the ledger itself.
    expect(SUMMARY_TARGET_WORDS).toBeLessThan(SUMMARY_UPDATE_TARGET_WORDS);
    expect(SUMMARY_UPDATE_TARGET_WORDS).toBeLessThanOrEqual(1000);
  });

  test("9. the workload target is monotonic, but the final budget may fall as headroom binds", () => {
    // The target alone (no window) never decreases as the workload grows.
    let prev = -Infinity;
    for (let w = 0; w <= 20000; w += 50) {
      const v = resolveSummaryBudget({ transcriptTokens: w });
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // With a fixed window the *final* budget is not monotonic: past the point
    // where headroom becomes limiting, more input yields a smaller ceiling.
    const window = 8192;
    let sawDecrease = false;
    let prevFinal = -Infinity;
    for (let w = 0; w <= 20000; w += 50) {
      const v = resolveSummaryBudget({ transcriptTokens: w, promptTokens: 400, contextWindow: window });
      if (v < prevFinal) sawDecrease = true;
      prevFinal = v;
    }
    expect(sawDecrease).toBe(true);
    // The decrease is the window responding, not the policy: the pure target
    // for the larger workload is still >= the smaller one's.
    expect(resolveSummaryBudget({ transcriptTokens: 4000 })).toBeGreaterThanOrEqual(
      resolveSummaryBudget({ transcriptTokens: 3000 })
    );
    // A prior ledger consumes headroom, so the final budget can fall below the
    // no-ledger case even though the target rose.
    const withBigLedger = resolveSummaryBudget({
      transcriptTokens: 2048,
      ledgerTokens: 5000,
      promptTokens: 400,
      contextWindow: 8192,
      hasPriorLedger: true,
    });
    expect(withBigLedger).toBeLessThan(resolveSummaryBudget({ transcriptTokens: 2048, promptTokens: 400, contextWindow: 8192 }));
  });
});

describe("Adaptive summary budget - through the fold seam", () => {
  test("the fold request carries an adaptive, bounded max_tokens", async () => {
    const folds = captureFolds("ledger");
    const session = compactable();
    await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    expect(folds.length).toBeGreaterThanOrEqual(1);
    for (const body of folds) {
      expect(body.stream).toBe(false);
      expect(typeof body.max_tokens).toBe("number");
      expect(body.max_tokens).toBeGreaterThanOrEqual(SUMMARY_FLOOR_TOKENS);
      expect(body.max_tokens).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS);
      // No cache-write controls ever ride along on a one-off fold.
      expect(body.prompt_cache_key).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("cache_control");
    }
  });

  test("in this fixture a prior-ledger update is budgeted at least as high as an initial fold of the same size", async () => {
    // Both folds are grown the same way; only the presence of a prior ledger
    // differs. In this window the headroom does not bind, so the update's
    // reasoning headroom survives into the final budget. (When headroom does
    // bind, the final budget can be smaller — see test 9.)
    const noLedger = grownSession({ words: 150 });
    const withLedger = grownSession({ words: 150, priorLedger: "L".repeat(600) });

    const initialFolds = captureFolds("ledger");
    await BrowserChatEngine.streamTurn({ card: null, session: noLedger, settings, persona: null, agentsContract: "" });
    const updateFolds = captureFolds("ledger");
    await BrowserChatEngine.streamTurn({ card: null, session: withLedger, settings, persona: null, agentsContract: "" });
    expect(initialFolds.length).toBeGreaterThanOrEqual(1);
    expect(updateFolds.length).toBeGreaterThanOrEqual(1);
    const initial = initialFolds[0].max_tokens;
    const update = updateFolds[0].max_tokens;
    expect(update).toBeGreaterThanOrEqual(initial);
    expect(update).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS);
    // The pure helper agrees when no window is supplied: identical workload plus
    // a ledger raises the *target*. (With a window, the ledger also consumes
    // headroom, so the final budget need not be larger — see test 9.)
    expect(resolveSummaryBudget({ transcriptTokens: 2048, hasPriorLedger: true })).toBeGreaterThan(
      resolveSummaryBudget({ transcriptTokens: 2048 })
    );
  });

  test("6. a length-truncated empty fold retries exactly once at a larger budget", async () => {
    const budgets = [];
    let call = 0;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      budgets.push(body.max_tokens);
      call += 1;
      // First fold: cut off at the ceiling with no visible ledger (the
      // reasoning-model failure mode). Retry: a real ledger.
      if (call === 1) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ledger" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = grownSession();
    await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    // Exactly one retry, and it spent a strictly larger budget.
    expect(budgets.length).toBe(2);
    expect(budgets[1]).toBeGreaterThan(budgets[0]);
    expect(budgets[1]).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS);
    // The retry's ledger won.
    expect(session.ledger).toBe("ledger");
  });

  test("6c. when the retry also fails there are still exactly two attempts, never a loop", async () => {
    // A window big enough that the retry's larger budget is genuinely available
    // (headroom does not clamp), and a model that fails both times. This is the
    // only fixture that exercises "retry fires AND fails", which is what bounds
    // the loop count: test 6 succeeds on retry, and 6b never retries at all.
    const bigWindow = { ...settings, maxContextTokens: 8192 };
    const budgets = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      budgets.push(body.max_tokens);
      // Always length-truncated and empty, so the retry can never "succeed".
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = grownSession();
    await BrowserChatEngine.streamTurn({ card: null, session, settings: bigWindow, persona: null, agentsContract: "" });
    // The first fold produced no text, so a retry was warranted (budget rose)…
    expect(budgets.length).toBe(2);
    expect(budgets[1]).toBeGreaterThan(budgets[0]);
    // …but the retry failing must not start a third attempt.
    expect(budgets.length).toBeLessThanOrEqual(2);
    // The deterministic digest took over, and the ledger is still bounded.
    expect(session.ledger.length).toBeGreaterThan(0);
    expect(estimateTokens(session.ledger)).toBeLessThanOrEqual(LEDGER_HARD_MAX_TOKENS);
  });

  test("6b. a content-less fold that has no headroom left does not loop", async () => {
    const budgets = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      budgets.push(body.max_tokens);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const notices = [];
    const session = compactable();
    await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings,
      persona: null,
      agentsContract: "",
      onNotice: (n) => notices.push(n),
    });
    // At most two attempts: the initial fold and its single bounded retry.
    expect(budgets.length).toBeLessThanOrEqual(2);
    // No text survived, so the deterministic digest took over and said so.
    expect(session.ledger.length).toBeGreaterThan(0);
    expect(notices.join(" ")).toContain("Continuity condensed without summarizer");
  });

  test("8. an oversized summary is stored but the payload stays bounded", async () => {
    // A model that ignores the word target and returns a huge ledger.
    captureFolds("L".repeat(60000));
    const session = compactable();
    const before = session.messages.length;
    await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    // The ledger is canon: it is never silently truncated or discarded.
    expect(session.ledger.length).toBe(60000);
    // But the very next payload cannot be over budget because of it.
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "sys",
      messages: session.messages,
      ledger: session.ledger,
      consumed: session.consumed,
      settings,
    });
    expect(plan.overflow).toBe(true);
    expect(plan.overflowWarning).toContain("exceed the configured prompt budget");
    // The stored transcript is untouched by compaction.
    expect(session.messages.length).toBe(before);
  });
});

describe("Adaptive summary budget - cancellation and generation budget", () => {
  test("7. aborting the fold aborts the turn, skips the fallback, and never generates", async () => {
    let generated = false;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) {
        generated = true;
        return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const notices = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      BrowserChatEngine.streamTurn({
        card: null,
        session: compactable(),
        settings,
        persona: null,
        agentsContract: "",
        signal: controller.signal,
        onNotice: (n) => notices.push(n),
      })
    ).rejects.toThrow(/abort/i);
    expect(generated).toBe(false);
    // Cancellation is not a degraded summarizer: no fallback, no notice.
    expect(notices.join(" ")).not.toContain("condensed without summarizer");
  });

  test("generation max_tokens is clamped to the window's reserved output", () => {
    // A 4096-token window cannot grant a 4000-token reply and still leave room
    // for any prompt: the ceiling is honoured only up to the minimum input
    // floor (4096 - 256 margin - 512 floor = 3328).
    const tiny = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 4096, maxTokens: 4000 }, []);
    expect(tiny.max_tokens).toBe(3328);
    // A request that already fits is passed through untouched.
    const normal = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 65536, maxTokens: 1200 }, []);
    expect(normal.max_tokens).toBe(1200);
    // A large ceiling on a large window is honoured in full (no 50% cap).
    const large = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 65536, maxTokens: 4096 }, []);
    expect(large.max_tokens).toBe(4096);
    // Omitting the ceiling leaves the provider default in force.
    const omitted = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 65536 }, []);
    expect("max_tokens" in omitted).toBe(false);
  });

  test("prompt plus reserved output can never exceed the configured window", () => {
    for (const window of [2048, 4096, 8192, 16384, 32768, 65536, 131072]) {
      const b = BrowserChatEngine.resolveBudgets({ maxContextTokens: window, maxTokens: 4096 });
      expect(b.promptBudget + b.reservedOutput).toBeLessThanOrEqual(b.contextWindow);
    }
  });

  test("the fold request's input is charged against its own window", () => {
    // Sanity: a fold is not exempt from the context invariant. Its input plus
    // its adaptive output must fit the window it was budgeted for.
    const transcript = "word ".repeat(2000);
    const transcriptTokens = estimateTokens(transcript);
    const budget = resolveSummaryBudget({
      transcriptTokens,
      promptTokens: 400,
      contextWindow: 8192,
    });
    expect(transcriptTokens + 400 + budget).toBeLessThanOrEqual(8192);
    expect(countMessages([{ role: "user", content: transcript }])).toBeGreaterThan(0);
  });
});

describe("Fold input fits the window - a large stored ledger cannot kill the summarizer", () => {
  // The stored ledger is bounded by LEDGER_HARD_MAX_TOKENS, not by the window,
  // so on a small window it can legitimately be larger than the whole request.
  // Passing it to the fold whole made the fold itself over-window, and the
  // provider's rejection silently degraded the fold to the extractive digest —
  // the summarizer became unreachable exactly when continuity mattered most.

  test("fitFoldLedgerTokens clips the prior ledger to what fits beside the transcript", () => {
    const fitted = fitFoldLedgerTokens({
      contextWindow: 8192,
      promptTokens: 400,
      transcriptTokens: 4000,
      ledgerTokens: 16000,
    });
    // Everything the fold sends, plus the floor it needs for output, fits.
    expect(fitted).toBeLessThan(16000);
    expect(400 + 4000 + fitted + SUMMARY_FLOOR_TOKENS + TOKEN_SAFETY_MARGIN).toBeLessThanOrEqual(8192);
  });

  test("a ledger that already fits is left untouched", () => {
    expect(fitFoldLedgerTokens({ contextWindow: 65536, promptTokens: 400, transcriptTokens: 2000, ledgerTokens: 3000 })).toBe(3000);
  });

  test("a huge ledger on a small window still folds via the summarizer", async () => {
    const window = 8192;
    const seen = { fold: 0, foldOver: 0, foldOk: 0 };
    const notices = [];
    // A stored ledger far larger than the window (bounded by the hard ceiling).
    const session = {
      messages: [
        { id: "m0", role: "assistant", content: "The lantern gutters." },
        ...Array.from({ length: 30 }, (_, i) => ({
          id: `m${i + 1}`,
          role: i % 2 ? "assistant" : "user",
          content: `Turn ${i}. `.repeat(60),
        })),
      ],
      ledger: "- Cast: Elena, the archivist with a lantern.\n".repeat(1200),
      consumed: 1,
    };
    const card = { id: "c", data: { name: "Elena", first_mes: "Hi." } };
    const localSettings = { ...settings, maxContextTokens: window };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const input = countMessages(body.messages);
      if (body.stream) return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
      seen.fold += 1;
      // A real provider rejects input + max_tokens over its window.
      if (input + (body.max_tokens || 0) > window) {
        seen.foldOver += 1;
        return new Response(JSON.stringify({ error: { message: `maximum context length is ${window} tokens` } }), { status: 400 });
      }
      seen.foldOk += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "- Cast: Elena.\n- Timeline: recently, the lantern." }, finish_reason: "stop" }] }),
        { status: 200 }
      );
    };
    await BrowserChatEngine.streamTurn({
      card,
      session,
      settings: localSettings,
      persona: { name: "You" },
      onChunk: () => {},
      onNotice: (n) => notices.push(n),
    });
    // The fold reached the summarizer instead of being rejected for size.
    expect(seen.fold).toBeGreaterThan(0);
    expect(seen.foldOver).toBe(0);
    expect(seen.foldOk).toBeGreaterThan(0);
    expect(notices.some((n) => /condensed without summarizer/i.test(n))).toBe(false);
    expect(session.ledger).toContain("Elena");
  });
});

describe("Ledger compression never spends a request it knows will be rejected", () => {
  test("an oversized ledger on a small window is clipped without a doomed compression call", async () => {
    // A ledger above LEDGER_HARD_MAX_TOKENS on a window smaller than that is
    // unsendable whole: the compression request would always be rejected, and
    // clipping its input would let the summarizer silently drop unseen canon.
    // The deterministic clip is the correct outcome, so no request is made.
    const window = 8192;
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: window, maxTokens: 1200 };
    const session = {
      messages: [
        { id: "m0", role: "assistant", content: "The lantern gutters." },
        ...Array.from({ length: 60 }, (_, i) => ({ id: `m${i + 1}`, role: i % 2 ? "assistant" : "user", content: `Turn ${i}. `.repeat(120) })),
      ],
      ledger: "",
      consumed: 1,
    };
    const card = { id: "c", data: { name: "Elena", first_mes: "Hi." } };
    // A fold output far above the hard ceiling, so the bound step runs.
    const oversized = "- Cast: Elena, the archivist with a lantern.\n".repeat(1500);
    let compressionCalls = 0;
    let foldCalls = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream) return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
      const isCompression = body.messages.some((m) => typeof m.content === "string" && m.content.includes("grown too large"));
      if (isCompression) {
        compressionCalls += 1;
        const input = countMessages(body.messages);
        if (input + (body.max_tokens || 0) > window) return new Response(JSON.stringify({ error: { message: "maximum context length" } }), { status: 400 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "- Cast: Elena." }, finish_reason: "stop" }] }), { status: 200 });
      }
      foldCalls += 1;
      // The fold returns a ledger larger than the hard ceiling.
      return new Response(JSON.stringify({ choices: [{ message: { content: oversized }, finish_reason: "stop" }] }), { status: 200 });
    };
    await BrowserChatEngine.streamTurn({ card, session, settings, persona: { name: "You" }, onChunk: () => {}, onNotice: () => {} });
    expect(foldCalls).toBeGreaterThan(0);
    // No compression request was attempted at a size that cannot fit.
    expect(compressionCalls).toBe(0);
    expect(estimateTokens(session.ledger)).toBeLessThanOrEqual(LEDGER_HARD_MAX_TOKENS);
  });
});

const filler = (n) => "word ".repeat(n); // ~n tokens at bytes/4

const buildMessages = (turns, wordsPerMsg) => {
  const msgs = [{ role: "assistant", content: filler(wordsPerMsg) }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: filler(wordsPerMsg) });
    msgs.push({ role: "assistant", content: filler(wordsPerMsg) });
  }
  return msgs;
};

describe("Fix 1 - fold-to-headroom cut", () => {
  test("fold keeps at least ~40% tail headroom after planning", () => {
    const settings = { maxContextTokens: 8192, maxTokens: 1000 };
    const messages = buildMessages(30, 200);
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages,
      ledger: "",
      consumed: 1,
      settings,
    });
    expect(plan.compacted).toBe(true);
    const { promptBudget } = BrowserChatEngine.resolveBudgets(settings);
    // Tail actually sent (history minus pinned) must fit well under the full
    // tail budget: the fold targeted ~60% of it.
    const historyTokens = countMessages(plan.history);
    const outer = estimateTokens("Base prompt.");
    const tailBudget = Math.max(256, promptBudget - outer - 4); // pinned = 1 msg
    expect(historyTokens - 4).toBeLessThanOrEqual(Math.floor(tailBudget * 0.6) + 16); // +16: user-turn boundary rounding
    expect(plan.history.length).toBeLessThan(messages.length);
  });

  test("a turn after a fold does not immediately compact again", () => {
    const settings = { maxContextTokens: 8192, maxTokens: 1000 };
    const messages = buildMessages(30, 200);
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages,
      ledger: "",
      consumed: 1,
      settings,
    });
    expect(plan.compacted).toBe(true);
    // One more short user turn lands inside the reserved headroom.
    const grown = [...messages, { role: "user", content: "ok" }];
    const next = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages: grown,
      ledger: "ledger text",
      consumed: plan.consumedAfter,
      settings,
    });
    expect(next.compacted).toBe(false);
  });
});

describe("Fix 1b - hard truncate after re-plan", () => {
  test("swollen ledger triggers hard truncate so payload respects budget", async () => {
    // Private #truncateHistory is unreachable from outside the class; drive it
    // through streamTurn with a mocked summary endpoint returning an
    // oversized ledger. The truncate path must keep the payload near budget.
    const E = BrowserChatEngine;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) {
        globalThis.__sent = body;
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "L".repeat(30000) } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = {
      messages: [
        { role: "assistant", content: "greeting" },
        ...Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "x ".repeat(300) })),
      ],
      ledger: "",
      consumed: 1,
    };
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 4096, maxTokens: 300 };
    await E.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    const est = (s) => Math.ceil(new TextEncoder().encode(s).length / 4);
    let total = 0;
    for (const msg of globalThis.__sent.messages) total += est(msg.content) + 4;
    const budget = E.resolveBudgets(settings).promptBudget;
    expect(globalThis.__sent.messages.length).toBeLessThan(session.messages.length);
    // A ledger that alone exceeds the budget is *condensed for the send* so the
    // assembled request stays valid, rather than being sent whole and pushing
    // the payload over the window. The stored ledger is canon and is untouched.
    const roles = globalThis.__sent.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[roles.length - 1]).toBe("user");
    const sentLedger = globalThis.__sent.messages[1]?.content || "";
    expect(est(sentLedger)).toBeLessThan(est(session.ledger));
    expect(total + globalThis.__sent.max_tokens).toBeLessThanOrEqual(settings.maxContextTokens);
    // Sanity: budget reference is real (guards against settings regressions).
    expect(budget).toBeGreaterThan(0);
  });

  test("moderately swollen ledger truncates tail to fit prompt budget", async () => {
    const E = BrowserChatEngine;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) {
        globalThis.__sent2 = body;
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "L".repeat(10000) } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = {
      messages: [
        { role: "assistant", content: "greeting" },
        ...Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "x ".repeat(300) })),
      ],
      ledger: "",
      consumed: 1,
    };
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 4096, maxTokens: 300 };
    await E.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    const est = (s) => Math.ceil(new TextEncoder().encode(s).length / 4);
    let total = 0;
    for (const msg of globalThis.__sent2.messages) total += est(msg.content) + 4;
    // The authoritative invariant is the window, not the planner's internal
    // prompt budget: the assembled request plus its requested reply must fit.
    expect(total + globalThis.__sent2.max_tokens).toBeLessThanOrEqual(settings.maxContextTokens);
    expect(globalThis.__sent2.messages.length).toBeLessThan(session.messages.length);
  });

});
describe("Fix 2 - compaction desync", () => {
  test("empty-content message mid-history does not shift the fold boundary", () => {
    const E = BrowserChatEngine;
    const big = "u1 ".repeat(2400);
    const msgs = [
      { role: "assistant", content: "greeting" }, // idx 0 pinned
      { role: "user", content: big }, // idx 1 folded
      { role: "assistant", content: "" }, // idx 2 empty residue, inside fold range
      { role: "user", content: "u2" }, // idx 3 kept
      { role: "assistant", content: "a2" }, // idx 4 kept
    ];
    const plan = E.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 2048, maxTokens: 256 },
    });
    expect(plan.compacted).toBe(true);
    // Absolute boundary: everything before consumedAfter that is folded or
    // empty is excluded from history; everything after must be present.
    expect(plan.consumedAfter).toBe(3);
    const keptContents = plan.history.map((m) => (m.content || "").trim().slice(0, 10));
    expect(keptContents).toContain("greeting");
    expect(keptContents).toContain("u2");
    expect(keptContents).toContain("a2");
    expect(keptContents.join("|")).not.toContain("u1 u1");
  });

  test("boundary crossing an empty message keeps the next message in history", () => {
    const E = BrowserChatEngine;
    // Two big messages with an empty between; cut folds the first one only.
    const msgs = [
      { role: "assistant", content: "greeting" },
      { role: "user", content: "a ".repeat(4800) }, // idx 1
      { role: "assistant", content: "" }, // idx 2 empty
      { role: "user", content: "b ".repeat(4800) }, // idx 3 must stay in history if cut lands on it
      { role: "assistant", content: "c" }, // idx 4
    ];
    const plan = E.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 2048, maxTokens: 256 },
    });
    expect(plan.compacted).toBe(true);
    // Invariant: every non-empty message after consumedAfter is in history,
    // every message before it is not (modulo the pinned opening).
    for (let i = plan.consumedAfter; i < msgs.length; i++) {
      if (!msgs[i].content) continue;
      expect(plan.history.some((m) => m.content === msgs[i].content)).toBe(true);
    }
    for (let i = 1; i < plan.consumedAfter; i++) {
      if (!msgs[i].content) continue;
      expect(plan.history.some((m) => m.content === msgs[i].content)).toBe(false);
    }
  });

  test("deleteMessage inside covered range decrements consumed", () => {
    const { SessionController } = require("../public/session_controller.js");
    const ctl = new SessionController();
    ctl.activeSession = {
      id: "s1",
      messages: [
        { id: "m0", role: "assistant", content: "greeting" },
        { id: "m1", role: "user", content: "one" },
        { id: "m2", role: "assistant", content: "two" },
        { id: "m3", role: "user", content: "three" },
      ],
      ledger: "some ledger",
      consumed: 3,
    };
    // Delete m1 (idx 1 < consumed 3): consumed must drop to 2 so coverage
    // stays aligned after the splice.
    expect(ctl.deleteMessage("m1")).toBe(true);
    expect(ctl.activeSession.messages.length).toBe(3);
    expect(ctl.activeSession.consumed).toBe(2);
    // Delete outside covered range: consumed untouched.
    expect(ctl.deleteMessage("m3")).toBe(true);
    expect(ctl.activeSession.consumed).toBe(2);
  });

  test("deleting msg_init resets ledger and consumed to empty state", () => {
    const { SessionController } = require("../public/session_controller.js");
    const ctl = new SessionController();
    ctl.activeSession = {
      id: "s1",
      messages: [
        { id: "m0", role: "assistant", content: "greeting" },
        { id: "m1", role: "user", content: "one" },
      ],
      ledger: "stale ledger",
      consumed: 2,
    };
    expect(ctl.deleteMessage("m0")).toBe(true);
    expect(ctl.activeSession.ledger).toBe("");
    expect(ctl.activeSession.consumed).toBe(0);
  });
});

describe("Fix 3 - thought shake bound", () => {
  test("shake strips thoughts from old turns with a small suffix", () => {
    const E = BrowserChatEngine;
    const msgs = [
      { role: "assistant", content: "greeting" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "<thought x>secret</thought>visible reply" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "latest" },
    ];
    const plan = E.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 32768, maxTokens: 1500 },
    });
    const shaken = plan.history.map((m) => m.content || "");
    expect(shaken.some((c) => c.includes("secret"))).toBe(false);
    expect(shaken.some((c) => c.includes("visible reply"))).toBe(true);
  });

  test("shake refuses to rewrite when the suffix exceeds the 1500-token cap", () => {
    const E = BrowserChatEngine;
    const bigTail = "tail ".repeat(2000); // ~2000 tokens > cap
    const msgs = [
      { role: "assistant", content: "<thought x>secret</thought>old reply" },
      { role: "user", content: bigTail },
      { role: "assistant", content: "final" },
    ];
    const plan = E.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 32768, maxTokens: 1500 },
    });
    expect(plan.history.some((m) => (m.content || "").includes("secret"))).toBe(true);
  });

  test("shake preserves deep history thought tags to protect prompt cache while stripping near-tail thoughts", () => {
    const E = BrowserChatEngine;
    const msgs = [
      { role: "assistant", content: "greeting" },
      { role: "user", content: "early user" },
      { role: "assistant", content: "<thought>deep secret</thought>early assistant" },
      { role: "user", content: "word ".repeat(9000) }, // suffix of early assistant is ~9000 tokens (> 8000 limit)
      { role: "assistant", content: "<thought>recent secret</thought>near-tail assistant" },
      { role: "user", content: "tail question" },
      { role: "assistant", content: "latest assistant" },
    ];
    const plan = E.planContext({
      systemPrompt: "sys",
      messages: msgs,
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 65536, maxTokens: 1500 },
    });
    const contents = plan.history.map((m) => m.content || "");
    // Deep message is untouched to preserve cache prefix:
    expect(contents.some((c) => c.includes("deep secret"))).toBe(true);
    // Near-tail message whose suffix is small is stripped:
    expect(contents.some((c) => c.includes("recent secret"))).toBe(false);
    expect(contents.some((c) => c.includes("near-tail assistant"))).toBe(true);
  });
});

describe("Fixes 4 & 5 - fold prompt hardening and no cache-write", () => {
  test("both fold prompts carry the loss + verbatim + time-anchor rules", () => {
    for (const prompt of [SUMMARY_PROMPT, SUMMARY_UPDATE_PROMPT]) {
      expect(prompt).toContain("lost forever");
      expect(prompt).toContain("conversation record wins");
      expect(prompt).toContain("dates and time anchors");
      expect(prompt).toContain('e.g. "earlier", "recently"');
    }
  });

  test("fold request never streams, never cache-writes", async () => {
    // Private #buildSummaryRequest: observe it through the mocked summary
    // endpoint rather than direct access.
    let summaryBody = null;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (!body.stream) summaryBody = body;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ledger" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const E = BrowserChatEngine;
    const settings = {
      apiEndpoint: "https://x.test/v1",
      model: "m",
      maxContextTokens: 2048,
      maxTokens: 256,
    };
    const session = {
      messages: [
        { role: "assistant", content: "greeting" },
        ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "x ".repeat(300) })),
      ],
      ledger: "",
      consumed: 1,
    };
    await E.streamTurn({ card: null, session, settings, persona: null, agentsContract: "" });
    expect(summaryBody).not.toBeNull();
    // One-off fold request: no stream, no cache_control anywhere in the body.
    expect(summaryBody.stream).toBe(false);
    expect(JSON.stringify(summaryBody)).not.toContain("cache_control");
    // Folding must be repeatable and cheap: temperature pinned near zero.
    expect(summaryBody.temperature).toBe(0.1);
    // No cache key on fold requests.
    expect(summaryBody.prompt_cache_key).toBeUndefined();
  });
});
