// Confirmation and undo for destructive actions.
//
// Contract
//   - `confirmAction({ title, body, confirmLabel, cancelLabel, tone, trigger })`
//     returns a Promise<boolean>. It is non-blocking: it opens a real
//     `.rp-dialog` with two labelled buttons and resolves on either choice,
//     Escape, or backdrop dismissal. The promise never rejects.
//   - `runWithUndo({ message, undo, timeout, host })` is the preferred path for
//     a reversible action. It performs nothing itself: it shows a toast with an
//     Undo control and returns a Promise<boolean> that resolves `true` if the
//     user pressed Undo, `false` when the window closed.
//   - `confirmDelete({ what, detail, onConfirm, host })` is the standard
//     wrapper for irreversible deletes: confirm, then run, with an error toast
//     if the operation throws.
//
// Exports
//   confirmAction(options) -> Promise<boolean>
//   runWithUndo(options) -> Promise<boolean>
//   confirmDelete(options) -> Promise<boolean>

import { openModal, closeModal } from "./modal.js";

let dialogSeq = 0;

function buildDialog({ title, body, confirmLabel, cancelLabel, tone }) {
  const id = `rp-confirm-${++dialogSeq}`;
  const dialog = document.createElement("dialog");
  dialog.className = "rp-dialog";
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  if (body) dialog.setAttribute("aria-describedby", `${id}-body`);

  const panel = document.createElement("div");
  panel.className = "rp-dialog__panel";

  const header = document.createElement("div");
  header.className = "rp-dialog__header";
  const heading = document.createElement("h2");
  heading.className = "rp-dialog__title";
  heading.id = `${id}-title`;
  heading.textContent = title;
  header.appendChild(heading);
  panel.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "rp-dialog__body";
  if (body) {
    const paragraph = document.createElement("p");
    paragraph.id = `${id}-body`;
    paragraph.textContent = body;
    bodyEl.appendChild(paragraph);
  }
  panel.appendChild(bodyEl);

  const footer = document.createElement("div");
  footer.className = "rp-dialog__footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "rp-btn rp-btn--ghost";
  cancel.dataset.role = "cancel";
  cancel.textContent = cancelLabel || "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = `rp-btn ${tone === "danger" ? "rp-btn--danger" : "rp-btn--primary"}`;
  confirm.dataset.role = "confirm";
  confirm.textContent = confirmLabel || "Confirm";
  footer.append(cancel, confirm);
  panel.appendChild(footer);

  dialog.appendChild(panel);
  return dialog;
}

/**
 * Asks the user to confirm. Resolves `true` when confirmed and `false` for
 * every other exit. Never rejects, and always removes the dialog from the DOM.
 */
export function confirmAction({
  title = "Are you sure?",
  body = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  trigger = null,
  initialFocus = "confirm",
} = {}) {
  return new Promise((resolve) => {
    const dialog = buildDialog({ title, body, confirmLabel, cancelLabel, tone });
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve(value);
    };

    dialog.querySelector('[data-role="confirm"]').addEventListener("click", () => finish(true));
    dialog.querySelector('[data-role="cancel"]').addEventListener("click", () => finish(false));

    const focusTarget = initialFocus === "cancel"
      ? dialog.querySelector('[data-role="cancel"]')
      : dialog.querySelector('[data-role="confirm"]');

    openModal({
      element: dialog,
      trigger: trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
      initialFocus: focusTarget,
      onClose: () => finish(false),
    });
  });
}

/**
 * Offers an undo window for a reversible action. Resolves `true` when the user
 * presses Undo, `false` when the window closes. `host` is a toast host from
 * `createToastHost`; pass the page host so the region is shared.
 */
export function runWithUndo({ message, undo, timeout = 8000, host } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const show = host?.toast || (() => () => {});
    const dismiss = show(message, {
      tone: "info",
      duration: timeout,
      action: {
        label: "Undo",
        onSelect: () => {
          try {
            undo?.();
          } finally {
            finish(true);
          }
        },
      },
    });
    // The toast host removes the node after `timeout`; mirror that window so
    // the promise settles either way.
    setTimeout(() => {
      void dismiss;
      finish(false);
    }, timeout);
  });
}

/**
 * Confirm-then-run for irreversible deletes. Resolves `true` when the action
 * ran, `false` when the user cancelled. A thrown operation is reported through
 * `onError` (a toast by default) and resolves `false`.
 */
export async function confirmDelete({ what = "this item", detail = "", onConfirm, onError } = {}) {
  const ok = await confirmAction({
    title: `Delete ${what}?`,
    body: detail || "This cannot be undone.",
    confirmLabel: "Delete",
    tone: "danger",
    initialFocus: "cancel",
  });
  if (!ok) return false;
  try {
    await onConfirm?.();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
