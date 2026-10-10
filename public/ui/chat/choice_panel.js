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

const isMobileViewport = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 720px)").matches;

export function createChoicePanel({
  mount,
  onSelect = () => {},
  onRegenerate = () => {},
  onRetry = () => {},
  autoFocus = () => true,
} = {}) {
  if (!mount) throw new Error("createChoicePanel needs a mount element");

  let state = { mode: "normal", status: "idle", choices: [], error: null, selectedId: null };
  let lastStatus = "idle";
  let isCollapsed = false;
  // The steer intent that has been handed to the caller but whose menu has not
  // settled yet. It exists so the field can be emptied the moment the intent is
  // consumed: the panel is built once per page and reused for every later menu,
  // so a value left in the field came back on the next Steer… and had to be
  // deleted by hand every time. A menu that *failed* has consumed nothing, so
  // the intent goes back into the field instead of being lost with the error.
  let pendingSteer = null;

  const header = el("div", { class: "rp-choices__header" });
  const heading = el("h2", { class: "rp-choices__title", id: "choice-title", text: "Next moves" });
  const badge = el("span", { class: "rp-choices__badge" });
  const headTitleWrap = el("div", { class: "rp-choices__header-title" }, [heading, badge]);
  const collapseBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm rp-choices__collapse-btn",
    attrs: {
      "aria-expanded": "true",
      "aria-controls": "choice-body",
      title: "Hide the choices to read the story",
    },
    // Names what it hides. "Collapse" described the layout rather than the
    // choices, which mattered when this was also the only way back to the
    // composer; it is still the clearer label either way.
    text: "Hide choices",
  });
  header.append(headTitleWrap, collapseBtn);

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
  const regenBtn = el("button", { type: "button", class: "rp-btn rp-btn--ghost rp-btn--sm", text: "Regenerate choices" });
  const steerToggleBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm rp-choices__steer-toggle",
    text: "Steer…",
    title: "Guide choices toward an intended action",
  });
  actions.append(retryBtn, regenBtn, steerToggleBtn);

  const steerBar = el("div", {
    class: "rp-choices__steer-bar",
    attrs: { hidden: "true" },
  });
  const steerInput = el("input", {
    type: "text",
    class: "rp-input rp-input--sm rp-choices__steer-input",
    placeholder: "Guide direction (e.g. attempt to negotiate, draw weapon)…",
    attrs: { maxlength: "120", "aria-label": "Steer choice direction" },
  });
  const steerSubmitBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--primary rp-btn--sm rp-choices__steer-submit",
    text: "Guide",
  });
  const steerCancelBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm rp-choices__steer-cancel",
    text: "Cancel",
  });
  steerBar.append(steerInput, steerSubmitBtn, steerCancelBtn);

  const body = el("div", { class: "rp-choices__body", id: "choice-body" });
  body.append(status, notice, list, actions, steerBar);

  mount.append(header, body);

  function updateBadge() {
    badge.className = "rp-choices__badge";
    if (state.status === "generating") {
      badge.classList.add("is-generating");
      // Only display the badge in the header when collapsed; when expanded,
      // the body notice ("Generating choices…") is the single clear indicator.
      badge.textContent = isCollapsed ? "Generating…" : "";
    } else if (state.status === "ready") {
      badge.classList.add("is-ready");
      badge.textContent = `${state.choices.length} ready`;
    } else if (state.status === "submitting") {
      badge.classList.add("is-submitting");
      badge.textContent = "Writing reply…";
    } else if (state.status === "error") {
      badge.classList.add("is-error");
      badge.textContent = "Failed";
    } else {
      badge.textContent = "";
    }
  }

  function setCollapsed(next) {
    isCollapsed = Boolean(next);
    mount.dataset.collapsed = isCollapsed ? "true" : "false";
    body.hidden = isCollapsed;
    collapseBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    updateBadge();

    if (isCollapsed) {
      if (state.status === "generating") {
        collapseBtn.textContent = "Generating…";
        collapseBtn.title = "Choices are generating";
      } else if (state.status === "ready") {
        const count = state.choices.length;
        collapseBtn.textContent = count > 0 ? `Show choices (${count})` : "Show choices";
        collapseBtn.title = "Expand choices to select an action";
      } else if (state.status === "submitting") {
        collapseBtn.textContent = "Writing…";
        collapseBtn.title = "Writing reply";
      } else if (state.status === "error") {
        collapseBtn.textContent = "Review error";
        collapseBtn.title = "Expand choices to see error and retry";
      } else {
        collapseBtn.textContent = "Show choices";
        collapseBtn.title = "Expand choices";
      }
    } else {
      collapseBtn.textContent = "Hide choices";
      collapseBtn.title = "Hide the choices to read the story";
    }
  }

  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setCollapsed(!isCollapsed);
  });

  header.addEventListener("click", () => {
    if (isCollapsed) setCollapsed(false);
  });

  retryBtn.addEventListener("click", () => onRetry());
  regenBtn.addEventListener("click", () => onRegenerate());

  steerToggleBtn.addEventListener("click", () => {
    steerBar.hidden = !steerBar.hidden;
    if (!steerBar.hidden) steerInput.focus();
  });

  const submitSteer = () => {
    const val = steerInput.value.trim();
    if (!val) return;
    // Handed over, so the field is emptied here rather than left behind for the
    // next menu to inherit. `pendingSteer` remembers it only so a failure can
    // give it back; a menu that arrives clears it (see `render`).
    pendingSteer = val;
    steerInput.value = "";
    steerBar.hidden = true;
    onRegenerate(val);
  };

  steerSubmitBtn.addEventListener("click", submitSteer);
  steerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitSteer();
    } else if (e.key === "Escape") {
      e.preventDefault();
      steerBar.hidden = true;
    }
  });

  steerCancelBtn.addEventListener("click", () => {
    steerBar.hidden = true;
  });

  // Buttons are rebuilt per set, so selection is delegated to the list.
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-choice-id]");
    if (!btn || btn.disabled) return;
    setCollapsed(true);
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
    const keyEl = el("span", { class: "rp-choices__key rp-tnum", attrs: { "aria-hidden": "true" }, text: CHOICE_LABELS[index] ?? "" });
    const textEl = el("span", { class: "rp-choices__text", text: choice.text && choice.label ? choice.label : choice.text });
    btn.append(keyEl, textEl);
    if (choice.type === "continuation" || choice.type === "story" || choice.type === "narrative") {
      const kindBadge = el("span", {
        class: "rp-badge rp-badge--ghost",
        attrs: { "aria-hidden": "true" },
        text: "Story",
      });
      kindBadge.style.cssText = "font-size: var(--text-2xs); margin-left: auto; align-self: center; opacity: 0.75;";
      btn.append(kindBadge);
    }
    if (disabled) btn.disabled = true;
    if (selected) btn.classList.add("is-selected");
    return btn;
  }

  function renderList() {
    if (state.status === "generating") {
      const skeletons = [1, 2, 3].map(() =>
        el("div", { class: "rp-choice-skeleton", attrs: { "aria-hidden": "true" } })
      );
      list.replaceChildren(...skeletons);
      return;
    }
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
    // Adapt heading if scene indicates continuation rather than player action
    if (state.heading) {
      heading.textContent = state.heading;
    } else if (state.isContinuation) {
      heading.textContent = "What happens next?";
    } else {
      heading.textContent = "Next moves";
    }

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

    // A submitted intent is settled by the menu that follows it: a menu that
    // arrived has consumed it, and a menu that failed has not — so the latter
    // puts the reader's words back in the field rather than making them retype
    // what the error cost them. A draft that was never submitted is left alone
    // (Cancel is "never mind", not "discard"), which is why this is gated on a
    // pending intent rather than clearing the field on every render.
    if (pendingSteer !== null && ready) {
      pendingSteer = null;
    } else if (pendingSteer !== null && state.status === "error") {
      steerInput.value = pendingSteer;
      pendingSteer = null;
    }

    // The steer control belongs to any settled menu, a failed one included: the
    // reader needs it precisely when the last attempt did not work. It is
    // hidden only while a request is in flight, where a second intent would
    // supersede the one already being generated.
    const steerable = ready || state.status === "error";
    retryBtn.hidden = state.status !== "error";
    regenBtn.hidden = !ready;
    regenBtn.disabled = !ready;
    steerToggleBtn.hidden = !steerable;
    steerToggleBtn.disabled = !steerable;
    if (!steerable) steerBar.hidden = true;

    const arrived = ready && lastStatus !== "ready";
    const entering = submitting && lastStatus !== "submitting";
    lastStatus = state.status;

    if (arrived) {
      setCollapsed(isMobileViewport());
    } else if (submitting) {
      setCollapsed(true);
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
      return { focusTarget: isCollapsed ? null : (list.querySelector("button") || heading) };
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
