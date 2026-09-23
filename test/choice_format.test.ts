// Choice Mode: the pure parser and the generation-request planner.
//
// Both are pure, so these cases drive them directly. The parser owns untrusted
// model output, so the malformed cases matter as much as the happy path: none of
// them may throw, and none may let model text through as anything but a string.
import { describe, test, expect } from "bun:test";
import {
  parseChoices,
  normalizeChoiceText,
  choicePrompt,
  CHOICE_SYSTEM_PROMPT,
  CHOICE_TEXT_MAX_CHARS,
  CHOICE_COUNT_MIN,
  CHOICE_COUNT_MAX,
} from "../public/choice_format.js";
import {
  BrowserChatEngine,
  planChoiceRequest,
  estimateTokens,
  stripThoughtBlocks,
  cleanPromptText,
} from "../public/browser_engine.js";

const words = (n) => "word ".repeat(n).trim();

describe("choice parser - the instructed shape", () => {
  test("parses the compact JSON object into id/text pairs", () => {
    const { choices } = parseChoices(
      '{"choices":[{"id":"c1","text":"Press her about the letter."},{"text":"Stay silent."},{"text":"Change the subject."},{"text":"Leave."}]}'
    );
    expect(choices.length).toBe(4);
    expect(choices[0]).toEqual({ id: "c1", text: "Press her about the letter." });
    expect(choices[1].id).toBe("c2"); // ids are normalised, not trusted
  });

  test("tolerates a code fence and surrounding prose", () => {
    const { choices } = parseChoices(
      'Sure!\n```json\n{"choices":[{"text":"Open the door."},{"text":"Wait."},{"text":"Call out."}]}\n```\nHope that helps.'
    );
    expect(choices.map((c) => c.text)).toEqual(["Open the door.", "Wait.", "Call out."]);
  });

  test("accepts a bare array and common key aliases", () => {
    expect(parseChoices('["Ask about it.","Leave."]').choices.length).toBe(2);
    expect(parseChoices('{"choices":[{"label":"Ask."},{"choice":"Leave."}]}').choices.map((c) => c.text)).toEqual(["Ask.", "Leave."]);
  });

  test("parses label for menu display alongside full roleplay text", () => {
    const raw = JSON.stringify({
      choices: [
        { label: "Refuse demand", text: "Menahan beban gravitasi sambil menatap lurus matanya, menolak permintaannya." },
        { label: "Step back", text: "Melangkah mundur tanpa sepatah kata pun menuju loker." },
      ],
    });
    const { choices } = parseChoices(raw);
    expect(choices.length).toBe(2);
    expect(choices[0].label).toBe("Refuse demand");
    expect(choices[0].text).toBe("Menahan beban gravitasi sambil menatap lurus matanya, menolak permintaannya.");
    expect(choices[1].label).toBe("Step back");
    expect(choices[1].text).toBe("Melangkah mundur tanpa sepatah kata pun menuju loker.");
  });

  test("a brace inside a quoted choice does not close the object early", () => {
    const { choices } = parseChoices('{"choices":[{"text":"Say \\"a { brace } thing\\"."},{"text":"Leave."}]}');
    expect(choices.map((c) => c.text)).toEqual(['Say "a { brace } thing".', "Leave."]);
  });

  test("falls back to a line list only when it yields a real menu", () => {
    const { choices } = parseChoices("1. Ask about the letter\n2. Stay silent\n3. Leave");
    expect(choices.map((c) => c.text)).toEqual(["Ask about the letter", "Stay silent", "Leave"]);
  });
});

describe("choice parser - validation and sanitation", () => {
  test("drops duplicates case- and punctuation-insensitively", () => {
    const { choices } = parseChoices(
      '{"choices":[{"text":"Ask about the letter."},{"text":"ask about the LETTER"},{"text":"Leave."}]}'
    );
    expect(choices.map((c) => c.text)).toEqual(["Ask about the letter.", "Leave."]);
  });

  test("strips list markers and wrapping quotes", () => {
    const { choices } = parseChoices(
      '{"choices":[{"text":"- Do the thing"},{"text":"\\u2022 Another thing"},{"text":"[2] Bracket thing"},{"text":"\\"Quoted thing\\""}]}'
    );
    expect(choices.map((c) => c.text)).toEqual(["Do the thing", "Another thing", "Bracket thing", "Quoted thing"]);
  });

  test("collapses a multi-line entry into one line", () => {
    const { choices } = parseChoices('{"choices":[{"text":"Ask her\\n\\nabout   the letter."},{"text":"Leave."}]}');
    expect(choices[0].text).toBe("Ask her about the letter.");
  });

  test("removes control, zero-width and bidi-override characters", () => {
    const { choices } = parseChoices('{"choices":[{"text":"A\\u0007 b\\u202Ec\\u200Bd"},{"text":"Leave."}]}');
    expect(choices[0].text).toBe("A bcd");
  });

  test("rejects empty, whitespace and single-character entries", () => {
    expect(parseChoices('{"choices":[{"text":"   "},{"text":"x"}]}').choices).toEqual([]);
  });

  test("clamps verbose choices only when too few already fit", () => {
    const longA = `${"alpha ".repeat(60)}end`;
    const longB = `${"bravo ".repeat(60)}finish`;
    const { choices } = parseChoices(JSON.stringify({ choices: [{ text: longA }, { text: longB }] }));
    expect(choices.length).toBe(2);
    for (const c of choices) expect(c.text.length).toBeLessThanOrEqual(CHOICE_TEXT_MAX_CHARS);
  });

  test("keeps fitting choices instead of clamping when at least two fit", () => {
    const long = "w ".repeat(200).trim();
    const { choices } = parseChoices(JSON.stringify({ choices: [{ text: "Short." }, { text: "Also short." }, { text: long }] }));
    expect(choices.map((c) => c.text)).toEqual(["Short.", "Also short."]);
  });

  test("caps the list at the maximum", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Choice number ${i}` }));
    expect(parseChoices(JSON.stringify({ choices: many })).choices.length).toBe(CHOICE_COUNT_MAX);
  });
});

describe("choice parser - never crashes on malformed output", () => {
  const bad = [
    "",
    "   ",
    "not json at all",
    "{}",
    '{"choices":[]}',
    '{"choices":null}',
    '{"choices":"nope"}',
    '{"choices":[null, 3, {}]}',
    '{"choices":[{"text":null}]}',
    '{"choices":[{"text":{"nested":"object"}}]}',
    '{"choices":[{"text":"Ask her."}',
    "```\n```",
    '{"choices": [{"text": "a"},]}',
    "[[[{{{",
    "\u0000\u0001",
  ];
  test("every malformed shape yields a list, never a throw", () => {
    for (const input of bad) {
      const result = parseChoices(input);
      expect(Array.isArray(result.choices)).toBe(true);
      for (const c of result.choices) {
        expect(typeof c.id).toBe("string");
        expect(typeof c.text).toBe("string");
        expect(c.text.length).toBeGreaterThan(0);
      }
    }
  });

  test("a single line of prose is not mistaken for a one-item menu", () => {
    expect(parseChoices("I cannot help with that request.").choices).toEqual([]);
  });

  test("non-string input is coerced, not thrown on", () => {
    expect(parseChoices(null).choices).toEqual([]);
    expect(parseChoices(undefined).choices).toEqual([]);
    expect(parseChoices(42).choices).toEqual([]);
  });
});

describe("normalizeChoiceText", () => {
  test("trims, unquotes and collapses whitespace", () => {
    expect(normalizeChoiceText('  "Hello\n\nworld"  ')).toBe("Hello world");
  });
});

describe("choicePrompt", () => {
  test("names the target count inside the allowed range", () => {
    expect(choicePrompt(4, { charName: "Elena", playerName: "Rowan" })).toContain("4 choices");
    expect(choicePrompt(2)).toContain(`${CHOICE_COUNT_MIN} choices`);
    expect(choicePrompt(99)).toContain(`${CHOICE_COUNT_MAX} choices`);
  });

  test("contains no card placeholder tokens that substitution could rewrite", () => {
    const prompt = choicePrompt(4, { charName: "Elena", playerName: "Rowan" });
    expect(prompt).not.toMatch(/\{\{\s*(char|user)/i);
  });
});

describe("planChoiceRequest", () => {
  const settings = { maxContextTokens: 8192, maxTokens: 1200, model: "m", apiEndpoint: "https://x.test/v1" };
  const card = { data: { name: "Elena", description: words(4000), mes_example: words(8000) } };

  function grownSession(turns = 30) {
    const session = { messages: [{ id: "g", role: "assistant", content: "The greeting." }], ledger: "", consumed: 1 };
    for (let i = 0; i < turns; i += 1) {
      session.messages.push({ id: `u${i}`, role: "user", content: words(300) });
      session.messages.push({ id: `a${i}`, role: "assistant", content: words(300) });
    }
    return session;
  }

  test("uses a small context, not the full preset or transcript", () => {
    const session = grownSession();
    session.ledger = words(3000);
    const req = planChoiceRequest({ card, session, settings, persona: { name: "Rowan" }, count: 4 });
    // The whole preset is ~12k tokens; a choice request must be far smaller.
    expect(req.inputTokens).toBeLessThan(4000);
    expect(req.inputTokens + req.outputTokens).toBeLessThanOrEqual(req.contextWindow);
    // Only the recent tail is carried, never all 61 messages.
    expect(req.payload.length).toBeLessThan(12);
  });

  test("the request always fits the effective window", () => {
    for (const window of [2048, 4096, 8192, 16384, 65536, 131072]) {
      const req = planChoiceRequest({ card, session: grownSession(), settings: { ...settings, maxContextTokens: window }, persona: null });
      expect(req.inputTokens + req.outputTokens).toBeLessThanOrEqual(req.contextWindow);
    }
  });

  test("the newest assistant turn is kept even on a tiny window", () => {
    const session = grownSession();
    const last = session.messages.at(-1);
    const req = planChoiceRequest({ card, session, settings: { ...settings, maxContextTokens: 2048 }, persona: null });
    const contents = req.payload.map((m) => m.content);
    expect(contents.some((c) => c.includes(last.content.slice(0, 40)))).toBe(true);
  });

  test("the last message is the instruction task line, and the first is the system prompt", () => {
    const req = planChoiceRequest({ card, session: grownSession(), settings, persona: { name: "Rowan" }, count: 4 });
    expect(req.payload[0].role).toBe("system");
    expect(req.payload.at(-1).role).toBe("user");
    expect(req.payload.at(-1).content).toContain("4 choices");
  });

  test("is pure: it does not mutate the session or the card", () => {
    const session = grownSession();
    session.ledger = words(2000);
    const before = JSON.stringify(session);
    const beforeCard = JSON.stringify(card);
    planChoiceRequest({ card, session, settings, persona: { name: "Rowan" }, count: 4 });
    expect(JSON.stringify(session)).toBe(before);
    expect(JSON.stringify(card)).toBe(beforeCard);
  });

  test("resolves card placeholders so no {{char}} reaches the model", () => {
    const session = { messages: [{ id: "g", role: "assistant", content: "{{char}} waits by the door." }], ledger: "", consumed: 1 };
    const req = planChoiceRequest({ card, session, settings, persona: { name: "Rowan" }, count: 4 });
    expect(JSON.stringify(req.payload)).not.toContain("{{char}}");
    expect(JSON.stringify(req.payload)).toContain("Elena");
  });

  test("the public static seam matches the module function", () => {
    const args = { card, session: grownSession(), settings, persona: null, count: 4 };
    expect(BrowserChatEngine.planChoiceRequest(args).inputTokens).toBe(planChoiceRequest(args).inputTokens);
  });

  test("carries agentsContract into the system prompt for choice generation", () => {
    const customContract = "Bahasa Indonesia contract: tulis dalam bahasa Indonesia.";
    const req = planChoiceRequest({
      card,
      session: { messages: [{ id: "g", role: "assistant", content: "The greeting." }] },
      settings: { ...settings, agentsContract: customContract },
      persona: { name: "Rowan" },
      count: 4,
    });
    const systemMessage = req.payload.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Bahasa Indonesia contract");
  });
});

describe("generateChoices - auxiliary request behaviour", () => {
  const settings = { maxContextTokens: 8192, maxTokens: 1200, model: "m", apiEndpoint: "https://x.test/v1" };
  const session = { messages: [{ id: "g", role: "assistant", content: "The greeting." }], ledger: "", consumed: 1 };

  test("parses a valid provider response into choices", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"choices":[{"text":"Ask."},{"text":"Leave."}]}' } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const { choices } = await BrowserChatEngine.generateChoices({ card: null, session, settings, persona: null });
    expect(choices.map((c) => c.text)).toEqual(["Ask.", "Leave."]);
  });

  test("a non-JSON body yields no choices instead of throwing a parse error", async () => {
    globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const { choices } = await BrowserChatEngine.generateChoices({ card: null, session, settings, persona: null });
    expect(choices).toEqual([]);
  });

  test("a provider error inside a 200 body is surfaced", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "model overloaded" } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    await expect(BrowserChatEngine.generateChoices({ card: null, session, settings, persona: null })).rejects.toThrow(/model overloaded/);
  });

  test("a non-2xx status surfaces the provider detail", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "no such model" } }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
    await expect(BrowserChatEngine.generateChoices({ card: null, session, settings, persona: null })).rejects.toThrow(/404.*no such model/s);
  });

  test("the request is non-streaming and never mutates the session", async () => {
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choices":[{"text":"A."},{"text":"B."}]}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const before = JSON.stringify(session);
    await BrowserChatEngine.generateChoices({ card: null, session, settings, persona: null });
    expect(sent.stream).toBe(false);
    expect(sent.max_tokens).toBeGreaterThan(0);
    // No cache key on a one-off auxiliary call.
    expect(sent.prompt_cache_key).toBeUndefined();
    expect(JSON.stringify(session)).toBe(before);
  });

  test("the request fits the configured window even with a huge preset", async () => {
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choices":[{"text":"A."},{"text":"B."}]}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const hugeCard = { data: { name: "Elena", description: words(60000), mes_example: words(60000) } };
    const big = { ...settings, maxContextTokens: 8192 };
    await BrowserChatEngine.generateChoices({ card: hugeCard, session, settings: big, persona: null });
    const inputTokens = estimateTokens(JSON.stringify(sent.messages));
    expect(inputTokens + sent.max_tokens).toBeLessThan(8192 * 4);
  });

  test("uses choiceModel when configured and falls back to model", async () => {
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choices":[{"text":"A."}]}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    // When choiceModel is configured
    await BrowserChatEngine.generateChoices({
      card: null,
      session,
      settings: { ...settings, model: "main-model", choiceModel: "custom-choice-model" },
      persona: null,
    });
    expect(sent.model).toBe("custom-choice-model");

    // When choiceModel is empty
    await BrowserChatEngine.generateChoices({
      card: null,
      session,
      settings: { ...settings, model: "main-model", choiceModel: "" },
      persona: null,
    });
    expect(sent.model).toBe("main-model");

    // When choiceModel is OpenAI reasoning model (o3-mini)
    await BrowserChatEngine.generateChoices({
      card: null,
      session,
      settings: { ...settings, choiceModel: "o3-mini" },
      persona: null,
    });
    expect(sent.model).toBe("o3-mini");
    expect(sent.max_completion_tokens).toBeGreaterThan(0);
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.temperature).toBeUndefined();
  });

  test("parseChoices ignores draft JSON inside reasoning <think> blocks and parses final JSON", () => {
    const raw = `<think>
I should generate 2 choices:
{"choices": [{"text": "Draft option from scratchpad"}]}
Let me think more, actually let's provide real actions.
</think>
{
  "choices": [
    {"label": "Direct", "text": "I step forward boldly."},
    {"label": "Cautious", "text": "I hold my ground quietly."}
  ]
}`;
    const result = parseChoices(raw);
    expect(result.choices.length).toBe(2);
    expect(result.choices[0].text).toBe("I step forward boldly.");
    expect(result.choices[0].label).toBe("Direct");
    expect(result.choices[1].text).toBe("I hold my ground quietly.");
    expect(result.choices.some((c) => c.text.includes("Draft"))).toBe(false);
  });
});

describe("stripThoughtBlocks and cleanPromptText", () => {
  test("stripThoughtBlocks removes closed thought and think tags", () => {
    const raw = "<think>Internal reasoning trace</think>Visible character action.";
    expect(stripThoughtBlocks(raw)).toBe("Visible character action.");

    const rawThought = "<thought>Thinking...</thought>Spoken words.";
    expect(stripThoughtBlocks(rawThought)).toBe("Spoken words.");
  });

  test("stripThoughtBlocks removes unclosed trailing thought tags", () => {
    const unclosed = "Spoken text.<think>Cut off mid-reasoning...";
    expect(stripThoughtBlocks(unclosed)).toBe("Spoken text.");
  });

  test("stripThoughtBlocks safely handles empty or non-string inputs", () => {
    expect(stripThoughtBlocks("")).toBe("");
    expect(stripThoughtBlocks(null)).toBe("");
    expect(stripThoughtBlocks(undefined)).toBe("");
  });

  test("cleanPromptText strips invisible characters and collapses blank lines (RTK)", () => {
    const dirty = "Line 1\u200B\n\n\n\nLine 2   \n\n\nLine 3";
    const cleaned = cleanPromptText(dirty);
    expect(cleaned).not.toContain("\u200B");
    expect(cleaned).not.toMatch(/\n{3,}/);
    expect(cleaned).toBe("Line 1\n\nLine 2\n\nLine 3");
  });
});

describe("Universal & Adaptive Choice Mode Prompt Contract", () => {
  test("CHOICE_SYSTEM_PROMPT contains Language Lock, Narrative Perspective, and 4 dramatic archetypes", () => {
    expect(CHOICE_SYSTEM_PROMPT).toContain("Language Lock");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Narrative Perspective");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Direct / Assertive");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Inquisitive / Diplomatic");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Cautious / Observant");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Unconventional / Intuitive");
    expect(CHOICE_SYSTEM_PROMPT).toContain("Strict Agency");
  });

  test("planChoiceRequest shakes thought blocks from assistant turns in history", () => {
    const session = {
      messages: [
        { id: "u1", role: "user", content: "What do you see?" },
        {
          id: "a1",
          role: "assistant",
          content: "<think>I should look at the horizon and see the storm approaching. This will heighten dramatic tension.</think>The horizon is dark with heavy clouds.",
        },
      ],
      ledger: "",
      consumed: 1,
    };
    const card = { data: { name: "Aria", scenario: "On the high ramparts at sunset." } };
    const req = planChoiceRequest({
      card,
      session,
      settings: { maxContextTokens: 4096, maxTokens: 1000 },
      persona: { name: "Rowan" },
      count: 4,
    });

    const assistantMsg = req.payload.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("The horizon is dark with heavy clouds.");
    expect(assistantMsg.content).not.toContain("<think>");
    expect(assistantMsg.content).not.toContain("heighten dramatic tension");

    // Also verify scenario hint is included in system prompt
    expect(req.payload[0].content).toContain("Scenario: On the high ramparts at sunset.");
  });
});

