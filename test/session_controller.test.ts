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

  test("refuses to reroll when there is no player turn to re-run", async () => {
    const { ctl } = await makeController();
    // Only the init assistant message. Reroll re-runs a player turn, so with
    // none it must leave the card's authored opening exactly as it is: popping
    // it would send the engine a request with no user turn in it at all.
    const prompt = ctl.reroll();
    expect(prompt).toBeNull();
    expect(ctl.messages.length).toBe(1);
    expect(ctl.messages[0].content).toBe(ctl.greeting());
  });

  test("refuses to reroll a reply that no player turn asked for", async () => {
    const { ctl } = await makeController();
    // Reachable by deleting your own message and keeping the reply, so the
    // transcript reads [greeting, reply]. Popping there would re-run the
    // greeting as if the player had said it.
    ctl.appendMessage({ role: "assistant", content: "creak" });
    const prompt = ctl.reroll();
    expect(prompt).toBeNull();
    expect(ctl.messages.length).toBe(2);
    expect(ctl.messages.at(-1).content).toBe("creak");
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
  test("switchSession aborts in-flight turn and targetSession retains its own messages without cross-session pollution", async () => {
    let resolveStream: ((val: string) => void) | null = null;
    const slowEngine = {
      calls: [] as unknown[],
      streamTurn(opts: unknown) {
        slowEngine.calls.push(opts);
        return new Promise<string>((res) => {
          resolveStream = res;
        });
      },
    };
    const { ctl } = await makeController({ engine: slowEngine });
    const session1 = ctl.activeSession;
    const session2 = {
      id: "sess_2",
      cardId: session1.cardId,
      title: "Second chat",
      messages: [{ id: "m2", role: "assistant", content: "Hi from 2", timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    ctl.sessions.push(session2);

    // Start turn on session1
    const streamPromise = ctl.streamResponse(() => {}, () => {}, { persistPending: false });
    expect(ctl.activeSession).toBe(session1);
    expect(session1.messages.length).toBe(2); // greeting + pending assistant
    // Switch to session2 while stream is pending
    ctl.switchSession(session2);
    expect(ctl.activeSession).toBe(session2);

    // Complete stream
    resolveStream!("Reply for session 1");
    await streamPromise;

    // Session 1 got the reply cleanly
    expect(session1.messages.at(-1)?.content).toBe("Reply for session 1");
    // Session 2 was not polluted by session 1's reply
    expect(session2.messages.length).toBe(1);
    expect(session2.messages[0].content).toBe("Hi from 2");
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

  test("greeting() supports alternate greetings by index", async () => {
    const altCard = {
      id: "c_alt",
      data: {
        name: "Aria",
        first_mes: "Original opening.",
        alternate_greetings: ["Second opening in rain.", "Third opening in tavern."],
      },
    };
    const db = makeDb({ cards: [altCard] });
    const { ctl } = await makeController({ db });
    expect(ctl.greeting()).toBe("Original opening.");
    expect(ctl.greeting(1)).toBe("Second opening in rain.");
    expect(ctl.greeting(2)).toBe("Third opening in tavern.");
  });

  test("createSession accepts custom greeting content or alternate index", async () => {
    const altCard = {
      id: "c_alt",
      data: {
        name: "Aria",
        first_mes: "Original opening.",
        alternate_greetings: ["Second opening in rain."],
      },
    };
    const db = makeDb({ cards: [altCard] });
    const { ctl } = await makeController({ db });
    const sessCustom = await ctl.createSession({ greeting: "Custom opening prompt." });
    expect(sessCustom.messages[0].content).toBe("Custom opening prompt.");
    const sessAlt = await ctl.createSession({ greetingIndex: 1 });
    expect(sessAlt.messages[0].content).toBe("Second opening in rain.");
  });
});

// The usage history is written here rather than in the engine, because this is
// the single seam every turn path takes — a typed turn, a chosen one, a reroll
// and a retry all arrive through `streamResponse`. These tests hold the write
// to the two rules the panel depends on: a turn is recorded once, and it is
// filed under the setup it was actually sent under.
describe("SessionController - the usage history is recorded per turn, per scope", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    reported: true,
    billedInput: 10000,
    cachedTokens: 6000,
    estimatedInput: 9000,
    reasoningTokens: null,
    ceilingIgnored: false,
    ...over,
  });

  const historyOf = (ctl: { activeSession: unknown }) => (ctl.activeSession as Record<string, unknown>).usageHistory as Array<Record<string, unknown>>;

  test("a measured turn is recorded once, under the setup in force", async () => {
    const engine = makeEngine({
      onStream: async (args) => {
        (args.session as Record<string, unknown>).lastUsageReport = report();
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl } = await makeController({ engine });
    await ctl.send("go");
    const history = historyOf(ctl);
    expect(history.length).toBe(1);
    expect(history[0].scope).toBe(ctl.usageScope());
    expect(history[0].cached).toBe(6000);
    expect(history[0].billed).toBe(10000);
  });

  test("a provider that reported nothing is recorded as unreported, never as a miss", async () => {
    // The distinction the whole trend turns on. If a silent endpoint produced a
    // sample with `cached: 0`, every reader on such an endpoint would be shown a
    // collapse in cache reuse that never happened.
    const { ctl } = await makeController();
    await ctl.send("go");
    const history = historyOf(ctl);
    expect(history.length).toBe(1);
    expect(history[0].cached).toBeNull();
    expect(history[0].billed).toBeNull();
  });

  test("a failed turn leaves no sample, because nothing was measured", async () => {
    const engine = makeEngine({ streamError: new Error("boom") });
    const { ctl } = await makeController({ engine });
    await expect(ctl.send("go")).rejects.toThrow();
    expect(historyOf(ctl) ?? []).toEqual([]);
  });

  test("two turns under different presets do not share a scope", async () => {
    const engine = makeEngine({
      onStream: async (args) => {
        (args.session as Record<string, unknown>).lastUsageReport = report();
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl } = await makeController({ engine });
    await ctl.send("one");
    const firstScope = ctl.usageScope();
    (ctl as unknown as Record<string, unknown>).currentPersona = { id: "persona_other", name: "Other" };
    await ctl.send("two");

    const history = historyOf(ctl);
    expect(history.length).toBe(2);
    expect(history[0].scope).toBe(firstScope);
    // A different persona is a different prefix, so a different scope: the two
    // samples are never averaged together.
    expect(history[1].scope).not.toBe(firstScope);
  });

  test("the scope is read before the first await, so a mid-stream preset change cannot refile it", async () => {
    let expected = "";
    const engine = makeEngine({
      onStream: async (args) => {
        (args.session as Record<string, unknown>).lastUsageReport = report();
        // The reader opens Settings and switches preset while the reply streams.
        (ctl as unknown as Record<string, unknown>).currentPersona = { id: "persona_switched", name: "Switched" };
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl } = await makeController({ engine });
    expected = ctl.usageScope();
    await ctl.send("go");
    const sample = historyOf(ctl)[0];
    expect(sample.scope).toBe(expected);
    expect(sample.scope).not.toBe(ctl.usageScope());
  });

  test("a recap rebuilt during the turn is marked on the sample", async () => {
    const engine = makeEngine({
      onStream: async (args) => {
        const session = args.session as Record<string, unknown>;
        session.lastUsageReport = report();
        session.consumed = 14; // the fold ran, so this reply's prompt was new
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl } = await makeController({ engine });
    await ctl.send("go");
    expect(historyOf(ctl)[0].folded).toBe(true);
  });

  test("the sample is persisted with the session, so it survives a reload", async () => {
    const engine = makeEngine({
      onStream: async (args) => {
        (args.session as Record<string, unknown>).lastUsageReport = report();
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl, db } = await makeController({ engine });
    await ctl.send("go");
    const saved = (db as { savedSessions: Array<Record<string, unknown>> }).savedSessions.at(-1);
    expect((saved?.usageHistory as Array<unknown>).length).toBe(1);
  });
});
