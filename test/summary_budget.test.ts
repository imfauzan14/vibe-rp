// Regression tests for the adaptive continuity-ledger summarizer budget.
//
// The fold request used to send `max_tokens: min(2048, maxOutput)` — a fixed
// ceiling that ignored both the size of the fold and the window it had to fit
// inside. A reasoning model charges its hidden tokens against that same
// allowance, so a long fold could settle at `finish_reason: "length"` with an
// empty ledger and silently degrade. These tests pin the replacement contract:
// an adaptive, bounded budget plus exactly one larger retry.
import { describe, test, expect, afterEach } from "bun:test";
import {
  BrowserChatEngine,
  resolveSummaryBudget,
  countMessages,
  estimateTokens,
  SUMMARY_MIN_TOKENS,
  SUMMARY_DEFAULT_TOKENS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_FLOOR_TOKENS,
  SUMMARY_PROMPT,
  SUMMARY_UPDATE_PROMPT,
  SUMMARY_TARGET_WORDS,
  SUMMARY_UPDATE_TARGET_WORDS,
} from "../public/browser_engine.js";

afterEach(() => {
  globalThis.fetch = undefined;
});

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
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

  test("2. a larger fold earns a larger budget", () => {
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

  test("a prior-ledger update is budgeted at least as high as an initial fold of the same size", async () => {
    // Both folds are grown the same way; only the presence of a prior ledger
    // differs. The merge case is the reasoning-heavy one.
    const noLedger = grownSession();
    const withLedger = grownSession({ priorLedger: "L".repeat(1200) });

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
    // The pure helper agrees: identical workload + a ledger is strictly larger.
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
    expect(plan.overflowWarning).toContain("exceed configured prompt budget");
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
    ).rejects.toThrow();
    expect(generated).toBe(false);
    // Cancellation is not a degraded summarizer: no fallback, no notice.
    expect(notices.join(" ")).not.toContain("condensed without summarizer");
  });

  test("generation max_tokens is clamped to the window's reserved output", () => {
    // A 4096-token window can only reserve half of it for the reply.
    const tiny = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 4096, maxTokens: 4000 }, []);
    expect(tiny.max_tokens).toBe(2048);
    // A request that already fits is passed through untouched.
    const normal = BrowserChatEngine.buildRequestBody({ model: "m", maxContextTokens: 65536, maxTokens: 1200 }, []);
    expect(normal.max_tokens).toBe(1200);
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
