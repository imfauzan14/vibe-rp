// The detail modal's Saved chats view must show only Back in the header: the
// redundant × is hidden there and reappears on the profile view, where it is
// the only header close control. No DOM library: a tiny fake document, in the
// style of test/library_resume.test.ts, extended with the surface
// openDetailModal touches (body, getElementById, classList.remove, contains,
// focus, document listeners, requestAnimationFrame, HTMLElement).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDetailModal } from "../public/ui/detail_modal.js";

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------
function classesOf(node) {
  return new Set(String(node.className || "").split(/\s+/).filter(Boolean));
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    if (!child || typeof child !== "object") continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function matchesOne(node, sel) {
  if (!sel || /[\s>:+~]/.test(sel)) return false;
  let rest = sel;
  const tag = rest.match(/^([a-zA-Z][\w-]*)/);
  if (tag) {
    if (node.tagName !== tag[1].toUpperCase()) return false;
    rest = rest.slice(tag[1].length);
  } else if (rest[0] !== "." && rest[0] !== "[") {
    return false;
  }
  while (rest.length) {
    if (rest[0] === ".") {
      const m = rest.match(/^\.([\w-]+)/);
      if (!m || !classesOf(node).has(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const m = rest.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
      if (!m) return false;
      const actual = node.getAttribute(m[1]);
      if (actual === null) return false;
      const want = m[2] ?? m[3] ?? m[4];
      if (want !== undefined && actual !== want) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matches(node, selector) {
  return String(selector)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => matchesOne(node, part));
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    style: {},
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
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attributes, k);
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
    replaceChildren(...nodes) {
      el.children = [];
      el.append(...nodes);
    },
    remove() {
      if (!el.parentNode) return;
      const i = el.parentNode.children.indexOf(el);
      if (i >= 0) el.parentNode.children.splice(i, 1);
      el.parentNode = null;
    },
    contains(node) {
      if (node === el) return true;
      return descendants(el).includes(node);
    },
    focus() {},
    addEventListener(type, fn) {
      (el._listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type) {
      for (const fn of el._listeners[type] || []) fn({ type, target: el });
    },
    get firstElementChild() {
      return el.children[0] || null;
    },
    querySelector(selector) {
      return descendants(el).find((node) => matches(node, selector)) || null;
    },
    querySelectorAll(selector) {
      return descendants(el).filter((node) => matches(node, selector));
    },
  };
  return el;
}

const realDocument = globalThis.document;
const realRAF = globalThis.requestAnimationFrame;
const realHTMLElement = globalThis.HTMLElement;
const realElement = globalThis.Element;

function installDom() {
  globalThis.document = {
    createElement: (tag) => makeElement(tag),
    getElementById: () => null,
    activeElement: null,
    body: makeElement("body"),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = () => 0;
  if (globalThis.HTMLElement === undefined) globalThis.HTMLElement = class {};
  if (globalThis.Element === undefined) globalThis.Element = class {};
}

function restoreDom() {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realRAF === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = realRAF;
  if (realHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = realHTMLElement;
  if (realElement === undefined) delete globalThis.Element;
  else globalThis.Element = realElement;
}

function openModal() {
  const card = { id: "card_a", data: { name: "Ada" } };
  const sessions = [
    { id: "sess_1", cardId: "card_a", title: "Chat 1", updatedAt: 1, messages: [] },
  ];
  return openDetailModal({ card, sessions, handlers: {} });
}

function buttons(root) {
  return root.querySelectorAll("button");
}

// `historyBtn` is assembled with `append`, so its own `textContent` stays ""
// and the label only exists across its children (including raw strings).
function textOf(node) {
  let out = node.textContent || "";
  for (const child of node.children) {
    if (child === null || child === undefined || child === false) continue;
    out += typeof child === "object" ? textOf(child) : String(child);
  }
  return out;
}

function byText(root, text) {
  return buttons(root).find((b) => b.textContent === text) || null;
}

function byTextContains(root, text) {
  return buttons(root).find((b) => textOf(b).includes(text)) || null;
}

// `reloadThreads` continues as a microtask after showView("history") and reads
// the fake document, so each case drains the queue before teardown removes it.
// Awaiting resolved promises is deterministic; no wall-clock wait is involved.
async function drainMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// The × / Back toggle
// ---------------------------------------------------------------------------
describe("detail modal header: × hides in Saved chats, Back returns", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  test("profile view shows × and hides Back", async () => {
    const handle = openModal();
    const closeBtn = handle.element.querySelector(".rp-dialog__close");
    const backBtn = byText(handle.element, "Back");
    expect(closeBtn).toBeTruthy();
    expect(backBtn).toBeTruthy();
    expect(Boolean(closeBtn.hidden)).toBe(false);
    expect(Boolean(backBtn.hidden)).toBe(true);
    await drainMicrotasks();
  });

  test("Saved chats view hides × and shows Back; Back restores both", async () => {
    const handle = openModal();
    const closeBtn = handle.element.querySelector(".rp-dialog__close");
    const backBtn = byText(handle.element, "Back");
    byTextContains(handle.element, "Saved chats").dispatch("click");
    expect(Boolean(closeBtn.hidden)).toBe(true);
    expect(Boolean(backBtn.hidden)).toBe(false);
    backBtn.dispatch("click");
    expect(Boolean(closeBtn.hidden)).toBe(false);
    expect(Boolean(backBtn.hidden)).toBe(true);
    await drainMicrotasks();
  });

  test("× still closes the dialog from the profile view", async () => {
    const handle = openModal();
    handle.element.querySelector(".rp-dialog__close").dispatch("click");
    expect(document.body.contains(handle.element)).toBe(false);
    await drainMicrotasks();
  });
});
