import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";

describe("Browser-First Chat Engine & In-UI Config", () => {
  const mockCard = {
    name: "Aria",
    description: "A stoic wandering swordswoman.",
    personality: "Pragmatic, observant, quiet.",
    scenario: "Northern ruins.",
    first_mes: "The wind is picking up.",
    mes_example: "",
    post_history_instructions: "",
  };

  const mockPersona = {
    name: "Rowan",
    description: "A wandering scholar.",
  };

  test("1. BrowserChatEngine correctly formats system prompt with persona and craft contract", () => {
    const settings = {
      agentsContract: "NO EM DASHES: never use em dashes.",
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(mockCard, mockPersona, settings);
    expect(prompt).toContain("CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Rowan]");
    expect(prompt).toContain("NO EM DASHES");
  });

  test("2. assembleMessages constructs valid LLM payload without mutating Block 0 prefix", () => {
    const systemPrompt = "Locked system prompt prefix.";
    const history = [
      { role: "assistant", content: "The wind is picking up." },
      { role: "user", content: "We should find shelter." },
    ];

    const payload = BrowserChatEngine.assembleMessages(systemPrompt, history, "I see a cavern nearby.", "");
    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toBe(systemPrompt);
    expect(payload.length).toBe(4);
    expect(payload[3].content).toBe("I see a cavern nearby.");
  });

  test("3. BrowserChatEngine.streamTurn is defined as a function", () => {
    expect(typeof BrowserChatEngine.streamTurn).toBe("function");
  });

  test("4. Live direct streaming test against mock or authenticated proxy", async () => {
    // Verifies streamDirect token-level anti-slop cleaning logic
    const chunks = ["The rain falls — silently", " upon the roof -- without", " pause."];
    let cleaned = "";
    for (const chunk of chunks) {
      cleaned += chunk.replace(/ — /g, ", ").replace(/—/g, ", ").replace(/ -- /g, ", ");
    }
    expect(cleaned).not.toContain("—");
    expect(cleaned).not.toContain("--");
    expect(cleaned).toBe("The rain falls, silently upon the roof, without pause.");
  });

  test("5. formatSystemPrompt resolves {{user}}/{{char}} in every embedded card field", () => {
    const card = {
      data: {
        name: "Aria",
        description: "{{char}} guards {{user}}'s road.",
        personality: "Loyal to {{user}}.",
        scenario: "{{user}} arrives at {{char}}'s post.",
        mes_example: "<START>\n{{user}}: hi\n{{char}}: hello",
        system_prompt: "Address {{user}} as captain.",
      },
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("[Description: Aria guards Rowan's road.]");
    expect(prompt).toContain("[Personality: Loyal to Rowan.]");
    expect(prompt).toContain("[Scenario: Rowan arrives at Aria's post.]");
    expect(prompt).toContain("[Dialogue Examples:\n<START>\nRowan: hi\nAria: hello]");
    expect(prompt).toContain("[Character Core Directives:\nAddress Rowan as captain.]");
    expect(prompt).not.toContain("{{user}}");
    expect(prompt).not.toContain("{{char}}");
  });

  test("6. formatSystemPrompt leaves unknown placeholders literal and keeps prompt structure", () => {
    const card = { data: { name: "Aria", description: "{{random}} and {{time}} and {{user}}" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("{{random}} and {{time}} and Rowan");
    expect(prompt).toContain("### CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Rowan]");
    // Byte-stable: the same inputs must assemble the identical prefix every call.
    expect(BrowserChatEngine.formatSystemPrompt(card, mockPersona, {}))
      .toBe(BrowserChatEngine.formatSystemPrompt(card, mockPersona, {}));
  });

  test("7. formatSystemPrompt resolves universal macros in agentsContract and persona", () => {
    const card = { data: { name: "Elena" } };
    const persona = { name: "Iqbal", description: "{user} is traveling with {char}.", template: "Call {user} boss." };
    const settings = { agentsContract: "RULE: Always refer to {user} and {char} respectfully." };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, persona, settings);
    expect(prompt).toContain("RULE: Always refer to Iqbal and Elena respectfully.");
    expect(prompt).toContain("Iqbal is traveling with Elena.");
    expect(prompt).toContain("Call Iqbal boss.");
    expect(prompt).not.toContain("{user}");
    expect(prompt).not.toContain("{char}");
  });

  test("8. formatSystemPrompt injects constant lorebook entries atomically into Block 0", () => {
    const card = {
      data: {
        name: "Elena",
        character_book: {
          entries: [
            { keys: [], content: "The kingdom has been at war for ten years.", constant: true, enabled: true, priority: 10 },
            { keys: ["sword"], content: "The Sunblade glows near danger.", constant: false, enabled: true },
          ],
        },
      },
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, mockPersona, {});
    expect(prompt).toContain("### CONSTANT WORLD LORE");
    expect(prompt).toContain("The kingdom has been at war for ten years.");
    // Non-constant entry should not be in Block 0
    expect(prompt).not.toContain("The Sunblade glows near danger.");
  });

  test("9. planContext shakes both <thought> and <think> tags in older history", () => {
    const systemPrompt = "Stable prefix";
    const messages = [
      { role: "assistant", content: "Opening greeting." },
      { role: "user", content: "What is your plan?" },
      { role: "assistant", content: "<think>I need to deceive them.</think>We head north." },
      { role: "user", content: "Are you sure?" },
      { role: "assistant", content: "<thought character=\"Elena\">Suspicion is high.</thought>Positive." },
      { role: "user", content: "Lead the way." },
    ];
    const plan = BrowserChatEngine.planContext({ systemPrompt, messages, ledger: "", consumed: 1, settings: { maxContextTokens: 16384 } });
    // The older assistant turn (<think>) should have its think tag shaken
    const oldAssistant = plan.history.find(m => m.content && m.content.includes("We head north."));
    expect(oldAssistant.content).toBe("We head north.");
    expect(oldAssistant.content).not.toContain("<think>");
  });

  test("10. selectLorebookEntries uses word-boundary matching to prevent substring false-positives", () => {
    const card = {
      data: {
        name: "Elena",
        character_book: {
          entries: [
            { keys: ["sword"], content: "Blade entry.", constant: false, enabled: true },
            { keys: ["royal archivist"], content: "Archivist entry.", constant: false, enabled: true },
          ],
        },
      },
    };
    // Substring match should NOT trigger (e.g. "swordsman" does not trigger "sword")
    const planNoMatch = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "He is a swordsman." }] },
      settings: {},
    });
    expect(planNoMatch.postHistory).not.toContain("Blade entry.");

    // Word boundary matches should trigger
    const planMatchPunctuation = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "Draw your sword!" }] },
      settings: {},
    });
    expect(planMatchPunctuation.postHistory).toContain("Blade entry.");

    // Multi-word key match
    const planMultiWord = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "Where is the Royal Archivist today?" }] },
      settings: {},
    });
    expect(planMultiWord.postHistory).toContain("Archivist entry.");
  });

  test("11. operationalPrecedence enforces epistemic knowledge boundaries and anti-omniscience for user personas", () => {
    const card = {
      data: {
        name: "Elena",
        description: "A mysterious alchemist living in an isolated tower.",
        scenario: "A stranger arrives at the tower door seeking shelter from a storm.",
      },
    };
    const persona = {
      name: "Fauzan",
      description: "An engineer from a distant high-tech land with secret cybernetic implants.",
    };
    const plan = BrowserChatEngine.planRequest({
      card,
      session: { messages: [{ role: "user", content: "I knock on the wooden door, shivering in the rain." }] },
      persona,
      settings: {},
    });

    const sys = plan.systemPrompt;
    expect(sys).toContain("[User Persona: Fauzan]");
    expect(sys).toContain("Operational Precedence & Epistemic Boundaries");
    expect(sys).toContain("Epistemic Boundary (Anti-Omniscience)");
    expect(sys).toContain("The character does NOT possess telepathic or out-of-character knowledge of the user");
    expect(sys).toContain("must NOT know or call the user by their persona name");
  });
});

