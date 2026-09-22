// Modal: one dialog controller for the whole app.
//
// Contract
//   - Dialogs are native <dialog> elements marked `.rp-dialog` with a
//     `.rp-dialog__panel` child. The platform owns Escape and the top layer,
//     but NOT backdrop dismissal: a click on a <dialog>'s ::backdrop is
//     delivered to the dialog element itself and does not close it. This
//     module adds that, plus focus, the modal stack and background inertness.
//   - `openModal({ element, trigger, onClose, initialFocus })` shows the
//     dialog, remembers `trigger` (or the current activeElement), moves focus
//     into the panel, and makes the rest of the page inert. Returns a close
//     function.
//   - `closeModal(element)` closes one dialog and restores focus to the
//     element that opened it. `closeTopModal()` closes the topmost dialog.
//   - ONE keydown listener for the whole page, installed on first open and
//     removed when the last dialog closes. It wraps Tab inside the top dialog
//     and routes Escape to that dialog only.
//   - Backdrop dismissal is per dialog (`bindBackdropDismiss`): a click closes
//     the top dialog only when the press and the release both landed on the
//     dialog element itself and outside its panel, so a text selection dragged
//     out of a field and released on the backdrop cannot dismiss it.
//   - `bindDismissable` gives a NON-modal popover (the ledger sheet) the same
//     Escape and outside-click contract without a focus trap.
//   - `aria-modal="true"` is set on open because the page really is inert;
//     nested dialogs leave the outer dialog's own content focusable.
//
// Exports
//   openModal(options) -> close function
//   closeModal(element) -> boolean
//   closeTopModal() -> boolean
//   isOpen(element) -> boolean
//   topModal() -> element | null
//   isPointOutsideRect(rect, x, y) -> boolean
//   bindBackdropDismiss(element, onBackdrop, options) -> unbind
//   bindDismissable({ element, isOpen, onDismiss, trigger }) -> unbind

import { focusables } from "./dom.js";

const stack = [];

function panelOf(element) {
  return element?.querySelector(":scope .rp-dialog__panel") || element;
}

/**
 * Pure geometry: is the point (x, y) outside the rectangle? The edges count as
 * inside, so a click on the panel's own padding or border never reads as
 * outside. Kept browser-free so the dismissal contract is unit-testable.
 */
export function isPointOutsideRect(rect, x, y) {
  if (!rect) return false;
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

/**
 * Backdrop dismissal for one native <dialog>. The ::backdrop is part of the
 * dialog's own box, so the platform delivers the click to the dialog element
 * itself; this closes only when the pointer both went down and came up on that
 * element and outside the panel. A press inside a field that is dragged out
 * and released on the backdrop is therefore ignored. Returns an unbind
 * function.
 */
export function bindBackdropDismiss(element, onBackdrop, { panel = null } = {}) {
  if (!element || typeof onBackdrop !== "function") return () => {};
  let pressed = null;
  const onPointerDown = (event) => {
    pressed = event.target;
  };
  const onClick = (event) => {
    const started = pressed;
    pressed = null;
    if (event.target !== element) return; // a descendant was clicked
    if (started && started !== element) return; // drag-out release
    const box = panel || panelOf(element);
    if (box && box !== element) {
      if (!isPointOutsideRect(box.getBoundingClientRect(), event.clientX, event.clientY)) return;
    }
    onBackdrop();
  };
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("click", onClick);
  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("click", onClick);
  };
}

/**
 * Escape + outside-click dismissal for a NON-modal popover (the ledger sheet):
 * no focus trap, no inertness, `aria-modal` untouched. Escape is ignored while
 * a modal dialog is open so the topmost dialog keeps its own Escape. Returns an
 * unbind function.
 */
export function bindDismissable({ element, isOpen: isOpenFn, onDismiss, trigger = null } = {}) {
  if (!element || typeof isOpenFn !== "function" || typeof onDismiss !== "function") return () => {};
  const onPointerDown = (event) => {
    if (!isOpenFn()) return;
    const target = event.target;
    if (element.contains(target)) return;
    if (trigger && (trigger === target || trigger.contains(target))) return;
    onDismiss();
  };
  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (topModal()) return; // a modal dialog owns Escape
    if (!isOpenFn()) return;
    event.preventDefault();
    onDismiss();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeydown, true);
  };
}


/**
 * Makes everything except the open dialog stack inert, so a screen reader and
 * the Tab key both stay inside. Elements already inert are restored on close.
 */
function syncBackgroundInert() {
  const openPanels = stack.map((entry) => entry.element);
  const top = openPanels[openPanels.length - 1];
  for (const child of Array.from(document.body.children)) {
    // The toast region stays live so an Undo control remains reachable while
    // a dialog is open.
    if (child.hasAttribute("data-rp-keep-active")) continue;
    const holdsDialog = openPanels.some((dialog) => child === dialog || child.contains(dialog));
    const shouldBeInert = Boolean(top) && !holdsDialog;
    if (shouldBeInert) {
      if (!child.hasAttribute("inert")) {
        child.setAttribute("inert", "");
        child.dataset.rpInert = "1";
      }
    } else if (child.dataset.rpInert === "1") {
      child.removeAttribute("inert");
      delete child.dataset.rpInert;
    }
  }
}

function onKeydown(event) {
  const entry = stack[stack.length - 1];
  if (!entry) return;
  const dialog = entry.element;

  if (event.key === "Escape") {
    // The topmost dialog consumes Escape. Nested dialogs must not fall
    // through and close the dialog underneath them.
    event.preventDefault();
    closeModal(dialog);
    return;
  }

  if (event.key !== "Tab") return;
  const items = focusables(panelOf(dialog));
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function installListener() {
  if (stack.length === 1) document.addEventListener("keydown", onKeydown, true);
}

function removeListener() {
  if (stack.length === 0) document.removeEventListener("keydown", onKeydown, true);
}

/** True when the element is on the open stack. */
export function isOpen(element) {
  return stack.some((entry) => entry.element === element);
}

/** The topmost open dialog, or null. */
export function topModal() {
  return stack.length ? stack[stack.length - 1].element : null;
}

/**
 * Opens `element`. Returns a function that closes it, so a caller can wire a
 * close button without repeating the element reference.
 */
export function openModal({ element, trigger = null, onClose = null, initialFocus = null } = {}) {
  if (!element) return () => {};
  if (isOpen(element)) return () => closeModal(element);

  const opener = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  element.setAttribute("aria-modal", "true");
  if (typeof element.showModal === "function") {
    if (!element.open) element.showModal();
  } else {
    element.setAttribute("open", "");
  }
  element.classList.add("open");

  const entry = { element, opener, onClose };
  stack.push(entry);
  installListener();
  syncBackgroundInert();

  // Backdrop click closes the top dialog only. `bindBackdropDismiss` requires
  // the press and the release to land on the dialog element itself, outside
  // its panel, so a drag-out text selection cannot dismiss it.
  entry.unbindBackdrop = bindBackdropDismiss(element, () => {
    if (element !== topModal()) return;
    closeModal(element);
  });

  // A dialog can close without going through `closeModal` (a
  // `<form method="dialog">` submit, or a direct `element.close()`). Keep the
  // stack honest so the next open/close and the inert pass stay correct.
  const onNativeClose = () => closeModal(element);
  element.addEventListener("close", onNativeClose);
  entry.onNativeClose = onNativeClose;

  // Focus after the dialog is in the top layer. A mid-transition panel can
  // refuse focus, so retry per frame, bounded so no loop can leak. A focus the
  // caller set synchronously inside the panel (e.g. a settings tab) is kept.
  const target = initialFocus || focusables(panelOf(element))[0] || panelOf(element);
  let tries = 0;
  const settle = () => {
    if (!isOpen(element)) return;
    const active = document.activeElement;
    if (active && active !== element && element.contains(active)) return;
    target?.focus?.();
    if (document.activeElement === target || document.activeElement === element || ++tries > 30) return;
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);

  const onCancel = (event) => {
    event.preventDefault();
    closeModal(element);
  };
  element.addEventListener("cancel", onCancel);
  entry.onCancel = onCancel;

  return () => closeModal(element);
}

/** Closes one dialog and restores focus to its trigger. */
export function closeModal(element) {
  const index = stack.findIndex((entry) => entry.element === element);
  if (index === -1) return false;
  const [entry] = stack.splice(index, 1);

  element.removeEventListener("cancel", entry.onCancel);
  element.removeEventListener("close", entry.onNativeClose);
  entry.unbindBackdrop?.();

  element.classList.remove("open");
  if (typeof element.close === "function" && element.open) {
    try {
      element.close();
    } catch (_) {
      element.removeAttribute("open");
    }
  } else {
    element.removeAttribute("open");
  }
  element.removeAttribute("aria-modal");

  syncBackgroundInert();
  removeListener();

  const restore = entry.opener;
  if (restore && restore.isConnected && !restore.hasAttribute("inert")) {
    restore.focus();
  }

  try {
    entry.onClose?.();
  } catch (_) {
    /* a close handler must not break focus restoration */
  }
  return true;
}

/** Closes the topmost dialog. Returns false when none is open. */
export function closeTopModal() {
  const top = topModal();
  return top ? closeModal(top) : false;
}
