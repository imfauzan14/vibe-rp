// The per-chat usage history: what makes a cache trend comparable, and what
// keeps two of them from being mixed.
//
// The whole point of this module is scoping. A hit rate is a property of a
// prompt prefix over time, so two samples are comparable only when the prefix
// was the same — and every part of that prefix can change between two replies
// of one chat. These tests hold the two halves of that apart: the scope key
// decides what is comparable, and the caps decide what survives.

import { describe, test, expect } from "bun:test";

import {
  USAGE_HISTORY_CAP,
  USAGE_SCOPE_CAP,
  scopeKeyOf,
  usageSampleFrom,
  rateOf,
  recordUsageSample,
  usageTrend,
} from "../public/usage_history.js";

const report = (over: Record<string, unknown> = {}) => ({
  reported: true,
  billedInput: 10000,
  cachedTokens: 6000,
  estimatedInput: 8000,
  reasoningTokens: null,
  ceilingIgnored: false,
  ...over,
});

const scopeOf = (over: Record<string, unknown> = {}) =>
  scopeKeyOf({ endpoint: "https://a.test/v1", model: "m", cardId: "card_1", personaId: "persona_default", directiveId: "directive_default", ...over });

/** A session bag with no history, which is what a chat starts as. */
const session = () => ({ id: "s", messages: [] });

describe("The scope key decides what is comparable", () => {
  test("every part of the prefix changes the key", () => {
    const base = scopeOf();
    // Each of these independently resets a provider's cache, so each has to
    // produce a different scope — otherwise two incomparable samples would be
    // averaged together and the trend would be a fiction.
    for (const part of ["endpoint", "model", "cardId", "personaId", "directiveId"]) {
      const other = scopeOf({ [part]: "something-else" });
      expect(other).not.toBe(base);
    }
  });

  test("a part in one slot is not confused with the same value in another", () => {
    // The failure this guards: a naive key that concatenates values without
    // separators, where `{model: "x"}` and `{endpoint: "x"}` collide.
    expect(scopeKeyOf({ endpoint: "x", model: "" })).not.toBe(scopeKeyOf({ endpoint: "", model: "x" }));
  });

  test("each chat keeps its own array, so two chats never share a history", () => {
    // Sessions are separate histories and nothing in this module may merge them.
    // The card is in the key but the transcript is not, so two chats of one card
    // under the same preset produce the SAME key on purpose — the separation is
    // that each session owns its own array. This test pins that reading so
    // nobody "fixes" it into a cross-session store by accident.
    const a = session();
    const b = session();
    recordUsageSample(a, { report: report(), scope: scopeOf(), at: 1 });
    expect(a.usageHistory.length).toBe(1);
    expect(b.usageHistory).toBeUndefined();
  });
});

describe("A sample records what was measured", () => {
  test("a missing figure is null, never zero", () => {
    const s = usageSampleFrom({ report: null, scope: "k", at: 5 });
    expect(s.cached).toBeNull();
    expect(s.billed).toBeNull();
    // The distinction the whole panel turns on: an endpoint that said nothing
    // has not measured a miss.
    expect(rateOf(s)).toBeNull();
    expect(rateOf(usageSampleFrom({ report: report({ cachedTokens: 0 }), scope: "k", at: 6 }))).toBe(0);
  });

  test("a total-volume report takes precedence over the legacy input alias", () => {
    const s = usageSampleFrom({ report: report({ totalInput: 2000, billedInput: 1000, cachedTokens: 900 }), scope: "k" });
    expect(s.billed).toBe(2000);
    expect(rateOf(s)).toBe(0.45);
  });

  test("a rate is derived, and a nonsense one is clamped rather than shown", () => {
    expect(rateOf(usageSampleFrom({ report: report({ billedInput: 1000, cachedTokens: 250 }), scope: "k" }))).toBe(0.25);
    // A provider that reports more cached tokens than billed ones is describing
    // something that cannot be read as a share.
    expect(rateOf(usageSampleFrom({ report: report({ billedInput: 100, cachedTokens: 400 }), scope: "k" }))).toBe(1);
    expect(rateOf(usageSampleFrom({ report: report({ billedInput: 0, cachedTokens: 0 }), scope: "k" }))).toBeNull();
  });

  test("the reasoning spend and the ignored ceiling travel with the figures", () => {
    const s = usageSampleFrom({ report: report({ reasoningTokens: 1603, ceilingIgnored: true }), scope: "k", at: 9, folded: true });
    expect(s.reasoning).toBe(1603);
    expect(s.ceiling).toBe(true);
    expect(s.folded).toBe(true);
    expect(s.at).toBe(9);
  });
});

describe("Pruning is per scope, so one preset cannot evict another", () => {
  test("the cap drops the oldest of that scope only", () => {
    const sess = session();
    const mine = scopeOf({ personaId: "p1" });
    const theirs = scopeOf({ personaId: "p2" });

    recordUsageSample(sess, { report: report({ cachedTokens: 100 }), scope: theirs, at: 1 });
    for (let i = 0; i < USAGE_HISTORY_CAP + 5; i += 1) {
      recordUsageSample(sess, { report: report({ cachedTokens: 1000 + i }), scope: mine, at: 100 + i });
    }

    const kept = sess.usageHistory.filter((s: any) => s.scope === mine);
    expect(kept.length).toBe(USAGE_HISTORY_CAP);
    // The oldest of `mine` went, and the newest is still there.
    expect(kept[0].at).toBe(100 + 5);
    expect(kept[kept.length - 1].at).toBe(100 + USAGE_HISTORY_CAP + 4);
    // The other scope's single sample is untouched — this is the mixing the
    // module exists to prevent, and a global cap would have taken it first.
    expect(sess.usageHistory.filter((s: any) => s.scope === theirs).length).toBe(1);
    // And the loss is counted, so the panel can say what it is showing.
    expect(sess.usagePruned[mine]).toBe(5);
    expect(sess.usagePruned[theirs]).toBeUndefined();
  });

  test("the number of distinct scopes is bounded, least recently used first", () => {
    const sess = session();
    for (let i = 0; i < USAGE_SCOPE_CAP + 3; i += 1) {
      recordUsageSample(sess, { report: report(), scope: scopeOf({ personaId: `p${i}` }), at: 10 + i });
    }
    const scopes = new Set(sess.usageHistory.map((s: any) => s.scope));
    expect(scopes.size).toBe(USAGE_SCOPE_CAP);
    // The three oldest setups are gone and the newest survived.
    expect(scopes.has(scopeOf({ personaId: "p0" }))).toBe(false);
    expect(scopes.has(scopeOf({ personaId: `p${USAGE_SCOPE_CAP + 2}` }))).toBe(true);
    // A pruned count for a scope that no longer exists would describe nothing.
    expect(sess.usagePruned[scopeOf({ personaId: "p0" })]).toBeUndefined();
  });
});

describe("The trend reads one scope and reports the rest", () => {
  const build = () => {
    const sess = session();
    const mine = scopeOf();
    const other = scopeOf({ personaId: "p_other" });
    for (const [i, rate] of [0, 0.5, 0.7, 0.8].entries()) {
      recordUsageSample(sess, {
        report: report({ billedInput: 1000, cachedTokens: Math.round(rate * 1000) }),
        scope: mine,
        at: 10 + i,
      });
    }
    recordUsageSample(sess, { report: report({ cachedTokens: 400 }), scope: other, at: 20 });
    recordUsageSample(sess, { report: report({ cachedTokens: 400 }), scope: other, at: 21 });
    return { sess, mine, other };
  };

  test("figures come from the scope in force and never from another", () => {
    const { sess, mine } = build();
    const trend = usageTrend(sess.usageHistory, mine);
    expect(trend.total).toBe(4);
    expect(trend.measured).toBe(4);
    // The two samples from the other preset are counted and set aside. If they
    // had been averaged in, the median would sit at 0.6 rather than 0.6 here —
    // so the assertion that matters is the count, which is what the panel says
    // out loud.
    expect(trend.otherSamples).toBe(2);
    expect(trend.otherScopes).toBe(1);
    expect(trend.median).toBeCloseTo(0.6, 5);
  });

  test("the rest of the chat is counted, never folded in", () => {
    const { sess, mine, other } = build();
    const trend = usageTrend(sess.usageHistory, other);
    expect(trend.total).toBe(2);
    expect(trend.otherSamples).toBe(4);
    expect(trend.otherScopes).toBe(1);
  });

  test("a scope with no history is empty, not borrowed", () => {
    const { sess } = build();
    const trend = usageTrend(sess.usageHistory, scopeOf({ model: "never-used" }));
    expect(trend.total).toBe(0);
    expect(trend.measured).toBe(0);
    expect(trend.median).toBeNull();
    expect(trend.series).toEqual([]);
    expect(trend.otherSamples).toBe(6);
    expect(trend.otherScopes).toBe(2);
  });

  test("an unreported reply is a gap in the series, not a zero", () => {
    const sess = session();
    const mine = scopeOf();
    recordUsageSample(sess, { report: report({ cachedTokens: 500 }), scope: mine, at: 1 });
    recordUsageSample(sess, { report: null, scope: mine, at: 2 });
    recordUsageSample(sess, { report: report({ cachedTokens: 0 }), scope: mine, at: 3 });

    const trend = usageTrend(sess.usageHistory, mine);
    expect(trend.total).toBe(3);
    expect(trend.measured).toBe(2);
    expect(trend.unreported).toBe(1);
    // Exactly one measured zero. Conflating the two would report two cold
    // replies and turn a silent endpoint into an apparent failure.
    expect(trend.cold).toBe(1);
    expect(trend.series.map((p: any) => p.rate)).toEqual([0.05, null, 0]);
  });

  test("the reading describes the shape of the series", () => {
    const { sess, mine } = build();
    const trend = usageTrend(sess.usageHistory, mine);
    expect(trend.best).toBe(0.8);
    expect(trend.worst).toBe(0);
    expect(trend.latest).toBe(0.8);
    // Cold first, warm after: the classic shape, and the one a single number
    // cannot show.
    expect(trend.direction).toBe("warming");
  });

  test("two samples are not enough to call a direction", () => {
    const sess = session();
    const mine = scopeOf();
    recordUsageSample(sess, { report: report({ cachedTokens: 0 }), scope: mine, at: 1 });
    recordUsageSample(sess, { report: report({ cachedTokens: 900 }), scope: mine, at: 2 });
    expect(usageTrend(sess.usageHistory, mine).direction).toBeNull();
  });

  test("a level series is steady, and a falling one falls", () => {
    // Noisy around a level, which is what "steady" is for.
    const flat = session();
    const mine = scopeOf();
    for (const [i, cached] of [600, 720, 650, 580, 700, 620].entries()) {
      recordUsageSample(flat, { report: report({ billedInput: 1000, cachedTokens: cached }), scope: mine, at: i });
    }
    expect(usageTrend(flat.usageHistory, mine).direction).toBe("steady");

    const falling = session();
    for (const [i, cached] of [900, 850, 800, 300, 200, 100].entries()) {
      recordUsageSample(falling, { report: report({ billedInput: 1000, cachedTokens: cached }), scope: mine, at: i });
    }
    expect(usageTrend(falling.usageHistory, mine).direction).toBe("cooling");
  });

  test("a constant is not a direction", () => {
    // "and it is steady" beside a run of identical numbers — most often a run of
    // zeros — tells the reader nothing they have not just read.
    const sess = session();
    const mine = scopeOf();
    for (let i = 0; i < 6; i += 1) recordUsageSample(sess, { report: report({ billedInput: 1000, cachedTokens: 0 }), scope: mine, at: i });
    const trend = usageTrend(sess.usageHistory, mine);
    expect(trend.direction).toBeNull();
    expect(trend.cold).toBe(6);
  });

  test("the prompt size a rate came from is available, because a rate alone is not a fact", () => {
    const sess = session();
    const mine = scopeOf();
    recordUsageSample(sess, { report: report({ billedInput: 200, cachedTokens: 200 }), scope: mine, at: 1 });
    recordUsageSample(sess, { report: report({ billedInput: 60000, cachedTokens: 30000 }), scope: mine, at: 2 });
    const trend = usageTrend(sess.usageHistory, mine);
    // 100% of 200 tokens and 50% of 60,000 are not the same story, and the
    // median alone would hide that.
    expect(trend.median).toBe(0.75);
    expect(trend.largestPrompt).toBe(60000);
  });
});

describe("The trend survives rubbish input", () => {
  test("no history, a null history and a malformed sample all degrade quietly", () => {
    expect(usageTrend(undefined, "k").total).toBe(0);
    expect(usageTrend(null, "k").measured).toBe(0);
    expect(usageTrend([null, undefined], "k").total).toBe(0);
    // A sample with no scope is not silently attributed to the caller's scope.
    expect(usageTrend([{ at: 1, billed: 100, cached: 50 }], "k").total).toBe(0);
  });

  test("recording against a session that cannot hold it returns without throwing", () => {
    expect(recordUsageSample(null, { report: report(), scope: "k" })).toBeNull();
    expect(recordUsageSample(undefined, { report: report(), scope: "k" })).toBeNull();
  });
});
