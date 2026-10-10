// Shared editor dialog shell: the `.rp-dialog` skeleton, header, footer and
// close/cancel/save/submit wiring used by the persona and directive editors.
// Each editor supplies its own form body, required-field message and payload;
// everything else (busy guard, invalid-field marking, async save, toast,
// close-on-success) is identical and lives here once.
import { el } from "../dom.js";
import { openModal, closeModal } from "../modal.js";

export function openEditorDialog({
  titleId,
  title,
  description,
  closeLabel,
  saveLabel,
  form,
  error,
  nameInput,
  requiredMessage,
  buildPayload,
  successToast,
  errorPrefix,
  onSave,
  host,
  onDialog = null,
  initialFocus = null,
}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", { class: "rp-dialog", attrs: { "aria-labelledby": titleId } }, [
      el("div", { class: "rp-dialog__panel" }, [
        el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
        el("header", { class: "rp-dialog__header" }, [
          el("div", {}, [
            el("h2", { class: "rp-dialog__title", id: titleId, text: title }),
            el("p", { class: "rp-dialog__desc", text: description }),
          ]),
          el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
            text: "\u00d7",
            attrs: { "aria-label": closeLabel, "data-role": "close" },
          }),
        ]),
        form,
        el("footer", { class: "rp-dialog__footer" }, [
          el("button", { type: "button", class: "rp-btn rp-btn--ghost", text: "Cancel", attrs: { "data-role": "cancel" } }),
          el("button", { type: "button", class: "rp-btn rp-btn--primary", text: saveLabel, attrs: { "data-role": "save" } }),
        ]),
      ]),
    ]);

    document.body.appendChild(dialog);
    onDialog?.(dialog);

    // The error element carries its role from the start, so it is already a
    // live region by the time any text lands in it — an element that only
    // becomes an alert as it is filled is not reliably announced. The field
    // points at it, so tabbing back to the name reads the reason.
    const errorId = `${titleId}-error`;
    error.id = errorId;
    error.setAttribute("role", "alert");
    nameInput.setAttribute("aria-describedby", errorId);

    let busy = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve();
    };

    function showError(text) {
      error.hidden = false;
      error.textContent = text;
    }

    function clearError() {
      error.hidden = true;
      error.textContent = "";
    }

    // A corrected field should not keep its old complaint on screen.
    nameInput.addEventListener("input", () => {
      if (error.hidden) return;
      clearError();
      nameInput.classList.remove("is-invalid");
      nameInput.removeAttribute("aria-invalid");
    });

    const saveBtn = dialog.querySelector('[data-role="save"]');

    dialog.querySelector('[data-role="close"]').addEventListener("click", finish);
    dialog.querySelector('[data-role="cancel"]').addEventListener("click", finish);

    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      const name = nameInput.value.trim();
      if (!name) {
        showError(requiredMessage);
        nameInput.classList.add("is-invalid");
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
      }
      nameInput.classList.remove("is-invalid");
      nameInput.removeAttribute("aria-invalid");
      busy = true;
      // A save that takes a moment used to look like a button that did nothing.
      saveBtn.disabled = true;
      saveBtn.setAttribute("aria-busy", "true");
      try {
        await onSave?.(buildPayload(name));
        host?.toast?.(successToast(name), { tone: "success" });
        finish();
      } catch (err) {
        showError(`${errorPrefix}: ${err.message}`);
      } finally {
        busy = false;
        saveBtn.disabled = false;
        saveBtn.removeAttribute("aria-busy");
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      dialog.querySelector('[data-role="save"]').click();
    });

    openModal({ element: dialog, onClose: finish, initialFocus: initialFocus || nameInput });
  });
}