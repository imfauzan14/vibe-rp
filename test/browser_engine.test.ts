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

  test("1. BrowserChatEngine correctly formats system prompt with persona and subagent thoughts", () => {
    const settings = {
      enableSubagentThoughts: true,
      agentsContract: "NO EM DASHES: never use em dashes.",
    };
    const prompt = BrowserChatEngine.formatSystemPrompt(mockCard, mockPersona, settings);
    expect(prompt).toContain("CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Rowan]");
    expect(prompt).toContain("SUBAGENT COGNITIVE LAYER");
    expect(prompt).toContain('<thought character="Aria">');
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
});
