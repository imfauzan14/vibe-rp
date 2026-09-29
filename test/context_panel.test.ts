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
    expect(labels(silent)).not.toContain("Input billed");
    expect(labels(silent)).not.toContain("Served from cache");
    expect(labels(silent)).not.toContain("Thinking tokens");

    const reported = renderContextPanel({
      request: request(30),
      usage: {
        reported: true,
        billedInput: 5934,
        overhead: 2150,
        cachedTokens: 4100,
        cacheHitRate: 0.69,
        completionTokens: 623,
        reasoningTokens: 1603,
        reasoningShare: 0.72,
        ceilingIgnored: true,
      },
    });
    expect(labels(reported)).toContain("Input billed");
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
    billedInput: 6000,
    overhead: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    completionTokens: 100,
    reasoningTokens: null,
    reasoningShare: null,
    ceilingIgnored: false,
    ...over,
  });

  test("a measured zero on a prompt long enough to have been cached is shown", () => {
    const html = renderContextPanel({ request: request(20), usage: usage() });
    expect(labels(html)).toContain("Served from cache");
    expect(html).toContain("none of this prompt was reused");
    // It must not name a cause it cannot know.
    expect(html).not.toMatch(/because the prompt changed/);
    expect(html).toMatch(/usually means/);
  });

  test("a provider that reported no cache count gets no cache row at all", () => {
    const html = renderContextPanel({ request: request(20), usage: usage({ cachedTokens: null, cacheHitRate: null }) });
    expect(labels(html)).not.toContain("Served from cache");
  });

  test("a measured zero on a prompt too short to cache is left out", () => {
    // Below the length any provider would cache, a zero says nothing about the
    // prefix and would only alarm the reader.
    const html = renderContextPanel({ request: request(0), usage: usage({ billedInput: 900 }) });
    expect(labels(html)).not.toContain("Served from cache");
  });

  test("a real hit rate is still reported as a rate", () => {
    const html = renderContextPanel({ request: request(20), usage: usage({ cachedTokens: 4200, cacheHitRate: 0.7 }) });
    expect(html).toContain("70%");
    expect(html).not.toContain("none of this prompt was reused");
  });
});
