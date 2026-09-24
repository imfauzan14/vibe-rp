// The detail modal's Saved chats view must show only Back in the header: the
// redundant × is hidden there and reappears on the profile view, where it is
// the only header close control. No DOM library: a tiny fake document, in the
// style of test/library_resume.test.ts, extended with the surface
// openDetailModal touches (body, getElementById, classList.remove, contains,
// focus, document listeners, requestAnimationFrame, HTMLElement).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDetailModal } from "../public/ui/detail_modal.js";


import { makeFakeElement as makeElement } from "./helpers.ts";
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
