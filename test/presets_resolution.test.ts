import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";
import { DEFAULT_SETTINGS } from "../public/local_db.js";

describe("User Personas & Directives Presets Resolution", () => {
  const defaultContract = "# AGENTS.md — Author's Craft Directive\nSensory grounding.";
  const grimdarkContract = "# AGENTS.md — Grimdark Action\nVisceral blood, mud, and steel.";

  const globalDefaultPersona = {
    id: "persona_default",
    name: "Author",
    description: "The primary observer and author.",
    isDefault: true,
  };

  const customPersona = {
    id: "persona_vance",
    name: "Valen Vance",
    description: "A disgraced royal archivist broker.",
    isDefault: false,
  };

  const mockCardNoOverrides = {
    id: "card_1",
    name: "Aria",
    description: "A stoic wandering swordswoman.",
  };

  const mockCardWithOverrides = {
    id: "card_2",
    name: "Kestrel",
    description: "A desert drifter.",
    userPersonaId: "persona_vance",
    directivePresetId: "directive_grimdark",
  };

  test("1. Block 0 formats system prompt with global default persona and contract fallback", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardNoOverrides,
      globalDefaultPersona,
      { agentsContract: defaultContract }
    );

    expect(prompt).toContain(defaultContract);
    expect(prompt).toContain("CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Author]");
    expect(prompt).toContain("The primary observer and author.");
  });

  test("2. Block 0 formats system prompt with overridden persona and custom directive contract", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardWithOverrides,
      customPersona,
      { agentsContract: grimdarkContract }
    );

    expect(prompt).toContain("Visceral blood, mud, and steel.");
    expect(prompt).not.toContain("Sensory grounding.");
    expect(prompt).toContain("CHARACTER IN SCENE: Kestrel");
    expect(prompt).toContain("[User Persona: Valen Vance]");
    expect(prompt).toContain("A disgraced royal archivist broker.");
  });

  test("3. assembleMessages keeps custom directive and persona in Block 0 prefix", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardWithOverrides,
      customPersona,
      { agentsContract: grimdarkContract }
    );

    const messages = [
      { role: "assistant", content: "The dust storm approaches." },
      { role: "user", content: "Hold the line." }
    ];

    const payload = BrowserChatEngine.assembleMessages(prompt, messages, "Strike now!", "");

    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toContain("Visceral blood, mud, and steel.");
    expect(payload[0].content).toContain("[User Persona: Valen Vance]");
    expect(payload[payload.length - 1].content).toBe("Strike now!");
  });
});

describe("Default Generation Parameters", () => {
  test("DEFAULT_SETTINGS matches the optimized modern-chat-model defaults", () => {
    expect(DEFAULT_SETTINGS.temperature).toBe(0.95);
    expect(DEFAULT_SETTINGS.topP).toBe(1); // >=1 so buildRequestBody omits top_p
    expect(DEFAULT_SETTINGS.minP).toBe(0); // <=0 so buildRequestBody omits min_p
    expect(DEFAULT_SETTINGS.frequencyPenalty).toBe(0); // not sent
    expect(DEFAULT_SETTINGS.presencePenalty).toBe(0); // not sent
    expect(DEFAULT_SETTINGS.maxTokens).toBe(1200);
    expect(DEFAULT_SETTINGS.maxContextTokens).toBe(65536);
  });

  test("default buildRequestBody omits neutral samplers and sends only temperature + max_tokens", () => {
    const body = BrowserChatEngine.buildRequestBody(DEFAULT_SETTINGS, [
      { role: "user", content: "hi" },
    ]);
    expect(body.temperature).toBe(0.95);
    expect(body.max_tokens).toBe(1200);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("min_p");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
  });

  test("resolveBudgets with new defaults keeps prompt budget above 50% of the window", () => {
    const b = BrowserChatEngine.resolveBudgets(DEFAULT_SETTINGS);
    expect(b.reservedOutput).toBe(1200);
    // 65536 - 1200 - floor(8% of 64336) = 59190
    expect(b.promptBudget).toBeGreaterThan(b.contextWindow * 0.5);
  });

  test("resolveBudgets at 32k window: maxTokens 1200 does not starve the prompt", () => {
    const b = BrowserChatEngine.resolveBudgets({ ...DEFAULT_SETTINGS, maxContextTokens: 32768 });
    expect(b.reservedOutput).toBe(1200); // under the 50% clamp (16384)
    // 32768 - 1200 - floor(8% of 31568) = 29043
    expect(b.promptBudget).toBe(29043);
    expect(b.promptBudget).toBeGreaterThan(32768 * 0.5);
  });
});
