import { describe, test, expect } from "bun:test";
import { SessionController, CHOICE_STATUS, choiceSourceSignature } from "../public/session_controller.js";
import { makeControllerDb, makeControllerEngine, makeControllerFake } from "./helpers.ts";

function makeCard(id = "card_1") {
  return { id, name: "Elena", data: { name: "Elena", first_mes: "The door closes behind you." } };
}

type Ctor = new (deps: { db: unknown; engine: unknown }) => { init: (cardId: string, sessionId: null) => Promise<void> };
const Ctl = SessionController as unknown as Ctor;

function makeDb({ cards = [makeCard()], sessions = [] }: { cards?: Array<Record<string, unknown>>; sessions?: Array<Record<string, unknown>> } = {}) {
  const db = makeControllerDb({ cards, sessions });
  db.resolvePersonaForCard = async () => ({ name: "Rowan" });
  return db;
}

/** Choice tests stream "The reply."; the shared engine defaults to "Hello world!". */
function makeEngine({ streamText = "The reply.", ...rest }: { streamText?: string; choices?: Array<string | { id?: string; text: string; label?: string }>; choiceError?: unknown; streamError?: unknown } = {}) {
  return makeControllerEngine({ streamText, ...rest });
}

async function makeController({ db, engine }: { db?: unknown; engine?: unknown } = {}) {
  return makeControllerFake(Ctl, { db: db ?? makeDb(), engine: engine ?? makeEngine() });
}

describe("Choice Mode - the core loop", () => {
  test("a settled turn yields a ready set with the parsed choices", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello there.");
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    expect(ctl.choiceState.choices.map((c) => c.text)).toEqual(["Ask about the letter.", "Stay silent.", "Leave the room."]);
    expect(ctl.choiceState.sourceId).toBe(ctl.choiceScene().id);
  });

  test("selecting a choice yields exactly one user turn and one generation", async () => {
    const { ctl, engine } = await makeController();
    await ctl.send("Hello there.");
    await ctl.requestChoices();
    const before = ctl.messages.length;
    const choice = ctl.selectChoice(ctl.choiceState.choices[0].id);
    expect(choice.text).toBe("Ask about the letter.");
    // The UI flow: append the user turn, then stream it (not `send`, which
    // appends internally).
    ctl.appendMessage({ role: "user", content: choice.text });
    await ctl.streamResponse(choice.text);
    // Exactly one user message and one assistant message were added.
    expect(ctl.messages.length).toBe(before + 2);
    expect(ctl.messages.at(-2).content).toBe("Ask about the letter.");
    expect(engine.streamCalls).toBe(2);
    // The selected choice is canonical, with no choice metadata on it.
    expect(ctl.messages.at(-2).role).toBe("user");
    expect(JSON.stringify(ctl.messages.at(-2))).not.toContain("c1");
  });

  test("a double click appends one user turn and starts one generation", async () => {
    const { ctl, engine } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const first = ctl.selectChoice(ctl.choiceState.choices[0].id);
    const second = ctl.selectChoice(ctl.choiceState.choices[1].id);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // the machine left READY on the first claim
    // The list stays for the UI to render disabled, with the pick acknowledged.
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.SUBMITTING);
    expect(ctl.choiceState.selectedId).toBe(first.id);
    ctl.appendMessage({ role: "user", content: first.text });
    // The turn the selection itself appends does not clear the acknowledged
    // state: the reader still sees which line they picked while it streams.
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.SUBMITTING);
    expect(ctl.choiceState.selectedId).toBe(first.id);
    await ctl.streamResponse(first.text);
    expect(engine.streamCalls).toBe(2); // greeting turn + one selection
  });

  test("any other user turn still discards the pending set", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    ctl.appendMessage({ role: "user", content: "A typed line." });
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
  });

  test("the assistant turn that settles after a selection produces a fresh set", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const firstSource = ctl.choiceState.sourceId;
    const choice = ctl.selectChoice(ctl.choiceState.choices[0].id);
    ctl.appendMessage({ role: "user", content: choice.text });
    await ctl.streamResponse(choice.text);
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    expect(ctl.choiceState.sourceId).not.toBe(firstSource);
  });
});

describe("Choice Mode - first turn", () => {
  test("the greeting alone is enough to generate choices, with no fake user turn", async () => {
    const { ctl, engine } = await makeController();
    // Only the greeting exists; no user message has ever been sent.
    expect(ctl.messages.length).toBe(1);
    expect(ctl.messages[0].role).toBe("assistant");
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    // No user turn was invented to make Choice Mode work.
    expect(ctl.messages.length).toBe(1);
    expect(ctl.messages.some((m) => m.role === "user")).toBe(false);
    expect(engine.choiceCalls).toBe(1);
  });

  test("a scene with no assistant turn cannot generate choices", async () => {
    const { ctl, engine } = await makeController();
    ctl.activeSession.messages = [];
    const state = await ctl.requestChoices();
    expect(state.status).toBe(CHOICE_STATUS.IDLE);
    expect(engine.choiceCalls).toBe(0);
  });
});

describe("Choice Mode - stale set protection", () => {
  test("a choice generated for scene A cannot submit into scene B", async () => {
    const { ctl, engine } = await makeController();
    await ctl.send("First turn.");
    await ctl.requestChoices();
    const choiceId = ctl.choiceState.choices[0].id;
    // The scene moves on: a new user turn and reply.
    await ctl.send("A different turn.");
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
    expect(ctl.selectChoice(choiceId)).toBeNull();
    expect(engine.streamCalls).toBe(2); // no third generation from the stale click
  });

  test("editing the source assistant turn invalidates its choices", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const sourceId = ctl.choiceState.sourceId;
    ctl.editMessage(sourceId, "A rewritten reply.");
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
    expect(ctl.choicesAreFresh()).toBe(false);
  });

  test("rerolling the assistant turn invalidates its choices", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    ctl.reroll();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
  });

  test("deleting the source assistant turn invalidates its choices", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const sourceId = ctl.choiceState.sourceId;
    ctl.deleteMessage(sourceId);
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
  });

  test("switching sessions discards the live set", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    const other = { id: "sess_other", cardId: "card_1", title: "Other", messages: [{ id: "g", role: "assistant", content: "Hi." }], consumed: 1 };
    ctl.switchSession(other);
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
    expect(ctl.selectChoice("c1")).toBeNull();
  });

  test("a source-signature change is detected even when the id is unchanged", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const source = ctl.activeSession.messages.find((m) => m.id === ctl.choiceState.sourceId);
    const before = choiceSourceSignature(source);
    source.content += " Extra text.";
    expect(choiceSourceSignature(source)).not.toBe(before);
    expect(ctl.choicesAreFresh()).toBe(false);
    expect(ctl.selectChoice(ctl.choiceState.choices[0]?.id || "c1")).toBeNull();
  });

  test("a set is stale once a newer assistant turn exists", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const staleId = ctl.choiceState.choices[0].id;
    // A newer reply lands (a rerolled/edited branch, an import, or another
    // client): the old menu no longer describes the present scene.
    ctl.activeSession.messages.push({ id: "msg_newer", role: "assistant", content: "A newer reply." });
    expect(ctl.choicesAreFresh()).toBe(false);
    expect(ctl.selectChoice(staleId)).toBeNull();
  });
});

describe("Choice Mode - generation failure is auxiliary", () => {
  test("a choice failure leaves the RP response intact and the state retryable", async () => {
    const engine = makeEngine({ choiceError: new Error("HTTP 500: upstream") });
    const { ctl } = await makeController({ engine });
    const { assistantMsg: reply } = await ctl.send("Hello.");
    expect(reply.content).toBe("The reply.");
    const state = await ctl.requestChoices();
    expect(state.status).toBe(CHOICE_STATUS.ERROR);
    expect(state.error).toContain("HTTP 500");
    // The transcript is untouched by the failure.
    expect(ctl.messages.at(-1).content).toBe("The reply.");
  });

  test("an empty choice list is an error state, not a crash", async () => {
    const engine = makeEngine({ choices: [] });
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello.");
    const state = await ctl.requestChoices();
    expect(state.status).toBe(CHOICE_STATUS.ERROR);
    expect(state.choices).toEqual([]);
  });

  test("a cancellation does not surface as an error", async () => {
    const engine = makeEngine();
    engine.generateChoices = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello.");
    await ctl.requestChoices();
    // An abort is a supersede, not a failure: the state stays idle.
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
  });

  test("regeneration replaces the set without touching the transcript", async () => {
    const engine = makeEngine({ choices: ["One.", "Two.", "Three."] });
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const firstSet = ctl.choiceState.choices.map((c) => c.text);
    const before = JSON.stringify(ctl.messages);
    engine.generateChoices = async () => ({ choices: [{ id: "c1", text: "Fresh A." }, { id: "c2", text: "Fresh B." }], usage: null, request: {} });
    await ctl.requestChoices();
    expect(ctl.choiceState.choices.map((c) => c.text)).toEqual(["Fresh A.", "Fresh B."]);
    expect(firstSet).not.toEqual(["Fresh A.", "Fresh B."]);
    expect(JSON.stringify(ctl.messages)).toBe(before);
  });
});

describe("Choice Mode - a failed turn never dead-ends the machine", () => {
  // The shipped UI path appends the user turn and then streams it, so a
  // provider failure keeps the turn for retry. The choice machine must return
  // to a usable state: leaving it in `submitting` showed a disabled menu with
  // no actions and made every later `selectChoice` a silent no-op.
  test("a failed turn after a selection resets the machine to idle", async () => {
    // A controllable engine: the first stream succeeds (the greeting), the
    // second — the turn a selection starts — fails at the provider.
    let streamCalls = 0;
    const engine = {
      async streamTurn({ onChunk }) {
        streamCalls += 1;
        if (streamCalls > 1) throw new Error("HTTP 500: boom");
        if (onChunk) onChunk("The reply.");
        return "The reply.";
      },
      async generateChoices() {
        return { choices: ["Ask about the letter.", "Stay silent.", "Leave the room."].map((text, i) => ({ id: `c${i}`, text })) };
      },
    };
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello."); // greeting turn succeeds
    await ctl.requestChoices();
    const pick = ctl.selectChoice(ctl.choiceState.choices[0].id);
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.SUBMITTING);
    ctl.appendMessage({ role: "user", content: pick.text });
    await expect(ctl.streamResponse(pick.text)).rejects.toThrow("HTTP 500");
    // Recoverable: idle, with the user turn kept so the turn can be retried.
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.IDLE);
    expect(ctl.choiceState.selectedId).toBeNull();
    // While that turn awaits its reply there is nothing to choose from.
    expect(await ctl.requestChoices()).toMatchObject({ status: CHOICE_STATUS.IDLE });
    // Retrying the same turn restores the scene, and a fresh set follows.
    streamCalls = 0;
    const assistantMsg = await ctl.retryLastTurn();
    expect(assistantMsg.content).toBe("The reply.");
    expect(ctl.messages.filter((m) => m.content === pick.text).length).toBe(1);
    const state = await ctl.requestChoices();
    expect(state.status).toBe(CHOICE_STATUS.READY);
  });
});

describe("Choice Mode - the scene must await the player", () => {
  test("no choices are offered while a user turn awaits its reply", async () => {
    const engine = makeEngine();
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello.");
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    // A turn is kept but its reply failed: the newest message is a user turn.
    ctl.appendMessage({ role: "user", content: "Awaiting a reply." });
    const calls = engine.choiceCalls;
    const state = await ctl.requestChoices();
    expect(state.status).toBe(CHOICE_STATUS.IDLE);
    expect(engine.choiceCalls).toBe(calls); // no request was made at all
  });

  test("a set for a previous scene cannot be selected once a user turn is pending", async () => {
    const engine = makeEngine();
    const { ctl } = await makeController({ engine });
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const id = ctl.choiceState.choices[0].id;
    // The turn is appended but its reply has not arrived yet.
    ctl.appendMessage({ role: "user", content: "Sent, no reply yet." });
    expect(ctl.selectChoice(id)).toBeNull();
    expect(engine.streamCalls).toBe(1);
  });
});

describe("Choice Mode - persistence and restoration", () => {
  test("a settled set is stored as session metadata, not as a message", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const sess = ctl.activeSession;
    expect(sess.choiceSet).toMatchObject({ sourceId: ctl.choiceState.sourceId });
    expect(sess.choiceSet.choices.length).toBe(3);
    // The transcript holds only user/assistant turns.
    expect(sess.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    expect(JSON.stringify(sess.messages)).not.toContain("choiceSet");
  });

  test("reopening a session restores a valid set without another request", async () => {
    const db = makeDb();
    const engine = makeEngine();
    const ctl = new SessionController({ db, engine });
    await ctl.init("card_1", null);
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const callsAfterGeneration = engine.choiceCalls;

    // Simulate a real reload: a fresh controller over the same database, which
    // returns a structured clone of what was actually persisted. A set that was
    // only ever held in memory is genuinely absent here.
    const reloaded = new SessionController({ db, engine });
    await reloaded.init("card_1", ctl.activeSession.id);
    const restored = reloaded.restoreChoices();
    expect(restored.status).toBe(CHOICE_STATUS.READY);
    expect(restored.choices.length).toBe(3);
    expect(restored.choices[0].label).toBe("Label 1");
    // No new request was spent restoring it.
    expect(engine.choiceCalls).toBe(callsAfterGeneration);
  });

  test("a persisted set whose source changed is discarded on restore", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const sess = ctl.activeSession;
    sess.choiceSet.sourceSig = "stale:0:0";
    const state = ctl.restoreChoices();
    expect(state.status).toBe(CHOICE_STATUS.IDLE);
    expect(sess.choiceSet).toBeNull();
  });
});

describe("Choice Mode - mode switching does not modify the transcript", () => {
  test("invalidating the set leaves the conversation byte-identical", async () => {
    const { ctl } = await makeController();
    await ctl.send("Hello.");
    await ctl.requestChoices();
    const before = JSON.stringify(ctl.messages);
    ctl.invalidateChoices();
    expect(JSON.stringify(ctl.messages)).toBe(before);
  });
});

describe("Choice Mode - agency and continuation type preservation", () => {
  test("preserves choice type through generation, selection, and restoration", async () => {
    const { ctl, db } = await makeController();
    ctl.engine.generateChoices = async () => ({
      choices: [
        { id: "c1", label: "Wait quietly", text: "Time passes as footsteps fade down the corridor.", type: "continuation" },
        { id: "c2", label: "Listen", text: "Faint whispers echo from beyond the wooden door.", type: "story" },
      ],
      usage: null,
      request: {},
    });
    await ctl.send("I fall unconscious from the potion.");
    await ctl.requestChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    expect(ctl.choiceState.choices[0].type).toBe("continuation");
    expect(ctl.choiceState.choices[1].type).toBe("story");

    // Restoration retains type
    const reloaded = new SessionController({ db, engine: ctl.engine });
    await reloaded.init("card_1", ctl.activeSession.id);
    const restored = reloaded.restoreChoices();
    expect(restored.status).toBe(CHOICE_STATUS.READY);
    expect(restored.choices[0].type).toBe("continuation");
    expect(restored.choices[1].type).toBe("story");

    // Selection works seamlessly without corrupting perspective
    const pick = ctl.selectChoice("c1");
    expect(pick.text).toBe("Time passes as footsteps fade down the corridor.");
  });
});
