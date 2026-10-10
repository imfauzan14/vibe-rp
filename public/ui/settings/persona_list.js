// Persona list: the saved author identities inside Settings.
//
// Contract
//   - `mountPersonaList(root, options)` renders and maintains the persona
//     rows inside `root` (an empty container). Options:
//       load()            -> Promise<persona[]>  (injected storage)
//       onEdit(persona)   -> open the editor
//       onCreate()        -> open the editor for a new persona
//       onDelete(persona) -> Promise, called after the caller confirmed
//       onSetDefault(persona) -> Promise
//       host              -> optional toast host
//   - `refresh()` reloads from `load()` and re-renders keyed by persona id, so
//     rows are reused rather than rebuilt. `destroy()` clears the container.
//   - Every value is rendered as text; avatars go through `img.src` only when
//     the string is a data or http URL.
//
// Exports
//   mountPersonaList(root, options) -> { refresh, destroy }

import { el } from "../dom.js";
import { mountPresetList } from "./preset_list.js";

function avatarUrl(persona) {
  const value = String(persona.avatar || "");
  return value.startsWith("data:") || value.startsWith("http") ? value : "";
}

function buildRow(persona, handlers, existing) {
  const row = existing || el("article", { class: "rp-panel rp-persona-row" });
  row.replaceChildren();

  const image = avatarUrl(persona);
  const media = el("div", { class: "rp-avatar rp-avatar--lg" });
  if (image) {
    const img = el("img", { alt: "", src: image });
    media.appendChild(img);
  } else {
    const letter = (persona.name || "U").trim().charAt(0).toUpperCase() || "U";
    media.appendChild(el("span", { class: "rp-avatar__initials", text: letter }));
  }

  const heading = el("div", { class: "rp-persona-row__heading" }, [
    el("h3", { class: "rp-persona-row__title", text: persona.name || "Unnamed persona" }),
    persona.isDefault ? el("span", { class: "rp-badge rp-badge--annotation", text: "Default" }) : null,
  ]);

  const blurb = el("p", {
    class: "rp-persona-row__blurb",
    text: persona.description || persona.template || "No bio or roleplay prompt recorded.",
  });

  const actions = el("div", { class: "rp-persona-row__actions" }, [
    persona.isDefault
      ? null
      : el("button", {
          type: "button",
          class: "rp-btn rp-btn--ghost rp-btn--sm",
          text: "Set default",
          attrs: { "data-action": "default" },
          onclick: () => handlers.onSetDefault(persona),
        }),
    el("button", {
      type: "button",
      class: "rp-btn rp-btn--ghost rp-btn--sm",
      text: "Edit",
      attrs: { "data-action": "edit" },
      onclick: () => handlers.onEdit(persona),
    }),
    persona.isDefault
      ? null
      : el("button", {
          type: "button",
          class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
          text: "Delete",
          attrs: { "data-action": "delete" },
          onclick: () => handlers.onDelete(persona),
        }),
  ]);

  row.append(
    el("div", { class: "rp-persona-row__identity" }, [media, heading]),
    blurb,
    actions
  );
  return row;
}

export function mountPersonaList(root, options = {}) {
  return mountPresetList(root, {
    ...options,
    listClass: "rp-persona-list",
    emptyTitle: "No personas yet",
    emptyBody: "A persona is the voice you write in. Create one to be recognised across chats.",
    deleteToast: (persona) => `Persona "${persona.name}" deleted.`,
    buildRow,
  });
}
