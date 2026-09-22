// Regression tests for the core-module hardening pass.
//
// Every case here is behavioral: it drives a public seam (SessionController,
// BrowserChatEngine.streamTurn, LocalDb, safe_html) against injected fakes.
// No test performs real network I/O — `globalThis.fetch` and `globalThis.indexedDB`
// are always replaced with deterministic fakes.
import { describe, test, expect, afterEach } from "bun:test";
import { escapeHtml, escapeAttr } from "../public/safe_html.js";

// ---------------------------------------------------------------------------
// Defect 9 — canonical safe escaping (stored XSS)
// ---------------------------------------------------------------------------
describe("Defect 9 - safe_html canonical escaping", () => {
  // The exact proof payload from the audit: a data URL that breaks out of a
  // double-quoted attribute and installs an onerror handler.
  const PROOF_PAYLOAD = `data:,x" onerror="document.title='INJECTED'" data-z="y"`;

  test("escapeHtml escapes all five canonical characters", () => {
    // Expected value is an independent literal, not a recomputation.
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("escapeAttr neutralises the stored-XSS proof payload in a quoted attribute", () => {
    const escaped = escapeAttr(PROOF_PAYLOAD);
    // No quote of either flavour survives, so the payload cannot close the
    // attribute and open a new one.
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
    // Serialised into a double-quoted attribute there are exactly two raw
    // delimiters (the src quotes); a breakout would add more.
    const html = `<img src="${escaped}">`;
    expect(html.split('"').length - 1).toBe(2);
    expect(html).not.toContain('onerror="document.title');
  });

  test("escapeAttr also survives a single-quoted attribute context", () => {
    const html = `<img src='${escapeAttr(PROOF_PAYLOAD)}'>`;
    expect(html.split("'").length - 1).toBe(2);
  });

  test("both helpers coerce null/undefined to empty and stringify other values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeAttr(null)).toBe("");
    expect(escapeAttr(undefined)).toBe("");
    expect(escapeHtml(0)).toBe("0");
    expect(escapeAttr(0)).toBe("0");
    expect(escapeHtml(42)).toBe("42");
  });
});

import { BrowserChatEngine } from "../public/browser_engine.js";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

// A transcript large enough that planContext compacts and folds.
function compactableSession() {
  return {
    messages: [
      { role: "assistant", content: "greeting" },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? "user" : "assistant",
        content: "x ".repeat(300),
      })),
    ],
    ledger: "",
    consumed: 1,
  };
}

const smallSettings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 2048, maxTokens: 256 };

describe("Defect 1 - degraded fold never emits a null chunk", () => {
  test("a failed summarizer surfaces a notice and no chunk is null/undefined", async () => {
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      throw new Error("summarizer down");
    };
    const chunks = [];
    const notices = [];
    const session = compactableSession();
    await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings: smallSettings,
      persona: null,
      agentsContract: "",
      onChunk: (chunk) => chunks.push(chunk),
      onNotice: (notice) => notices.push(notice),
    });

    // The fold happened and degraded, so the notice must have surfaced...
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices.join(" ")).toContain("summarizer down");
    // ...and every chunk handed to the callback is a real string.
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(typeof c).toBe("string");
    // A null/undefined chunk is what produced the literal "null" reply text.
    expect(chunks.some((c) => c === null || c === undefined)).toBe(false);
  });

  test("a caller wiring only onChunk (page-style) still never receives null", async () => {
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      throw new Error("summarizer down");
    };
    const chunks = [];
    const session = compactableSession();
    const text = await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings: smallSettings,
      persona: null,
      agentsContract: "",
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(chunks.some((c) => c === null || c === undefined)).toBe(false);
    expect(text).toBe("ok");
  });
});

describe("Defect 3 - provider error inside a 200 SSE body is not swallowed", () => {
  test("an error payload in the stream body rejects instead of returning empty success", async () => {
    globalThis.fetch = async () =>
      new Response('data: {"error":{"message":"upstream boom","code":"bad_model"}}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    const session = { messages: [{ role: "user", content: "hi" }], ledger: "", consumed: 1 };
    await expect(
      BrowserChatEngine.streamTurn({ card: null, session, settings: smallSettings, persona: null, agentsContract: "" })
    ).rejects.toThrow(/upstream boom/);
  });

  test("a 200 with a raw JSON error body (no SSE framing) also rejects", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "model not found", code: "404_model" } }), {
        headers: { "Content-Type": "application/json" },
      });
    const session = { messages: [{ role: "user", content: "hi" }], ledger: "", consumed: 1 };
    await expect(
      BrowserChatEngine.streamTurn({ card: null, session, settings: smallSettings, persona: null, agentsContract: "" })
    ).rejects.toThrow(/model not found/);
  });

  test("a normal SSE delta stream is unaffected (no false positive)", async () => {
    globalThis.fetch = async () =>
      new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    const session = { messages: [{ role: "user", content: "hi" }], ledger: "", consumed: 1 };
    const text = await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings: smallSettings,
      persona: null,
      agentsContract: "",
    });
    expect(text).toBe("hi");
  });
});

describe("Defect 4 - the whole turn honours the abort signal", () => {
  afterEach(() => {
    globalThis.fetch = undefined;
  });

  test("the generation request receives the caller's signal", async () => {
    const controller = new AbortController();
    let seenSignal = null;
    globalThis.fetch = async (url, opts) => {
      seenSignal = opts.signal;
      return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
    };
    const session = { messages: [{ role: "user", content: "hi" }], ledger: "", consumed: 1 };
    await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings: smallSettings,
      persona: null,
      agentsContract: "",
      signal: controller.signal,
    });
    expect(seenSignal).toBe(controller.signal);
  });

  test("the summarizer/fold request receives the caller's signal too", async () => {
    const controller = new AbortController();
    const signals = [];
    globalThis.fetch = async (url, opts) => {
      signals.push(opts.signal);
      const body = JSON.parse(opts.body);
      if (body.stream) return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ledger" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = compactableSession();
    await BrowserChatEngine.streamTurn({
      card: null,
      session,
      settings: smallSettings,
      persona: null,
      agentsContract: "",
      signal: controller.signal,
    });
    expect(signals.length).toBe(2); // fold + generation
    for (const s of signals) expect(s).toBe(controller.signal);
  });

  test("an abort during folding rejects the turn and never generates", async () => {
    const controller = new AbortController();
    let generated = false;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.stream) {
        generated = true;
        return new Response(SSE_OK, { headers: { "Content-Type": "text/event-stream" } });
      }
      // Mirror real fetch: an aborted request rejects with an AbortError.
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const session = compactableSession();
    controller.abort();
    await expect(
      BrowserChatEngine.streamTurn({
        card: null,
        session,
        settings: smallSettings,
        persona: null,
        agentsContract: "",
        signal: controller.signal,
      })
    ).rejects.toThrow();
    expect(generated).toBe(false);
  });
});

import { SessionController } from "../public/session_controller.js";

function makeCard(id = "card_1") {
  return { id, name: "Test Char", data: { name: "Test Char", first_mes: "Hello there." } };
}

function makeDb({ cards = [makeCard()], sessions = [] } = {}) {
  const savedSessions = [];
  return {
    savedSessions,
    getSettings: () => ({ temperature: 0.5, agentsContract: "contract" }),
    getAllCards: async () => cards,
    getSessionsForCard: async () => sessions,
    saveSession: async (s) => {
      savedSessions.push(s);
    },
    saveCard: async () => {},
    resolvePersonaForCard: async () => ({ name: "User" }),
    resolveDirectiveForCard: async () => ({ name: "D", content: "do" }),
  };
}

function makeEngine({ onStream } = {}) {
  return {
    calls: [],
    lastArgs: null,
    async streamTurn(args) {
      this.calls.push(args.userPrompt);
      this.lastArgs = args;
      if (onStream) return onStream(args);
      for (const chunk of ["Hello", " world", "!"]) args.onChunk(chunk);
      return "Hello world!";
    },
  };
}

async function makeController({ db, engine } = {}) {
  db = db || makeDb();
  engine = engine || makeEngine();
  const ctl = new SessionController({ db, engine });
  await ctl.init("card_1", null);
  return { ctl, db, engine };
}

describe("Defect 1 - controller ignores null chunks but keeps the notice", () => {
  test("a null/undefined chunk never becomes literal 'null' text and the notice surfaces", async () => {
    const notices = [];
    const engine = makeEngine({
      onStream: async (args) => {
        args.onChunk(null, "Continuity condensed without summarizer: down");
        args.onChunk(undefined, "again");
        args.onChunk("real ");
        args.onChunk("text");
        return "real text";
      },
    });
    const { ctl } = await makeController({ engine });
    const seen = [];
    const { assistantMsg } = await ctl.send("go", (chunk, msg) => seen.push(chunk), (notice) => notices.push(notice));
    expect(assistantMsg.content).toBe("real text");
    expect(assistantMsg.content).not.toContain("null");
    expect(assistantMsg.content).not.toContain("undefined");
    // The notice is not swallowed: it reaches the caller's notice channel.
    expect(notices.length).toBe(2);
    expect(notices[0]).toContain("Continuity condensed");
  });
});

describe("Defect 2 - a failed turn leaves no trace", () => {
  test("streamResponse leaves the transcript byte-identical on failure", async () => {
    const engine = makeEngine({
      onStream: async () => {
        throw new Error("HTTP 500");
      },
    });
    const { ctl, db } = await makeController({ engine });
    const snapshot = JSON.stringify(ctl.activeSession.messages);
    await expect(ctl.streamResponse("boom")).rejects.toThrow("HTTP 500");
    // The placeholder assistant message is gone: byte-identical transcript.
    expect(JSON.stringify(ctl.activeSession.messages)).toBe(snapshot);
    // No persisted snapshot ever contains the empty placeholder.
    expect(
      db.savedSessions.some((s) => s.messages.some((m) => m.role === "assistant" && m.content === ""))
    ).toBe(false);
  });

  test("send rolls the whole turn back on failure and persists no phantom", async () => {
    const engine = makeEngine({
      onStream: async () => {
        throw new Error("HTTP 500");
      },
    });
    const { ctl, db } = await makeController({ engine });
    const before = JSON.stringify(ctl.activeSession.messages);
    await expect(ctl.send("boom")).rejects.toThrow("HTTP 500");
    // Byte-identical to before the turn: user turn and placeholder both gone.
    expect(JSON.stringify(ctl.activeSession.messages)).toBe(before);
    expect(ctl.messages.some((m) => m.content === "boom")).toBe(false);
    expect(ctl.messages.some((m) => m.role === "assistant" && m.content === "")).toBe(false);
    const lastSaved = db.savedSessions.at(-1);
    expect(lastSaved.messages.some((m) => m.content === "boom")).toBe(false);
  });
});

describe("Defect 4 - controller cancellation", () => {
  test("cancel() aborts the in-flight turn and forwards the signal to the engine", async () => {
    let captured = null;
    const engine = {
      async streamTurn(args) {
        captured = args;
        // Emulate the engine waiting on the network until aborted.
        return new Promise((resolve, reject) => {
          args.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    };
    const { ctl } = await makeController({ engine });
    const pending = ctl.send("go");
    await Promise.resolve();
    expect(captured.signal).toBeInstanceOf(AbortSignal);
    ctl.cancel();
    await expect(pending).rejects.toThrow();
    expect(captured.signal.aborted).toBe(true);
  });

  test("an externally supplied signal is forwarded to the engine", async () => {
    const external = new AbortController();
    let captured = null;
    const engine = makeEngine({
      onStream: async (args) => {
        captured = args;
        return "ok";
      },
    });
    const { ctl } = await makeController({ engine });
    await ctl.send("go", undefined, undefined, { signal: external.signal });
    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(captured.signal.aborted).toBe(false);
  });
});

describe("Defect 5 - persist at a safe cheap point", () => {
  test("the user turn is persisted before the stream settles, the assistant after", async () => {
    const order = [];
    const db = makeDb();
    const baseSave = db.saveSession;
    db.saveSession = async (s) => {
      order.push(s.messages.map((m) => m.role).join(","));
      return baseSave(s);
    };
    const engine = makeEngine({
      onStream: async (args) => {
        order.push("streaming");
        args.onChunk("hi");
        return "hi";
      },
    });
    const { ctl } = await makeController({ db, engine });
    order.length = 0; // drop the greeting save performed by init()
    await ctl.send("hello");
    // Exactly three events, in order: the durable user turn, the stream, the
    // settled assistant turn.
    expect(order).toEqual(["assistant,user", "streaming", "assistant,user,assistant"]);
  });
});
describe("Defect 8 - edit forks instead of mutating", () => {
  test("editing preserves the superseded text as a fork record and keeps id/position", async () => {
    const { ctl } = await makeController();
    const original = ctl.appendMessage({ role: "user", content: "before" });
    const forked = ctl.editMessage(original.id, "after");
    // Same id and slot: the payload prefix stays stable (byte-stable prefix
    // rule) — the edit never moves or re-sends the message position.
    expect(forked.id).toBe(original.id);
    expect(ctl.messages.find((m) => m.id === original.id)).toBe(forked);
    expect(forked.content).toBe("after");
    // The original text is preserved, not destroyed.
    expect(forked.forks.map((f) => f.content)).toEqual(["before"]);
    expect(JSON.stringify(forked)).toContain("before");
  });

  test("a second edit stacks fork records in order", async () => {
    const { ctl } = await makeController();
    const original = ctl.appendMessage({ role: "user", content: "v1" });
    ctl.editMessage(original.id, "v2");
    const forked = ctl.editMessage(original.id, "v3");
    expect(forked.content).toBe("v3");
    expect(forked.forks.map((f) => f.content)).toEqual(["v1", "v2"]);
  });

  test("editMessage returns null for an unknown id", async () => {
    const { ctl } = await makeController();
    expect(ctl.editMessage("msg_nope", "x")).toBeNull();
  });
});
