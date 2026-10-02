// The Context sheet: the one place the app explains what the next request
// carries. Every reader sees it, most of them know nothing about tokens, and
// each of them has a different model behind the app — so what it says has to be
// true for a setup the app has never seen.
//
// The rendering is a pure function of the measured request, which is what makes
// these assertions possible at all: the panel cannot disagree with the payload
// `streamTurn` would send, because both come from the same `describeRequest`.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BrowserChatEngine } from "../public/browser_engine.js";
import { DEFAULT_SETTINGS } from "../public/local_db.js";
import { renderContextPanel, contextSummary, formatTokens } from "../public/ui/chat/context_panel.js";
import { recordUsageSample, scopeKeyOf } from "../public/usage_history.js";

const ROOT = join(import.meta.dir, "..");
const filler = (words: number) => "word ".repeat(words).trim();

const CARD = {
  id: "c",
  data: {
    name: "Elena",
    description: filler(400),
    personality: filler(120),
    scenario: filler(80),
    system_prompt: filler(90),
    mes_example: filler(140),
  },
};
const PERSONA = { name: "Rin", description: "The viewpoint protagonist." };

function session(turns: number, { ledger = "", consumed = 1 } = {}) {
  const messages = [{ id: "msg_init", role: "assistant", content: "The lamp gutters." }];
  for (let i = 1; i <= turns; i += 1) {
    messages.push({ id: `u${i}`, role: "user", content: `I wait. ${filler(40)} [${i}]` });
    messages.push({ id: `a${i}`, role: "assistant", content: `She turns a page. ${filler(120)} [${i}]` });
  }
  messages.push({ id: `u${turns + 1}`, role: "user", content: `I wait again. ${filler(40)}` });
  return { id: "s", messages, ledger, consumed };
}

const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, apiEndpoint: "https://x.test/v1", model: "m", ...over });

const request = (turns: number, over = {}, opts = {}) =>
  BrowserChatEngine.describeRequest({ card: CARD, session: session(turns, opts), settings: settings(over), persona: PERSONA });

/** The row labels the panel actually rendered, in order. */
const labels = (html: string) =>
  [...html.matchAll(/<span class="rp-ledger__key">([^<]*)/g)].map((m) => m[1].trim());

describe("Context panel", () => {
  test("a row with nothing in it is left out rather than shown as a zero", () => {
    // The shipped defaults leave several of these at zero for every session —
    // at 65,536 tokens the continuity recap never engages at all — and an empty
    // row reads to a reader as a feature that is broken rather than absent.
    //
    // "Story so far: 0 tokens" is deliberately NOT one of them: it is the anchor
    // that shows where the growth comes from, and zero is the honest answer on a
    // chat that has not started.
    const fresh = renderContextPanel({ request: request(0), usage: null });
    const shown = labels(fresh);
    expect(shown).not.toContain("Continuity recap");
    expect(shown).not.toContain("Left out");
    expect(shown).toContain("Story so far");

    // Negative control: the same row is present the moment it has something in
    // it, so its absence above is the emptiness and not a missing feature.
    const folded = renderContextPanel({
      request: request(20, { maxContextTokens: 8192 }, { ledger: `## Cast\n${filler(500)}`, consumed: 12 }),
      usage: null,
    });
    expect(labels(folded)).toContain("Continuity recap");
  });

  test("a reader who has set no persona is not told about one", () => {
    const bare = BrowserChatEngine.describeRequest({
      card: { id: "c", data: { name: "Elena", description: filler(200) } },
      session: session(2),
      settings: settings(),
      persona: null,
    });
    const shown = labels(renderContextPanel({ request: bare, usage: null }));
    expect(shown).not.toContain("Your persona");
    // "Optional guidance" is not the reader's to set — it is the engine's own
    // degradable material, so it is present whether or not a persona exists.
    expect(shown).toContain("Optional guidance");
  });

  test("the window is not presented as a fact the app knows when the reader chose it", () => {
    const configured = renderContextPanel({ request: request(10), usage: null, windowLearned: false });
    expect(configured).toContain("From your settings");
    expect(configured).not.toContain("Reported by your provider");

    const learned = renderContextPanel({ request: request(10), usage: null, windowLearned: true });
    expect(learned).toContain("Reported by your provider");
    expect(learned).not.toContain("From your settings");
  });

  test("provider figures appear only when the provider reported them", () => {
    const silent = renderContextPanel({ request: request(30), usage: null });
    expect(labels(silent)).not.toContain("Input reported");
    expect(labels(silent)).not.toContain("Served from cache");
    expect(labels(silent)).not.toContain("Thinking tokens");

    const reported = renderContextPanel({
      request: request(30),
      usage: {
        reported: true,
        totalInput: 5934,
        overhead: 2150,
        cachedTokens: 4100,
        cacheHitRate: 0.69,
        completionTokens: 623,
        reasoningTokens: 1603,
        reasoningShare: 0.72,
        ceilingIgnored: true,
      },
    });
    expect(labels(reported)).toContain("Input reported");
    expect(reported).toContain("different prices");
    expect(labels(reported)).toContain("Served from cache");
    expect(labels(reported)).toContain("Thinking tokens");
    expect(reported).toContain("69%");
    expect(reported).toContain("72%");
  });

  test("a provider that reports nothing still leaves the measured preamble on show", () => {
    // The preamble is the app's own measurement of the provider's behaviour, so
    // it survives an endpoint that sends no usage at all — which is exactly the
    // endpoint the app was tested against.
    const html = renderContextPanel({ request: { ...request(10), overheadTokens: 2150 }, usage: null });
    expect(labels(html)).toContain("Added by your provider");
    expect(html).toContain("+2.1k tokens");
  });

  test("an over-window request is named, not printed as arithmetic that cannot be read", () => {
    const req = request(14, { maxContextTokens: 2048 });
    expect(req.impossible).toBe(true);
    const html = renderContextPanel({ request: req, usage: null });
    // "2.1k tokens of 2.0k used" is a sentence a reader has to decode; the state
    // is what matters, so it is said outright.
    expect(html).toContain("over the");
    expect(html).not.toContain(`of ${formatTokens(req.contextWindow).replace(" tokens", "")} used`);
    expect(html).toContain('data-status="over"');
    expect(html).toMatch(/summarize or trim/);
  });

  test("the headline agrees with the request the engine measured", () => {
    const req = request(30);
    const summary = contextSummary(req);
    expect(summary.window).toBe(req.contextWindow);
    expect(summary.used).toBe(req.totalTokens);
    expect(summary.free).toBe(req.breakdown.remaining);
    // The meter is a proportion of the window, so it cannot exceed it.
    expect(summary.pct).toBeLessThanOrEqual(100);
    expect(summary.pct).toBeGreaterThanOrEqual(0);
  });

  test("a section id the name table does not know is shown as words, never as an identifier", () => {
    // The failure this guards: a section added later reaches the reader as
    // "voiceDifferentiation" or "someNewSection" in the middle of a sentence.
    const html = renderContextPanel({
      request: { ...request(10), excludedSections: ["someNewSection", "examples"] },
      usage: null,
    });
    expect(html).toContain("some new section");
    expect(html).not.toContain("someNewSection");
    expect(html).toContain("dialogue examples");
  });

  test("token counts read as quantities, not as bare integers", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(208)).toBe("208 tokens");
    expect(formatTokens(1200)).toBe("1.2k tokens");
    expect(formatTokens(65536)).toBe("65.5k tokens");
    expect(formatTokens(131072)).toBe("131k tokens");
    // A window above a million arrives through an imported session; "1049k" is a
    // number the reader would have to convert.
    expect(formatTokens(1048576)).toBe("1.0M tokens");
    // A missing or nonsense figure must not become NaN on screen.
    expect(formatTokens(undefined)).toBe("0 tokens");
    expect(formatTokens(-5)).toBe("0 tokens");
  });

  test("the sheet does not say the same thing twice", () => {
    // The modal header carries the title and one description. Repeating them as
    // an inner heading and help line is what the panel used to do.
    const markup = readFileSync(join(ROOT, "public", "chat.html"), "utf8");
    const sheet = markup.slice(markup.indexOf('id="ledger-sheet"'), markup.indexOf("<!-- Saved chats"));
    const titles = [...sheet.matchAll(/<h[23][^>]*>([^<]*)<\/h[23]>/g)].map((m) => m[1].trim());
    expect(titles).toEqual(["Context"]);
    expect(sheet).not.toContain("rp-ledger__group-help");
  });
});

// The one row that can tell a reader their prompt is not being reused. It exists
// only when the provider reported a cache count: a provider that reports nothing
// has not measured a miss, and the app must not imply one. The cause is left
// open — the app can see that nothing was reused, not why.
describe("The cache row reports a measurement, never a guess", () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    reported: true,
    totalInput: 6000,
    overhead: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    completionTokens: 100,
    reasoningTokens: null,
    reasoningShare: null,
    ceilingIgnored: false,
    ...over,
  });

  test("a legacy report saved under the old field name still shows its input", () => {
    // Sessions persisted before the total-volume rename carry `billedInput`
    // alone. It is the same figure, so the panel must keep reading it.
    const html = renderContextPanel({ request: request(30), usage: { ...usage(), totalInput: undefined, billedInput: 5934 } });
    expect(labels(html)).toContain("Input reported");
    expect(html).toContain("5.9k tokens");
  });

  test("a measured zero on a prompt long enough to have been cached is shown", () => {
    const html = renderContextPanel({ request: request(20), usage: usage() });
    expect(labels(html)).toContain("Served from cache");
    expect(html).toContain("no cache reads");
    // It must not name a cause it cannot know.
    expect(html).not.toMatch(/because the prompt changed/);
    expect(html).toContain("may have changed");
  });

  test("a provider that reported no cache count gets no cache row at all", () => {
    const html = renderContextPanel({ request: request(20), usage: usage({ cachedTokens: null, cacheHitRate: null }) });
    expect(labels(html)).not.toContain("Served from cache");
  });

  test("a measured zero on a prompt too short to cache is left out", () => {
    // Below the length any provider would cache, a zero says nothing about the
    // prefix and would only alarm the reader.
    const html = renderContextPanel({ request: request(0), usage: usage({ totalInput: 900 }) });
    expect(labels(html)).not.toContain("Served from cache");
  });

  test("a real hit rate is still reported as a rate", () => {
    const html = renderContextPanel({ request: request(20), usage: usage({ cachedTokens: 4200, cacheHitRate: 0.7 }) });
    expect(html).toContain("70%");
    expect(html).not.toContain("none of this prompt was reused");
  });
});

// The one part of the sheet that is a history rather than a snapshot. It exists
// because a single hit rate cannot be acted on: the first reply after anything
// changes is cold by definition, so one number cannot tell a prompt that is
// never reused from one that was rebuilt a moment ago.
describe("Cache reuse over time is scoped, and says so", () => {
  const SCOPE = scopeKeyOf({
    endpoint: "https://x.test/v1",
    model: "m",
    cardId: "c",
    personaId: "persona_default",
    directiveId: "directive_default",
  });
  const OTHER = scopeKeyOf({
    endpoint: "https://x.test/v1",
    model: "m",
    cardId: "c",
    personaId: "persona_other",
    directiveId: "directive_default",
  });
  const LABEL = "Rin · Author's Craft Directive";

  /** A session holding one measured sample per rate; `null` is "no report". */
  function history(rates: (number | null)[], { scope = SCOPE, folded = [] as number[] } = {}) {
    const sess: Record<string, unknown> = {};
    rates.forEach((rate, i) => {
      recordUsageSample(sess, {
        report: rate === null ? null : { reported: true, billedInput: 1000, cachedTokens: Math.round(rate * 1000), estimatedInput: 900 },
        scope,
        at: 100 + i,
        folded: folded.includes(i),
      });
    });
    return sess;
  }

  const panel = (sess: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    renderContextPanel({
      request: request(20),
      usage: null,
      samples: sess.usageHistory as unknown[],
      scope: SCOPE,
      scopeLabel: LABEL,
      pruned: sess.usagePruned,
      ...over,
    });

  test("a chat with no measured history says nothing about caching", () => {
    // Every existing caller passes no samples at all. The sheet has to be
    // exactly what it was before this section existed.
    const html = renderContextPanel({ request: request(20), usage: null });
    expect(html).not.toContain("Cache reuse over time");
    expect(html).not.toContain("rp-ledger__trend");
  });

  test("the trend shows the series, the reading and the scope it belongs to", () => {
    const html = panel(history([0, 0.5, 0.7, 0.8]));
    expect(html).toContain("Cache reuse over time");
    expect(html).toContain(LABEL);
    // Four replies, four bars.
    expect((html.match(/rp-ledger__trend-bar/g) || []).length).toBe(4);
    // The reading is the median with the shape of the series.
    expect(html).toContain("Reused 60% of the prompt on average across 4 replies, and it is rising.");
    expect(html).toContain("1 of them reused nothing");
    // And the accessible equivalent carries every point, because a two-pixel
    // bar is not readable.
    expect(html).toContain("oldest first: 0%, 50%, 70%, 80%");
  });

  test("a provider that reported nothing is a gap, not a run of misses", () => {
    const html = panel(history([0.5, null, null]));
    // Two of the three bars are the "no figure" state, not the cold one.
    expect((html.match(/data-state="unknown"/g) || []).length).toBe(2);
    expect((html.match(/data-state="cold"/g) || []).length).toBe(0);
    expect(html).toContain("1 of 3 replies reported a cache figure");
    expect(html).not.toContain("reused nothing");
  });

  test("a scope where nothing was ever reported has no chart to misread", () => {
    const html = panel(history([null, null]));
    expect(html).toContain("has not reported a cache figure");
    expect(html).not.toContain("rp-ledger__trend");
  });

  test("history under another setup is counted and kept out of the figures", () => {
    const sess = history([0.2, 0.2]);
    recordUsageSample(sess, { report: { reported: true, billedInput: 1000, cachedTokens: 900 }, scope: OTHER, at: 500 });
    recordUsageSample(sess, { report: { reported: true, billedInput: 1000, cachedTokens: 900 }, scope: OTHER, at: 501 });
    recordUsageSample(sess, { report: { reported: true, billedInput: 1000, cachedTokens: 900 }, scope: OTHER, at: 502 });

    const html = panel(sess);
    // The reading is this scope's 20%, not a blend of all five samples — which
    // is the whole reason the section is scoped.
    expect(html).toContain("Reused 20% of the prompt on average across 2 replies.");
    expect(html).not.toContain("72%");
    expect(html).not.toContain("90%");
    expect((html.match(/rp-ledger__trend-bar/g) || []).length).toBe(2);
    expect(html).toContain("3 earlier replies in this chat ran under a different setup and are not counted here.");
  });

  test("one reply is described in the singular, never as \"all 1 replies\"", () => {
    const html = panel(history([0.2]));
    expect(html).toContain("The one reply reported a cache figure.");
    expect(html).not.toContain("All 1 replies");
    expect(html).toContain("Cache reuse for the one reply under this setup");
  });

  test("a chat that has not run under this setup yet says so instead of borrowing", () => {
    const sess = history([0.9], { scope: OTHER });
    const html = panel(sess);
    expect(html).toContain("No reply has run under this setup yet.");
    expect(html).not.toContain("rp-ledger__trend");
    expect(html).toContain("1 earlier reply in this chat ran under a different setup and is not counted here.");
  });

  test("a single reply is not dressed up as a trend", () => {
    const html = panel(history([0.46]));
    expect(html).toContain("One reply reused 46% of its prompt.");
    expect(html).toContain("A single reply cannot show a trend");
  });

  test("a reply whose prompt was rebuilt is marked, and the mark is explained", () => {
    const html = panel(history([0.1, 0.6], { folded: [1] }));
    expect((html.match(/data-folded="true"/g) || []).length).toBe(1);
    expect(html).toContain("A tick marks a reply whose prompt had just been rebuilt");
    // The dip is expected, not a change in behaviour — otherwise the mark
    // explains a fact and leaves the reader to draw the wrong conclusion.
    expect(html).toContain("a dip there is expected");
  });

  test("a run of identical rates is not described as a trend", () => {
    const html = panel(history([0, 0, 0, 0]));
    expect(html).toContain("Reused 0% of the prompt on average across 4 replies.");
    expect(html).not.toContain("and it is steady");
  });

  test("a pruned history says what it is showing rather than passing a window off as the whole story", () => {
    const sess: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      recordUsageSample(sess, { report: { reported: true, billedInput: 1000, cachedTokens: 700 }, scope: SCOPE, at: i });
    }
    const html = panel(sess);
    expect(html).toContain("Showing the 30 most recent replies under this setup.");
  });

  test("no identifier from the scope key ever reaches the page", () => {
    // The key is built from ids. It exists to group samples, never to be read.
    const html = panel(history([0.5, 0.6]));
    expect(html).not.toContain(SCOPE);
    expect(html).not.toContain("persona_default");
    expect(html).not.toContain("directive_default");
    expect(html).not.toContain("x.test");
  });

  test("a setup with nothing nameable falls back to the chat alone", () => {
    const html = panel(history([0.5, 0.6]), { scopeLabel: null });
    expect(html).toContain("For this chat.");
    expect(html).not.toContain("For this chat, under");
  });
});

