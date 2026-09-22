// Detail dialog: one character's profile, its openings and its conversations.
//
// Contract
//   - `openDetailModal(options)` builds and shows a `.rp-dialog` for one card
//     and returns `{ close, refresh, element }`.
//       card      the catalogue record (already `withSessions`-shaped)
//       sessions  that card's sessions, most recent first
//       host      a toast host from createToastHost
//       handlers  {
//         onStartNew(card, opening?)   start a conversation
//         onDeleteCard(card)           after the caller confirmed
//         onChangeAvatar(card)         Promise<dataUrl|""> ; "" removes it
//         onRenameSession(session, title)
//         onDeleteSession(session)     after the caller confirmed
//         onConfirmDelete(kind, label) Promise<boolean> from confirm.js
//       }
//   - The three content tabs use `initTabs`, so arrow keys, Home/End and the
//     aria wiring are the shared implementation, not a local copy.
//   - The history view swaps inside the same dialog; there is never a second
//     dialog stacked on top of the first for it.
//   - Every card string is rendered as text. Nothing from a card becomes
//     markup.
//
// Exports
//   openDetailModal(options) -> { close, refresh, element }
import { el } from "./dom.js";
import { openModal, closeModal } from "./modal.js";
import { initTabs } from "./tabs.js";
import { cardTitle, cardByline, cardTags, cardAvatarUrl, cardInitial } from "./character_card.js";

const FALLBACK_OPENING = "The door closes behind you. Silence settles into the corridor.";

function imageUrl(value) {
  const text = String(value || "");
  return text.startsWith("data:") || text.startsWith("http") ? text : "";
}

function section(title, hint, children) {
  return el("section", { class: "rp-detail__section" }, [
    el("div", { class: "rp-detail__eyebrow" }, [
      el("span", { class: "rp-detail__eyebrow-title", text: title }),
      hint ? el("span", { class: "rp-detail__eyebrow-hint", text: hint }) : null,
    ]),
    ...[].concat(children).filter(Boolean),
  ]);
}

/** A collapsible lore block. */
function dossier(title, content, { mono = false } = {}) {
  const text = String(content ?? "").trim();
  if (!text) return null;
  return el("details", { class: "rp-dossier" }, [
    el("summary", { class: "rp-dossier__summary" }, [
      el("span", { class: "rp-dossier__title", text: title }),
      el("span", { class: "rp-dossier__chevron", attrs: { "aria-hidden": "true" } }),
    ]),
    el("div", { class: `rp-dossier__body${mono ? " rp-dossier__body--mono" : ""}`, text }),
  ]);
}

/** A collapsible opening, with an optional action to start from it. */
function variation(label, text, onStart) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return null;
  const firstLine = cleaned.split("\n")[0];
  const preview = firstLine.length > 65 ? `${firstLine.slice(0, 65)}\u2026` : firstLine;
  const body = [el("p", { class: "rp-variation__text", text: cleaned })];
  if (onStart) {
    const button = el("button", {
      type: "button",
      class: "rp-btn rp-btn--ghost rp-btn--sm",
      text: "Start chat with this opening",
    });
    button.addEventListener("click", () => onStart(cleaned));
    body.push(el("div", { class: "rp-variation__actions" }, [button]));
  }
  return el("details", { class: "rp-variation" }, [
    el("summary", { class: "rp-variation__summary" }, [
      el("span", { class: "rp-badge rp-badge--annotation", text: label }),
      el("span", { class: "rp-variation__preview", text: preview }),
    ]),
    el("div", { class: "rp-variation__body" }, body),
  ]);
}

function formatSampleDialogue(raw, name) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw)
    .replace(/<START>/gi, "")
    .replace(/\{\{char\}\}/gi, name)
    .replace(/\{\{user\}\}/gi, "You")
    .trim();
}

function threadRow(session, card, handlers) {
  const count = session.messages?.length || 0;
  const date = session.updatedAt
    ? new Date(session.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })
    : "";

  const titleBtn = el("button", {
    type: "button",
    class: "rp-thread__title",
    text: session.title || "Chat",
  });
  titleBtn.addEventListener("click", () => startRename(session, titleBtn, handlers));

  // A destructive action is labelled with the word, never a bare glyph: a
  // multiplication sign reads as "close", not "delete this chat". The
  // aria-label still names the target, because "Delete" alone is ambiguous
  // across rows.
  const remove = el("button", {
    type: "button",
    class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
    text: "Delete",
    attrs: { "aria-label": `Delete "${session.title || "chat"}"` },
  });
  remove.addEventListener("click", async () => {
    const ok = await handlers.onConfirmDelete?.("chat", session.title || "this chat");
    if (!ok) return;
    await handlers.onDeleteSession?.(session);
  });

  const resume = el("a", {
    class: "rp-btn rp-btn--primary rp-btn--sm",
    text: "Resume",
    href: `chat.html?cardId=${encodeURIComponent(card.id)}&sessionId=${encodeURIComponent(session.id)}`,
  });

  return el("div", { class: "rp-thread" }, [
    el("div", { class: "rp-thread__identity" }, [
      titleBtn,
      el("p", {
        class: "rp-thread__meta rp-tnum",
        text: `${count} ${count === 1 ? "message" : "messages"}${date ? `, ${date}` : ""}`,
      }),
    ]),
    el("div", { class: "rp-thread__actions" }, [remove, resume]),
  ]);
}

function startRename(session, titleBtn, handlers) {
  const original = session.title || "";
  const input = el("input", {
    type: "text",
    class: "rp-input rp-thread__input",
    value: original,
    maxlength: 80,
    attrs: { "aria-label": "Rename conversation" },
  });
  titleBtn.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const next = (save ? input.value.trim() : original) || "Conversation";
    await handlers.onRenameSession?.(session, next);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

export function openDetailModal({ card, sessions = [], loadSessions = null, handlers = {}, host } = {}) {
  const data = card?.data && typeof card.data === "object" ? card.data : card || {};
  const name = cardTitle(card);

  // Character hero header.
  const portraitInner = el("div", { class: "rp-detail__portrait-inner" });
  const changeAvatar = el("button", {
    type: "button",
    class: "rp-detail__portrait",
    attrs: { "aria-label": `Change the artwork for ${name}` },
  });
  changeAvatar.addEventListener("click", async () => {
    try {
      const next = await handlers.onChangeAvatar?.(card);
      if (next === undefined) return;
      paintPortrait(next);
      host?.toast?.(next ? "Character portrait updated." : "Character portrait removed.", { tone: "success" });
    } catch (error) {
      host?.toast?.(`Could not update the portrait: ${error.message}`, { tone: "danger" });
    }
  });
  // The scrim is a layer over the portrait, not a caption under it: it is
  // absolutely positioned over `.rp-detail__portrait-inner` and revealed by
  // the button's hover/focus state (see library.css). `aria-hidden` because
  // the button's own aria-label already carries the accessible name, so a
  // screen reader must not hear the affordance twice.
  changeAvatar.appendChild(portraitInner);
  changeAvatar.appendChild(
    el("span", { class: "rp-detail__portrait-hint", attrs: { "aria-hidden": "true" } }, [
      // On touch the full "Change artwork" scrim covered most of a 96px
      // portrait, so the picture was unreadable. The label is shown on fine
      // pointers (where the scrim only appears on hover) and the icon alone on
      // touch, where the chip rests visible in the corner without hiding the
      // art. Both are aria-hidden: the button's aria-label carries the name.
      el("span", {
        class: "rp-detail__portrait-hint-icon",
        attrs: { "aria-hidden": "true" },
        html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14 7l3 3"/></svg>',
      }),
      el("span", { class: "rp-detail__portrait-hint-text", text: "Change artwork" }),
    ])
  );

  function paintPortrait(url) {
    portraitInner.replaceChildren();
    const src = imageUrl(url);
    if (src) portraitInner.appendChild(el("img", { alt: "", src }));
    else portraitInner.appendChild(el("span", { class: "rp-avatar__initials", text: cardInitial(card) }));
  }
  paintPortrait(cardAvatarUrl(card));

  const nickname = String(data.nickname || "").trim();
  const hero = el("div", { class: "rp-detail__hero" }, [
    changeAvatar,
    el("div", { class: "rp-detail__hero-meta" }, [
      el("h2", { class: "rp-detail__name", id: "rp-detail-name", text: name }),
      nickname && nickname.toLowerCase() !== name.toLowerCase()
        ? el("p", { class: "rp-detail__nickname", text: `"${nickname}"` })
        : null,
      el("p", { class: "rp-detail__byline", text: `${cardByline(card)}, v${data.character_version || data.char_version || "1.0"}` }),
      el(
        "div",
        { class: "rp-chip-group rp-detail__tags" },
        cardTags(card).map((tag) => el("span", { class: "rp-chip rp-chip--muted", text: tag }))
      ),
    ]),
  ]);

  // Navigation tabs.
  const tablist = el("div", { class: "rp-tabs rp-detail__tabs" }, [
    el("button", { type: "button", class: "rp-tab", id: "rp-tab-about", text: "About", attrs: { "aria-selected": "true" } }),
    el("button", { type: "button", class: "rp-tab", id: "rp-tab-story", text: "Story and hook" }),
    el("button", { type: "button", class: "rp-tab", id: "rp-tab-notes", text: "Author notes" }),
  ]);
  tablist.children[0].setAttribute("aria-controls", "rp-panel-about");
  tablist.children[1].setAttribute("aria-controls", "rp-panel-story");
  tablist.children[2].setAttribute("aria-controls", "rp-panel-notes");

  const aboutPanel = el("div", { class: "rp-tabpanel", id: "rp-panel-about" });
  const storyPanel = el("div", { class: "rp-tabpanel", id: "rp-panel-story", hidden: true });
  const notesPanel = el("div", { class: "rp-tabpanel", id: "rp-panel-notes", hidden: true });

  // About panel.
  const lorebook = data.character_book?.entries;
  const entryCount = Array.isArray(lorebook)
    ? lorebook.length
    : lorebook && typeof lorebook === "object"
      ? Object.keys(lorebook).length
      : 0;

  const dossiers = [
    dossier("Description and lore", data.description),
    dossier("Personality and traits", data.personality),
    dossier("Scenario and world", data.scenario),
    dossier("Voice and dialogue samples", formatSampleDialogue(data.mes_example, name)),
    dossier("System prompt", data.system_prompt, { mono: true }),
    dossier("Post-history instructions", data.post_history_instructions, { mono: true }),
  ].filter(Boolean);

  if (entryCount > 0) {
    aboutPanel.appendChild(
      el("div", { class: "rp-notice" }, [
        el("p", { class: "rp-notice__title", text: `Embedded world info, ${entryCount} ${entryCount === 1 ? "entry" : "entries"}` }),
        el("p", { class: "rp-notice__body", text: "This card carries a lorebook. Injecting it requires an endpoint that supports it." }),
      ])
    );
  }
  if (dossiers.length) {
    aboutPanel.appendChild(el("div", { class: "rp-dossier-list" }, dossiers));
  } else if (entryCount === 0) {
    aboutPanel.appendChild(
      el("p", { class: "rp-detail__empty", text: "No lore or prompt instructions recorded for this character." })
    );
  }

  // Story and hook panel.
  const startFrom = (opening) => {
    close();
    handlers.onStartNew?.(card, opening);
  };
  const firstMes = data.first_mes || FALLBACK_OPENING;
  storyPanel.appendChild(
    section("Opening scene", "First message in new chats", [
      el("p", { class: "rp-detail__prose", text: firstMes }),
    ])
  );
  const alternates = Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [];
  if (alternates.length) {
    storyPanel.appendChild(
      section(
        `Alternate openings (${alternates.length})`,
        "Open one to read it",
        el(
          "div",
          { class: "rp-variation-list" },
          alternates.map((alt, index) => variation(`Variation ${index + 1}`, alt, startFrom)).filter(Boolean)
        )
      )
    );
  }
  const groupOnly = Array.isArray(data.group_only_greetings) ? data.group_only_greetings : [];
  if (groupOnly.length) {
    storyPanel.appendChild(
      section(
        `Group-only openings (${groupOnly.length})`,
        "Used in multi-character scenes",
        el(
          "div",
          { class: "rp-variation-list" },
          groupOnly.map((alt, index) => variation(`Group ${index + 1}`, alt)).filter(Boolean)
        )
      )
    );
  }

  // Creator notes panel.
  const notes = String(data.creator_notes ?? "").trim();
  notesPanel.appendChild(
    notes
      ? section("Creator and author guidance", "From the card creator", [
          el("p", { class: "rp-detail__prose", text: notes }),
        ])
      : el("p", { class: "rp-detail__empty", text: "No author notes or creator guidance provided for this character." })
  );
  const sources = Array.isArray(data.source) ? data.source.map((s) => String(s).trim()).filter(Boolean) : [];
  if (sources.length) {
    notesPanel.appendChild(
      section("Source", null, [
        el("div", { class: "rp-chip-group" }, sources.map((s) => el("span", { class: "rp-chip rp-chip--muted", text: s }))),
      ])
    );
  }

  // History thread panel.
  const threadList = el("div", { class: "rp-thread-list rp-scroll" });
  const historyEmpty = el("p", {
    class: "rp-detail__empty",
    text: "No chats recorded yet. Choose New chat to start one.",
  });

  /** Reads the current session list: the loader when given, else the cache. */
  async function currentSessions() {
    if (typeof loadSessions === "function") {
      const fresh = await loadSessions(card);
      if (Array.isArray(fresh)) sessions = fresh;
    }
    return sessions;
  }

  function paintThreads(list) {
    threadList.replaceChildren();
    if (list.length === 0) {
      threadList.appendChild(historyEmpty);
      return;
    }
    for (const session of list) threadList.appendChild(threadRow(session, card, threadHandlers));
  }

  async function reloadThreads() {
    const list = await currentSessions();
    countLabel.textContent = String(list.length);
    historyBtn.disabled = list.length === 0;
    paintThreads(list);
  }

  // Renaming and deleting both mutate the store, so the list is re-read from
  // the loader afterwards. Without this the dialog would keep showing the
  // pre-edit rows.
  const threadHandlers = {
    ...handlers,
    onRenameSession: async (session, title) => {
      await handlers.onRenameSession?.(session, title);
      await reloadThreads();
    },
    onDeleteSession: async (session) => {
      await handlers.onDeleteSession?.(session);
      await reloadThreads();
    },
  };

  const infoView = el("div", { class: "rp-detail__view" }, [hero, tablist, aboutPanel, storyPanel, notesPanel]);
  const historyView = el("div", { class: "rp-detail__view", hidden: true }, [
    section("Saved chats", "Choose a chat to resume it", threadList),
  ]);

  // Modal chrome and controls.
  const backBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Back",
    hidden: true,
  });
  const closeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
    text: "\u00d7",
    attrs: { "aria-label": "Close dialog" },
  });
  const countLabel = el("span", { class: "rp-tnum", text: String(sessions.length) });
  const historyBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost",
  });
  historyBtn.append("Saved chats (", countLabel, ")");
  historyBtn.disabled = sessions.length === 0;

  const deleteBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--danger-ghost",
    text: "Delete",
    attrs: { "aria-label": `Delete "${name}"` },
  });
  deleteBtn.addEventListener("click", async () => {
    const ok = await handlers.onConfirmDelete?.("character", name);
    if (!ok) return;
    await handlers.onDeleteCard?.(card);
    close();
  });

  const newChatBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--primary",
    text: "New chat",
  });
  newChatBtn.addEventListener("click", () => {
    close();
    handlers.onStartNew?.(card);
  });

  const footer = el("footer", { class: "rp-dialog__footer" }, [
    deleteBtn,
    el("div", { class: "rp-detail__footer-actions" }, [historyBtn, newChatBtn]),
  ]);

  const dialog = el("dialog", { class: "rp-dialog", attrs: { "aria-labelledby": "rp-detail-name" } }, [
    el("div", { class: "rp-dialog__panel" }, [
      el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
      el("header", { class: "rp-dialog__header" }, [
        el("div", {}, [
          el("h2", { class: "rp-dialog__title", text: "Character profile" }),
          el("p", { class: "rp-dialog__desc", text: "Read the card, then start or resume a conversation." }),
        ]),
        el("div", { class: "rp-detail__header-actions" }, [
          backBtn,
          closeBtn,
        ]),
      ]),
      el("div", { class: "rp-dialog__body" }, [infoView, historyView]),
      footer,
    ]),
  ]);

  document.body.appendChild(dialog);
  const tabs = initTabs(tablist, { activation: "auto" });

  function showView(view) {
    const history = view === "history";
    infoView.hidden = history;
    historyView.hidden = !history;
    footer.hidden = history;
    backBtn.hidden = !history;
    closeBtn.hidden = history;
    if (history) {
      // Read the sessions afresh so a rename or delete performed elsewhere is
      // reflected the moment the list is shown.
      reloadThreads();
      backBtn.focus();
    } else {
      tablist.querySelector('[aria-selected="true"]')?.focus();
    }
  }

  backBtn.addEventListener("click", () => showView("info"));
  historyBtn.addEventListener("click", () => showView("history"));
  closeBtn.addEventListener("click", () => close());

  let settled = false;
  function close() {
    if (settled) return;
    settled = true;
    closeModal(dialog);
  }

  // Escape, the backdrop and the close control all route through `closeModal`,
  // which calls this handler. Removing the element here keeps the DOM clean and
  // makes "is the dialog gone" a reliable question for tests and callers.
  const handle = openModal({
    element: dialog,
    initialFocus: changeAvatar,
    onClose: () => {
      settled = true;
      dialog.remove();
    },
  });

  return {
    element: dialog,
    close,
    /** Re-renders the thread list with a fresh set of sessions. */
    refresh(nextSessions) {
      if (Array.isArray(nextSessions)) {
        sessions = nextSessions;
        countLabel.textContent = String(nextSessions.length);
        historyBtn.disabled = nextSessions.length === 0;
        if (!historyView.hidden) paintThreads(nextSessions);
      }
    },
    /** Selects one of the three content tabs by index or id. */
    selectTab: tabs.select,
    handle,
  };
}
