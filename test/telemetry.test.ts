// The measured side of the engine: what the provider billed versus what the app
// predicted, what it learned, and what it does with it.
//
// These behaviours are all invisible from the outside — a capability that fails
// to persist, an overhead that is learned from noise, a cache breakpoint on the
// wrong message: none of them break a turn. They just quietly cost money or
// quietly stop working. So each one is pinned here, including the guards.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  BrowserChatEngine,
  getModelCapability,
  updateModelCapability,
  clearModelCapabilities,
  notePromptOverhead,
  promptOverheadTokens,
  noteContextWindow,
  effectiveContextWindow,
  shouldUseCacheBreakpoints,
  withCacheBreakpoints,
  summaryModelOf,
  LEDGER_OPEN,
  LEDGER_CLOSE,
} from "../public/browser_engine.js";

const EP = "https://x.test/v1";
const MODEL = "m";

/** A stand-in for the host store, so persistence is testable without a browser. */
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
  return map;
}

beforeEach(() => {
  clearModelCapabilities();
});

afterEach(() => {
  clearModelCapabilities();
  delete (globalThis as unknown as Record<string, unknown>).localStorage;
});

// ───────────────────────── describeUsage ─────────────────────────

describe("describeUsage reconciles the estimate against the bill", () => {
  const payload = [{ role: "user", content: "x ".repeat(400) }];

  test("reports the overhead the provider added on top of the payload", () => {
    const estimated = BrowserChatEngine.describeUsage({ usage: null, payload }).estimatedInput;
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: estimated + 2050, completion_tokens: 10 },
      payload,
    });
    expect(r.billedInput).toBe(estimated + 2050);
    expect(r.overhead).toBe(2050);
    expect(r.reported).toBe(true);
  });

  test("reports nothing when the provider sends no usage", () => {
    const r = BrowserChatEngine.describeUsage({ usage: null, payload });
    expect(r.reported).toBe(false);
    expect(r.billedInput).toBeNull();
    expect(r.overhead).toBeNull();
    expect(r.cacheHitRate).toBeNull();
    expect(r.reasoningShare).toBeNull();
    expect(r.ceilingIgnored).toBe(false);
  });

  // The shape a gateway that reports only totals returns, measured on a real
  // router: `usage` carries prompt_tokens, completion_tokens and total_tokens and
  // nothing else — no cache field of any vendor's shape, no reasoning count. The
  // app must claim nothing it was not told, and must still learn the one thing
  // the totals do reveal, which is the per-request preamble.
  test("a totals-only usage makes no cache or reasoning claim, but still prices the preamble", () => {
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 6516, completion_tokens: 127, total_tokens: 6643 },
      payload,
    });
    expect(r.reported).toBe(true);
    expect(r.billedInput).toBe(6516);
    // Unknown, not zero: no cached count arrived, so no hit rate is asserted.
    expect(r.cachedTokens).toBeNull();
    expect(r.cacheHitRate).toBeNull();
    // And the same rule for reasoning: 0 would assert a figure never sent.
    expect(r.reasoningTokens).toBeNull();
    expect(r.reasoningShare).toBeNull();
    // The delta the totals do reveal is the preamble, which is the whole point.
    expect(r.overhead).toBe(6516 - r.estimatedInput);
  });

  test("an explicit zero reasoning count is a measurement, not an absence", () => {
    // The distinction the rule above depends on: a provider that sends
    // `reasoning_tokens: 0` has measured a zero, and that is reported as 0.
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 0 } },
      payload,
    });
    expect(r.reasoningTokens).toBe(0);
    expect(r.reasoningShare).toBe(0);
  });

  test("reads cached tokens from the OpenAI and Anthropic shapes alike", () => {
    const openai = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } },
      payload,
    });
    expect(openai.cachedTokens).toBe(800);
    expect(openai.cacheHitRate).toBeCloseTo(0.8, 5);

    const anthropic = BrowserChatEngine.describeUsage({
      usage: { input_tokens: 1000, cache_read_input_tokens: 900 },
      payload,
    });
    expect(anthropic.cachedTokens).toBe(900);
  });

  test("reasoning share counts what the reader never sees, not just the reply", () => {
    // Measured on a real endpoint: 28 visible tokens against 304 internal ones.
    // A figure that counted only the reply would call this a 28-token turn.
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 100, completion_tokens: 28, completion_tokens_details: { reasoning_tokens: 304 } },
      payload,
    });
    expect(r.reasoningTokens).toBe(304);
    expect(r.reasoningShare).toBeCloseTo(304 / 332, 5);
  });

  test("flags an output ceiling the provider produced past", () => {
    const over = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 10, completion_tokens: 1735 },
      payload,
      outputCeiling: 16,
    });
    expect(over.ceilingIgnored).toBe(true);

    const under = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 10, completion_tokens: 900 },
      payload,
      outputCeiling: 1200,
    });
    expect(under.ceilingIgnored).toBe(false);
  });

  test("tolerates a provider that counts the ceiling slightly differently", () => {
    // Within the 5% slack: not evidence of an ignored ceiling.
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 10, completion_tokens: 1250 },
      payload,
      outputCeiling: 1200,
    });
    expect(r.ceilingIgnored).toBe(false);
  });

  test("no ceiling was sent means no ceiling can have been ignored", () => {
    const r = BrowserChatEngine.describeUsage({
      usage: { prompt_tokens: 10, completion_tokens: 99999 },
      payload,
      outputCeiling: null,
    });
    expect(r.ceilingIgnored).toBe(false);
  });
});

// ───────────────────────── prompt overhead ─────────────────────────

describe("the measured per-request overhead", () => {
  test("is zero until something is measured", () => {
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(0);
  });

  test("takes the median, so one anomalous response cannot move it", () => {
    // Four consistent samples plus one wild one. A mean would land near 3400;
    // the median stays on the real figure.
    for (const billed of [2000, 2000, 2000, 2000, 9000]) {
      notePromptOverhead(EP, MODEL, billed, 0);
    }
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(2000);
  });

  test("only the most recent samples count, so the figure tracks the endpoint", () => {
    for (const billed of [9000, 9000, 9000, 9000, 9000]) notePromptOverhead(EP, MODEL, billed, 0);
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(9000);
    // A provider that stops adding a preamble is believed within one window.
    for (let i = 0; i < 5; i += 1) notePromptOverhead(EP, MODEL, 200, 0);
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(200);
  });

  test("ignores a delta a provider could not have produced", () => {
    notePromptOverhead(EP, MODEL, 500, 1000); // negative: billed less than sent
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(0);

    notePromptOverhead(EP, MODEL, 500000, 1000); // absurd
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(0);

    notePromptOverhead(EP, MODEL, undefined as unknown as number, 1000);
    notePromptOverhead(EP, MODEL, NaN, 1000);
    expect(promptOverheadTokens({ apiEndpoint: EP, model: MODEL })).toBe(0);
  });

  test("is charged against the window the planner sizes", () => {
    const settings = { apiEndpoint: EP, model: MODEL, maxContextTokens: 16384, maxTokens: 1200 };
    const session = { messages: [{ role: "user", content: "hello" }], ledger: "", consumed: 1 };
    const before = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(before.overheadTokens).toBe(0);

    notePromptOverhead(EP, MODEL, 4000, 2000); // 2000 tokens the app cannot see
    const after = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(after.overheadTokens).toBe(2000);
    expect(after.billedInput).toBe(after.inputTokens + 2000);
    // The reply allowance shrinks by the same amount: the window did not grow.
    expect(after.outputTokens).toBeLessThanOrEqual(before.outputTokens);
  });

  test("the overhead is charged, so the request the provider receives still fits", () => {
    // The failure this exists to catch: the app predicts a fit, the provider
    // rejects, and the reader pays a round trip for a number the app could have
    // measured on the previous turn. Here the app's own accounting fits the
    // window either way — only the billed total reveals the difference.
    const settings = { apiEndpoint: EP, model: MODEL, maxContextTokens: 4096, maxTokens: 256 };
    const session = {
      messages: [
        { role: "user", content: "x ".repeat(2000) },
        { role: "assistant", content: "y ".repeat(2000) },
        { role: "user", content: "z ".repeat(2000) },
      ],
      ledger: "",
      consumed: 1,
    };
    const clean = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(clean.overheadTokens).toBe(0);
    expect(clean.inputTokens + clean.outputTokens).toBeLessThanOrEqual(4096);

    notePromptOverhead(EP, MODEL, 2100, 100); // 2000 tokens the app cannot see
    const measured = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(measured.overheadTokens).toBe(2000);
    // History yields to make room for input the app does not control.
    expect(measured.inputTokens).toBeLessThan(clean.inputTokens);
    expect(measured.inputTokens + measured.outputTokens + measured.overheadTokens).toBeLessThanOrEqual(4096);
  });

  test("the overflow report names the preamble instead of blaming the preset", async () => {
    // The report exists to tell the reader *which* component to shrink. The
    // preamble is input the app never assembled, so it is absent from the
    // breakdown the report used to rank — and when the preamble is what pushed
    // the request over, the largest visible component is the wrong answer.
    const settings = { apiEndpoint: EP, model: MODEL, maxContextTokens: 4096, maxTokens: 256 };
    const session = { messages: [{ role: "assistant", content: "greeting" }, { role: "user", content: "I open the door." }], ledger: "", consumed: 1 };
    const cardWith = (words: number) => ({ id: "c", data: { name: "Elena", description: "word ".repeat(words) } });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const runTurn = async (card: unknown) => {
      const notices: string[] = [];
      await BrowserChatEngine.streamTurn({
        card,
        session: { ...session, messages: session.messages.map((m) => ({ ...m })) },
        settings,
        persona: null,
        onChunk: () => {},
        onNotice: (m: string) => notices.push(m),
      });
      return notices.find((n) => n.includes("exceed the configured prompt budget")) || "";
    };
    try {
      // A preset large enough to overflow on its own, with nothing measured.
      const fromPreset = await runTurn(cardWith(4800));
      expect(fromPreset).toMatch(/largest component is the static preset/);
      // Negative control: with no preamble measured there is none to name.
      expect(fromPreset).not.toContain("provider preamble");

      notePromptOverhead(EP, MODEL, 3500, 500); // 3000 tokens the app cannot see
      const fromPreamble = await runTurn(cardWith(1600));
      expect(fromPreamble).toContain("provider preamble");
      // And it is ranked, so the advice points at the real cause.
      expect(fromPreamble).toMatch(/largest component is the provider preamble/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ───────────────────────── persistence ─────────────────────────

describe("capabilities survive the reload that paid for them", () => {
  test("a learned fact is written to the host store", () => {
    const store = installStorage();
    clearModelCapabilities();
    updateModelCapability(EP, MODEL, { supportsTemperature: false });
    const raw = store.get("vibe_rp_model_caps");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)[`${EP}::${MODEL}`]).toEqual({ supportsTemperature: false });
  });

  test("a fresh read hydrates what an earlier session learned", () => {
    // Simulate a reload: the store holds a fact, the in-memory map does not.
    const store = installStorage();
    clearModelCapabilities(); // re-arms hydration and empties the store
    store.set("vibe_rp_model_caps", JSON.stringify({ [`${EP}::${MODEL}`]: { tokenKey: "max_completion_tokens", contextWindow: 8192 } }));
    expect(getModelCapability(EP, MODEL).tokenKey).toBe("max_completion_tokens");
    expect(getModelCapability(EP, MODEL).contextWindow).toBe(8192);
  });

  test("a corrupt store is discarded rather than breaking every lookup", () => {
    const store = installStorage();
    clearModelCapabilities();
    store.set("vibe_rp_model_caps", "{ this is not json");
    expect(getModelCapability(EP, MODEL)).toEqual({});
    // And the bad entry is gone, so the next write starts from a clean store.
    expect(store.has("vibe_rp_model_caps")).toBe(false);
    updateModelCapability(EP, MODEL, { observedCaching: true });
    expect(getModelCapability(EP, MODEL).observedCaching).toBe(true);
  });

  test("clearing removes the stored copy, not just the in-memory one", () => {
    const store = installStorage();
    clearModelCapabilities();
    updateModelCapability(EP, MODEL, { supportsTemperature: false });
    expect(store.has("vibe_rp_model_caps")).toBe(true);
    clearModelCapabilities();
    expect(store.has("vibe_rp_model_caps")).toBe(false);
    expect(getModelCapability(EP, MODEL)).toEqual({});
  });

  test("a host with no storage degrades to memory rather than throwing", () => {
    delete (globalThis as unknown as Record<string, unknown>).localStorage;
    clearModelCapabilities();
    expect(() => updateModelCapability(EP, MODEL, { observedReasoning: true })).not.toThrow();
    expect(getModelCapability(EP, MODEL).observedReasoning).toBe(true);
  });
});

// ───────────────────────── learned window ─────────────────────────

describe("the learned context window", () => {
  test("lowers the configured window to the one the provider named", () => {
    noteContextWindow(EP, MODEL, 8192);
    expect(effectiveContextWindow({ apiEndpoint: EP, model: MODEL, maxContextTokens: 65536 })).toBe(8192);
  });

  test("leaves a smaller configured window alone", () => {
    noteContextWindow(EP, MODEL, 32768);
    expect(effectiveContextWindow({ apiEndpoint: EP, model: MODEL, maxContextTokens: 8192 })).toBe(8192);
  });

  test("ignores a value too small to be a real window", () => {
    noteContextWindow(EP, MODEL, 12);
    noteContextWindow(EP, MODEL, NaN);
    expect(effectiveContextWindow({ apiEndpoint: EP, model: MODEL, maxContextTokens: 65536 })).toBe(65536);
  });

  test("is scoped to the endpoint and model it was learned on", () => {
    noteContextWindow(EP, MODEL, 8192);
    expect(effectiveContextWindow({ apiEndpoint: "https://other.test/v1", model: MODEL, maxContextTokens: 65536 })).toBe(65536);
    expect(effectiveContextWindow({ apiEndpoint: EP, model: "other", maxContextTokens: 65536 })).toBe(65536);
  });

  test("the planner plans against it, not against the guess", () => {
    const messages = [{ role: "assistant", content: "opening" }];
    for (let i = 0; i < 40; i += 1) {
      messages.push({ role: "user", content: "x ".repeat(400) });
      messages.push({ role: "assistant", content: "y ".repeat(400) });
    }
    messages.push({ role: "user", content: "the newest turn" });
    const session = { messages, ledger: "", consumed: 1 };
    const settings = { apiEndpoint: EP, model: MODEL, maxContextTokens: 65536, maxTokens: 1200 };

    const loose = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(loose.contextWindow).toBe(65536);
    expect(loose.plan.compacted).toBe(false);

    noteContextWindow(EP, MODEL, 8192);
    const tight = BrowserChatEngine.describeRequest({ card: null, session, settings, persona: null });
    expect(tight.contextWindow).toBe(8192);
    expect(tight.plan.compacted).toBe(true);
  });
});

// ───────────────────────── cache breakpoints ─────────────────────────

describe("cache breakpoints", () => {
  const payload = () => [
    { role: "system", content: "stable prefix" },
    // Built from the real framing, so a change to it cannot silently make this
    // test stop exercising the ledger breakpoint.
    { role: "user", content: `${LEDGER_OPEN}ledger body${LEDGER_CLOSE}` },
    { role: "user", content: "first turn" },
    { role: "assistant", content: "first reply" },
    { role: "user", content: "newest turn" },
  ];

  test("is off for an endpoint that does not require it", () => {
    expect(shouldUseCacheBreakpoints({ apiEndpoint: "https://api.openai.com/v1", model: "gpt-x" })).toBe(false);
  });

  test("is on for an Anthropic-shaped endpoint or model", () => {
    expect(shouldUseCacheBreakpoints({ apiEndpoint: "https://api.anthropic.com/v1", model: "x" })).toBe(true);
    expect(shouldUseCacheBreakpoints({ apiEndpoint: "https://router.test/v1", model: "claude-sonnet-4-6" })).toBe(true);
  });

  test("stays off once the provider has rejected the field", () => {
    updateModelCapability("https://api.anthropic.com/v1", "x", { supportsCacheControl: false });
    expect(shouldUseCacheBreakpoints({ apiEndpoint: "https://api.anthropic.com/v1", model: "x" })).toBe(false);
  });

  test("marks the stable prefix, the ledger and the frozen history — never the newest turn", () => {
    const marked = withCacheBreakpoints(payload());
    const isMarked = (m: Record<string, unknown>) => Array.isArray(m.content);
    expect(isMarked(marked[0] as Record<string, unknown>)).toBe(true); // system
    expect(isMarked(marked[1] as Record<string, unknown>)).toBe(true); // ledger
    expect(isMarked(marked[2] as Record<string, unknown>)).toBe(false);
    expect(isMarked(marked[3] as Record<string, unknown>)).toBe(true); // frozen history
    expect(isMarked(marked[4] as Record<string, unknown>)).toBe(false); // newest: changes every turn
    expect(marked.length).toBe(payload().length);
  });

  test("stays within the four breakpoints the API allows", () => {
    const long = withCacheBreakpoints([
      { role: "system", content: "s" },
      { role: "user", content: "l" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "newest" },
    ]);
    const count = long.filter((m) => Array.isArray((m as Record<string, unknown>).content)).length;
    expect(count).toBeLessThanOrEqual(4);
  });

  test("preserves the text exactly and does not mutate the caller's array", () => {
    const original = payload();
    const snapshot = JSON.stringify(original);
    const marked = withCacheBreakpoints(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    for (let i = 0; i < original.length; i += 1) {
      const text = Array.isArray((marked[i] as Record<string, unknown>).content)
        ? ((marked[i] as { content: Array<{ text: string }> }).content[0].text)
        : ((marked[i] as { content: string }).content);
      expect(text).toBe(original[i].content);
    }
  });

  test("a short payload gets a breakpoint on the system prompt and nothing else", () => {
    const marked = withCacheBreakpoints([{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    expect(Array.isArray((marked[0] as Record<string, unknown>).content)).toBe(true);
    expect(Array.isArray((marked[1] as Record<string, unknown>).content)).toBe(false);
  });

  test("an empty payload is returned unchanged", () => {
    expect(withCacheBreakpoints([])).toEqual([]);
    expect(withCacheBreakpoints(null as unknown as unknown[])).toBeNull();
  });

  test("the wire body carries the field only when the endpoint asks for it", () => {
    const messages = payload();
    const openai = BrowserChatEngine.buildRequestBody({ apiEndpoint: "https://api.openai.com/v1", model: "g", maxTokens: 100 }, messages);
    expect(JSON.stringify(openai)).not.toContain("cache_control");
    const anthropic = BrowserChatEngine.buildRequestBody({ apiEndpoint: "https://api.anthropic.com/v1", model: "claude-x", maxTokens: 100 }, messages);
    expect(JSON.stringify(anthropic)).toContain("cache_control");
  });
});

// ───────────────────────── summary model ─────────────────────────

describe("the summariser model", () => {
  test("falls back to the main model so an existing setup is unchanged", () => {
    expect(summaryModelOf({ model: "main" })).toBe("main");
    expect(summaryModelOf({ model: "main", summaryModel: "" })).toBe("main");
    expect(summaryModelOf({ model: "main", summaryModel: "   " })).toBe("main");
  });

  test("uses the dedicated model when one is set", () => {
    expect(summaryModelOf({ model: "main", summaryModel: "cheap" })).toBe("cheap");
  });

  test("survives an empty settings object", () => {
    expect(summaryModelOf()).toBe("");
    expect(summaryModelOf({})).toBe("");
  });
});
