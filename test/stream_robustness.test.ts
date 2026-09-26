// Regression tests for the OpenAI-compatible streaming contract.
//
// The blank-reply defect had two independent halves:
//   1. The parser read only `delta.content`, so a stream that reported content
//      on a non-streaming shape (`message.content`), omitted the space after
//      `data:`, or carried only reasoning/usage settled as a silent empty reply.
//   2. The controller discarded the engine's return value, so any engine that
//      returned text without invoking `onChunk` persisted an empty bubble.
//
// Every case drives the real public seam (`BrowserChatEngine.streamTurn` and
// `SessionController`) against a deterministic fake fetch. No network I/O.
import { describe, test, expect, afterEach } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";
import { SessionController } from "../public/session_controller.js";
import { sseResponse, jsonResponse, resetFetch } from "./helpers.js";

const settings = { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 4096, maxTokens: 512 };

function session() {
  return { messages: [{ role: "user", content: "hi" }], ledger: "", consumed: 1 };
}

afterEach(() => {
  resetFetch();
});

function run() {
  return BrowserChatEngine.streamTurn({
    card: null,
    session: session(),
    settings,
    persona: null,
    agentsContract: "",
  });
}

describe("Streaming contract - visible content", () => {
  test("1. a single normal delta chunk streams through", async () => {
    globalThis.fetch = async () => sseResponse('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
    expect(await run()).toBe("Hello");
  });

  test("2. multiple content chunks concatenate in order", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
          "data: [DONE]\n\n"
      );
    expect(await run()).toBe("Hello world");
  });

  test("preserves em-dashes and formatting without programmatic string mutation", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"She paused — then turned -- slowly."}}]}\n\n' +
          "data: [DONE]\n\n"
      );
    expect(await run()).toBe("She paused — then turned -- slowly.");
  });

  test("reasoning before visible content keeps only the visible text", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          "data: [DONE]\n\n"
      );
    expect(await run()).toBe("Answer");
  });

  test("`data:` without the optional space is still parsed", async () => {
    globalThis.fetch = async () => sseResponse('data:{"choices":[{"delta":{"content":"tight"}}]}\n\ndata:[DONE]\n\n');
    expect(await run()).toBe("tight");
  });

  test("a JSON payload split across two reads is reassembled", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"spl'));
            c.enqueue(enc.encode('it"}}]}\n\ndata: [DONE]\n\n'));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    expect(await run()).toBe("split");
  });
});

describe("Streaming contract - terminators and usage", () => {
  test("4. finish_reason stop with content is a normal success", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n"
      );
    expect(await run()).toBe("done");
  });

  test("5. finish_reason length with no content rejects with a descriptive error", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"completion_tokens":1200}}\n\n' +
          "data: [DONE]\n\n"
      );
    await expect(run()).rejects.toThrow(/empty reply.*token limit.*finish_reason: length.*completion_tokens: 1200/);
  });

  test("6. a usage-only chunk after content is recorded, not treated as the reply", async () => {
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
          "data: [DONE]\n\n"
      );
    expect(await run()).toBe("hi");
  });

  test("7. duplicate [DONE] markers are harmless", async () => {
    globalThis.fetch = async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: [DONE]\n\n');
    expect(await run()).toBe("ok");
  });

  test("the captured real-world response (reasoning-only + length + 1200) rejects descriptively", async () => {
    // Reproduces a reported provider SSE body verbatim.
    globalThis.fetch = async () =>
      sseResponse(
        ": keepalive\n\n" +
          'data: {"choices":[{"delta":{},"finish_reason":"length","index":0}],"created":1790088829,"id":"8077a059af26130f","model":"knr/muse-spark-1-3-contributor:free","object":"chat.completion.chunk","usage":{"prompt_tokens":9797,"completion_tokens":1200,"total_tokens":10997,"cached_tokens":113}}\n\n' +
          "data: [DONE]\n\n" +
          "data: [DONE]\n\n"
      );
    await expect(run()).rejects.toThrow(/empty reply.*token limit.*finish_reason: length.*completion_tokens: 1200/);
  });
});

describe("Streaming contract - finish_reason length with partial content", () => {
  test("a truncated reply surfaces a notice but returns the partial text", async () => {
    const notices: string[] = [];
    globalThis.fetch = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Once upon"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"completion_tokens":50}}\n\n' +
          "data: [DONE]\n\n"
      );
    const text = await BrowserChatEngine.streamTurn({
      card: null,
      session: session(),
      settings,
      persona: null,
      agentsContract: "",
      onNotice: (n: string) => notices.push(n),
    });
    expect(text).toBe("Once upon");
    expect(notices.some((n) => /cut off.*output token limit/i.test(n))).toBe(true);
  });
});

describe("Streaming contract - non-streaming providers", () => {
  test("8. a JSON completion document is accepted as the reply", async () => {
    globalThis.fetch = async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "Whole body" }, finish_reason: "stop" }] });
    expect(await run()).toBe("Whole body");
  });

  test("a JSON body mislabeled as text/plain is still accepted", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "unlabeled" } }] }), {
        headers: { "Content-Type": "text/plain" },
      });
    expect(await run()).toBe("unlabeled");
  });
});

describe("Streaming contract - max_tokens forwarding", () => {
  test("9. an explicit maxTokens is forwarded as max_tokens", async () => {
    let body = null;
    globalThis.fetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    };
    await BrowserChatEngine.streamTurn({
      card: null,
      session: session(),
      settings: { ...settings, maxTokens: 2048 },
      persona: null,
      agentsContract: "",
    });
    expect(body.max_tokens).toBe(2048);
  });

  test("10. omitting maxTokens leaves the provider default in force", async () => {
    let body = null;
    globalThis.fetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    };
    const { maxTokens, ...withoutMax } = settings;
    await BrowserChatEngine.streamTurn({
      card: null,
      session: session(),
      settings: withoutMax,
      persona: null,
      agentsContract: "",
    });
    expect("max_tokens" in body).toBe(false);
  });

  test("11. Parameter self-healing adapts to provider rejection and caches model capabilities", async () => {
    let calls = 0;
    let sentBodies = [];
    globalThis.fetch = async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      sentBodies.push(body);
      if (body.temperature !== undefined) {
        return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'. Use 'max_completion_tokens'." } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return sseResponse('data: {"choices":[{"delta":{"content":"Adapted reply."}}]}\n\ndata: [DONE]\n\n');
    };

    const targetSettings = {
      apiEndpoint: "https://router.local/v1",
      model: "adaptive-story-model",
      maxTokens: 1000,
      temperature: 0.9,
      frequencyPenalty: 0.2,
      presencePenalty: 0.2,
    };

    const reply = await BrowserChatEngine.streamTurn({
      card: null,
      session: session(),
      settings: targetSettings,
      persona: null,
      agentsContract: "",
    });

    expect(calls).toBe(2);
    expect(reply).toContain("Adapted reply");
    // First call sent standard parameters
    expect(sentBodies[0].max_tokens).toBe(1000);
    expect(sentBodies[0].temperature).toBe(0.9);
    // Second call adapted: max_completion_tokens and stripped temperature
    expect(sentBodies[1].max_completion_tokens).toBe(1000);
    expect(sentBodies[1].max_tokens).toBeUndefined();
    expect(sentBodies[1].temperature).toBeUndefined();
    expect(sentBodies[1].frequency_penalty).toBeUndefined();

    // Subsequent call uses cached capabilities directly on first attempt
    calls = 0;
    sentBodies = [];
    await BrowserChatEngine.streamTurn({
      card: null,
      session: session(),
      settings: targetSettings,
      persona: null,
      agentsContract: "",
    });
    expect(calls).toBe(1);
    expect(sentBodies[0].max_completion_tokens).toBe(1000);
    expect(sentBodies[0].temperature).toBeUndefined();
  });
});

describe("Controller - engine return value is never dropped", () => {
  function makeController(engine) {
    const db = {
      getSettings: () => ({ temperature: 0.5, agentsContract: "" }),
      getAllCards: async () => [{ id: "card_1", name: "C", data: { name: "C", first_mes: "hi" } }],
      getSessionsForCard: async () => [],
      saveSession: async () => {},
      saveCard: async () => {},
      resolvePersonaForCard: async () => ({ name: "User" }),
      resolveDirectiveForCard: async () => null,
    };
    return new SessionController({ db, engine });
  }

  test("a non-streaming engine that only returns text yields a real reply", async () => {
    const engine = {
      async streamTurn() {
        return "returned without chunks";
      },
    };
    const ctl = makeController(engine);
    await ctl.init("card_1", null);
    const { assistantMsg } = await ctl.send("go");
    expect(assistantMsg.content).toBe("returned without chunks");
  });

  test("an engine that streams nothing and returns nothing rejects, keeping the user turn", async () => {
    const engine = { async streamTurn() {} };
    const ctl = makeController(engine);
    await ctl.init("card_1", null);
    await expect(ctl.send("go")).rejects.toThrow(/empty reply/);
    // No empty assistant bubble is persisted, and the user's turn survives so
    // it can be retried without retyping.
    expect(ctl.messages.some((m) => m.role === "assistant" && !m.content)).toBe(false);
    expect(ctl.messages.at(-1).content).toBe("go");
  });

  test("an engine that both streams and returns the same text does not duplicate it", async () => {
    const engine = {
      async streamTurn({ onChunk }) {
        onChunk("once");
        return "once";
      },
    };
    const ctl = makeController(engine);
    await ctl.init("card_1", null);
    const { assistantMsg } = await ctl.send("go");
    expect(assistantMsg.content).toBe("once");
  });
});
