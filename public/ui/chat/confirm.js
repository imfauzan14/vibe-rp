// Non-blocking confirmation.
//
// CONVERGENCE NOTE: `public/ui/confirm.js` is the shared module, but this file
// is NOT a drop-in duplicate of it — do not swap the import blindly:
//   - Its confirmAction renders `.rp-dialog__body` with a bare <p> and a
//     `rp-btn--ghost` cancel; this one renders `.rp-dialog__desc` (text-xs,
//     ink-faint) and a `rp-btn--secondary` cancel, so a swap changes the
//     dialog's type size, colour and button fill.
//   - Its runWithUndo takes a `host` (createToastHost) and passes
//     `{ action: { label, onSelect } }`; this one takes a `notifier` and passes
//     `{ actionLabel, onAction, persist }`. The notifier adapter ignores
//     `action`, so handing it a host-shaped option would drop the Undo button.
// Both divergences are documented, not silently reconciled.
//
// Two patterns:
//   confirmAction: a modal question for a destructive, irreversible act. It
//     runs on the shared modal controller (public/ui/modal.js), so Escape, the
//     focus trap and a backdrop click all dismiss it; a backdrop click counts
//     as Cancel (resolves false), matching every other dialog in the app.
//   runWithUndo:   perform immediately, offer Undo in a toast for a window.
//
// Both are keyboard accessible and announced through a live region.

import { openModal, closeModal } from "../modal.js";

let dialogSeq = 0;

/**
 * Asks a question in a native <dialog>. Focus trapping, Escape and a backdrop
 * click are the shared controller's job (public/ui/modal.js). Resolves true
 * when confirmed, false otherwise.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.body]
 * @param {string} [args.confirmLabel]
 * @param {string} [args.cancelLabel]
 * @param {"default"|"danger"} [args.tone]
 */
export function confirmAction({
  title,
  body = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
} = {}) {
  return new Promise((resolve) => {
    const id = `rp-confirm-${++dialogSeq}`;
    const dialog = document.createElement("dialog");
    dialog.className = "rp-dialog";
    dialog.id = id;
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    if (body) dialog.setAttribute("aria-describedby", `${id}-body`);
    dialog.innerHTML = `
      <form method="dialog" class="rp-dialog__panel">
        <div class="rp-dialog__header">
          <div>
            <h2 class="rp-dialog__title" id="${id}-title"></h2>
            ${body ? `<p class="rp-dialog__desc" id="${id}-body"></p>` : ""}
          </div>
        </div>
        <div class="rp-dialog__footer">
          <button type="submit" value="cancel" class="rp-btn rp-btn--secondary" data-cancel></button>
          <button type="submit" value="confirm" class="rp-btn ${tone === "danger" ? "rp-btn--danger" : "rp-btn--primary"}" data-confirm></button>
        </div>
      </form>`;
    dialog.querySelector(".rp-dialog__title").textContent = title;
    if (body) dialog.querySelector(".rp-dialog__desc").textContent = body;
    dialog.querySelector("[data-confirm]").textContent = confirmLabel;
    dialog.querySelector("[data-cancel]").textContent = cancelLabel;

    document.body.appendChild(dialog);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve(result);
    };
    // The shared controller owns showModal, focus, Escape and the backdrop.
    // Submitting the form closes natively, which `close` reports with the
    // pressed button's value.
    dialog.addEventListener("close", () => finish(dialog.returnValue === "confirm"));
    openModal({
      element: dialog,
      initialFocus: dialog.querySelector("[data-cancel]"),
      onClose: () => finish(false),
    });
  });
}

/**
 * Runs an action immediately and offers Undo through the notifier.
 * `undo` is called when the reader presses Undo; `commit` when the window
 * closes without one, if the caller needs a deferred commit.
 *
 * ONE clock: the toast's lifetime IS the undo window. The toast host owns the
 * timer, so there is no second `setTimeout` that could fire after the toast
 * has gone, and the Undo control can never outlive the commit it precedes.
 * An action toast also carries no generic close control (see ui/toast.js), so
 * the only exits are pressing Undo or letting the window close.
 *
 * @param {object} args
 * @param {object} args.notifier   from createNotifier()
 * @param {string} args.message    what was done, in the past tense
 * @param {() => void|Promise<void>} args.undo
 * @param {() => void|Promise<void>} [args.commit]
 * @param {number} [args.timeout]  the undo window, in ms
 */
export const UNDO_WINDOW_MS = 6000;

export function runWithUndo({
  notifier,
  message,
  undo,
  commit = null,
  timeout = UNDO_WINDOW_MS,
}) {
  let undone = false;
  const handle = notifier.toast(message, {
    tone: "info",
    actionLabel: "Undo",
    // The window the reader sees is exactly the window the caller asked for.
    duration: timeout,
    onAction: async () => {
      undone = true;
      try {
        await undo();
      } catch (err) {
        notifier.toast(`Could not undo: ${err.message}`, { tone: "error" });
      }
    },
    // Fires once, only when the window closes the toast. Pressing Undo removes
    // the toast without expiring it, so the commit can never follow an undo.
    onExpire: async () => {
      if (undone) return;
      try {
        await commit?.();
      } catch (err) {
        notifier.toast(`Could not finish: ${err.message}`, { tone: "error" });
      }
    },
  });
  return {
    get undone() {
      return undone;
    },
    settle() {
      handle?.dismiss?.();
    },
  };
}
