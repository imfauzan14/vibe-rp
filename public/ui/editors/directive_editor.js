// Directive editor: create or edit a craft contract (system prompt).
//
// Contract
//   - `openDirectiveEditor({ directive, onSave, host })` opens a `.rp-dialog`
//     with a name, a summary and the contract body. `directive` is the record
//     to edit, or null to create.
//   - `onSave(payload)` receives `{ id, name, description, content }` and may
//     be async. The dialog closes only after it resolves.
//   - Returns a Promise that resolves when the dialog closes.
//
// Exports
//   openDirectiveEditor(options) -> Promise<void>

import { el } from "../dom.js";
import { openModal, closeModal } from "../modal.js";

export function openDirectiveEditor({ directive = null, onSave, host } = {}) {
  return new Promise((resolve) => {
    let busy = false;

    const nameInput = el("input", {
      id: "rp-directive-name",
      class: "rp-input",
      type: "text",
      maxlength: 80,
      value: directive?.name || "",
      placeholder: "e.g. AGENTS.md contract",
      attrs: { required: "" },
    });

    const descInput = el("input", {
      id: "rp-directive-desc",
      class: "rp-input",
      type: "text",
      maxlength: 200,
      value: directive?.description || "",
      placeholder: "e.g. Third person limited, anti-slop rules",
    });

    const contentInput = el("textarea", {
      id: "rp-directive-content",
      class: "rp-textarea rp-textarea--mono",
      rows: 10,
      value: directive?.content || "",
      placeholder: "System prompt instructions, bans and formatting rules.",
      attrs: { required: "" },
    });

    const error = el("p", { class: "rp-error", hidden: true });

    const form = el("form", { class: "rp-dialog__body", attrs: { novalidate: "" } }, [
      el("div", { class: "rp-directive-editor__row" }, [
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", for: "rp-directive-name", text: "Prompt name" }),
          nameInput,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", for: "rp-directive-desc", text: "Summary or purpose" }),
          descInput,
        ]),
      ]),
      el("div", { class: "rp-field" }, [
        el("label", { class: "rp-label", for: "rp-directive-content", text: "Contract content" }),
        contentInput,
      ]),
      error,
    ]);

    const dialog = el("dialog", { class: "rp-dialog", attrs: { "aria-labelledby": "rp-directive-editor-title" } }, [
      el("div", { class: "rp-dialog__panel" }, [
        el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
        el("header", { class: "rp-dialog__header" }, [
          el("div", {}, [
            el("h2", {
              class: "rp-dialog__title",
              id: "rp-directive-editor-title",
              text: directive ? "Edit prompt" : "Create prompt",
            }),
            el("p", { class: "rp-dialog__desc", text: "Contract rules injected into the prompt prefix." }),
          ]),
          el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
            text: "\u00d7",
            attrs: { "aria-label": "Close prompt editor", "data-role": "close" },
          }),
        ]),
        form,
        el("footer", { class: "rp-dialog__footer" }, [
          el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost",
            text: "Cancel",
            attrs: { "data-role": "cancel" },
          }),
          el("button", {
            type: "button",
            class: "rp-btn rp-btn--primary",
            text: directive ? "Save prompt" : "Create prompt",
            attrs: { "data-role": "save" },
          }),
        ]),
      ]),
    ]);

    document.body.appendChild(dialog);

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
        error.textContent = "A directive name is required.";
        nameInput.classList.add("is-invalid");
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
      }
      nameInput.classList.remove("is-invalid");
      nameInput.removeAttribute("aria-invalid");
      busy = true;
      try {
        await onSave?.({
          id: directive?.id || `directive_${Date.now()}`,
          name,
          description: descInput.value.trim(),
          content: contentInput.value,
        });
        host?.toast?.(`Directive "${name}" saved.`, { tone: "success" });
        finish();
      } catch (err) {
        error.hidden = false;
        error.textContent = `Could not save the directive: ${err.message}`;
      } finally {
        busy = false;
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      dialog.querySelector('[data-role="save"]').click();
    });

    openModal({ element: dialog, onClose: finish, initialFocus: nameInput });
  });
}
