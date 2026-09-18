import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";

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
