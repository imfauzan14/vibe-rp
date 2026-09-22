// LibraryController: catalogue state and orchestration, no DOM.
//
// Contract
//   - `createLibraryController({ db, now, onError })` returns a controller
//     that owns the card list, the session index, the filter/sort state and
//     the import flow. It never touches the document: the page subscribes and
//     renders. `db` is injectable so tests can pass a fake.
//   - State shape: `{ cards, sessions, query, sort, tag, status, error }`.
//     `cards` are `withSessions`-shaped, so every card already carries its
//     `sessions`, `sessionCount` and `lastUpdated`.
//   - Sessions are read ONCE per refresh through `db.open()`, not once per
//     card. `getSessionsForCard` is never called in a loop.
//   - `importCard` detects duplicates and delegates the decision to the
//     caller's `onDuplicate` (a Promise of "replace" | "add" | "abort"), so
//     the confirmation UI stays in the page.
//   - `subscribe(fn)` is called with the new state after every mutation.
//
// Exports
//   createLibraryController(options) -> controller
//   SORT_MODES  the two supported sort keys

import {
  withSessions,
  sortCards,
  matchesQuery,
  findDuplicate,
  allTags,
  cardTags,
  cardTitle,
} from "./character_card.js";

export const SORT_MODES = ["recent", "name"];

/** One read of the sessions store, shared by every card. */
async function readAllSessions(db) {
  if (typeof db.getAllSessions === "function") return db.getAllSessions();
  const handle = await db.open();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("sessions", "readonly");
    const request = tx.objectStore("sessions").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export function createLibraryController({ db, now = () => Date.now(), onError = null } = {}) {
  if (!db) throw new Error("createLibraryController requires a db");

  let state = {
    cards: [],
    sessions: [],
    query: "",
    sort: "recent",
    tag: "",
    status: "idle",
    error: null,
  };

  const listeners = new Set();

  function emit(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (_) {
        /* one bad renderer must not stop the others */
      }
    }
    return state;
  }

  function report(error) {
    try {
      onError?.(error);
    } catch (_) {
      /* reporting must not throw */
    }
  }

  /** Cards matching the current query and tag, in the current sort order. */
  function visibleCards(current = state) {
    const filtered = current.cards.filter(
      (card) => matchesQuery(card, current.query) && (!current.tag || cardTags(card).includes(current.tag))
    );
    return sortCards(filtered, current.sort);
  }


  /** Reloads cards and the session index. One session read for the whole set. */
  async function refresh() {
    emit({ status: "loading", error: null });
    try {
      const [cards, sessions] = await Promise.all([db.getAllCards(), readAllSessions(db)]);
      emit({ cards: withSessions(cards, sessions), sessions, status: "ready", error: null });
    } catch (error) {
      emit({ status: "error", error });
      report(error);
    }
    return state;
  }

  /**
   * Saves an incoming card, resolving the duplicate question first.
   * `onDuplicate(dup, incoming)` returns "replace", "add" or "abort".
   * Returns the stored card, or null when the user aborted.
   */
  async function importCard(incoming, { onDuplicate } = {}) {
    if (!incoming || typeof incoming !== "object") return null;
    const dup = findDuplicate(state.cards, incoming);
    if (dup) {
      const choice = (await onDuplicate?.(dup, incoming)) || "abort";
      if (choice === "abort") return null;
      if (choice === "replace") {
        // Keep the existing id so every conversation stays linked.
        incoming.id = dup.card.id;
        await db.saveCard(incoming);
        await refresh();
        return incoming;
      }
      // "add" falls through to a fresh record.
    }
    incoming.id = incoming.id || `card_${now()}`;
    await db.saveCard(incoming);
    await refresh();
    return incoming;
  }

  /** Deletes a card and its sessions, then reloads. */
  async function removeCard(cardId) {
    await db.deleteCard(cardId);
    await refresh();
  }

  /** Deletes one session, then reloads the index. */
  async function removeSession(sessionId) {
    await db.deleteSession(sessionId);
    await refresh();
  }

  /** Renames a session in place and reloads. */
  async function renameSession(sessionId, title) {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const next = { ...session, title: String(title || "").trim() || "Conversation", updatedAt: now() };
    await db.saveSession(next);
    await refresh();
    return next;
  }

  /** The card record with the given id, or null. */
  function getCard(cardId) {
    return state.cards.find((card) => card.id === cardId) || null;
  }

  /** Sessions for one card, most recent first, from the cached index. */
  function sessionsFor(cardId) {
    return state.sessions
      .filter((session) => session.cardId === cardId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  return {
    /** Current immutable state snapshot. */
    getState: () => state,
    /** Subscribe to state changes. Returns an unsubscribe function. */
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visibleCards,
    refresh,
    importCard,
    removeCard,
    removeSession,
    renameSession,
    getCard,
    sessionsFor,
    /** Every tag in the catalogue, most common first. */
    tags: () => allTags(state.cards),
    setQuery(query) {
      return emit({ query: String(query ?? "") });
    },
    setSort(sort) {
      return emit({ sort: SORT_MODES.includes(sort) ? sort : "recent" });
    },
    setTag(tag) {
      return emit({ tag: String(tag ?? "") });
    },
    /** A short, human summary of the visible set for a live region. */
    summary() {
      const total = state.cards.length;
      const shown = visibleCards().length;
      if (total === 0) return "No characters in the library.";
      if (shown === total) return `${total} ${total === 1 ? "character" : "characters"}.`;
      return `${shown} of ${total} characters shown.`;
    },
    titleOf: cardTitle,
  };
}

