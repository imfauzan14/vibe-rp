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
import { applyFold, resetLedger } from "./session_state.js";

const GREETING_FALLBACK = "The door closes behind you. Silence settles into the corridor.";
const INITIAL_TITLE = "Chapter 1: The Initial Approach";

// Message ids must be unique: the feed keys its DOM nodes by id, and Choice
// Mode ties a choice set to a source id. `Date.now()` alone is not unique — a
// user turn and the assistant turn that follows it land in the same
// millisecond — so a monotonic counter guarantees distinct ids even within one
// millisecond. The `msg_` prefix and the leading timestamp are preserved so
// ids remain readable and time-ordered.
let messageCounter = 0;
function nextMessageId() {
  messageCounter += 1;
  return `msg_${Date.now()}_${messageCounter}`;
}

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
  // If the external signal is already aborted at call time the event never
  // fires, so abort the controller immediately in that case.
  if (external.aborted) { controller.abort(); return controller.signal; }
  external.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

export const MODAL_NAMES = ["history", "settings", "personaEditor", "directiveEditor"];

/**
 * Choice Mode lifecycle. Modelled as explicit states rather than booleans so
 * the impossible states cannot be expressed: choices cannot be selected while
 * generating, two selections cannot both start a turn, and a stale set can
 * never be submitted into a newer scene.
 *
 *   idle ──beginChoiceGeneration──▶ generating ──settle(ok)──▶ ready
 *    ▲                                  │                       │
 *    │                                  └──settle(error)──▶ error
 *    │                                                          │
 *    └────────────invalidate─────────────◀────────selectChoice──┘
 *
 * `ready` is the only state in which `selectChoice` may act, and it leaves
 * `ready` in the same synchronous step, so a double click can never append two
 * user turns. Every event carries the source assistant message id, so an event
 * belonging to a superseded scene is dropped instead of applied.
 */
export const CHOICE_STATUS = Object.freeze({
  IDLE: "idle",
  GENERATING: "generating",
  READY: "ready",
  ERROR: "error",
  SUBMITTING: "submitting",
});

/**
 * Identity of the scene a choice set belongs to: the assistant message it was
 * generated from, plus that message's revision. If either moves, the set is
 * stale. Mirrors the feed's own signature so "the text changed" means the same
 * thing in both places.
 */
export function choiceSourceSignature(msg) {
  if (!msg) return "";
  return `${msg.id}:${(msg.content || "").length}:${(msg.forks || []).length}`;
}

export class SessionController {
  #activeTurn = null;
  #choiceToken = 0;
  #choiceAbort = null;
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
    // Derived UI state, never part of the transcript. `choices` are session
    // metadata; `choiceState` is the live machine that drives the panel.
    this.choiceState = { status: CHOICE_STATUS.IDLE, sourceId: null, sourceSig: "", choices: [], error: null, selectedId: null };
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
    const data = this.activeCard?.data || this.activeCard || {};
    // Ensemble cards open with the group greeting (multi-character intro) when
    // the author provided one; single-character cards keep the classic opener.
    const groupGreet = Array.isArray(data.group_only_greetings) ? data.group_only_greetings.find((g) => typeof g === "string" && g.trim()) : "";
    if (groupGreet) return groupGreet;
    return data.first_mes || this.activeCard.first_mes || GREETING_FALLBACK;
  }

  async loadSessions(sessionId) {
    this.sessions = await this.db.getSessionsForCard(this.activeCard.id);
    this.#discardLiveChoices();
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
    this.#discardLiveChoices();
    this.activeSession = sess;
    return sess;
  }

  switchSession(sess) {
    // The live choice state belongs to the session being left. Discard it
    // without touching either session's persisted set, so returning to a
    // session restores its own choices.
    this.#discardLiveChoices();
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
    const msg = { id: nextMessageId(), role, content, timestamp };
    this.activeSession.messages.push(msg);
    // A new user turn begins here, so any pending choice set describes a scene
    // that is now in the past. Discarding it is what stops a stale choice from
    // ever being submitted into the turn this message starts.
    //
    // The one exception is the turn a selected choice itself appends: the
    // machine is already in `submitting` (not selectable), and clearing it
    // would drop the acknowledged state the reader should see while the reply
    // streams. Every other append invalidates as usual.
    if (this.choiceState.status !== CHOICE_STATUS.SUBMITTING) this.invalidateChoices();
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
    // The message's text changed, so any choice set derived from this branch is
    // stale by definition (its source signature no longer matches).
    this.invalidateChoices();
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
      // Clearing the pinned opening resets all ledger bookkeeping; route
      // through the session-write seam so the mutation has one owner.
      if (sess) resetLedger(sess);
    } else if (idx < consumed) {
      sess.consumed = consumed - 1;
    }
    msgs.splice(idx, 1);
    // The scene the choices described has been altered.
    this.invalidateChoices();
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
      // The response the choices were generated from is gone, so the set is
      // stale; a fresh set is generated once the replacement settles.
      this.invalidateChoices();
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
    // A new turn supersedes any turn still in flight, so two generations can
    // never run at once: a double-submit, or Retry pressed while the previous
    // attempt is still streaming. The superseded turn is aborted and its own
    // failure path removes its placeholder, so nothing is left behind.
    if (this.#activeTurn) this.#activeTurn.abort();
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
        id: nextMessageId(),
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
      // A turn that fails leaves the scene exactly as it was before the turn
      // started, so the choice machine must not stay in `submitting`: that
      // state disables the menu and makes every later `selectChoice` a silent
      // no-op, which is a failure state the reader cannot escape. The consumed
      // set cannot be restored (its source is no longer the latest assistant
      // turn), so the machine returns to idle and a retry re-enters the normal
      // pipeline.
      if (this.choiceState.status === CHOICE_STATUS.SUBMITTING) this.#resetChoiceState();
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
   * crash mid-turn cannot lose it (defect 5).
   *
   * On failure only the assistant placeholder is rolled back (by
   * `streamResponse`). The user turn is deliberately kept: it is canonical,
   * already durable, and the reader already sent it, so a provider failure must
   * never force them to retype it. `retryLastTurn()` re-streams that exact turn
   * through the normal pipeline, which is also what the chat page does.
   */
  async send(userText, onChunk, onNotice, options = {}) {
    const userMsg = this.appendMessage({ role: "user", content: userText });
    const assistantMsg = await this.streamResponse(userText, onChunk, onNotice, options);
    return { userMsg, assistantMsg };
  }

  /**
   * Re-streams the trailing user turn after a failed generation. Appends
   * nothing, so the turn can never be duplicated, and reuses the ordinary
   * planning/streaming path. Returns null when there is nothing to retry —
   * the newest message is not a user turn, i.e. a reply already exists.
   */
  async retryLastTurn(onChunk, onNotice, options = {}) {
    const pending = this.pendingUserTurn();
    if (!pending) return null;
    return this.streamResponse(pending.content, onChunk, onNotice, options);
  }

  /**
   * Cancels the in-flight turn, if any. Safe to call at any time; the next
   * streamResponse creates a fresh controller. This is the Stop-button seam.
   */
  cancel() {
    if (this.#activeTurn) this.#activeTurn.abort();
    return true;
  }

  // Choice Mode
  //
  // Choice Mode is a UI-level way to pick the next user turn. The transcript,
  // the ledger, compaction and generation are untouched by everything here: a
  // selected choice is appended as an ordinary user message by the same send
  // path a typed message uses. This section owns only the derived choice state.

  /**
   * The trailing user turn when nothing has answered it — its generation failed
   * or was interrupted — otherwise null.
   *
   * This is the one definition of "the scene is waiting on the character". It
   * gates two opposite behaviours, which is why it is named for the state
   * rather than either caller: a pending turn is exactly the case where a reply
   * can be retried, and exactly the case where choices must NOT be offered.
   */
  pendingUserTurn() {
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (!msgs[i] || !msgs[i].content) continue;
      return msgs[i].role === "user" ? msgs[i] : null;
    }
    return null;
  }

  /**
   * The assistant turn choices may be offered after, or null when the scene is
   * not awaiting the player.
   *
   * Choices answer "what do you do next", so they are only valid once the
   * newest message is the character's reply. If the newest message is a user
   * turn — most importantly a turn whose generation failed and was kept so the
   * reader can retry it — the player has already acted and the scene is waiting
   * on the reply, not on another choice. Generating there would describe the
   * *previous* scene and offer a second action before the first resolved.
   */
  choiceScene() {
    if (this.pendingUserTurn()) return null;
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i] && msgs[i].role === "assistant" && msgs[i].content) return msgs[i];
    }
    return null;
  }

  #findMessage(id) {
    // Newest-first: a choice set is about the most recent scene, and message
    // ids are millisecond-derived, so two turns in one millisecond can share
    // an id. The newest match is the one the current scene actually is.
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i] && msgs[i].id === id) return msgs[i];
    }
    return null;
  }

  /**
   * True when the current choice set is still about the current scene: the
   * source assistant message exists, its text has not changed, and it is still
   * the *latest* assistant turn. A set whose source was edited, deleted,
   * rerolled, forked away, superseded by a newer reply, or replaced is stale.
   *
   * The "latest" clause matters: choices answer "what do you do next" after the
   * most recent reply, so once a newer assistant turn exists the old menu
   * describes a scene that is no longer the present one.
   */
  choicesAreFresh() {
    const st = this.choiceState;
    if (!st.sourceId) return false;
    const source = this.#findMessage(st.sourceId);
    if (!source || choiceSourceSignature(source) !== st.sourceSig) return false;
    return this.choiceScene() === source;
  }

  /**
   * Restores a persisted choice set for the active session, if it is still
   * valid. No model request is made: a reopened chat shows the same choices it
   * showed before. A set whose source no longer matches is discarded.
   */
  restoreChoices() {
    const saved = this.activeSession?.choiceSet;
    if (!saved || !Array.isArray(saved.choices) || !saved.choices.length) {
      this.#resetChoiceState();
      return this.choiceState;
    }
    const source = this.#findMessage(saved.sourceId);
    if (!source || choiceSourceSignature(source) !== saved.sourceSig || this.choiceScene() !== source) {
      // The scene moved on while the tab was closed (the source was edited,
      // deleted, or a newer reply landed): the set is stale, so it is discarded
      // from storage too rather than re-checked on every open. Applying the
      // same rule the live path uses keeps a restored menu always selectable —
      // otherwise the reader would see options that `selectChoice` rejects.
      this.activeSession.choiceSet = null;
      this.#resetChoiceState();
      return this.choiceState;
    }
    this.#choiceToken += 1; // supersede anything in flight
    this.choiceState = {
      status: CHOICE_STATUS.READY,
      sourceId: saved.sourceId,
      sourceSig: saved.sourceSig,
      choices: saved.choices.map((c) => ({ id: c.id, text: c.text, label: c.label || "", type: c.type || "" })),
      error: null,
    };
    return this.choiceState;
  }

  /**
   * Drops the current choice set and cancels any in-flight generation. Called
   * on every event that changes the scene the choices were generated from, so a
   * set for Scene A can never be submitted into Scene B. Bumping the token is
   * what makes a late-arriving response for the old scene a no-op.
   *
   * The persisted `choiceSet` of the *active* session is cleared too, because
   * the scene it described has changed; use `#discardLiveChoices` when the
   * transcript is untouched (a session switch) so a valid set survives.
   */
  invalidateChoices() {
    this.#discardLiveChoices();
    if (this.activeSession) this.activeSession.choiceSet = null;
    return this.choiceState;
  }

  /** Resets the live machine and cancels any in-flight request, touching no session. */
  #discardLiveChoices() {
    this.#choiceToken += 1;
    if (this.#choiceAbort) {
      this.#choiceAbort.abort();
      this.#choiceAbort = null;
    }
    return this.#resetChoiceState();
  }

  #resetChoiceState() {
    this.choiceState = { status: CHOICE_STATUS.IDLE, sourceId: null, sourceSig: "", choices: [], error: null, selectedId: null };
    return this.choiceState;
  }

  /**
   * Enters `generating` and returns a run descriptor, or null when the machine
   * cannot start (no assistant turn yet, or a request is already in flight).
   * The token is the run's identity: a result tagged with a superseded token is
   * discarded, which is what makes the flow race-safe.
   */
  #beginChoiceGeneration() {
    if (this.choiceState.status === CHOICE_STATUS.GENERATING) return null;
    // Only the character's latest reply offers choices: a pending user turn
    // (a kept, failed turn awaiting retry) means the scene is not waiting on
    // the player, so there is nothing to offer.
    const source = this.choiceScene();
    if (!source) return null;
    const token = ++this.#choiceToken;
    this.choiceState = {
      status: CHOICE_STATUS.GENERATING,
      sourceId: source.id,
      sourceSig: choiceSourceSignature(source),
      choices: [],
      error: null,
    };
    return { token, source };
  }

  /**
   * Generates the next choice set for the latest assistant turn and settles the
   * machine. Auxiliary by design: a failure becomes an `error` state the reader
   * can retry, never a thrown error that could fail the RP turn, and the
   * transcript is never touched. Resolves to the settled `choiceState`.
   */
  async requestChoices({ count, onState } = {}) {
    const run = this.#beginChoiceGeneration();
    if (!run) return this.choiceState;
    onState?.(this.choiceState);
    const { token } = run;
    const abort = new AbortController();
    this.#choiceAbort = abort;
    let settled;
    try {
      const { choices } = await this.engine.generateChoices({
        card: this.activeCard,
        session: this.activeSession,
        settings: this.settings,
        persona: this.currentPersona,
        agentsContract: this.currentDirective?.content || this.settings.agentsContract,
        count,
        charName: this.charName,
        playerName: this.currentPersona?.name || "the player",
        signal: abort.signal,
      });
      settled = this.#settleChoices(token, choices);
    } catch (err) {
      // An aborted request is not a failure: a superseding event usually already
      // reset the state, and reporting an error would flash a stale message. If
      // this run is still the current one (an abort with no supersede), the
      // machine must not be left stuck in `generating`.
      if (err && err.name === "AbortError") {
        if (token === this.#choiceToken) this.#resetChoiceState();
        return this.choiceState;
      }
      settled = this.#failChoices(token, err);
    } finally {
      if (this.#choiceAbort === abort) this.#choiceAbort = null;
    }
    if (settled) onState?.(this.choiceState);
    // Persist the set so a reload shows the same menu without another request.
    // `#settleChoices` already stored it on the session object; without this
    // write that state existed only in memory and was lost on reload. A
    // storage failure must never surface as a choice error — the menu is
    // already valid on screen and the transcript is untouched — so it is
    // reported and swallowed.
    if (this.choiceState.status === CHOICE_STATUS.READY && this.activeSession) {
      try {
        await this.db.saveSession(this.activeSession);
      } catch (err) {
        console.warn("Could not persist the choice set", err);
      }
    }
    return this.choiceState;
  }

  /** Applies a completed generation, unless a newer run has superseded it. */
  #settleChoices(token, choices) {
    if (token !== this.#choiceToken) return false;
    const source = this.#findMessage(this.choiceState.sourceId);
    if (!source || choiceSourceSignature(source) !== this.choiceState.sourceSig) {
      this.#resetChoiceState();
      return true;
    }
    if (!choices || !choices.length) {
      this.choiceState = { ...this.choiceState, status: CHOICE_STATUS.ERROR, choices: [], error: "The model returned no usable choices." };
      return true;
    }
    this.choiceState = {
      ...this.choiceState,
      status: CHOICE_STATUS.READY,
      choices: choices.map((c) => ({ id: c.id, text: c.text, label: c.label || "", type: c.type || "" })),
      error: null,
    };
    // Persist the minimum needed to restore this set without another request.
    if (this.activeSession) {
      this.activeSession.choiceSet = {
        id: `cs_${Date.now()}`,
        sourceId: this.choiceState.sourceId,
        sourceSig: this.choiceState.sourceSig,
        choices: this.choiceState.choices.map((c) => ({ id: c.id, text: c.text, label: c.label || "", type: c.type || "" })),
        generatedAt: Date.now(),
      };
    }
    return true;
  }

  /** Records a generation failure, unless a newer run has superseded it. */
  #failChoices(token, err) {
    if (token !== this.#choiceToken) return false;
    const raw = String(err?.message || err || "").trim();
    this.choiceState = {
      ...this.choiceState,
      status: CHOICE_STATUS.ERROR,
      choices: [],
      error: raw || "Could not generate choices.",
    };
    return true;
  }

  /**
   * Claims the selected choice and moves the machine out of `ready` in the same
   * synchronous step, so a double click cannot append two user turns or start
   * two generations. Returns `{ id, text }`, or null when the machine is not
   * ready or the set has gone stale. The caller appends the text through the
   * normal send path; this method never writes to the transcript itself.
   */
  selectChoice(choiceId) {
    const st = this.choiceState;
    if (st.status !== CHOICE_STATUS.READY) return null;
    const choice = st.choices.find((c) => c.id === choiceId);
    if (!choice) return null;
    // Re-check freshness at the moment of selection: the scene may have changed
    // since the set was rendered.
    if (!this.choicesAreFresh()) {
      this.invalidateChoices();
      return null;
    }
    // Leave READY now. Any later click finds `submitting` and is a no-op. The
    // list is kept (not cleared) so the UI can render it disabled with the
    // selected line acknowledged, rather than the menu vanishing on click.
    this.choiceState = { ...st, status: CHOICE_STATUS.SUBMITTING, selectedId: choice.id, error: null };
    if (this.activeSession) this.activeSession.choiceSet = null;
    return { id: choice.id, text: choice.text };
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
