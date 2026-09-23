// Context inspector contract tests.
//
// The inspector must show the SAME numbers the send path uses. `describeRequest`
// runs the identical `planRequest` the turn runner runs, so these tests assert
// the inspector's breakdown is self-consistent and matches the assembled
// payload rather than a re-derived estimate.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine, estimateTokens, countMessages } from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';
const words = (n) => "word ".repeat(n).trim();
const CHUNK = "## Character Sheet\n\nElena Voss is a cartographer. ```json\n{\"n\":\"E\"}\n```\n| s | v |\n|---|---|\n| r | 8 |\n";
const presetOfTokens = (t) => CHUNK.repeat(Math.max(1, Math.ceil(t / estimateTokens(CHUNK))));

afterEach(() => {
  globalThis.fetch = undefined;
});

function session(turns = 0, ledgerTokens = 0) {
  const s = { messages: [{ role: "assistant", content: "greeting" }], ledger: ledgerTokens ? words(ledgerTokens) : "", consumed: 1 };
  for (let i = 0; i < turns; i++) s.messages.push({ role: i % 2 ? "user" : "assistant", content: words(200) });
  s.messages.push({ role: "user", content: words(150) });
  return s;
}

function cardWith(descTokens, exTokens = 0) {
  return { data: { name: "Elena Voss", description: descTokens ? presetOfTokens(descTokens) : "", personality: "", scenario: "", mes_example: exTokens ? presetOfTokens(exTokens) : "", system_prompt: "", post_history_instructions: "", character_book: null } };
}

describe("Context inspector - the breakdown matches the request", () => {
  test("the breakdown sums to the measured input", () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 4096 };
    const r = BrowserChatEngine.describeRequest({ card: cardWith(30000), session: session(40), settings, persona: { name: "You" } });
    const b = r.breakdown;
    const sum = b.requiredStatic + b.optionalStatic + b.persona + b.lore + b.ledger + b.history + b.currentInput;
    // Framing overhead is small and positive; the buckets must account for the
    // measured input to within that overhead, not diverge from it.
    expect(Math.abs(r.inputTokens - sum)).toBeLessThan(32);
  });

  test("describeRequest measures the exact payload streamTurn sends", async () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 65536, maxTokens: 4096 };
    const card = cardWith(20000);
    const sess = session(30);
    const described = BrowserChatEngine.describeRequest({ card, session: sess, settings, persona: { name: "You" } });

    const gen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream) gen.push(body);
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    await BrowserChatEngine.streamTurn({ card, session: sess, settings, persona: { name: "You" }, agentsContract: "" });
    const sent = gen[gen.length - 1];
    // The inspector's prediction and the actual send agree, message for message
    // and token for token: the send path uses the allocator's output decision
    // rather than re-deriving its own ceiling.
    expect(described.payload.length).toBe(sent.messages.length);
    expect(countMessages(described.payload)).toBe(countMessages(sent.messages));
    expect(described.outputTokens).toBe(sent.max_tokens);
  });

  test("a crowded window reports the same reduced ceiling it sends", async () => {
    // The case where an independent re-derivation would drift: the prompt eats
    // into the reservation, so the allocator reduces the reply. No fold occurs
    // here, so the inspector's plan is the plan that is actually sent.
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 8192 };
    const card = cardWith(6000);
    const sess = session(0);
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
    const r = BrowserChatEngine.describeRequest({ card: cardWith(10000, 55000), session: session(2), settings, persona: { name: "You" } });
    expect(r.excludedSections).toContain("examples");
    expect(r.includedSections).toContain("description");
    expect(r.includedSections).not.toContain("examples");
  });

  test("a condensed ledger is flagged in the breakdown", () => {
    const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 1200 };
    const r = BrowserChatEngine.describeRequest({ card: null, session: session(4, 15000), settings, persona: { name: "You" } });
    expect(r.ledgerCondensed).toBe(true);
    expect(r.breakdown.ledger).toBeLessThan(estimateTokens(words(15000)));
    expect(r.totalTokens).toBeLessThanOrEqual(8192);
  });
});
