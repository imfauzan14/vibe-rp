// Regression tests for the library card's two footer actions: Resume and
// New chat. Both were instances of the SAME bug class: a control created in
// JS that had neither a working href/type=submit nor a working listener.
//
// Resume: `paintAction` created the anchor without an href and only assigned
// one on a LATER paint. The anchor's click handler delegates to
// `handlers.onResume`, which the page deliberately leaves as a no-op so an
// in-app router can intercept it. So on the first paint a Resume click was a
// dead no-op: no href to follow natively and no handler to navigate. Resuming
// the same session from the in-app "Saved chats" list (detail_modal.js) worked
// because that anchor is built with its href.
//
// New chat: `renderCard` created the button with `data-action="new"` but never
// attached a listener, and no delegation handled that action, so the declared
// `onNewChat` handler was never invoked and the click did nothing at all.
//
// These tests render a card exactly once (no second paint) and assert each
// action is wired. No DOM library: a tiny fake document is installed for the
// duration of each case, matching the "drive the public seam" style of the
// rest of the suite. `href` is reflected onto the attribute, like the real
// HTMLAnchorElement, so the assertion sees what a browser would.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderCard } from "../public/ui/library_view.js";

import { makeFakeElement as makeElement } from "./helpers.ts";

const realDocument = globalThis.document;
function installDom() {
  globalThis.document = {
    createElement: (tag) => makeElement(tag),
  };
}
function restoreDom() {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
}

function cardWithSession({ id = "card_a", sessionId = "sess_1" } = {}) {
  return {
    id,
    data: { name: "Test Character", first_mes: "Hello.", tags: ["Test"] },
    latestSession: { id: sessionId, cardId: id, title: "Chat 1", updatedAt: 1 },
    sessions: [{ id: sessionId, cardId: id, title: "Chat 1", updatedAt: 1 }],
    sessionCount: 1,
  };
}

function resumeAnchor(cardEl) {
  return cardEl.querySelector('[data-action="resume"]');
}

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------
describe("library card Resume is a working link on first render", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  test("href is set on the FIRST render, with no second paint", () => {
    // Exactly one render: the node is created here, never updated again.
    const cardEl = renderCard(cardWithSession(), {});
    const anchor = resumeAnchor(cardEl);
    expect(anchor).toBeTruthy();
    const href = anchor.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).toContain("sess_1");
    expect(href).toBe("chat.html?cardId=card_a&sessionId=sess_1");
  });

  test("the href carries the exact card and session ids, url-encoded", () => {
    const card = cardWithSession({ id: "card/with space", sessionId: "sess/1 & 2" });
    const anchor = resumeAnchor(renderCard(card, {}));
    expect(anchor.getAttribute("href")).toBe(
      "chat.html?cardId=card%2Fwith%20space&sessionId=sess%2F1%20%26%202"
    );
  });

  test("a card with no session has no Resume anchor", () => {
    const card = { id: "card_b", data: { name: "No Chats" }, latestSession: null, sessionCount: 0 };
    const cardEl = renderCard(card, {});
    expect(resumeAnchor(cardEl)).toBeNull();
  });

  test("a repaint keeps the href correct when the latest session changes", () => {
    const cardEl = renderCard(cardWithSession(), {});
    const updated = cardWithSession({ sessionId: "sess_2" });
    renderCard(updated, {}, cardEl);
    expect(resumeAnchor(cardEl).getAttribute("href")).toBe("chat.html?cardId=card_a&sessionId=sess_2");
  });

  test("clicking Resume still calls onResume with the card and its latest session", () => {
    const card = cardWithSession();
    let seen = null;
    const cardEl = renderCard(card, { onResume: (c, s) => (seen = { c, s }) });
    resumeAnchor(cardEl).dispatch("click");
    expect(seen).toEqual({ c: card, s: card.latestSession });
  });
});

// ---------------------------------------------------------------------------
// The second instance of the same bug class
// ---------------------------------------------------------------------------
describe("library card New chat is wired on first render", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  test("clicking New chat calls onNewChat with the card", () => {
    const card = cardWithSession();
    let seen = null;
    const cardEl = renderCard(card, { onNewChat: (c) => (seen = c) });
    const button = cardEl.querySelector('[data-action="new"]');
    expect(button).toBeTruthy();
    button.dispatch("click");
    expect(seen).toBe(card);
  });

  test("New chat is a sibling of the card body control, never nested inside it", () => {
    const cardEl = renderCard(cardWithSession(), {});
    const link = cardEl.querySelector(".rp-card__link");
    const button = cardEl.querySelector('[data-action="new"]');
    // No interactive element may sit inside another: the button must not be a
    // descendant of the detail-opening control.
    expect(link.querySelector('[data-action="new"]')).toBeNull();
    expect(button).toBeTruthy();
  });

  test("a reused card node acts on the card it currently shows", () => {
    // `mountLibrary` passes ONE stable handlers object across repaints, so the
    // listener attached at creation stays valid. What must not go stale is the
    // card: the handler reads `article.__card` at click time.
    let seen = null;
    const handlers = { onNewChat: (c) => (seen = c) };
    const cardEl = renderCard(cardWithSession({ id: "card_a" }), handlers);
    const second = cardWithSession({ id: "card_b", sessionId: "sess_b" });
    renderCard(second, handlers, cardEl);
    cardEl.querySelector('[data-action="new"]').dispatch("click");
    expect(seen).toBe(second);
  });
});
