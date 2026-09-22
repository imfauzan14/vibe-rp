// SessionController: testable state + orchestration for the chat page.
//
// Owns three things:
//   1. Session lifecycle state (active card, session, persona, directive, settings)
//   2. A modal state machine (mutual exclusion by construction, not cross-calls)
//   3. Message mutations as data transitions and the streaming turn flow
//
// No DOM/window/document references. db and engine are injectable so tests
// can pass fakes; both default to the real browser singletons.

import { LocalDb } from "./local_db.js";
import { BrowserChatEngine } from "./browser_engine.js";

const GREETING_FALLBACK = "The door closes behind you. Silence settles into the corridor.";
const INITIAL_TITLE = "Chapter 1: The Initial Approach";

/**
 * Combines the caller's signal with the controller's per-turn signal. Prefers
 * `AbortSignal.any`; falls back to the per-turn signal on runtimes without it,
 * so cancellation via `cancel()` still works everywhere.
 */
function mergeSignals(external, controller) {
  if (!external) return controller.signal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, controller.signal]);
  // Fallback for runtimes without AbortSignal.any: an external abort cancels
  // the per-turn controller, so both cancellation paths still take effect.
  external.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

export const MODAL_NAMES = ["history", "settings", "personaEditor", "directiveEditor"];

export class SessionController {
  #activeTurn = null;
  constructor({ db = LocalDb, engine = BrowserChatEngine } = {}) {
    this.db = db;
    this.engine = engine;
    this.activeCard = null;
    this.sessions = [];
    this.activeSession = null;
    this.currentPersona = null;
    this.currentDirective = null;
    this.settings = db.getSettings();
    this.openModalName = null;
    this.modalPayload = null;
  }

  async init(cardId, sessionId) {
    const cards = await this.db.getAllCards();
    this.activeCard = cards.find(c => c.id === cardId) || cards[0];
    if (!this.activeCard) {
      throw new Error("No character cards found. Redirecting to library...");
    }
    await this.loadSessions(sessionId);
    await this.refreshPresets();
    return this;
  }

  get charName() {
    return this.activeCard?.data?.name || this.activeCard?.name || "Character";
  }

  get initialLetter() {
    return this.charName.charAt(0).toUpperCase();
  }

  get messages() {
    return this.activeSession?.messages || [];
  }

  greeting() {
    return this.activeCard.data?.first_mes || this.activeCard.first_mes || GREETING_FALLBACK;
  }

  async loadSessions(sessionId) {
    this.sessions = await this.db.getSessionsForCard(this.activeCard.id);
    this.activeSession = this.sessions.find(s => s.id === sessionId) || this.sessions[0];
    if (!this.activeSession) {
      await this.createSession({ id: sessionId, title: INITIAL_TITLE });
    }
    return this.sessions;
  }

  async createSession({ id = null, title = null } = {}) {
    const sess = {
      id: id || `sess_${Date.now()}`,
      cardId: this.activeCard.id,
      title: title || INITIAL_TITLE,
      messages: [
        {
          id: "msg_init",
          role: "assistant",
          content: this.greeting(),
          timestamp: Date.now()
        }
      ],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await this.db.saveSession(sess);
    this.sessions.push(sess);
    this.activeSession = sess;
    return sess;
  }

  switchSession(sess) {
    this.activeSession = sess;
    return sess;
  }

  async saveSession(sess = this.activeSession) {
    await this.db.saveSession(sess);
    return sess;
  }

  async saveCard() {
    await this.db.saveCard(this.activeCard);
    return this.activeCard;
  }

  async setCardPersona(val) {
    this.activeCard.userPersonaId = val;
    if (this.activeCard.data) this.activeCard.data.userPersonaId = val;
    return this.saveCard();
  }

  async setCardDirective(val) {
    this.activeCard.directivePresetId = val;
    if (this.activeCard.data) this.activeCard.data.directivePresetId = val;
    return this.saveCard();
  }

  async refreshPresets() {
    this.currentPersona = await this.db.resolvePersonaForCard(this.activeCard);
    this.currentDirective = await this.db.resolveDirectiveForCard(this.activeCard);
    return { persona: this.currentPersona, directive: this.currentDirective };
  }

  // Modal state machine

  openModal(name, payload = null) {
    if (!MODAL_NAMES.includes(name)) throw new Error(`Unknown modal: ${name}`);
    const closed = this.openModalName && this.openModalName !== name ? this.openModalName : null;
    this.openModalName = name;
    this.modalPayload = payload;
    return { opened: name, closed };
  }

  closeModal() {
    const closed = this.openModalName;
    this.openModalName = null;
    this.modalPayload = null;
    return { closed };
  }

  // Message transitions

  appendMessage({ role, content, timestamp = Date.now() }) {
    const msg = { id: `msg_${Date.now()}`, role, content, timestamp };
    this.activeSession.messages.push(msg);
    return msg;
  }

  /**
   * Forks a message instead of mutating it (append-only invariant). The new
   * revision keeps the original's id and position — so the transcript stays
   * append-only and the provider's byte-stable prefix is undisturbed — while the
   * superseded text is retained in `forks`, so the original is never destroyed.
   * Returns the new revision, or null for an unknown id.
   */
  editMessage(id, content) {
    const msgs = this.activeSession?.messages || [];
    const idx = msgs.findIndex(m => m.id === id);
    if (idx === -1) return null;
    const original = msgs[idx];
    const fork = {
      ...original,
      content,
      timestamp: Date.now(),
      forks: [...(original.forks || []), { content: original.content, timestamp: original.timestamp }],
    };
    msgs[idx] = fork;
    return fork;
  }

  deleteMessage(id) {
    const sess = this.activeSession;
    const msgs = sess?.messages || [];
    const idx = msgs.findIndex(m => m.id === id);
    if (idx === -1) return false;
    // Keep ledger coverage aligned with absolute message indices. Deleting
    // msg_init (index 0) invalidates the whole ledger bookkeeping: the pinned
    // message becomes a ledger-covered one, so reset to empty state (the next
    // plan re-pins and consumed=0 normalizes back to 1).
    const consumed = Number(sess?.consumed) || 0;
    if (idx === 0) {
      if (sess) { sess.ledger = ""; sess.consumed = 0; }
    } else if (idx < consumed) {
      sess.consumed = consumed - 1;
    }
    msgs.splice(idx, 1);
    return true;
  }


  /**
   * Pops the trailing assistant message and returns the prompt that produced
   * it (the preceding user message), or null when there is nothing to reuse —
   * the caller substitutes the reroll hint in that case.
   */
  reroll() {
    const msgs = this.activeSession?.messages || [];
    if (msgs.length === 0) return null;
    let prompt = null;
    if (msgs[msgs.length - 1].role === "assistant") {
      msgs.pop();
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
        prompt = msgs[msgs.length - 1].content;
      }
    }
    return prompt;
  }

  // Streaming orchestration

  /**
   * Streams one assistant turn into the active session.
   *
   * Persistence policy (defect 5): unless `options.persistPending` is false,
   * the session is checkpointed before the network call, so the user turn (and
   * any other pending edit) is durable even if the tab crashes mid-stream. The
   * assistant turn is saved only once it settles, so a failed stream never
   * persists a placeholder. This is the one place the checkpoint lives, so the
   * `send()` path and the page's append-then-stream path both get it.
   *
   * Failure (defect 2): the assistant placeholder is pushed before streaming so
   * the engine sees it, and is removed again if the stream throws, leaving the
   * transcript byte-identical to before the turn.
   *
   * Cancellation (defect 4): `options.signal` and `cancel()` both feed a
   * per-turn AbortController whose signal is forwarded to the engine for the
   * whole turn, summarizer/fold request included.
   */
  async streamResponse(promptHint, onChunk, onNotice, options = {}) {
    const { persistPending = true, signal: externalSignal } = options;
    const turn = new AbortController();
    this.#activeTurn = turn;
    const signal = mergeSignals(externalSignal, turn);
    let assistantMsg = null;
    try {
      // Crash-safety checkpoint before the network call (defect 5). Kept inside
      // the try so a storage failure here cannot leak the turn controller.
      if (persistPending) {
        this.activeSession.updatedAt = Date.now();
        await this.db.saveSession(this.activeSession);
      }
      assistantMsg = {
        id: `msg_${Date.now() + 1}`,
        role: "assistant",
        content: "",
        timestamp: Date.now()
      };
      this.activeSession.messages.push(assistantMsg);
      const returnedText = await this.engine.streamTurn({
        card: this.activeCard,
        session: this.activeSession,
        settings: this.settings,
        persona: this.currentPersona,
        agentsContract: this.currentDirective?.content || this.settings.agentsContract,
        userPrompt: promptHint,
        signal,
        onChunk: (chunk, notice) => {
          // Defensive: a null/undefined chunk must never be stringified into the
          // reply as the literal "null". The notice still surfaces separately.
          if (chunk !== null && chunk !== undefined) {
            assistantMsg.content += chunk;
            if (onChunk) onChunk(chunk, assistantMsg);
          }
          if (notice) this.#surfaceNotice(notice, onNotice, assistantMsg);
        },
        onNotice: (notice) => this.#surfaceNotice(notice, onNotice, assistantMsg),
      });
      // An engine may return the full reply without ever invoking onChunk (a
      // non-streaming provider, a whole-body JSON response, or a test fake).
      // Adopt that text so a valid reply is never dropped into a blank bubble.
      if (!assistantMsg.content && typeof returnedText === "string" && returnedText) {
        assistantMsg.content = returnedText;
        if (onChunk) onChunk(returnedText, assistantMsg);
      }
    } catch (err) {
      // Defect 2: drop the placeholder so the transcript is byte-identical to
      // before the turn and no empty assistant message is ever persisted.
      if (assistantMsg) {
        const idx = this.activeSession.messages.indexOf(assistantMsg);
        if (idx !== -1) this.activeSession.messages.splice(idx, 1);
      }
      throw err;
    } finally {
      if (this.#activeTurn === turn) this.#activeTurn = null;
    }
    // A stream that settles with zero content must not persist a blank
    // assistant bubble. The engine already throws a descriptive error for a
    // content-less stream; this is the last-resort guard for an engine that
    // returns empty text without throwing. send() rolls the turn back so retry
    // is clean.
    if (!assistantMsg.content) {
      const idx = this.activeSession.messages.indexOf(assistantMsg);
      if (idx !== -1) this.activeSession.messages.splice(idx, 1);
      throw new Error("The model returned an empty reply. Retry, or check the endpoint and max output tokens for this model.");
    }
    this.activeSession.updatedAt = Date.now();
    await this.db.saveSession(this.activeSession);
    return assistantMsg;
  }

  /**
   * Full user turn: append the user message, then stream the response.
   * `streamResponse` checkpoints the user message before the network call, so a
   * crash mid-turn cannot lose it (defect 5). If the turn fails, both the
   * assistant placeholder and this turn's user message are removed, leaving the
   * transcript byte-identical to before the call (defect 2) — the user simply
   * sees the error and can retry.
   */
  async send(userText, onChunk, onNotice, options = {}) {
    const userMsg = this.appendMessage({ role: "user", content: userText });
    try {
      const assistantMsg = await this.streamResponse(userText, onChunk, onNotice, options);
      return { userMsg, assistantMsg };
    } catch (err) {
      const idx = this.activeSession.messages.indexOf(userMsg);
      if (idx !== -1) this.activeSession.messages.splice(idx, 1);
      // Re-checkpoint the rolled-back transcript so the pre-stream user save
      // cannot survive as a phantom turn in storage. A failure here must not
      // mask the original turn error.
      try {
        this.activeSession.updatedAt = Date.now();
        await this.db.saveSession(this.activeSession);
      } catch (saveErr) {
        console.warn("Rollback checkpoint failed", saveErr);
      }
      throw err;
    }
  }

  /**
   * Cancels the in-flight turn, if any. Safe to call at any time; the next
   * streamResponse creates a fresh controller. This is the Stop-button seam.
   */
  cancel() {
    if (this.#activeTurn) this.#activeTurn.abort();
    return true;
  }

  /**
   * Delivers an engine notice to the caller, or logs it when no handler is
   * wired, so a degraded fold is never silently swallowed.
   */
  #surfaceNotice(notice, onNotice, assistantMsg) {
    if (onNotice) onNotice(notice, assistantMsg);
    else console.warn("Engine notice:", notice);
  }
}
