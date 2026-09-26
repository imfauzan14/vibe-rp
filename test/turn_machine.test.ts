// The turn machine. chat_boot composes it with the page's DOM objects; these
// tests drive the machine directly against collaborator fakes, so the turn
// lifecycle (start, chunk piping, settle, stop, failure, retry) is proven
// without a browser.
import { describe, test, expect } from "bun:test";
import { createTurnMachine, describeFailure } from "../public/ui/chat/turn_machine.js";

function makeController({ reply = "The reply.", fail = null } = {}) {
  const calls = [];
  return {
    calls,
    appendMessage(msg) {
      calls.push(["appendMessage", msg]);
      return { ...msg, id: "m_user" };
    },
    reroll() {
      calls.push(["reroll"]);
      return "prior prompt";
    },
    pendingUserTurn() {
      calls.push(["pendingUserTurn"]);
      return { content: "unanswered" };
    },
    cancel() {
      calls.push(["cancel"]);
      return true;
    },
    async streamResponse(promptHint, onChunk) {
      calls.push(["streamResponse", promptHint]);
      if (fail) throw fail;
      if (onChunk) {
        for (const part of ["The ", "reply."]) onChunk(part);
      }
      return { id: "m_reply", content: reply };
    },
  };
}

function makeFeed() {
  const calls = [];
  return {
    calls,
    beginStream(id, opts) {
      calls.push(["beginStream", id]);
      return { id, el: null };
    },
    appendChunk(stream, chunk) {
      calls.push(["appendChunk", chunk]);
    },
    settleStream(stream, msg) {
      calls.push(["settleStream", msg.content]);
    },
    failStream(stream) {
      calls.push(["failStream"]);
    },
  };
}

function makeComposer() {
  return { busy: false, setBusyCalls: [], focused: 0, cleared: [],
    setBusy(b) { this.setBusyCalls.push(b); },
    clearIfMatched(t) { this.cleared.push(t); },
    focus() { this.focused += 1; },
  };
}

function rig(over = {}) {
  const controller = over.controller || makeController(over.reply);
  const feed = over.feed || makeFeed();
  const composer = over.composer || makeComposer();
  const settled = [];
  const machine = createTurnMachine({
    controller,
    composer,
    feed,
    onSettled: () => settled.push("settled"),
    clearComposerInput: (hint) => composer.clearIfMatched(hint),
    ...over.machine,
  });
  return { controller, feed, composer, settled, machine };
}

describe("describeFailure", () => {
  test("a stop is silent, not an error", () => {
    expect(describeFailure(new DOMException("aborted", "AbortError"))).toBeNull();
    expect(describeFailure(new Error("user aborted"))).toBeNull();
  });

  test("provider failures name the fix and whether retry helps", () => {
    expect(describeFailure(new Error("HTTP 401 unauthorized"))).toMatchObject({ retry: true });
    expect(describeFailure(new Error("HTTP 429 too many requests"))).toMatchObject({ retry: true });
    expect(describeFailure(new Error("HTTP 500 boom"))).toMatchObject({ retry: true });
    expect(describeFailure(new Error("storage quota exceeded"))).toMatchObject({ retry: false });
  });

  test("an unknown failure still retries with the raw text", () => {
    expect(describeFailure(new Error("weird"))).toMatchObject({ text: "weird", retry: true });
  });
});

describe("streamTurn", () => {
  test("pipes chunks into the feed and settles the reconciled reply", async () => {
    const { machine, feed, composer, settled } = rig();
    await machine.streamTurn("go");
    const names = feed.calls.map((c) => c[0]);
    expect(names).toEqual(["beginStream", "appendChunk", "appendChunk", "settleStream"]);
    expect(feed.calls[3][1]).toBe("The reply.");
    expect(settled).toEqual(["settled"]);
    expect(composer.setBusyCalls).toEqual([true, false]);
    expect(composer.cleared).toEqual(["go"]);
  });

  test("anchors the view at the top of the new incoming assistant message via scrollToStream", async () => {
    const scrolled: string[] = [];
    const { machine } = rig({
      machine: {
        scrollToStream: (id: string) => scrolled.push(id),
      },
    });
    await machine.streamTurn("hello");
    expect(scrolled.length).toBe(1);
    expect(scrolled[0]).toMatch(/^msg_/);
  });

  test("a failure fails the stream and shows the retry toast", async () => {
    const toasted = [];
    const notifier = { toast: (text, opts) => toasted.push([text, opts]) };
    const failed = [];
    const { machine, feed } = rig({
      controller: makeController({ fail: new Error("HTTP 500 boom") }),
      machine: { notifier, onChoiceTurnFailed: () => failed.push("failed") },
    });
    await machine.streamTurn("go");
    expect(feed.calls.map((c) => c[0])).toEqual(["beginStream", "failStream"]);
    expect(toasted).toHaveLength(1);
    expect(typeof toasted[0][1].onAction).toBe("function");
    expect(failed).toEqual([]);
  });

  test("a stopped turn stays silent", async () => {
    const shown = [];
    const { machine, feed } = rig({
      controller: {
        ...makeController(),
        async streamResponse() {
          machine.stopTurn();
          throw new DOMException("aborted", "AbortError");
        },
      },
      machine: { showToast: (t) => shown.push(t) },
    });
    await machine.streamTurn("go");
    expect(feed.calls.map((c) => c[0])).toEqual(["beginStream", "failStream"]);
    expect(shown).toEqual(["Stopped."]);
  });
});

describe("entries", () => {
  test("submitTurn appends one user turn and streams it", async () => {
    const { machine, controller } = rig();
    await machine.submitTurn("hello");
    expect(controller.calls[0]).toEqual(["appendMessage", { role: "user", content: "hello" }]);
    expect(controller.calls[1]).toEqual(["streamResponse", "hello"]);
  });

  test("submitTurn ignores an empty turn and a busy composer", async () => {
    const { machine, controller } = rig();
    await machine.submitTurn("  ");
    expect(controller.calls).toEqual([]);
    const busy = rig({ composer: { ...makeComposer(), busy: true } });
    await busy.machine.submitTurn("hello");
    expect(busy.controller.calls).toEqual([]);
  });

  test("rerollLastTurn reuses the prior prompt", async () => {
    const { machine, controller } = rig();
    await machine.rerollLastTurn();
    expect(controller.calls[0]).toEqual(["reroll"]);
    expect(controller.calls[1]).toEqual(["streamResponse", "prior prompt"]);
  });

  test("retryUnansweredTurn re-streams the pending turn without appending", async () => {
    const { machine, controller } = rig();
    await machine.retryUnansweredTurn();
    expect(controller.calls[0]).toEqual(["pendingUserTurn"]);
    expect(controller.calls[1]).toEqual(["streamResponse", "unanswered"]);
    expect(controller.calls.some((c) => c[0] === "appendMessage")).toBe(false);
  });

  test("stopTurn cancels the controller", () => {
    const { machine, controller } = rig();
    machine.stopTurn();
    expect(controller.calls).toEqual([["cancel"]]);
  });
});
