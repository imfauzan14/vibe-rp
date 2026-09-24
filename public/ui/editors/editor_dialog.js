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

    let busy = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve();
    };

    dialog.querySelector('[data-role="close"]').addEventListener("click", finish);
    dialog.querySelector('[data-role="cancel"]').addEventListener("click", finish);

    dialog.querySelector('[data-role="save"]').addEventListener("click", async () => {
      if (busy) return;
      const name = nameInput.value.trim();
      if (!name) {
        error.hidden = false;
        error.textContent = requiredMessage;
        nameInput.classList.add("is-invalid");
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
      }
      nameInput.classList.remove("is-invalid");
      nameInput.removeAttribute("aria-invalid");
      busy = true;
      try {
        await onSave?.(buildPayload(name));
        host?.toast?.(successToast(name), { tone: "success" });
        finish();
      } catch (err) {
        error.hidden = false;
        error.textContent = `${errorPrefix}: ${err.message}`;
      } finally {
        busy = false;
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      dialog.querySelector('[data-role="save"]').click();
    });

    openModal({ element: dialog, onClose: finish, initialFocus: initialFocus || nameInput });
  });
}