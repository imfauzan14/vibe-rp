// The Choice Mode panel: the VN-style interaction layer that sits between the
// reading well and the composer dock.
//
// Contract
//   - Purely presentational. It renders a view model and reports intent through
//     callbacks; it owns no session, no request, and no persistence.
//   - Choice text comes from the model, so every choice is built as a real
//     <button> with a text node child. Model text can never become markup.
//   - One panel per page, reused across states. `render(state)` reconciles in
//     place, so focus is only moved deliberately, never by a rebuild.
//
// `render` takes:
//   {
//     mode:     "normal" | "choice",
//     status:   "idle" | "generating" | "ready" | "error" | "submitting",
//     choices:  [{ id, text }],
//     error:    string | null,
//     selectedId: string | null,
//   }
//
// Callbacks: onSelect(id), onRegenerate(), onManual(), onRetry().

import { el } from "../dom.js";

const CHOICE_LABELS = ["1", "2", "3", "4", "5"];

/** True when the event target is a field the reader is typing into. */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.isContentEditable);
}

export function createChoicePanel({
  mount,
  onSelect = () => {},
  onRegenerate = () => {},
  onManual = () => {},
  onRetry = () => {},
  autoFocus = () => true,
} = {}) {
  if (!mount) throw new Error("createChoicePanel needs a mount element");

  let state = { mode: "normal", status: "idle", choices: [], error: null, selectedId: null };
  let lastStatus = "idle";
  let isCollapsed = false;

  const header = el("div", { class: "rp-choices__header" });
  const heading = el("h2", { class: "rp-choices__title", id: "choice-title", text: "What do you do?" });
  const collapseBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm rp-choices__collapse-btn",
    attrs: {
      "aria-expanded": "true",
      "aria-controls": "choice-body",
      title: "Collapse choices to view story",
    },
    text: "Collapse",
  });
  header.append(heading, collapseBtn);

  // A quiet live region: the reader hears that choices arrived, and that a turn
  // started, without the panel taking over the reading flow.
  const status = el("p", {
    class: "visually-hidden",
    attrs: { role: "status", "aria-live": "polite" },
  });
  const list = el("div", { class: "rp-choices__list", attrs: { role: "group" } });
  const notice = el("p", { class: "rp-choices__notice" });
  const actions = el("div", { class: "rp-choices__actions" });
  const retryBtn = el("button", { type: "button", class: "rp-btn rp-btn--secondary rp-btn--sm", text: "Retry" });
  const otherBtn = el("button", { type: "button", class: "rp-btn rp-btn--ghost rp-btn--sm", text: "Other…" });
  const regenBtn = el("button", { type: "button", class: "rp-btn rp-btn--ghost rp-btn--sm", text: "Regenerate choices" });
  actions.append(retryBtn, otherBtn, regenBtn);

  const body = el("div", { class: "rp-choices__body", id: "choice-body" });
  body.append(status, notice, list, actions);

  mount.append(header, body);

  function setCollapsed(next) {
    isCollapsed = Boolean(next);
    mount.dataset.collapsed = isCollapsed ? "true" : "false";
    body.hidden = isCollapsed;
    collapseBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    collapseBtn.textContent = isCollapsed
      ? (state.choices.length > 0 ? `Show choices (${state.choices.length})` : "Show choices")
      : "Collapse";
    collapseBtn.title = isCollapsed ? "Expand choices" : "Collapse choices to view story";
  }

  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setCollapsed(!isCollapsed);
  });

  header.addEventListener("click", () => {
    if (isCollapsed) setCollapsed(false);
  });

  retryBtn.addEventListener("click", () => onRetry());
  otherBtn.addEventListener("click", () => onManual());
  regenBtn.addEventListener("click", () => onRegenerate());

  // Buttons are rebuilt per set, so selection is delegated to the list.
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-choice-id]");
    if (!btn || btn.disabled) return;
    onSelect(btn.getAttribute("data-choice-id"));
  });

  /** Numeric shortcuts, only while choices wait and no field has focus. */
  function onKeydown(event) {
    if (state.mode !== "choice" || state.status !== "ready") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setCollapsed(!isCollapsed);
      return;
    }
    if (isCollapsed) return;
    const index = CHOICE_LABELS.indexOf(event.key);
    if (index === -1 || index >= state.choices.length) return;
    event.preventDefault();
    onSelect(state.choices[index].id);
  }
  document.addEventListener("keydown", onKeydown);

  function buildChoice(choice, index, { disabled, selected }) {
    const btn = el("button", {
      type: "button",
      class: "rp-choices__option",
      attrs: { "data-choice-id": choice.id, "aria-disabled": disabled ? "true" : null },
    });
    // The number key is a quiet affordance, hidden from the accessible name so
    // the button reads as the action itself.
    btn.append(
      el("span", { class: "rp-choices__key rp-tnum", attrs: { "aria-hidden": "true" }, text: CHOICE_LABELS[index] ?? "" }),
      // Model text as a text node: it can never become markup.
      el("span", { class: "rp-choices__text", text: choice.text })
    );
    if (disabled) btn.disabled = true;
    if (selected) btn.classList.add("is-selected");
    return btn;
  }

  function renderList() {
    // Disabled in every state but `ready`: a choice is clickable only while the
    // menu is live, so a stale or in-flight set can never be submitted.
    const disabled = state.status !== "ready";
    list.replaceChildren(
      ...state.choices.map((choice, index) =>
        buildChoice(choice, index, { disabled, selected: choice.id === state.selectedId })
      )
    );
  }

  /**
   * Applies a view model. Returns `{ focusTarget }` so the caller can decide
   * whether focus actually moves (it must not steal focus from a typing reader).
   */
  function render(next) {
    state = { ...state, ...next };
    // Visible while Choice Mode is on and there is something to say: generating,
    // a ready menu, an error, or a submitted pick. An idle machine in Choice
    // Mode (the escape hatch just used, or a scene with no assistant turn yet)
    // shows nothing, so the composer is the only next-turn input in view.
    const visible = state.mode === "choice" && state.status !== "idle";
    mount.hidden = !visible;
    mount.dataset.status = state.status;
    if (!visible) {
      list.replaceChildren();
      lastStatus = state.status;
      setCollapsed(false);
      return { focusTarget: null };
    }

    renderList();
    const ready = state.status === "ready";
    const submitting = state.status === "submitting";

    // The status line: one sentence, describing the state, never the outcome.
    notice.hidden = false;
    if (state.status === "generating") notice.textContent = "Generating choices…";
    else if (state.status === "submitting") notice.textContent = "Continuing the scene…";
    else if (state.status === "error") notice.textContent = state.error || "Couldn't generate choices.";
    else notice.textContent = "";

    retryBtn.hidden = state.status !== "error";
    regenBtn.hidden = !ready;
    regenBtn.disabled = !ready;
    otherBtn.hidden = submitting;

    const arrived = ready && lastStatus !== "ready";
    const entering = submitting && lastStatus !== "submitting";
    lastStatus = state.status;

    if (arrived) {
      setCollapsed(false);
    } else {
      setCollapsed(isCollapsed);
    }

    if (state.status === "generating") status.textContent = "Generating choices.";
    else if (ready) status.textContent = `${state.choices.length} choices available.`;
    else if (submitting) status.textContent = "Choice selected. Writing the next reply.";
    else if (state.status === "error") status.textContent = notice.textContent;

    // Focus only on a real transition, and only when the caller allows it, so a
    // reader typing in the composer is never interrupted.
    if (arrived && autoFocus()) {
      return { focusTarget: isCollapsed ? collapseBtn : (list.querySelector("button") || heading) };
    }
    if (entering) return { focusTarget: mount };
    return { focusTarget: null };
  }

  return {
    render,
    /** Moves focus to the first choice when one exists, else the heading. */
    focus: () => {
      const target = isCollapsed ? collapseBtn : (list.querySelector("button") || heading);
      target?.focus?.();
    },
    get element() {
      return mount;
    },
    get status() {
      return state.status;
    },
    get isCollapsed() {
      return isCollapsed;
    },
    setCollapsed,
    destroy() {
      document.removeEventListener("keydown", onKeydown);
      mount.replaceChildren();
    },
  };
}
