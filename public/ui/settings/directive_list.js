// Directive list: the saved craft contracts inside Settings.
//
// Contract
//   - `mountDirectiveList(root, options)` mirrors the persona list for
//     directives (system prompts). Options:
//       load()                -> Promise<directive[]>
//       onEdit(directive)     -> open the editor
//       onCreate()            -> open the editor for a new directive
//       onDelete(directive)   -> Promise, called after the caller confirmed
//       onSetDefault(directive) -> Promise
//       host                  -> optional toast host
//   - Rows are keyed by directive id and reused across refreshes.
//
// Exports
//   mountDirectiveList(root, options) -> { refresh, destroy }

import { el, renderKeyed } from "../dom.js";

function preview(directive) {
  const text = String(directive.description || directive.content || "").trim();
  if (!text) return "No description recorded.";
  return text.length > 140 ? `${text.slice(0, 140).trimEnd()}...` : text;
}

function buildRow(directive, handlers, existing) {
  const row = existing || el("article", { class: "rp-panel rp-directive-row" });
  row.replaceChildren();

  const heading = el("div", { class: "rp-directive-row__heading" }, [
    el("h3", { class: "rp-directive-row__title", text: directive.name || "Unnamed prompt" }),
    directive.isDefault ? el("span", { class: "rp-badge rp-badge--annotation", text: "Default" }) : null,
  ]);

  const blurb = el("p", { class: "rp-directive-row__blurb", text: preview(directive) });

  const actions = el("div", { class: "rp-directive-row__actions" }, [
    directive.isDefault
      ? null
      : el("button", {
          type: "button",
          class: "rp-btn rp-btn--ghost rp-btn--sm",
          text: "Set default",
          onclick: () => handlers.onSetDefault(directive),
        }),
    el("button", {
      type: "button",
      class: "rp-btn rp-btn--ghost rp-btn--sm",
      text: "Edit",
      onclick: () => handlers.onEdit(directive),
    }),
    directive.isDefault
      ? null
      : el("button", {
          type: "button",
          class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
          text: "Delete",
          onclick: () => handlers.onDelete(directive),
        }),
  ]);

  row.append(heading, blurb, actions);
  return row;
}

export function mountDirectiveList(root, options = {}) {
  const { load, onEdit, onCreate, onDelete, onSetDefault, host } = options;
  if (!root) return { refresh: async () => {}, destroy: () => {} };

  const list = el("div", { class: "rp-directive-list" });
  root.replaceChildren(list);

  const handlers = {
    onEdit: (directive) => onEdit?.(directive),
    onSetDefault: async (directive) => {
      await onSetDefault?.(directive);
      await refresh();
    },
    onDelete: async (directive) => {
      const removed = await onDelete?.(directive);
      if (removed === false) return;
      host?.toast?.(`Prompt "${directive.name}" deleted.`, { tone: "info" });
      await refresh();
    },
  };

  async function refresh() {
    const directives = (await load?.()) || [];
    if (directives.length === 0) {
      list.replaceChildren(
        el("div", { class: "rp-empty" }, [
          el("p", { class: "rp-empty__title", text: "No system prompts yet" }),
          el("p", {
            class: "rp-empty__body",
            text: "The system prompt is the craft contract every reply obeys. Create one to set the voice.",
          }),
        ])
      );
      return;
    }
    renderKeyed(
      list,
      directives,
      (directive) => directive.id,
      (directive, existing) => buildRow(directive, handlers, existing)
    );
  }

  const createBtn = options.createButton;
  if (createBtn) createBtn.addEventListener("click", () => onCreate?.());

  return {
    refresh,
    destroy() {
      root.replaceChildren();
    },
  };
}
