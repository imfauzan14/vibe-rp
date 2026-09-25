import { describe, test, expect } from "bun:test";
import { SessionController } from "../public/session_controller.js";
import { makeControllerDb as makeDb, makeControllerEngine as makeEngine, makeControllerFake } from "./helpers.ts";

async function makeController({ db, engine }: { db?: unknown; engine?: unknown } = {}) {
  return makeControllerFake(SessionController as unknown as new (deps: { db: unknown; engine: unknown }) => { init: (cardId: string, sessionId: null) => Promise<void> }, { db, engine });
}

describe("SessionController - message transitions", () => {
  test("appendMessage pushes a user message with id/role/content/timestamp", async () => {
    const { ctl } = await makeController();
    const msg = ctl.appendMessage({ role: "user", content: "hi" });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hi");
    expect(typeof msg.timestamp).toBe("number");
    expect(ctl.messages.at(-1)).toBe(msg);
  });

  test("editMessage installs an updated revision of the matching id and returns it", async () => {
    const { ctl } = await makeController();
    const msg = ctl.appendMessage({ role: "user", content: "before" });
    const updated = ctl.editMessage(msg.id, "after");
    // Same id/slot (byte-stable prefix), new revision object; the superseded
    // text is retained as a fork record rather than destroyed (defect 8).
    expect(updated.id).toBe(msg.id);
    expect(ctl.messages.find(m => m.id === msg.id)).toBe(updated);
    expect(ctl.messages.find(m => m.id === msg.id).content).toBe("after");
    expect(updated.forks.map(f => f.content)).toEqual(["before"]);
  });

  test("editMessage returns null for unknown id", async () => {
    const { ctl } = await makeController();
    expect(ctl.editMessage("msg_nope", "x")).toBeNull();
  });

  test("deleteMessage removes the matching id and returns true", async () => {
    const { ctl } = await makeController();
    const msg = ctl.appendMessage({ role: "user", content: "temp" });
    const before = ctl.messages.length;
    expect(ctl.deleteMessage(msg.id)).toBe(true);
    expect(ctl.messages.length).toBe(before - 1);
    expect(ctl.messages.find(m => m.id === msg.id)).toBeUndefined();
  });

  test("deleteMessage returns false for unknown id", async () => {
    const { ctl } = await makeController();
    expect(ctl.deleteMessage("msg_nope")).toBe(false);
  });
});

describe("SessionController - reroll semantics", () => {
  test("pops trailing assistant msg and returns the prior user prompt", async () => {
    const { ctl } = await makeController();
    ctl.appendMessage({ role: "user", content: "open the door" });
    ctl.appendMessage({ role: "assistant", content: "creak" });
    const prompt = ctl.reroll();
    expect(prompt).toBe("open the door");
    expect(ctl.messages.length).toBe(2); // trailing assistant popped, init greeting + user kept
    expect(ctl.messages.at(-1).role).toBe("user");
  });

  test("returns null (caller substitutes hint) when prior message is not user", async () => {
    const { ctl } = await makeController();
    // Only the init assistant message
    const prompt = ctl.reroll();
    expect(prompt).toBeNull();
    expect(ctl.messages.length).toBe(0);
  });

  test("no-op on empty messages returns null", async () => {
    const { ctl } = await makeController();
    ctl.activeSession.messages = [];
    expect(ctl.reroll()).toBeNull();
  });
});

describe("SessionController - modal mutual exclusion", () => {
  test("opening one modal closes the previously open one", async () => {
    const { ctl } = await makeController();
    expect(ctl.openModal("history")).toEqual({ opened: "history", closed: null });
    expect(ctl.openModal("settings")).toEqual({ opened: "settings", closed: "history" });
    expect(ctl.openModalName).toBe("settings");
  });

  test("re-opening the same modal closes nothing", async () => {
    const { ctl } = await makeController();
    ctl.openModal("personaEditor");
    expect(ctl.openModal("personaEditor")).toEqual({ opened: "personaEditor", closed: null });
  });

  test("closeModal clears state and reports what closed", async () => {
    const { ctl } = await makeController();
    ctl.openModal("directiveEditor");
    expect(ctl.closeModal()).toEqual({ closed: "directiveEditor" });
    expect(ctl.openModalName).toBeNull();
    expect(ctl.closeModal()).toEqual({ closed: null });
  });

  test("unknown modal name throws", async () => {
    const { ctl } = await makeController();
    expect(() => ctl.openModal("bogus")).toThrow(/Unknown modal/);
  });
});

describe("SessionController - send flow with fake engine + db", () => {
  test("send appends user msg, streams chunks into assistant msg, saves session", async () => {
    const { ctl, db, engine } = await makeController();
    const chunksSeen = [];
    const { userMsg, assistantMsg } = await ctl.send("knock knock", (chunk, msg) => {
      chunksSeen.push(chunk);
      expect(msg.content.endsWith(chunk)).toBe(true); // accumulation is live
    });

    expect(engine.calls).toEqual(["knock knock"]);
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("knock knock");

    expect(chunksSeen).toEqual(["Hello", " world", "!"]);
    expect(assistantMsg.content).toBe("Hello world!");
    expect(assistantMsg.role).toBe("assistant");

    // Assistant message is in the session and was persisted
    expect(ctl.messages.at(-1)).toBe(assistantMsg);
    expect(ctl.messages.at(-2)).toBe(userMsg);
    const saved = db.savedSessions.at(-1);
    expect(saved).toBe(ctl.activeSession);
    expect(saved.messages.some(m => m.content === "Hello world!")).toBe(true);
  });

  test("streamTurn receives card/session/settings/persona/agentsContract", async () => {
    const captured = [];
    const engine = {
      async streamTurn(args) {
        captured.push(args);
        args.onChunk("x");
        return "x";
      },
    };
    const db = makeDb();
    const ctl = new SessionController({ db, engine });
    await ctl.init("card_1", null);
    await ctl.send("go");
    const args = captured[0];
    expect(args.card).toBe(ctl.activeCard);
    expect(args.session).toBe(ctl.activeSession);
    expect(args.settings).toBe(ctl.settings);
    expect(args.persona).toEqual({ name: "User" });
    expect(args.agentsContract).toBe("do"); // directive content wins over settings
  });

  test("session saved after streamTurn (updatedAt bumped)", async () => {
    const { ctl, db, engine } = await makeController();
    const before = db.savedSessions.length;
    await ctl.send("hello");
    // Defect 5: the user turn is persisted immediately (crash safety) and the
    // assistant turn when it settles — two saves, the last carrying both.
    expect(db.savedSessions.length).toBe(before + 2);
    expect(engine.calls.length).toBe(1);
    const last = db.savedSessions.at(-1);
    expect(last).toBe(ctl.activeSession);
    expect(last.messages.some(m => m.content === "Hello world!")).toBe(true);
    expect(last.updatedAt).toBeGreaterThanOrEqual(0);
  });
});

describe("SessionController - ensemble greeting", () => {
  const soloCard = { id: "card_1", name: "Aria", data: { name: "Aria", first_mes: "Aria nods at you." } };
  const groupCard = {
    id: "card_1",
    name: "Trio",
    data: {
      name: "Aria",
      first_mes: "Aria nods at you.",
      group_only_greetings: ["Aria draws her blade. Vex steps back. Marlow freezes."],
    },
  };

  test("greeting() prefers the group greeting when the card carries one", async () => {
    const db = makeDb({ cards: [groupCard] });
    const { ctl } = await makeController({ db });
    expect(ctl.greeting()).toBe("Aria draws her blade. Vex steps back. Marlow freezes.");
  });

  test("greeting() falls back to first_mes for single-character cards", async () => {
    const db = makeDb({ cards: [soloCard] });
    const { ctl } = await makeController({ db });
    expect(ctl.greeting()).toBe("Aria nods at you.");
  });

  test("new sessions open on the group greeting for ensemble cards", async () => {
    const db = makeDb({ cards: [groupCard] });
    const { ctl } = await makeController({ db });
    // init() with no stored sessions creates one via createSession -> greeting().
    expect(ctl.activeSession.messages[0].content).toBe("Aria draws her blade. Vex steps back. Marlow freezes.");
  });
});
