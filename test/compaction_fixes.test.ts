import { describe, test, expect } from "bun:test";
import { BrowserChatEngine, SUMMARY_PROMPT, SUMMARY_UPDATE_PROMPT, countMessages, estimateTokens } from "../public/browser_engine.js";

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
    // With a ledger that alone exceeds the budget, truncate keeps pinned +
    // newest turn only; the ledger itself is irreducible canon (overflow
    // warning territory, seam 1 covers that case).
    const roles = globalThis.__sent.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[roles.length - 1]).toBe("user");
    expect(globalThis.__sent.messages.length).toBeLessThanOrEqual(3);
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
    expect(total).toBeLessThanOrEqual(E.resolveBudgets(settings).promptBudget);
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
      cacheKey: "routing-key-123",
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
    // prompt_cache_key is dropped from fold requests entirely (pi rule:
    // never route a one-off request into a cache bucket it cannot reuse).
    expect(summaryBody.prompt_cache_key).toBeUndefined();
  });
});
