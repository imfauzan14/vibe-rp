// Dismissal contract for public/ui/modal.js.
//
// The browser half of the contract (a real backdrop click closing a real
// <dialog>) is covered by the headless-Chromium harness; what can be pinned
// without a DOM is the geometry that decides "is this click on the backdrop
// rather than on the panel". These tests drive that pure helper directly and
// assert the module still exports the rest of the contract, so a refactor
// cannot quietly delete the API the two pages depend on.
import { describe, expect, test } from "bun:test";
import {
  isPointOutsideRect,
  bindBackdropDismiss,
  bindDismissable,
  openModal,
  closeModal,
  closeTopModal,
  isOpen,
  topModal,
} from "../public/ui/modal.js";

// A 400x300 panel placed at (100, 50) on the viewport: left 100, top 50,
// right 500, bottom 350.
const PANEL = { left: 100, top: 50, right: 500, bottom: 350 };

describe("isPointOutsideRect", () => {
  test("a point well inside the panel is not outside", () => {
    expect(isPointOutsideRect(PANEL, 300, 200)).toBe(false);
  });

  test("a point above, below, left or right of the panel is outside", () => {
    expect(isPointOutsideRect(PANEL, 300, 10)).toBe(true); // above
    expect(isPointOutsideRect(PANEL, 300, 400)).toBe(true); // below
    expect(isPointOutsideRect(PANEL, 10, 200)).toBe(true); // left
    expect(isPointOutsideRect(PANEL, 900, 200)).toBe(true); // right
  });

  test("a point in the panel's own padding (inside the edge) is not outside", () => {
    // 4px inside each edge still belongs to the panel, so a click on padding
    // or the border must never read as a backdrop click.
    expect(isPointOutsideRect(PANEL, 104, 54)).toBe(false);
    expect(isPointOutsideRect(PANEL, 496, 346)).toBe(false);
  });

  test("the edges themselves count as inside", () => {
    expect(isPointOutsideRect(PANEL, 100, 200)).toBe(false);
    expect(isPointOutsideRect(PANEL, 500, 200)).toBe(false);
    expect(isPointOutsideRect(PANEL, 300, 50)).toBe(false);
    expect(isPointOutsideRect(PANEL, 300, 350)).toBe(false);
  });

  test("a degenerate or missing rect never reports outside", () => {
    expect(isPointOutsideRect(null, 0, 0)).toBe(false);
    expect(isPointOutsideRect(undefined, 0, 0)).toBe(false);
  });
});

describe("modal.js dismissal contract", () => {
  test("the exported controller API is present", () => {
    for (const fn of [openModal, closeModal, closeTopModal, isOpen, topModal, bindBackdropDismiss, bindDismissable]) {
      expect(typeof fn).toBe("function");
    }
  });

  test("openModal without an element is a no-op that still returns a closer", () => {
    const close = openModal({});
    expect(typeof close).toBe("function");
    expect(() => close()).not.toThrow();
  });

  test("bindBackdropDismiss and bindDismissable tolerate a missing element", () => {
    expect(typeof bindBackdropDismiss(null, () => {})).toBe("function");
    expect(typeof bindBackdropDismiss(undefined, null)).toBe("function");
    expect(typeof bindDismissable({})).toBe("function");
    expect(typeof bindDismissable()).toBe("function");
  });
});
