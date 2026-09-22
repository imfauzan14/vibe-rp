// LibraryView: rendering for the catalogue. Owns no state.
//
// Contract
//   - `mountLibrary({ grid, tagFilter, status, controller, handlers })`
//     subscribes to a LibraryController and renders it. All DOM lives in the
//     containers passed in, so the view is testable against a detached tree.
//   - Cards are rendered keyed by card id, so a filter or sort change reuses
//     the nodes that survive instead of rebuilding the grid.
//   - A card is a `<button class="rp-card__link">` covering the identity and
//     body; the footer holds the Resume and New chat actions as siblings. No
//     interactive element is nested inside another.
//   - Handlers: `{ onOpenDetail(card), onResume(card, session), onNewChat(card) }`.
//   - Returns `{ render, destroy }`.
//
// Exports
//   mountLibrary(options) -> { render, destroy }
//   renderCard(card, handlers) -> HTMLElement

import { el, renderKeyed } from "./dom.js";
import {
  cardTitle,
  cardByline,
  cardTags,
  cardAvatarUrl,
  cardInitial,
  cardDescription,
} from "./character_card.js";

const MAX_TAGS = 3;
const NO_SYNOPSIS = "No synopsis recorded.";

/**
 * Fits `text` into a line-clamped element so the visible cut lands on a whole
 * word. A character budget cannot do this on its own: the CSS clamp decides
 * where the box ends, and it will happily split a word in half. So the full
 * text is written first, the element is measured, and when it overflows the
 * text is binary-searched down to the longest word-boundary prefix that still
 * fits. Trailing punctuation is dropped before the ellipsis so the cut reads
 * "precision\u2026" rather than "precision,\u2026". Returns what was written.
 */
function fitClampedText(element, text) {
  const value = String(text ?? "").trim();
  if (!element) return value;
  element.textContent = value;
  // An element with no layout (hidden, or not yet in the document) cannot be
  // measured, so the full text is kept rather than collapsed to one word.
  if (element.clientHeight === 0) return value;

  const words = value.split(/\s+/);
  let low = 0;
  let high = words.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    element.textContent = `${trimTrailingPunctuation(words.slice(0, mid).join(" "))}\u2026`;
    if (element.scrollHeight <= element.clientHeight + 1) low = mid;
    else high = mid - 1;
  }
  const fitted =
    low > 0
      ? `${trimTrailingPunctuation(words.slice(0, low).join(" "))}\u2026`
      : `${trimTrailingPunctuation(words[0] ?? "")}\u2026`;
  element.textContent = fitted;
  return fitted;
}

/**
 * Removes trailing punctuation and whitespace from a fragment so an ellipsis
 * appended to it does not read as a stray comma or full stop. A closing
 * bracket or quote is left alone when it terminates a word.
 */
function trimTrailingPunctuation(fragment) {
  return String(fragment ?? "").replace(/[\s,;:.!?\u2013\u2014-]+$/u, "").trimEnd();
}


function paintTags(group, card) {
  const tags = cardTags(card);
  const wanted = tags.slice(0, MAX_TAGS);
  const overflow = tags.length - MAX_TAGS;
  const labels = overflow > 0 ? [...wanted, `+${overflow}`] : wanted;
  // Reuse the existing chips so a refresh does not churn the node tree.
  labels.forEach((label, index) => {
    let chip = group.children[index];
    if (!chip) {
      chip = el("span", { class: "rp-chip rp-chip--muted" });
      group.appendChild(chip);
    }
    if (chip.textContent !== label) chip.textContent = label;
  });
  while (group.children.length > labels.length) group.lastElementChild.remove();
}

function paintAvatar(media, card) {
  const url = cardAvatarUrl(card);
  const current = media.firstElementChild;
  const isImage = current?.tagName === "IMG";
  if (url) {
    if (isImage) {
      if (current.getAttribute("src") !== url) current.setAttribute("src", url);
    } else {
      media.replaceChildren(el("img", { alt: "", src: url, attrs: { loading: "lazy" } }));
    }
    return;
  }
  const letter = cardInitial(card);
  if (isImage) media.replaceChildren(el("span", { class: "rp-avatar__initials", text: letter }));
  else if (current && current.textContent !== letter) current.textContent = letter;
  else if (!current) media.appendChild(el("span", { class: "rp-avatar__initials", text: letter }));
}

function paintAction(actions, card, handlers) {
  const wantResume = Boolean(card.latestSession);
  const resume = actions.querySelector('[data-action="resume"]');
  if (wantResume) {
    const href = `chat.html?cardId=${encodeURIComponent(card.id)}&sessionId=${encodeURIComponent(card.latestSession.id)}`;
    if (!resume) {
      // The href is set here, at creation, so the anchor is a working link on
      // the very first paint. Setting it only on a later paint left the first
      // render with a dead anchor: the click handler below delegates to
      // `onResume`, which the page leaves as a no-op so a router can intercept
      // it, so a missing href meant the click did nothing at all.
      const link = el("a", {
        class: "rp-btn rp-btn--ghost rp-btn--sm",
        text: "Resume",
        href,
        attrs: { "data-action": "resume" },
      });
      link.addEventListener("click", () => handlers.onResume?.(card, card.latestSession));
      actions.prepend(link);
    } else if (resume.getAttribute("href") !== href) {
      resume.setAttribute("href", href);
    }
  } else if (resume) {
    resume.remove();
  }
}

/**
 * Trims every card blurb in `root` to the longest word-boundary prefix that
 * fits its clamped box. Called after the cards are inserted, because only an
 * attached element has a measurable line box. Re-run after a resize, when the
 * column width changes what fits.
 */
function fitCardBodies(root) {
  if (!root) return;
  for (const body of root.querySelectorAll(".rp-card__body:not(.rp-card__body--empty)")) {
    fitClampedText(body, body.textContent);
  }
}

/**
 * One catalogue card. Updates `existing` in place when given, so the grid can
 * reuse nodes across refreshes and keep focus where the reader left it.
 */
export function renderCard(card, handlers = {}, existing = null) {
  const article = existing || el("article", { class: "rp-card rp-card--interactive" });

  if (!article.firstElementChild) {
    // The identity-plus-body block is the control that opens detail; the
    // footer actions are its siblings, never nested inside it.
    const link = el("button", { type: "button", class: "rp-card__link" });
    link.appendChild(
      el("div", { class: "rp-card__head" }, [
        el("div", { class: "rp-card__media rp-avatar" }),
        el("div", { class: "rp-card__heading" }, [
          el("h2", { class: "rp-card__title" }),
          el("p", { class: "rp-card__byline" }),
          el("div", { class: "rp-chip-group rp-card__tags" }),
        ]),
      ])
    );
    link.appendChild(el("p", { class: "rp-card__body" }));
    link.addEventListener("click", () => handlers.onOpenDetail?.(article.__card));

    // "New chat" is a sibling of the card body control, never nested inside
    // it. Its listener reads `article.__card` at click time (like
    // `onOpenDetail` above) so a node reused across repaints acts on the card
    // it currently shows, not the one it was built for.
    const newChat = el("button", {
      type: "button",
      class: "rp-btn rp-btn--primary rp-btn--sm",
      text: "New chat",
      attrs: { "data-action": "new" },
    });
    newChat.addEventListener("click", () => handlers.onNewChat?.(article.__card));
    const footer = el("div", { class: "rp-card__footer" }, [
      el("span", { class: "rp-card__meta rp-tnum" }),
      el("div", { class: "rp-card__actions" }, [newChat]),
    ]);
    article.append(link, footer);
  }
  article.__card = card;
  const title = cardTitle(card);
  const link = article.querySelector(".rp-card__link");
  link.setAttribute("aria-label", `Open ${title}`);
  link.querySelector(".rp-card__title").textContent = title;
  link.querySelector(".rp-card__byline").textContent = cardByline(card);
  paintAvatar(link.querySelector(".rp-card__media"), card);
  paintTags(link.querySelector(".rp-card__tags"), card);

  const blurb = cardDescription(card);
  const body = link.querySelector(".rp-card__body");
  // The full text is written here; `fitCardBody` trims it to a whole word once
  // the card is in the document and can be measured.
  body.textContent = blurb || NO_SYNOPSIS;
  body.classList.toggle("rp-card__body--empty", !blurb);

  const count = card.sessionCount || 0;
  article.querySelector(".rp-card__meta").textContent = `${count} ${count === 1 ? "chat" : "chats"}`;
  paintAction(article.querySelector(".rp-card__actions"), card, handlers);
  return article;
}

function emptyState(kind, { query, onClear, onImport }) {
  if (kind === "no-cards") {
    return el("div", { class: "rp-empty rp-library__empty" }, [
      el("h2", { class: "rp-empty__title", text: "The library is empty" }),
      el("p", {
        class: "rp-empty__body",
        text: "Import a character card to begin. JSON, JSONC, PNG and WebP all work.",
      }),
      el("button", {
        type: "button",
        class: "rp-btn rp-btn--primary",
        text: "Import character",
        onclick: () => onImport?.(),
      }),
    ]);
  }
  return el("div", { class: "rp-empty rp-library__empty" }, [
    el("h2", { class: "rp-empty__title", text: "No characters match" }),
    el("p", {
      class: "rp-empty__body",
      text: query ? `Nothing matched "${query}". Try a different search or clear the filters.` : "No characters match the current filters.",
    }),
    el("button", {
      type: "button",
      class: "rp-btn rp-btn--secondary",
      text: "Clear filters",
      onclick: () => onClear?.(),
    }),
  ]);
}

/**
 * Wires the grid, the tag filter and the live status line to a controller.
 * Every container is passed in, so the caller keeps ownership of the markup.
 */
export function mountLibrary({ grid, tagFilter, status, controller, handlers = {} }) {
  if (!grid || !controller) return { render: () => {}, destroy: () => {} };

  const unsubscribe = controller.subscribe((state) => paint(state));

  /**
   * Drives the single-select tag control. One option per tag plus an "All
   * tags" head, so the toolbar is a fixed height regardless of how many tags
   * the catalogue carries. `controller.setTag` is the same one-tag contract
   * the old chip row used; nothing here is multi-select.
   */
  function paintTagSelect(state) {
    if (!tagFilter) return;
    const tags = controller.tags();
    // Counts come from the cards already in state, so no extra read is made.
    const counts = new Map();
    for (const card of state.cards) {
      for (const tag of cardTags(card)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const values = ["", ...tags];
    renderKeyed(
      tagFilter,
      values,
      (value) => value || "\u0000all",
      (value, existing) => {
        const option = existing || el("option", {});
        option.value = value;
        option.textContent = value ? `${value} (${counts.get(value) || 0})` : "All tags";
        return option;
      }
    );
    // A tag that no card carries any more would leave the control reading "All
    // tags" while the grid stayed empty. Reset it through the controller so
    // state and control never disagree.
    if (state.tag && !tags.includes(state.tag)) {
      controller.setTag("");
      return;
    }
    tagFilter.value = state.tag || "";
    const wrap = tagFilter.parentElement;
    if (wrap) wrap.hidden = tags.length === 0;
  }

  function paint(state) {
    const cards = controller.visibleCards(state);
    if (status) status.textContent = controller.summary();

    if (state.cards.length === 0) {
      grid.replaceChildren(
        emptyState("no-cards", { onImport: handlers.onImport })
      );
      paintTagSelect(state);
      return;
    }
    if (cards.length === 0) {
      grid.replaceChildren(
        emptyState("no-match", {
          query: state.query,
          onClear: handlers.onClearFilters,
        })
      );
      paintTagSelect(state);
      return;
    }
    renderKeyed(
      grid,
      cards,
      (card) => card.id,
      (card, existing) => renderCard(card, handlers, existing)
    );
    paintTagSelect(state);
    syncAddTiles(state, cards);
    // Measure and trim after the cards are in the document, where they have a
    // real width and line box. A detached card reports zero height and cannot
    // be fitted.
    fitCardBodies(grid);
  }

  /**
   * Fills the final grid row with "add" tiles so a short catalogue ends on a
   * composed row instead of a ragged one. The column count is read from the
   * laid-out grid, so it follows the responsive breakpoints without duplicating
   * them here. Skipped while a filter is active, because the row count is then
   * the reader's own doing.
   */
  function syncAddTiles(state, cards) {
    for (const tile of grid.querySelectorAll(".rp-card--add")) tile.remove();
    if (!handlers.onImport || state.query || state.tag || cards.length === 0) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
    if (!columns) return;
    const remainder = cards.length % columns;
    if (remainder === 0) return;
    // One tile spanning exactly the cells left in the final row. Repeating the
    // same action across several tiles would say the same thing more than once
    // and read as a row of buttons rather than a row terminator.
    const span = columns - remainder;
    const tile = el("button", {
      type: "button",
      class: "rp-card rp-card--add",
      text: "Import character",
      attrs: { "aria-label": "Import character" },
    });
    tile.style.gridColumn = `span ${span}`;
    tile.addEventListener("click", () => handlers.onImport?.());
    grid.appendChild(tile);
  }

  // Column count changes at the responsive breakpoints, so the filler row is
  // recomputed after a resize as well as after every state change.
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => paint(controller.getState()), 120);
  };
  window.addEventListener("resize", onResize);

  return {
    render: () => paint(controller.getState()),
    destroy() {
      unsubscribe();
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    },
  };
}
