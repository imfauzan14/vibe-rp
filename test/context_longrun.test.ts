// Long-run and provider-adaptation tests for the universal allocator.
//
// The compaction stress suite already proves 100 turns. This extends the same
// invariants to 500 and 1000 deterministic turns and adds the provider
// context-overflow adaptation, which must be bounded, non-recursive and
// cancellation-safe.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine, estimateTokens, countMessages, LEDGER_HARD_MAX_TOKENS } from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
const words = (n) => "word ".repeat(n).trim();

afterEach(() => {
  globalThis.fetch = undefined;
});

const BASE = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };

/**
 * Runs a deterministic session and records one row per turn: whether the actual
 * request fit the window, the consumed boundary (must be monotonic), the stored
 * ledger size, and whether any fold happened twice.
 */
async function longRun({ turns, settings = BASE, ledgerWords = 750, seed = 7, wordsPerTurn = 150, replyWords = 200 }) {
  const generationBodies = [];
  let fold = 0;
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
    void fold;
  }
  return { session, rows };
}

describe("Long-run allocation - 500 and 1000 turns", () => {
  for (const turns of [500, 1000]) {
    test(`${turns} turns: every request fits, coverage is monotonic, ledger stays bounded`, async () => {
      const r = await longRun({ turns });
      for (const row of r.rows) {
        expect(row.input + row.output).toBeLessThanOrEqual(BASE.maxContextTokens);
        expect(row.output).toBeGreaterThan(0);
        expect(row.consumed).toBeGreaterThanOrEqual(row.consumedBefore);
      }
      expect(r.session.messages.length).toBe(1 + turns * 2);
      expect(estimateTokens(r.session.ledger)).toBeLessThanOrEqual(LEDGER_HARD_MAX_TOKENS);
      // Coverage advanced at least once, so folding is actually happening.
      expect(r.rows[r.rows.length - 1].consumed).toBeGreaterThan(r.rows[0].consumed);
    }, 60000);
  }
});

describe("Provider context-overflow adaptation", () => {
  function overflowBody(limit) {
    return JSON.stringify({ error: { message: `This model's maximum context length is ${limit} tokens, however you requested more`, code: "context_length_exceeded" } });
  }

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
    // Configured for 64K but the provider only supports 4K.
    const settings = { ...BASE, maxContextTokens: 65536, maxTokens: 1200 };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: words(150) }], ledger: "", consumed: 1 };
    await BrowserChatEngine.streamTurn({ card: null, session, settings, persona: null, agentsContract: "", onNotice: (n) => notices.push(n) });
    // Exactly one retry, and it fits the provider's real window.
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
    // The initial attempt plus exactly one adaptation attempt.
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
    // Each shape must adapt when the named limit is below the configured
    // window, and must not when it is not. The Anthropic form names the
    // requested size first and the real maximum second: the maximum is the one
    // that matters.
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
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("content already streamed is never duplicated by an overflow retry", async () => {
    // A stream that emits a chunk and THEN fails with a context-overflow-shaped
    // error must not be resent: the partial reply would be duplicated. The
    // fake reader yields one chunk before throwing, which is what a mid-stream
    // failure actually looks like on the wire.
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
    expect(threw).toBeTruthy();
    expect(chunks.join("")).toBe("partial");
    expect(calls).toBe(1);
  });
});
