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

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------
function classesOf(node) {
  return new Set(String(node.className || "").split(/\s+/).filter(Boolean));
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    _listeners: {},
    className: "",
    textContent: "",
    parentNode: null,
    classList: {
      add: (...c) => {
        const set = classesOf(el);
        c.forEach((x) => set.add(x));
        el.className = [...set].join(" ");
      },
      remove: (...c) => {
        const set = classesOf(el);
        c.forEach((x) => set.delete(x));
        el.className = [...set].join(" ");
      },
      contains: (c) => classesOf(el).has(c),
      toggle: (c, force) => {
        const set = classesOf(el);
        const on = force === undefined ? !set.has(c) : Boolean(force);
        if (on) set.add(c);
        else set.delete(c);
        el.className = [...set].join(" ");
        return on;
      },
    },
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null;
    },
    removeAttribute(k) {
      delete el.attributes[k];
    },
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) {
        if (node === null || node === undefined || node === false) continue;
        el.children.push(node);
        if (node && typeof node === "object") node.parentNode = el;
      }
    },
    prepend(...nodes) {
      for (const node of nodes) {
        if (node === null || node === undefined || node === false) continue;
        el.children.unshift(node);
        if (node && typeof node === "object") node.parentNode = el;
      }
    },
    replaceChildren(...nodes) {
      el.children = [];
      el.append(...nodes);
    },
    remove() {
      if (!el.parentNode) return;
      const i = el.parentNode.children.indexOf(el);
      if (i >= 0) el.parentNode.children.splice(i, 1);
    },
    addEventListener(type, fn) {
      (el._listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of el._listeners[type] || []) fn({ type, target: el });
    },
    get firstElementChild() {
      return el.children[0] || null;
    },
    get lastElementChild() {
      return el.children[el.children.length - 1] || null;
    },
    querySelector(selector) {
      return descendants(el).find((node) => matches(node, selector)) || null;
    },
    querySelectorAll(selector) {
      return descendants(el).filter((node) => matches(node, selector));
    },
  };
  // Real anchors reflect `.href` onto the attribute; `el()` assigns the href
  // as a property, so the fake must reflect it too or the test would read "".
  Object.defineProperty(el, "href", {
    get() {
      return el.attributes.href === undefined ? "" : el.attributes.href;
    },
    set(v) {
      el.attributes.href = String(v);
    },
  });
  return el;
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    if (!child || typeof child !== "object") continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function matches(node, selector) {
  const sel = String(selector);
  if (sel.startsWith("[")) {
    const m = sel.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
    if (!m) return false;
    const [, key, value] = m;
    const actual = node.getAttribute(key);
    if (actual === null) return false;
    return value === undefined || actual === value;
  }
  if (sel.startsWith(".")) return classesOf(node).has(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

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
